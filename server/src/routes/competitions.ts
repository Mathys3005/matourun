import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { calendarSaveSchema, goingSchema, uuidSchema } from "../../../shared/schemas.js";
import { asyncH, HttpError, requireAdmin } from "../middleware/security.js";
import { listCompetitions, replaceSeason, setGoing } from "../lib/competitions.js";
import { readCalendarDocx } from "../lib/calendarDocx.js";
import { todayIso } from "../lib/progress.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 2 } });
const importLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Trop d'imports, réessaie plus tard" },
});

export const competitionsRouter = Router();

competitionsRouter.get(
  "/",
  asyncH(async (req, res) => {
    res.json(await listCompetitions(req.user!.id, { all: req.query.all === "1" }));
  }),
);

competitionsRouter.put(
  "/:id/going",
  asyncH(async (req, res) => {
    const id = uuidSchema.parse(req.params.id);
    const { going } = goingSchema.parse(req.body);
    if (!(await setGoing(req.user!.id, id, going))) throw new HttpError(404, "Compétition introuvable");
    res.status(204).end();
  }),
);

/** Admin: reads a new club calendar (.docx) and returns a preview; nothing is saved yet. */
competitionsRouter.post(
  "/import",
  requireAdmin,
  importLimiter,
  upload.single("file"),
  asyncH(async (req, res) => {
    if (!req.file) throw new HttpError(400, "Aucun fichier reçu");
    const today = todayIso();
    const currentSeasonStart = Number(today.slice(5, 7)) >= 8 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1;
    const { seasonStart, rows, skipped } = await readCalendarDocx(req.file.buffer, currentSeasonStart);
    res.json({ season: `${seasonStart}-${seasonStart + 1}`, rows, skipped });
  }),
);

/** Admin: replaces one season's calendar (entries on unchanged competitions are kept). */
competitionsRouter.post(
  "/save",
  requireAdmin,
  asyncH(async (req, res) => {
    const { season, rows } = calendarSaveSchema.parse(req.body);
    res.json({ saved: await replaceSeason(season, rows) });
  }),
);
