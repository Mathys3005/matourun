import { Router } from "express";
import rateLimit from "express-rate-limit";
import { progressQuerySchema } from "../../../shared/schemas.js";
import { asyncH, HttpError, requireAdmin } from "../middleware/security.js";
import { garminConfigured } from "../lib/garminClient.js";
import { computeProgress, lastSyncAt, syncActivities, syncLaps } from "../lib/progress.js";

/** The Garmin account belongs to the server, so only admins import its runs. */
const canSync = (role: string) => role === "admin" && garminConfigured();

const syncLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Trop de synchronisations, réessaie plus tard" },
});

export const progressRouter = Router();

progressRouter.get(
  "/",
  asyncH(async (req, res) => {
    const { weeks } = progressQuerySchema.parse(req.query);
    res.json(await computeProgress(req.user!.id, weeks, { canSync: canSync(req.user!.role) }));
  }),
);

progressRouter.post(
  "/sync",
  requireAdmin,
  syncLimiter,
  asyncH(async (req, res) => {
    if (!garminConfigured()) throw new HttpError(503, "Garmin n'est pas configuré sur le serveur");
    // A sync from less than 2 minutes ago is reused rather than hitting Garmin again.
    const last = await lastSyncAt(req.user!.id);
    if (last && Date.now() - last.getTime() < 2 * 60_000) {
      // Only continue importing the laps still missing.
      await syncLaps(req.user!.id);
      return res.json({ added: 0, total: -1, lastSyncAt: last.toISOString() });
    }
    res.json(await syncActivities(req.user!.id));
  }),
);
