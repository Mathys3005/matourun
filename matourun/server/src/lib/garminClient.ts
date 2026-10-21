import crypto from "node:crypto";
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

/** Turns a sign-in failure into a precise message, and logs the details for Render's logs. */
function loginError(err: unknown): HttpError {
  const e = err as { message?: string; response?: { status?: number; data?: unknown } };
  const status = e?.response?.status;
  const message = e?.message ?? String(err);
  const body = typeof e?.response?.data === "string" ? e.response.data.slice(0, 200) : "";
  console.error("[garmin] login failed", { status, message, body });
  if (status === 429)
    return new HttpError(502, "Garmin limite les connexions depuis le serveur (429). Réessaie dans une heure.");
  if (status === 403)
    return new HttpError(502, "Garmin bloque les connexions depuis le serveur (403).");
  if (/MFA|Ticket not found/i.test(message))
    return new HttpError(502, "Garmin a refusé l'identifiant ou le mot de passe, ou demande une double authentification.");
  if (/AccountLocked/i.test(message))
    return new HttpError(502, "Compte Garmin verrouillé : ouvre connect.garmin.com pour le débloquer.");
  if (/csrf/i.test(message))
    return new HttpError(502, "La page de connexion Garmin a changé (csrf introuvable).");
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

async function connect(): Promise<GC> {
  const e = env();
  if (!e.GARMIN_EMAIL || !e.GARMIN_PASSWORD) {
    throw new HttpError(503, "Identifiants Garmin non configurés sur le serveur");
  }
  const gc = new GarminConnect({ username: e.GARMIN_EMAIL, password: e.GARMIN_PASSWORD });
  const { rows } = await q<{ value: string }>(`SELECT value FROM app_secrets WHERE key = $1`, [TOKEN_KEY]);
  if (rows[0]) {
    try {
      const t = JSON.parse(decrypt(rows[0].value)) as { oauth1: unknown; oauth2: unknown };
      gc.loadToken(t.oauth1, t.oauth2);
      await gc.get(`${API}/userprofile-service/socialProfile`);
      return gc;
    } catch {
      // Tokens unusable: fall through to a fresh sign-in.
    }
  }
  try {
    await gc.login();
  } catch (err) {
    throw loginError(err);
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
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 401 || status === 403) {
      client = null;
      await q(`DELETE FROM app_secrets WHERE key = $1`, [TOKEN_KEY]);
      return fn(await gc());
    }
    if (err instanceof HttpError) throw err;
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

/** Deleting the workout also removes it from the Garmin calendar. */
export async function deleteWorkout(workoutId: string): Promise<void> {
  if (!/^\d+$/.test(workoutId)) return;
  await withGarmin((g) => g.client.delete(`${API}/workout-service/workout/${workoutId}`)).catch(
    () => undefined,
  );
}

export const garminConfigured = () => Boolean(env().GARMIN_EMAIL && env().GARMIN_PASSWORD);
