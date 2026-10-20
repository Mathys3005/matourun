import { Router } from "express";
import rateLimit from "express-rate-limit";
import { hash, verify } from "@node-rs/argon2";
import { authStatusSchema, loginSchema, setupSchema } from "../../../shared/schemas.js";
import { env } from "../env.js";
import { q } from "../db.js";
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

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const MAX_FAILS = 5;
const LOCK_MIN = 15;
// Verified against when the account does not exist, so timing doesn't reveal it.
const DUMMY_HASH = hash("matourun-dummy-password", ARGON);

const BAD_CREDENTIALS = "E-mail ou mot de passe incorrect";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Trop de tentatives, réessaie dans quelques minutes" },
});

const isAuthorized = (email: string) => env().AUTHORIZED_EMAILS.includes(email);

async function findUser(email: string) {
  const { rows } = await q<{
    id: string;
    email: string;
    password_hash: string | null;
    failed_logins: number;
    locked: boolean;
  }>(
    `SELECT id, email, password_hash, failed_logins,
            COALESCE(locked_until > now(), false) AS locked
       FROM users WHERE email = $1`,
    [email],
  );
  return rows[0] ?? null;
}

function sendSession(res: import("express").Response, user: { id: string; email: string }, rt: string) {
  setAuthCookies(res, rt);
  res.json({ accessToken: signAccess(user.id, user.email), expiresIn: ACCESS_TTL_SEC, email: user.email });
}

export const authRouter = Router();

authRouter.use(authLimiter);

/** Tells the login screen whether to show "create password" for this e-mail. */
authRouter.post(
  "/status",
  asyncH(async (req, res) => {
    const { email } = authStatusSchema.parse(req.body);
    if (!isAuthorized(email)) return res.json({ needsSetup: false });
    const user = await findUser(email);
    res.json({ needsSetup: !user?.password_hash });
  }),
);

authRouter.post(
  "/setup",
  asyncH(async (req, res) => {
    const { email, password, setupCode } = setupSchema.parse(req.body);
    if (!isAuthorized(email) || !safeEqual(setupCode, env().SETUP_CODE)) {
      throw new HttpError(403, "Code de configuration ou e-mail invalide");
    }
    const passwordHash = await hash(password, ARGON);
    // Only sets a password when none exists yet (atomic).
    const { rows } = await q<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
         WHERE users.password_hash IS NULL
       RETURNING id, email`,
      [email, passwordHash],
    );
    const user = rows[0];
    if (!user) throw new HttpError(409, "Un mot de passe existe déjà pour ce compte");
    sendSession(res, user, await issueRefresh(user.id));
  }),
);

authRouter.post(
  "/login",
  asyncH(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const user = isAuthorized(email) ? await findUser(email) : null;
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
    sendSession(res, { id: rotated.userId, email: rotated.email }, rotated.token);
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
  res.json({ email: req.user!.email });
});
