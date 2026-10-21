import { z } from "zod";
import { estimate, type Progress, type ProgressWeek } from "../../../shared/schemas.js";
import { q, tx } from "../db.js";
import { getProfile, listSessions } from "./store.js";
import { listActivities } from "./garminClient.js";

/* ---------- Dates (calendar days as YYYY-MM-DD, in the runner's time zone) ---------- */

const TZ = "Europe/Paris";
const DAY = 86_400_000;

export function todayIso(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
const toMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (iso: string, n: number) => fromMs(toMs(iso) + n * DAY);
export function mondayOf(iso: string): string {
  const dow = (new Date(toMs(iso)).getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

/* ---------- Garmin sync ---------- */

/** Garmin's activity list is untrusted input: only well-formed runs are kept. */
const garminActivitySchema = z.object({
  activityId: z.number().int().positive(),
  activityName: z.string().max(300).nullish(),
  startTimeLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/),
  activityType: z.object({ typeKey: z.string().max(80) }),
  distance: z.number().nonnegative().nullish(),
  duration: z.number().nonnegative().nullish(),
  movingDuration: z.number().nonnegative().nullish(),
  averageHR: z.number().positive().max(260).nullish(),
  maxHR: z.number().positive().max(260).nullish(),
  elevationGain: z.number().nonnegative().nullish(),
  averageRunningCadenceInStepsPerMinute: z.number().nonnegative().nullish(),
});
type GarminActivity = z.infer<typeof garminActivitySchema>;

const PAGE = 100;
const MAX_PAGES = 10;
const FIRST_SYNC_DAYS = 370;

export async function syncActivities(userId: string): Promise<{ added: number; total: number; lastSyncAt: string }> {
  const { rows: last } = await q<{ last: string | null }>(
    `SELECT to_char(max(start_local), 'YYYY-MM-DD') AS last FROM activities WHERE user_id = $1`,
    [userId],
  );
  // Incremental: re-read the last few days (edits, late uploads), else one year back.
  const cutoff = last[0]?.last ? addDays(last[0].last, -3) : addDays(todayIso(), -FIRST_SYNC_DAYS);

  const runs: GarminActivity[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await listActivities(page * PAGE, PAGE);
    const list = Array.isArray(raw) ? raw : [];
    let reachedCutoff = false;
    for (const item of list) {
      const a = garminActivitySchema.safeParse(item);
      if (!a.success) continue;
      if (a.data.startTimeLocal.slice(0, 10) < cutoff) {
        reachedCutoff = true;
        continue;
      }
      if (/run/i.test(a.data.activityType.typeKey) && (a.data.distance ?? 0) > 0) runs.push(a.data);
    }
    if (reachedCutoff || list.length < PAGE) break;
  }

  const added = await tx(async (c) => {
    let inserted = 0;
    for (const a of runs) {
      const { rows } = await c.query<{ inserted: boolean }>(
        `INSERT INTO activities (user_id, garmin_id, name, type_key, start_local, distance_m, duration_s,
                                 moving_s, avg_hr, max_hr, elevation_m, cadence)
         VALUES ($1, $2, $3, $4, $5::timestamp, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (user_id, garmin_id) DO UPDATE SET
           name = EXCLUDED.name, type_key = EXCLUDED.type_key, start_local = EXCLUDED.start_local,
           distance_m = EXCLUDED.distance_m, duration_s = EXCLUDED.duration_s, moving_s = EXCLUDED.moving_s,
           avg_hr = EXCLUDED.avg_hr, max_hr = EXCLUDED.max_hr, elevation_m = EXCLUDED.elevation_m,
           cadence = EXCLUDED.cadence
         RETURNING (xmax = 0) AS inserted`,
        [
          userId,
          a.activityId,
          (a.activityName ?? "").slice(0, 120),
          a.activityType.typeKey,
          a.startTimeLocal.slice(0, 19).replace("T", " "),
          a.distance ?? 0,
          a.duration ?? 0,
          a.movingDuration ?? null,
          a.averageHR ?? null,
          a.maxHR ?? null,
          a.elevationGain ?? null,
          a.averageRunningCadenceInStepsPerMinute ?? null,
        ],
      );
      if (rows[0]?.inserted) inserted++;
    }
    return inserted;
  });

  const { rows } = await q<{ synced: Date; total: number }>(
    `UPDATE users SET garmin_synced_at = now() WHERE id = $1
     RETURNING garmin_synced_at AS synced,
               (SELECT count(*)::int FROM activities WHERE user_id = $1) AS total`,
    [userId],
  );
  return { added, total: rows[0]?.total ?? 0, lastSyncAt: rows[0]!.synced.toISOString() };
}

export async function lastSyncAt(userId: string): Promise<Date | null> {
  const { rows } = await q<{ synced: Date | null }>(`SELECT garmin_synced_at AS synced FROM users WHERE id = $1`, [userId]);
  return rows[0]?.synced ?? null;
}

/* ---------- Statistics ---------- */

interface Run {
  id: string;
  name: string;
  date: string;
  time: string;
  km: number;
  durationSec: number;
  movingSec: number;
  avgHr: number | null;
  elevation: number | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function computeProgress(
  userId: string,
  weeks: number,
  sync: { canSync: boolean },
): Promise<Progress> {
  const thisMonday = mondayOf(todayIso());
  const from = addDays(thisMonday, -(weeks - 1) * 7);
  const to = addDays(thisMonday, 6);
  const weekIndex = (date: string) => Math.floor((toMs(date) - toMs(from)) / (7 * DAY));

  const table: ProgressWeek[] = Array.from({ length: weeks }, (_, i) => ({
    monday: addDays(from, i * 7),
    plannedKm: 0,
    plannedSec: 0,
    plannedCount: 0,
    doneKm: 0,
    doneSec: 0,
    doneCount: 0,
    elevation: 0,
    paceSec: null,
  }));

  // Planned: MatouRun sessions, estimated with the runner's current paces.
  const [profile, sessions] = await Promise.all([getProfile(userId), listSessions(userId, from, to)]);
  const plannedByDate = new Map<string, string>();
  for (const s of sessions) {
    const w = table[weekIndex(s.date)];
    if (!w) continue;
    const e = estimate(profile, s.blocks);
    w.plannedKm += e.meters / 1000;
    w.plannedSec += e.seconds;
    w.plannedCount++;
    if (!plannedByDate.has(s.date)) plannedByDate.set(s.date, s.title);
  }

  // Done: synced Garmin runs.
  const { rows } = await q<{
    id: string;
    name: string;
    date: string;
    time: string;
    distance_m: number;
    duration_s: number;
    moving_s: number | null;
    avg_hr: number | null;
    elevation_m: number | null;
  }>(
    `SELECT garmin_id::text AS id, name, to_char(start_local, 'YYYY-MM-DD') AS date,
            to_char(start_local, 'HH24:MI') AS time, distance_m, duration_s, moving_s, avg_hr, elevation_m
       FROM activities
      WHERE user_id = $1 AND start_local >= $2::date AND start_local < ($3::date + 1)
      ORDER BY start_local DESC`,
    [userId, from, to],
  );
  const runs: Run[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    date: r.date,
    time: r.time,
    km: r.distance_m / 1000,
    durationSec: r.duration_s,
    movingSec: r.moving_s && r.moving_s > 0 ? r.moving_s : r.duration_s,
    avgHr: r.avg_hr ? Math.round(r.avg_hr) : null,
    elevation: r.elevation_m === null ? null : Math.round(r.elevation_m),
  }));

  const paceMoving = new Array<number>(weeks).fill(0);
  const days = new Map<string, number>();
  for (const r of runs) {
    const i = weekIndex(r.date);
    const w = table[i];
    if (!w) continue;
    w.doneKm += r.km;
    w.doneSec += r.durationSec;
    w.doneCount++;
    w.elevation += r.elevation ?? 0;
    paceMoving[i]! += r.movingSec;
    days.set(r.date, (days.get(r.date) ?? 0) + r.km);
  }
  table.forEach((w, i) => {
    w.paceSec = w.doneKm > 0.5 ? Math.round(paceMoving[i]! / w.doneKm) : null;
    w.plannedKm = round1(w.plannedKm);
    w.doneKm = round1(w.doneKm);
    w.plannedSec = Math.round(w.plannedSec);
    w.doneSec = Math.round(w.doneSec);
    w.elevation = Math.round(w.elevation);
  });

  // Records over the period.
  let longest: { value: number; date: string } | null = null;
  let bestPace: { value: number; date: string } | null = null;
  for (const r of runs) {
    if (!longest || r.km > longest.value) longest = { value: round1(r.km), date: r.date };
    const pace = r.movingSec / r.km;
    if (r.km >= 5 && (!bestPace || pace < bestPace.value)) bestPace = { value: Math.round(pace), date: r.date };
  }
  const biggest = table.reduce<ProgressWeek | null>((b, w) => (w.doneKm > (b?.doneKm ?? 0) ? w : b), null);
  // Consecutive weeks with at least one run, ending this week (or last week if this one is still empty).
  let streak = 0;
  let k = weeks - 1;
  if (table[k]?.doneCount === 0) k--;
  while (k >= 0 && table[k]!.doneCount > 0) {
    streak++;
    k--;
  }

  const { rows: any } = await q<{ has: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM activities WHERE user_id = $1) AS has`,
    [userId],
  );
  const synced = await lastSyncAt(userId);

  return {
    weeks: table,
    days: [...days.entries()].map(([date, km]) => ({ date, km: round1(km) })).sort((a, b) => a.date.localeCompare(b.date)),
    activities: runs.slice(0, 8).map((r) => ({
      id: r.id,
      name: r.name || "Course",
      date: r.date,
      time: r.time,
      km: round1(r.km),
      durationSec: Math.round(r.durationSec),
      paceSec: r.km > 0.2 ? Math.round(r.movingSec / r.km) : null,
      avgHr: r.avgHr,
      elevation: r.elevation,
      plannedTitle: plannedByDate.get(r.date) ?? null,
    })),
    records: {
      longestKm: longest,
      bestPaceSec: bestPace,
      biggestWeekKm: biggest ? { value: biggest.doneKm, date: biggest.monday } : null,
      streakWeeks: streak,
    },
    sync: { canSync: sync.canSync, lastSyncAt: synced?.toISOString() ?? null, hasActivities: any[0]?.has ?? false },
  };
}
