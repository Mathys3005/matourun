import crypto from "node:crypto";
import { z } from "zod";
import gcPkg from "garmin-connect";
import { env } from "../env.js";
import { q } from "../db.js";
import { HttpError } from "../middleware/security.js";

const { GarminConnect } = gcPkg as unknown as { GarminConnect: new (c?: unknown) => GC };

interface GC {
  login(u?: string, p?: string): Promise<GC>;
  exportToken(): { oauth1: unknown; oauth2: unknown };
  loadToken(o1: unknown, o2: unknown): void;
  get<T>(url: string, data?: unknown): Promise<T>;
  post<T>(url: string, data: unknown): Promise<T>;
  put<T>(url: string, data: unknown): Promise<T>;
  client: { delete<T>(url: string): Promise<T> };
}

const API = "https://connectapi.garmin.com";
const TOKEN_KEY = "garmin_tokens";

/* Garmin OAuth tokens are stored encrypted (AES-256-GCM) so the account isn't
   signed in again on every cold start. */
function key() {
  return crypto.createHash("sha256").update(`garmin-tokens:${env().JWT_SECRET}`).digest();
}
function encrypt(text: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}
function decrypt(blob: string) {
  const [iv, tag, data] = blob.split(".").map((p) => Buffer.from(p, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(data!), d.final()]).toString("utf8");
}

/** HTTP status of a Garmin failure (axios error, or the library's "ERROR: (429), …" message). */
function statusOf(err: unknown): number | undefined {
  const e = err as { message?: string; response?: { status?: number } };
  if (e?.response?.status) return e.response.status;
  const m = /ERROR: \((\d{3})\)/.exec(e?.message ?? "");
  return m ? Number(m[1]) : undefined;
}

/* After a failed sign-in, no new attempt is made until the cooldown ends: retrying
   in bursts is what gets the server's address blocked by Garmin (Cloudflare 1015).
   Stored in the database so a restart of the server doesn't reset it. */
const COOLDOWN_KEY = "garmin_cooldown_until";
const RATE_LIMIT_COOLDOWN_MIN = 60;
const OTHER_COOLDOWN_MIN = 10;

const hhmm = (ms: number) =>
  new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(ms);

async function cooldownUntil(): Promise<number> {
  const { rows } = await q<{ value: string }>(`SELECT value FROM app_secrets WHERE key = $1`, [COOLDOWN_KEY]);
  return Number(rows[0]?.value ?? 0) || 0;
}

