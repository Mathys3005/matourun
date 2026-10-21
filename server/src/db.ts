import pg from "pg";
import { env } from "./env.js";

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    const e = env();
    pool = new pg.Pool({
      connectionString: e.DATABASE_URL,
      ssl: e.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
      max: 5,
    });
  }
  return pool;
}

export async function closeDb() {
  await pool?.end();
  pool = null;
}

/**
 * Every query in the app goes through parameterized statements ($1, $2…);
 * no value is ever concatenated into SQL.
 */
export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return db().query<T>(text, params);
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     email text NOT NULL UNIQUE,
     password_hash text,
     failed_logins int NOT NULL DEFAULT 0,
     locked_until timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     family uuid NOT NULL,
     token_hash text NOT NULL UNIQUE,
     expires_at timestamptz NOT NULL,
     revoked_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family)`,
  `CREATE TABLE IF NOT EXISTS profiles (
     user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     data jsonb NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     date date NOT NULL,
     title text NOT NULL,
     description text NOT NULL DEFAULT '',
     blocks jsonb NOT NULL,
     garmin_workout_id text,
     garmin_schedule_id text,
     exported_at timestamptz,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_user_date_idx ON sessions(user_id, date)`,
  // Users allowed in the app live in the database (role + one-time invite code).
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_hash text`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'member'))`,
  // Accounts created before roles existed: the first ones become admins.
  `UPDATE users SET role = 'admin'
    WHERE password_hash IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
  // Running activities synced from Garmin, for the Progression tab.
  `CREATE TABLE IF NOT EXISTS activities (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     garmin_id bigint NOT NULL,
     name text NOT NULL DEFAULT '',
     type_key text NOT NULL,
     start_local timestamp NOT NULL,
     distance_m real NOT NULL,
     duration_s real NOT NULL,
     moving_s real,
     avg_hr real,
     max_hr real,
     elevation_m real,
     cadence real,
     PRIMARY KEY (user_id, garmin_id)
   )`,
  `CREATE INDEX IF NOT EXISTS activities_user_start_idx ON activities(user_id, start_local)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS garmin_synced_at timestamptz`,
  // Laps (splits) of each run: lets the Progression tab isolate the parts run at 5k/10k/... pace.
  `ALTER TABLE activities ADD COLUMN IF NOT EXISTS laps_synced boolean NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS activity_laps (
     user_id uuid NOT NULL,
     garmin_id bigint NOT NULL,
     lap_index int NOT NULL,
     distance_m real NOT NULL,
     moving_s real NOT NULL,
     avg_hr real,
     avg_cadence real,
     PRIMARY KEY (user_id, garmin_id, lap_index),
     FOREIGN KEY (user_id, garmin_id) REFERENCES activities(user_id, garmin_id) ON DELETE CASCADE
   )`,
  // Web push: one row per device, and each person's morning reminder.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     endpoint text NOT NULL UNIQUE,
     p256dh text NOT NULL,
     auth text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS reminders (
     user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     enabled boolean NOT NULL DEFAULT false,
     time text NOT NULL DEFAULT '07:30',
     last_sent date
   )`,
  // Club competition calendar (shared by everyone) and who goes where.
  `CREATE TABLE IF NOT EXISTS competitions (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     season text NOT NULL,
     start_date date NOT NULL,
     end_date date NOT NULL,
     title text NOT NULL,
     place text,
     categories text[],
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS competitions_date_idx ON competitions(start_date)`,
  `CREATE TABLE IF NOT EXISTS competition_entries (
     user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     competition_id uuid NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (user_id, competition_id)
   )`,
  `CREATE TABLE IF NOT EXISTS app_secrets (
     key text PRIMARY KEY,
     value text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/** Runs `fn` inside a transaction on a single connection. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate() {
  // gen_random_uuid() is built into PostgreSQL 13+.
  for (const m of MIGRATIONS) await q(m);
}
