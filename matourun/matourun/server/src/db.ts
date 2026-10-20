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
  `CREATE TABLE IF NOT EXISTS app_secrets (
     key text PRIMARY KEY,
     value text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];

export async function migrate() {
  // gen_random_uuid() is built into PostgreSQL 13+.
  for (const m of MIGRATIONS) await q(m);
}
