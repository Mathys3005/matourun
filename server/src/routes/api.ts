import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import {
  exportWeekSchema,
  importOptionsSchema,
  importTextSchema,
  moveSessionSchema,
  profileSchema,
  saveImportSchema,
  sessionInputSchema,
  uuidSchema,
  weekQuerySchema,
} from "../../../shared/schemas.js";
import { HttpError, asyncH, requireAuth } from "../middleware/security.js";
import * as store from "../lib/store.js";
import { parsePlanImage, parsePlanText, sniffImage } from "../lib/parsePlan.js";
import { buildGarminWorkout } from "../lib/garminWorkout.js";
import * as garmin from "../lib/garminClient.js";
import { adminRouter } from "./admin.js";
import { progressRouter } from "./progress.js";
import { pushRouter } from "./push.js";
import { listRuns } from "../lib/progress.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 },
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Trop de requêtes, réessaie plus tard" },
});

const MAX_RANGE_DAYS = 62;
function checkRange(from: string, to: string) {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days < 0 || days > MAX_RANGE_DAYS) throw new HttpError(400, "Période invalide");
}

export const apiRouter = Router();
apiRouter.use(requireAuth);
apiRouter.use("/admin", adminRouter);
apiRouter.use("/progress", progressRouter);
apiRouter.use("/push", pushRouter);

apiRouter.get("/config", (_req, res) => {
  res.json({ garmin: garmin.garminConfigured() });
});

/* ---------- Profile ---------- */

apiRouter.get(
  "/profile",
  asyncH(async (req, res) => res.json(await store.getProfile(req.user!.id))),
);

apiRouter.put(
  "/profile",
  asyncH(async (req, res) => {
    const p = profileSchema.parse(req.body);
    await store.saveProfile(req.user!.id, p);
    res.json(p);
  }),
);

/* ---------- Sessions ---------- */

apiRouter.get(
  "/sessions",
  asyncH(async (req, res) => {
    const { from, to } = weekQuerySchema.parse(req.query);
    checkRange(from, to);
    res.json(await store.listSessions(req.user!.id, from, to));
  }),
);

apiRouter.get(
  "/sessions/:id",
  asyncH(async (req, res) => {
    const s = await store.getSession(req.user!.id, uuidSchema.parse(req.params.id));
    if (!s) throw new HttpError(404, "Séance introuvable");
    res.json(s);
  }),
);

apiRouter.post(
  "/sessions",
  asyncH(async (req, res) => {
    res.status(201).json(await store.createSession(req.user!.id, sessionInputSchema.parse(req.body)));
  }),
);

apiRouter.put(
  "/sessions/:id",
  asyncH(async (req, res) => {
    const s = await store.updateSession(
      req.user!.id,
      uuidSchema.parse(req.params.id),
      sessionInputSchema.parse(req.body),
    );
    if (!s) throw new HttpError(404, "Séance introuvable");
    res.json(s);
  }),
);

/** Moves a session to another day (drag and drop), and its Garmin calendar entry with it. */
apiRouter.patch(
  "/sessions/:id/date",
  asyncH(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const { date } = moveSessionSchema.parse(req.body);
    const before = await store.getGarminIds(req.user!.id, id);
    const moved = await store.moveSession(req.user!.id, id, date);
    if (!moved) throw new HttpError(404, "Séance introuvable");
    let garminStatus: "none" | "moved" | "failed" = "none";
    if (before?.garmin_workout_id && moved.session.exportedAt && garmin.garminConfigured()) {
      try {
        const scheduleId = await garmin.rescheduleWorkout(before.garmin_workout_id, moved.scheduleId, date);
        await store.markExported(req.user!.id, id, before.garmin_workout_id, scheduleId);
        garminStatus = "moved";
      } catch {
        await store.clearExport(req.user!.id, id);
        garminStatus = "failed";
      }
    }
    res.json({ session: await store.getSession(req.user!.id, id), garmin: garminStatus });
  }),
);

