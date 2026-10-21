import { env } from "../env.js";
import { q } from "../db.js";
import { garminConfigured } from "./garminClient.js";
import { syncActivities } from "./progress.js";
import { runReminders } from "./push.js";

const MIN = 60_000;

/** Background work of the single server instance. Each job swallows its own errors. */
export function startBackgroundJobs() {
  const e = env();

  // Morning reminders.
  setInterval(() => {
    runReminders().catch((err) => console.error("[reminders]", err instanceof Error ? err.message : err));
  }, 5 * MIN).unref();

  // Keep the free Render instance awake: it sleeps after 15 min without inbound traffic,
  // and a request to its own public URL counts as inbound.
  const base = e.KEEP_ALIVE_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (base && e.NODE_ENV === "production") {
    const url = new URL("/api/health", base).toString();
    setInterval(() => {
      fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    }, 10 * MIN).unref();
  }

  // Garmin runs for admins every 3 h, so "done / not done" is fresh without opening Progrès.
  setInterval(() => {
    autoSync().catch((err) => console.error("[auto-sync]", err instanceof Error ? err.message : err));
  }, 30 * MIN).unref();
}

async function autoSync() {
  if (!garminConfigured()) return;
  const { rows } = await q<{ id: string }>(
    `SELECT id FROM users
      WHERE role = 'admin' AND password_hash IS NOT NULL
        AND (garmin_synced_at IS NULL OR garmin_synced_at < now() - interval '3 hours')`,
  );
  for (const { id } of rows) await syncActivities(id);
}
