import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import { hash, verify } from "@node-rs/argon2";
import { authStatusSchema, loginSchema, setupSchema, type Role } from "../../../shared/schemas.js";
import { env } from "../env.js";
import { q, tx } from "../db.js";
import { HttpError, asyncH, requireAuth, requireCsrf } from "../middleware/security.js";
import {
  ACCESS_TTL_SEC,
  REFRESH_COOKIE,
  clearAuthCookies,
  issueRefresh,
  revokeByRaw,
  rotateRefresh,
  safeEqual,
  setAuthCookies,
  signAccess,
} from "../lib/tokens.js";
import { bootstrapOpen, findUserByEmail, hashInvite } from "../lib/users.js";

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MAX_FAILS = 5;
const LOCK_MIN = 15;
// Verified against when the account does not exist, so timing doesn't reveal it.
const DUMMY_HASH = hash("matourun-dummy-password", ARGON);

const BAD_CREDENTIALS = "E-mail ou mot de passe incorrect";
const BAD_SETUP = "Code d'invitation invalide ou expiré";
/** Serializes the creation of the first account. */
const BOOTSTRAP_LOCK = 4_242_001;

/* Brute-force guard on the routes that check a secret (not on refresh/logout). */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: () => (env().NODE_ENV === "test" ? 500 : 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Trop de tentatives, réessaie dans quelques minutes" },
});

function sendSession(res: Response, user: { id: string; email: string; role: Role }, rt: string) {
  setAuthCookies(res, rt);
  res.json({
    accessToken: signAccess(user.id, user.email),
    expiresIn: ACCESS_TTL_SEC,
    email: user.email,
    role: user.role,
  });
}

export const authRouter = Router();

/** Tells the login screen whether to show "create password" for this e-mail. */
authRouter.post(
  "/status",
  authLimiter,
  asyncH(async (req, res) => {
    const { email } = authStatusSchema.parse(req.body);
    if (await bootstrapOpen()) return res.json({ needsSetup: Boolean(env().SETUP_CODE) });
    const user = await findUserByEmail(email);
    res.json({ needsSetup: Boolean(user && !user.password_hash) });
  }),
);

/**
 * First sign-in. Two cases:
 * - nobody has an account yet: SETUP_CODE (server secret) creates the first admin;
 * - otherwise: the e-mail must have been invited by an admin, with its one-time code.
 */
authRouter.post(
  "/setup",
  authLimiter,
  asyncH(async (req, res) => {
    const { email, password, setupCode } = setupSchema.parse(req.body);
    const passwordHash = await hash(password, ARGON);

    const user = await tx(async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock($1)`, [BOOTSTRAP_LOCK]);
      const { rows: open } = await c.query<{ open: boolean }>(
        `SELECT NOT EXISTS (SELECT 1 FROM users WHERE password_hash IS NOT NULL) AS open`,
      );

      if (open[0]?.open) {
        const code = env().SETUP_CODE;
        if (!code || !safeEqual(setupCode, code)) return null;
        const { rows } = await c.query<{ id: string; email: string; role: Role }>(
          `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')
           ON CONFLICT (email) DO UPDATE
             SET password_hash = EXCLUDED.password_hash, role = 'admin',
                 invite_hash = NULL, invite_expires_at = NULL
           RETURNING id, email, role`,
          [email, passwordHash],
        );
        return rows[0] ?? null;
      }

      // Invited user: the code must match, be unexpired, and is consumed atomically.
      const { rows } = await c.query<{ id: string; email: string; role: Role }>(
        `UPDATE users
            SET password_hash = $3, invite_hash = NULL, invite_expires_at = NULL
          WHERE email = $1 AND password_hash IS NULL
            AND invite_hash = $2 AND invite_expires_at > now()
          RETURNING id, email, role`,
        [email, hashInvite(setupCode), passwordHash],
      );
      return rows[0] ?? null;
    });

    if (!user) throw new HttpError(403, BAD_SETUP);
    sendSession(res, user, await issueRefresh(user.id));
  }),
);

authRouter.post(
  "/login",
  authLimiter,
  asyncH(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = await findUserByEmail(email);
    if (!user?.password_hash) {
      await verify(await DUMMY_HASH, password).catch(() => false);
      throw new HttpError(401, BAD_CREDENTIALS);
    }
    if (user.locked) throw new HttpError(429, "Compte verrouillé temporairement, réessaie plus tard");
    const ok = await verify(user.password_hash, password).catch(() => false);
    if (!ok) {
      await q(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2
                               THEN now() + make_interval(mins => $3) ELSE locked_until END
         WHERE id = $1`,
        [user.id, MAX_FAILS, LOCK_MIN],
      );
      throw new HttpError(401, BAD_CREDENTIALS);
    }
    await q(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    sendSession(res, user, await issueRefresh(user.id));
  }),
);

authRouter.post(
  "/refresh",
  requireCsrf,
  asyncH(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    const rotated = typeof raw === "string" && raw.length < 200 ? await rotateRefresh(raw) : null;
    if (!rotated) {
      clearAuthCookies(res);
      throw new HttpError(401, "Session expirée");
    }
    sendSession(res, { id: rotated.userId, email: rotated.email, role: rotated.role }, rotated.token);
  }),
);

authRouter.post(
  "/logout",
  requireCsrf,
  asyncH(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (typeof raw === "string" && raw.length < 200) await revokeByRaw(raw);
    clearAuthCookies(res);
    res.status(204).end();
  }),
);

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ email: req.user!.email, role: req.user!.role });
});