apiRouter.get(
  "/runs",
  asyncH(async (req, res) => {
    const { from, to } = weekQuerySchema.parse(req.query);
    checkRange(from, to);
    res.json(await listRuns(req.user!.id, from, to));
  }),
);

apiRouter.delete(
  "/sessions/:id",
  asyncH(async (req, res) => {
    const deleted = await store.deleteSession(req.user!.id, uuidSchema.parse(req.params.id));
    if (!deleted) throw new HttpError(404, "Séance introuvable");
    if (deleted.garmin_workout_id && garmin.garminConfigured()) {
      await garmin.deleteWorkout(deleted.garmin_workout_id);
    }
    res.status(204).end();
  }),
);

/* ---------- Screenshot import ---------- */

apiRouter.post(
  "/import/parse",
  heavyLimiter,
  upload.single("image"),
  asyncH(async (req, res) => {
    const opts = importOptionsSchema.parse(req.body);
    if (!req.file) throw new HttpError(400, "Aucune image reçue");
    const mime = sniffImage(req.file.buffer);
    if (!mime) throw new HttpError(415, "Format d'image non pris en charge (JPEG, PNG ou WebP)");
    const sessions = await parsePlanImage(req.file.buffer, mime, opts.group);
    // Default: one session per day from the start date; the user can move them.
    const start = Date.parse(opts.startDate + "T00:00:00Z");
    res.json({
      sessions: sessions.map((s, i) => ({
        ...s,
        date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      })),
    });
  }),
);

apiRouter.post(
  "/import/parse-text",
  heavyLimiter,
  asyncH(async (req, res) => {
    const opts = importTextSchema.parse(req.body);
    const sessions = await parsePlanText(opts.text, opts.group);
    const start = Date.parse(opts.startDate + "T00:00:00Z");
    res.json({
      sessions: sessions.map((s, i) => ({
        ...s,
        date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      })),
    });
  }),
);

apiRouter.post(
  "/import/save",
  asyncH(async (req, res) => {
    const { sessions } = saveImportSchema.parse(req.body);
    const created = [];
    for (const s of sessions) created.push(await store.createSession(req.user!.id, s));
    res.status(201).json(created);
  }),
);

/* ---------- Garmin export ---------- */

async function exportOne(userId: string, id: string) {
  const session = await store.getSession(userId, id);
  if (!session) throw new HttpError(404, "Séance introuvable");
  if (!session.blocks.length) throw new HttpError(400, "Séance vide");
  const profile = await store.getProfile(userId);
  const ids = await store.getGarminIds(userId, id);
  if (ids?.garmin_workout_id) await garmin.deleteWorkout(ids.garmin_workout_id);
  const workoutId = await garmin.createWorkout(buildGarminWorkout(profile, session));
  const scheduleId = await garmin.scheduleWorkout(workoutId, session.date);
  await store.markExported(userId, id, workoutId, scheduleId);
  return { id, workoutId, date: session.date };
}

apiRouter.post(
  "/sessions/:id/export",
  heavyLimiter,
  asyncH(async (req, res) => {
    res.json(await exportOne(req.user!.id, uuidSchema.parse(req.params.id)));
  }),
);

apiRouter.post(
  "/export/week",
  heavyLimiter,
  asyncH(async (req, res) => {
    const { from, to } = exportWeekSchema.parse(req.body);
    checkRange(from, to);
    const sessions = await store.listSessions(req.user!.id, from, to);
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const s of sessions) {
      try {
        await exportOne(req.user!.id, s.id);
        results.push({ id: s.id, ok: true });
      } catch (err) {
        results.push({ id: s.id, ok: false, error: err instanceof HttpError ? err.message : "Erreur" });
        // Garmin unavailable or rate-limiting: stop, the other sessions would fail the same way.
        if (err instanceof HttpError && [429, 502, 503, 504].includes(err.status)) break;
      }
    }
    res.json({ results });
  }),
);