async function startCooldown(minutes: number): Promise<number> {
  const until = Date.now() + minutes * 60_000;
  await q(
    `INSERT INTO app_secrets (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [COOLDOWN_KEY, String(until)],
  );
  return until;
}

async function assertNoCooldown() {
  const until = await cooldownUntil();
  if (until > Date.now()) {
    throw new HttpError(
      429,
      `Garmin limite les connexions depuis le serveur. Nouvel essai possible à ${hhmm(until)}.`,
    );
  }
}

/** Turns a sign-in failure into a precise message, logs it, and starts the cooldown. */
async function loginError(err: unknown): Promise<HttpError> {
  const status = statusOf(err);
  const message = (err as { message?: string })?.message ?? String(err);
  console.error("[garmin] login failed", { status, message: message.slice(0, 300) });
  if (status === 429 || /rate.?limit|1015/i.test(message)) {
    const until = await startCooldown(RATE_LIMIT_COOLDOWN_MIN);
    return new HttpError(
      429,
      `Garmin limite les connexions depuis le serveur. Nouvel essai possible à ${hhmm(until)}.`,
    );
  }
  await startCooldown(OTHER_COOLDOWN_MIN);
  if (status === 403) return new HttpError(502, "Garmin bloque les connexions depuis le serveur (403).");
  if (/MFA|Ticket not found/i.test(message))
    return new HttpError(502, "Garmin a refusé l'identifiant ou le mot de passe, ou demande une double authentification.");
  if (/AccountLocked/i.test(message))
    return new HttpError(502, "Compte Garmin verrouillé : ouvre connect.garmin.com pour le débloquer.");
  if (/csrf/i.test(message)) return new HttpError(502, "La page de connexion Garmin a changé (csrf introuvable).");
  return new HttpError(502, `Connexion Garmin impossible (${status ?? message.slice(0, 80)})`);
}

let client: GC | null = null;
let loginPromise: Promise<GC> | null = null;

async function saveTokens(gc: GC) {
  const blob = encrypt(JSON.stringify(gc.exportToken()));
  await q(
    `INSERT INTO app_secrets (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [TOKEN_KEY, blob],
  );
}

const tokensSchema = z.object({
  oauth1: z.object({ oauth_token: z.string().min(1), oauth_token_secret: z.string().min(1) }).passthrough(),
  oauth2: z.object({ access_token: z.string().min(1), expires_at: z.number() }).passthrough(),
});
type Tokens = z.infer<typeof tokensSchema>;

/** GARMIN_TOKENS: base64url JSON printed by scripts/garmin-token.mjs. */
function envTokens(): Tokens | null {
  const raw = env().GARMIN_TOKENS?.trim();
  if (!raw) return null;
  try {
    const parsed = tokensSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  console.error("[garmin] GARMIN_TOKENS is not a valid token");
  return null;
}

const ENV_FP_KEY = "garmin_env_tokens_fp";
const fingerprint = (s: string) => crypto.createHash("sha256").update(s.trim()).digest("hex");

async function readSecret(key: string): Promise<string | null> {
  const { rows } = await q<{ value: string }>(`SELECT value FROM app_secrets WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

async function writeSecret(key: string, value: string) {
  await q(
    `INSERT INTO app_secrets (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

async function storedTokens(): Promise<Tokens | null> {
  const blob = await readSecret(TOKEN_KEY);
  if (!blob) return null;
  try {
    const parsed = tokensSchema.safeParse(JSON.parse(decrypt(blob)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function connect(): Promise<GC> {
  const e = env();
  const fromEnv = envTokens();
  const canLogin = Boolean(e.GARMIN_EMAIL && e.GARMIN_PASSWORD);
  if (!fromEnv && !canLogin) {
    throw new HttpError(503, "Garmin n'est pas configuré sur le serveur (GARMIN_TOKENS)");
  }
  const gc = new GarminConnect({ username: e.GARMIN_EMAIL ?? "", password: e.GARMIN_PASSWORD ?? "" });

  // A newly pasted GARMIN_TOKENS wins; otherwise the refreshed copy kept in the database.
  let tokens: Tokens | null = null;
  let envFp: string | null = null;
  if (fromEnv) {
    envFp = fingerprint(e.GARMIN_TOKENS!);
    if (envFp !== (await readSecret(ENV_FP_KEY))) tokens = fromEnv;
  }
  tokens ??= (await storedTokens()) ?? fromEnv;

  if (tokens) {
    try {
      gc.loadToken(tokens.oauth1, tokens.oauth2);
      await gc.get(`${API}/userprofile-service/socialProfile`);
      await saveTokens(gc); // keeps the refreshed access token
      if (envFp) await writeSecret(ENV_FP_KEY, envFp);
      return gc;
    } catch (err) {
      const status = statusOf(err);
      // Only a rejected token justifies signing in again; anything else (429, network) is temporary.
      if (status !== 401 && status !== 403) {
        console.error("[garmin] token check failed", { status });
        throw new HttpError(status === 429 ? 429 : 502, "Garmin est momentanément indisponible, réessaie plus tard.");
      }
      await q(`DELETE FROM app_secrets WHERE key = $1`, [TOKEN_KEY]);
      if (!canLogin) {
        throw new HttpError(503, "Le jeton Garmin a expiré : génère-en un nouveau (GARMIN_TOKENS).");
      }
    }
  }

  await assertNoCooldown();
  try {
    await gc.login();
  } catch (err) {
    throw await loginError(err);
  }
  await saveTokens(gc);
  return gc;
}

async function gc(): Promise<GC> {
  if (client) return client;
  loginPromise ??= connect().finally(() => (loginPromise = null));
  client = await loginPromise;
  return client;
}

/** Runs a call, signing in again once if the session was rejected. */
async function withGarmin<T>(fn: (g: GC) => Promise<T>): Promise<T> {
  try {
    const g = await gc();
    const r = await fn(g);
    await saveTokens(g).catch(() => undefined);
    return r;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const status = statusOf(err);
    if (status === 401 || status === 403) {
      client = null;
      await q(`DELETE FROM app_secrets WHERE key = $1`, [TOKEN_KEY]);
      return fn(await gc());
    }
    console.error("[garmin] request failed", { status });
    if (status === 429) throw new HttpError(429, "Garmin limite les requêtes, réessaie dans quelques minutes.");
    throw new HttpError(502, "Garmin a refusé la requête");
  }
}

export async function createWorkout(workout: unknown): Promise<string> {
  const r = await withGarmin((g) => g.post<{ workoutId: number }>(`${API}/workout-service/workout`, workout));
  if (!r?.workoutId) throw new HttpError(502, "Réponse Garmin inattendue");
  return String(r.workoutId);
}

export async function scheduleWorkout(workoutId: string, date: string): Promise<string | null> {
  const r = await withGarmin((g) =>
    g.post<{ workoutScheduleId?: number }>(
      `${API}/workout-service/schedule/${encodeURIComponent(workoutId)}`,
      { date },
    ),
  );
  return r?.workoutScheduleId ? String(r.workoutScheduleId) : null;
}

/** One page of the Garmin activity list, newest first (raw, untrusted). */
export async function listActivities(start: number, limit: number): Promise<unknown> {
  const qs = new URLSearchParams({ start: String(start), limit: String(limit) });
  return withGarmin((g) => g.get<unknown>(`${API}/activitylist-service/activities/search/activities?${qs}`));
}

/** Laps of one activity (raw, untrusted). */
export async function getSplits(activityId: string): Promise<unknown> {
  if (!/^\d+$/.test(activityId)) throw new HttpError(400, "Activité invalide");
  return withGarmin((g) => g.get<unknown>(`${API}/activity-service/activity/${activityId}/splits`));
}

/** Deleting the workout also removes it from the Garmin calendar. */
export async function deleteWorkout(workoutId: string): Promise<void> {
  if (!/^\d+$/.test(workoutId)) return;
  await withGarmin((g) => g.client.delete(`${API}/workout-service/workout/${workoutId}`)).catch(
    () => undefined,
  );
}

export const garminConfigured = () =>
  Boolean(env().GARMIN_TOKENS?.trim() || (env().GARMIN_EMAIL && env().GARMIN_PASSWORD));
