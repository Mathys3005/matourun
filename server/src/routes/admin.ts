import { Router } from "express";
import { createUserSchema, uuidSchema } from "../../../shared/schemas.js";
import { q } from "../db.js";
import { HttpError, asyncH, requireAdmin } from "../middleware/security.js";
import {
  INVITE_TTL_DAYS,
  hashInvite,
  listUsers,
  newInviteCode,
  toAdminUser,
  type UserRow,
} from "../lib/users.js";

/** Mounted under the authenticated API: every route here also requires the admin role. */
export const adminRouter = Router();
adminRouter.use(requireAdmin);

const RETURNING = `RETURNING id, email, role, password_hash, created_at,
                   COALESCE(invite_expires_at > now(), false) AS invite_valid, invite_expires_at`;

type InviteRow = UserRow & { invite_expires_at: Date };

function inviteResponse(row: InviteRow, code: string) {
  return { user: toAdminUser(row), inviteCode: code, expiresAt: row.invite_expires_at.toISOString() };
}

adminRouter.get(
  "/users",
  asyncH(async (_req, res) => res.json(await listUsers())),
);

/** Authorizes an e-mail and returns its one-time invite code (shown only once). */
adminRouter.post(
  "/users",
  asyncH(async (req, res) => {
    const { email, role } = createUserSchema.parse(req.body);
    const code = newInviteCode();
    const { rows } = await q<InviteRow>(
      `INSERT INTO users (email, role, invite_hash, invite_expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))
       ON CONFLICT (email) DO UPDATE
         SET role = EXCLUDED.role, invite_hash = EXCLUDED.invite_hash,
             invite_expires_at = EXCLUDED.invite_expires_at
         WHERE users.password_hash IS NULL
       ${RETURNING}`,
      [email, role, hashInvite(code), INVITE_TTL_DAYS],
    );
    if (!rows[0]) throw new HttpError(409, "Cette personne a déjà un compte");
    res.status(201).json(inviteResponse(rows[0], code));
  }),
);

/** New code for someone who hasn't created their password yet. */
adminRouter.post(
  "/users/:id/invite",
  asyncH(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const code = newInviteCode();
    const { rows } = await q<InviteRow>(
      `UPDATE users SET invite_hash = $2, invite_expires_at = now() + make_interval(days => $3)
        WHERE id = $1 AND password_hash IS NULL
       ${RETURNING}`,
      [id, hashInvite(code), INVITE_TTL_DAYS],
    );
    if (!rows[0]) throw new HttpError(409, "Ce compte est déjà actif");
    res.json(inviteResponse(rows[0], code));
  }),
);

/** Removes access immediately (sessions, profile and refresh tokens are deleted with it). */
adminRouter.delete(
  "/users/:id",
  asyncH(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    if (id === req.user!.id) throw new HttpError(400, "Tu ne peux pas retirer ton propre accès");
    const { rowCount } = await q(`DELETE FROM users WHERE id = $1`, [id]);
    if (!rowCount) throw new HttpError(404, "Utilisateur introuvable");
    res.status(204).end();
  }),
);
