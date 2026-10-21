import webpush from "web-push";
import { estimate, formatDuration } from "../../../shared/schemas.js";
import { env } from "../env.js";
import { q } from "../db.js";
import { open, seal } from "./secretBox.js";
import { getProfile, listSessions } from "./store.js";
import { todayIso } from "./progress.js";
import { goingBetween } from "./competitions.js";

/* Web push (VAPID). The key pair is generated once and kept encrypted in the database,
   so there is nothing to configure. */

const VAPID_KEY = "vapid_keys";
let vapid: { publicKey: string; privateKey: string } | null = null;

export async function vapidKeys() {
  if (vapid) return vapid;
  const { rows } = await q<{ value: string }>(`SELECT value FROM app_secrets WHERE key = $1`, [VAPID_KEY]);
  if (rows[0]) {
    vapid = JSON.parse(open("vapid", rows[0].value));
  } else {
    const generated = webpush.generateVAPIDKeys();
    // ON CONFLICT: two cold starts racing keep the first pair.
    await q(`INSERT INTO app_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [
      VAPID_KEY,
      seal("vapid", JSON.stringify(generated)),
    ]);
    const again = await q<{ value: string }>(`SELECT value FROM app_secrets WHERE key = $1`, [VAPID_KEY]);
    vapid = JSON.parse(open("vapid", again.rows[0]!.value));
  }
  return vapid!;
}

function subject() {
  const e = env();
  return e.APP_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? "https://matourun.onrender.com";
}

/** Push services browsers actually use. The server only ever posts to these hosts (no SSRF). */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /(^|\.)push\.apple\.com$/,
  /(^|\.)notify\.windows\.com$/,
];

export function isPushEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export async function saveSubscription(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
  await q(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth],
  );
}

export async function removeSubscription(userId: string, endpoint: string) {
  await q(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

/** Sends to every device of the user; drops subscriptions the push service says are gone. */
export async function sendToUser(userId: string, payload: PushPayload): Promise<number> {
  const keys = await vapidKeys();
  const { rows } = await q<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  );
  let sent = 0;
  for (const s of rows) {
    if (!isPushEndpoint(s.endpoint)) continue;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 6 * 3600 },
      );
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await removeSubscription(userId, s.endpoint);
      else console.error("[push] send failed", { status });
    }
  }
  return sent;
}

/* ---------- Morning reminders ---------- */

export async function getReminder(userId: string) {
  const { rows } = await q<{ enabled: boolean; time: string }>(
    `SELECT enabled, time FROM reminders WHERE user_id = $1`,
    [userId],
  );
  const { rows: subs } = await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  );
  return { enabled: rows[0]?.enabled ?? false, time: rows[0]?.time ?? "07:30", devices: subs[0]?.n ?? 0 };
}

export async function setReminder(userId: string, enabled: boolean, time: string) {
  await q(
    `INSERT INTO reminders (user_id, enabled, time) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, time = EXCLUDED.time`,
    [userId, enabled, time],
  );
}

const hhmmParis = (now: Date) =>
  new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Paris" })
    .format(now)
    .replace("h", ":");

/** Called every few minutes: sends "today's session" to people whose reminder time has passed. */
export async function runReminders(now = new Date()): Promise<number> {
  const today = todayIso(now);
  const time = hhmmParis(now);
  const { rows } = await q<{ user_id: string }>(
    `SELECT user_id FROM reminders
      WHERE enabled AND time <= $2 AND (last_sent IS NULL OR last_sent < $1::date)`,
    [today, time],
  );
  let sent = 0;
  for (const { user_id } of rows) {
    // Marked first: a crash mid-way never sends the same reminder twice.
    await q(`UPDATE reminders SET last_sent = $2::date WHERE user_id = $1`, [user_id, today]);
    const races = await goingBetween(user_id, today, today);
    if (races.length) {
      const r = races[0]!;
      sent += await sendToUser(user_id, {
        title: "Jour de compétition",
        body: `${r.title}${r.place ? `, ${r.place}` : ""}. Bonne course !`,
        url: "/competitions",
      });
      continue;
    }
    const sessions = await listSessions(user_id, today, today);
    if (!sessions.length) continue;
    const profile = await getProfile(user_id);
    const body = sessions
      .map((s) => {
        const e = estimate(profile, s.blocks);
        const parts = [e.seconds ? formatDuration(e.seconds) : "", e.meters ? `${(e.meters / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km` : ""].filter(Boolean);
        return parts.length ? `${s.title} (${parts.join(", ")})` : s.title;
      })
      .join(" + ");
    sent += await sendToUser(user_id, { title: "Séance du jour", body, url: "/" });
  }
  return sent;
}
