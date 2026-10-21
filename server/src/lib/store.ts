import {
  DEFAULT_PROFILE,
  blockSchema,
  profileSchema,
  type Profile,
  type Session,
  type SessionInput,
} from "../../../shared/schemas.js";
import { z } from "zod";
import { q } from "../db.js";

export async function getProfile(userId: string): Promise<Profile> {
  const { rows } = await q<{ data: unknown }>(`SELECT data FROM profiles WHERE user_id = $1`, [userId]);
  const parsed = profileSchema.safeParse(rows[0]?.data);
  return parsed.success ? parsed.data : DEFAULT_PROFILE;
}

export async function saveProfile(userId: string, p: Profile) {
  await q(
    `INSERT INTO profiles (user_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [userId, JSON.stringify(p)],
  );
}

interface Row {
  id: string;
  date: string;
  title: string;
  description: string;
  blocks: unknown;
  garmin_workout_id: string | null;
  exported_at: Date | null;
  updated_at: Date;
}

const COLS = `id, to_char(date, 'YYYY-MM-DD') AS date, title, description, blocks,
              garmin_workout_id, exported_at, updated_at`;

function toSession(r: Row): Session {
  return {
    id: r.id,
    date: r.date,
    title: r.title,
    description: r.description,
    // Data comes from our own validated writes, but re-validate on the way out.
    blocks: z.array(blockSchema).catch([]).parse(r.blocks),
    garminWorkoutId: r.garmin_workout_id,
    exportedAt: r.exported_at?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}

export async function listSessions(userId: string, from: string, to: string): Promise<Session[]> {
  const { rows } = await q<Row>(
    `SELECT ${COLS} FROM sessions WHERE user_id = $1 AND date BETWEEN $2 AND $3
     ORDER BY date, updated_at`,
    [userId, from, to],
  );
  return rows.map(toSession);
}

export async function getSession(userId: string, id: string): Promise<Session | null> {
  const { rows } = await q<Row>(`SELECT ${COLS} FROM sessions WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rows[0] ? toSession(rows[0]) : null;
}

export async function createSession(userId: string, s: SessionInput): Promise<Session> {
  const { rows } = await q<Row>(
    `INSERT INTO sessions (user_id, date, title, description, blocks)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [userId, s.date, s.title, s.description, JSON.stringify(s.blocks)],
  );
  return toSession(rows[0]!);
}

/** Editing a session invalidates its Garmin export (it must be sent again). */
export async function updateSession(userId: string, id: string, s: SessionInput): Promise<Session | null> {
  const { rows } = await q<Row>(
    `UPDATE sessions SET date = $3, title = $4, description = $5, blocks = $6,
            exported_at = NULL, updated_at = now()
      WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`,
    [userId, id, s.date, s.title, s.description, JSON.stringify(s.blocks)],
  );
  return rows[0] ? toSession(rows[0]) : null;
}

/** Moves a session to another day; its Garmin export is kept (rescheduled by the caller). */
export async function moveSession(userId: string, id: string, date: string) {
  const { rows } = await q<Row & { garmin_schedule_id: string | null }>(
    `UPDATE sessions SET date = $3, updated_at = now()
      WHERE user_id = $1 AND id = $2 RETURNING ${COLS}, garmin_schedule_id`,
    [userId, id, date],
  );
  const r = rows[0];
  return r ? { session: toSession(r), scheduleId: r.garmin_schedule_id } : null;
}

export async function clearExport(userId: string, id: string) {
  await q(`UPDATE sessions SET exported_at = NULL WHERE user_id = $1 AND id = $2`, [userId, id]);
}

export async function deleteSession(userId: string, id: string) {
  const { rows } = await q<{ garmin_workout_id: string | null }>(
    `DELETE FROM sessions WHERE user_id = $1 AND id = $2 RETURNING garmin_workout_id`,
    [userId, id],
  );
  return rows[0] ?? null;
}

export async function markExported(userId: string, id: string, workoutId: string, scheduleId: string | null) {
  await q(
    `UPDATE sessions SET garmin_workout_id = $3, garmin_schedule_id = $4, exported_at = now()
      WHERE user_id = $1 AND id = $2`,
    [userId, id, workoutId, scheduleId],
  );
}

export async function getGarminIds(userId: string, id: string) {
  const { rows } = await q<{ garmin_workout_id: string | null; garmin_schedule_id: string | null }>(
    `SELECT garmin_workout_id, garmin_schedule_id FROM sessions WHERE user_id = $1 AND id = $2`,
    [userId, id],
  );
  return rows[0] ?? null;
}
