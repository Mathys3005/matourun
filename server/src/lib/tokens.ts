import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response, CookieOptions } from "express";
import { env } from "../env.js";
import { q } from "../db.js";
import type { Role } from "../../../shared/schemas.js";

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 3600;
const ISSUER = "matourun";
const AUDIENCE = "matourun-web";

export const REFRESH_COOKIE = "mr_rt";
export const CSRF_COOKIE = "mr_csrf";

export interface AccessClaims {
  sub: string;
  email: string;
}

export function signAccess(userId: string, email: string): string {
  return jwt.sign({ email }, env().JWT_SECRET, {
    algorithm: "HS256",
    subject: userId,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ACCESS_TTL_SEC,
  });
}

export function verifyAccess(token: string): AccessClaims | null {
  try {
    const p = jwt.verify(token, env().JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof p !== "object" || typeof p.sub !== "string" || typeof p.email !== "string") return null;
    return { sub: p.sub, email: p.email };
  } catch {
    return null;
  }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function issueRefresh(userId: string, family?: string): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  await q(
    `INSERT INTO refresh_tokens (user_id, family, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [userId, family ?? crypto.randomUUID(), sha256(raw), REFRESH_TTL_SEC],
  );
  return raw;
}

/**
 * Rotates a refresh token. A token that was already used revokes its whole
 * family (a stolen token being replayed), and the caller must sign in again.
 */
export async function rotateRefresh(
  raw: string,
): Promise<{ userId: string; email: string; role: Role; token: string } | null> {
  const { rows } = await q<{
    id: string;
    user_id: string;
    family: string;
    revoked_at: Date | null;
    expired: boolean;
    email: string;
    role: Role;
    has_password: boolean;
  }>(
    `SELECT t.id, t.user_id, t.family, t.revoked_at, t.expires_at < now() AS expired,
            u.email, u.role, u.password_hash IS NOT NULL AS has_password
       FROM refresh_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1`,
    [sha256(raw)],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) {
    await revokeFamily(row.family);
    return null;
  }
  if (row.expired) return null;
  if (!row.has_password) {
    await revokeFamily(row.family);
    return null;
  }
  const upd = await q(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [row.id],
  );
  if (upd.rowCount !== 1) {
    // Lost a race with a concurrent rotation of the same token.
    await revokeFamily(row.family);
    return null;
  }
  const token = await issueRefresh(row.user_id, row.family);
  return { userId: row.user_id, email: row.email, role: row.role, token };
}

export async function revokeFamily(family: string) {
  await q(`UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL`, [
    family,
  ]);
}

export async function revokeByRaw(raw: string) {
  const { rows } = await q<{ family: string }>(
    `SELECT family FROM refresh_tokens WHERE token_hash = $1`,
    [sha256(raw)],
  );
  if (rows[0]) await revokeFamily(rows[0].family);
}

function baseCookie(): CookieOptions {
  return { secure: env().NODE_ENV === "production", sameSite: "strict" };
}

export function setAuthCookies(res: Response, refreshToken: string) {
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie(),
    httpOnly: true,
    path: "/api/auth",
    maxAge: REFRESH_TTL_SEC * 1000,
  });
  // Double-submit CSRF token: readable by our JS, echoed in a header.
  res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString("base64url"), {
    ...baseCookie(),
    httpOnly: false,
    path: "/",
    maxAge: REFRESH_TTL_SEC * 1000,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie(), httpOnly: true, path: "/api/auth" });
  res.clearCookie(CSRF_COOKIE, { ...baseCookie(), path: "/" });
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
