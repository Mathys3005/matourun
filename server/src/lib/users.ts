import crypto from "node:crypto";
import type { AdminUser, Role } from "../../../shared/schemas.js";
import { q } from "../db.js";

export const INVITE_TTL_DAYS = 7;

/* Invite codes: 12 characters from an alphabet without look-alikes (0/O, 1/I/L),
   shown as XXXX-XXXX-XXXX. ~60 bits, single use, stored hashed, expire after 7 days. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function newInviteCode(): string {
  let raw = "";
  for (let i = 0; i < 12; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return raw.match(/.{4}/g)!.join("-");
}

/** Typing-tolerant: case, spaces and dashes don't matter. */
export function hashInvite(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return crypto.createHash("sha256").update(`invite:${normalized}`).digest("hex");
}

export interface UserRow {
  id: string;
  email: string;
  role: Role;
  password_hash: string | null;
  invite_hash: string | null;
  invite_valid: boolean;
  failed_logins: number;
  locked: boolean;
  created_at: Date;
}

const COLS = `id, email, role, password_hash, invite_hash, failed_logins, created_at,
              COALESCE(invite_expires_at > now(), false) AS invite_valid,
              COALESCE(locked_until > now(), false) AS locked`;

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await q<UserRow>(`SELECT ${COLS} FROM users WHERE email = $1`, [email]);
  return rows[0] ?? null;
}

/** True until the first account has a password: only then does SETUP_CODE work. */
export async function bootstrapOpen(): Promise<boolean> {
  const { rows } = await q<{ open: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM users WHERE password_hash IS NOT NULL) AS open`,
  );
  return rows[0]?.open ?? false;
}

export function toAdminUser(r: Pick<UserRow, "id" | "email" | "role" | "password_hash" | "invite_valid" | "created_at">): AdminUser {
  return {
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.password_hash ? "active" : r.invite_valid ? "invited" : "expired",
    createdAt: r.created_at.toISOString(),
  };
}

export async function listUsers(): Promise<AdminUser[]> {
  const { rows } = await q<UserRow>(`SELECT ${COLS} FROM users ORDER BY role, email`);
  return rows.map(toAdminUser);
}
