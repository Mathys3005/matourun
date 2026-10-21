import { z } from "zod";
import { CATEGORY_CODES } from "./categories.js";

/* ---------- Primitives ---------- */

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("E-mail invalide")
  .max(254);

export const passwordSchema = z
  .string()
  .min(12, "12 caractères minimum")
  .max(128, "128 caractères maximum");

/** Pace in seconds per km, between 2:00 and 12:00 /km. */
export const paceSecSchema = z.number().int().min(120).max(720);

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date au format AAAA-MM-JJ")
  .refine((s) => !Number.isNaN(Date.parse(s + "T00:00:00Z")), "Date invalide");

export const uuidSchema = z.string().uuid();

/* ---------- Auth ---------- */

export const authStatusSchema = z.object({ email: emailSchema });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const setupSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  setupCode: z.string().trim().min(1).max(200),
});

/* ---------- Users (admin) ---------- */

export const ROLES = ["admin", "member"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const meSchema = z.object({ email: z.string(), role: roleSchema });

export const createUserSchema = z.object({
  email: emailSchema,
  role: roleSchema.default("member"),
});

export const adminUserSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  role: roleSchema,
  status: z.enum(["active", "invited", "expired"]),
  createdAt: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const inviteSchema = z.object({
  user: adminUserSchema,
  inviteCode: z.string(),
  expiresAt: z.string(),
});

/* ---------- Profile ---------- */

export const PACE_REFS = ["5k", "10k", "hm", "m"] as const;
export const paceRefSchema = z.enum(PACE_REFS);
export type PaceRef = z.infer<typeof paceRefSchema>;

export const profileSchema = z
  .object({
    pace5k: paceSecSchema,
    pace10k: paceSecSchema,
    paceHm: paceSecSchema,
    paceM: paceSecSchema,
    easyFast: paceSecSchema,
    easySlow: paceSecSchema,
    toleranceSec: z.number().int().min(0).max(30),
    /** For the FFA category (Compétitions tab). */
    birthDate: isoDateSchema
      .refine((d) => d >= "1920-01-01" && d <= new Date().toISOString().slice(0, 10), "Date de naissance invalide")
      .nullable()
      .optional(),
  })
  .refine((p) => p.easyFast <= p.easySlow, {
    message: "L'allure footing rapide doit être plus rapide que la lente",
    path: ["easyFast"],
  });
export type Profile = z.infer<typeof profileSchema>;

export const DEFAULT_PROFILE: Profile = {
  pace5k: 225,
  pace10k: 235,
  paceHm: 250,
  paceM: 265,
  easyFast: 320,
  easySlow: 340,
  toleranceSec: 5,
};

/* ---------- Workout structure ---------- */

export const STEP_TYPES = ["warmup", "interval", "recovery", "rest", "cooldown"] as const;
export const stepTypeSchema = z.enum(STEP_TYPES);

export const endSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("time"), seconds: z.number().int().min(1).max(6 * 3600) }),
  z.object({ type: z.literal("distance"), meters: z.number().int().min(1).max(100_000) }),
  z.object({ type: z.literal("lap") }),
]);
export type StepEnd = z.infer<typeof endSchema>;

export const targetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  /** Easy-run range from the profile. */
  z.object({ type: z.literal("easy") }),
  /** Reference pace from the profile, plus an offset in s/km (positive = slower). */
  z.object({
    type: z.literal("pace"),
    ref: paceRefSchema,
    offsetSec: z.number().int().min(-60).max(180),
  }),
  /** Explicit pace range (seconds per km). */
  z.object({
    type: z.literal("range"),
    fastSec: paceSecSchema,
    slowSec: paceSecSchema,
  }),
]);
export type StepTarget = z.infer<typeof targetSchema>;

const noteSchema = z.string().trim().max(120).optional();

export const stepSchema = z.object({
  kind: z.literal("step"),
  type: stepTypeSchema,
  end: endSchema,
  target: targetSchema,
  note: noteSchema,
});
export type Step = z.infer<typeof stepSchema>;

export const repeatSchema = z.object({
  kind: z.literal("repeat"),
  times: z.number().int().min(1).max(50),
  steps: z.array(stepSchema).min(1).max(10),
});
export type Repeat = z.infer<typeof repeatSchema>;

export const blockSchema = z.discriminatedUnion("kind", [stepSchema, repeatSchema]);
export type Block = z.infer<typeof blockSchema>;

export const sessionInputSchema = z.object({
  date: isoDateSchema,
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  blocks: z.array(blockSchema).max(40),
});
export type SessionInput = z.infer<typeof sessionInputSchema>;

export const sessionSchema = sessionInputSchema.extend({
  id: uuidSchema,
  garminWorkoutId: z.string().nullable(),
  exportedAt: z.string().nullable(),
  updatedAt: z.string(),
});
export type Session = z.infer<typeof sessionSchema>;

/** Output of the screenshot reader before dates are attached. */
export const parsedSessionSchema = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  blocks: z.array(blockSchema).max(40),
});
export const parsedPlanSchema = z.object({
  sessions: z.array(parsedSessionSchema).min(1).max(14),
});
export type ParsedSession = z.infer<typeof parsedSessionSchema>;

export const importOptionsSchema = z.object({
  startDate: isoDateSchema,
  group: z.string().trim().max(40).default(""),
});

export const importTextSchema = z.object({
  text: z.string().trim().min(10, "Colle le message du club").max(4000, "Message trop long (4000 caractères max)"),
  startDate: isoDateSchema,
  group: z.string().trim().max(40).default(""),
});

export const saveImportSchema = z.object({
  sessions: z.array(sessionInputSchema).min(1).max(14),
});

export const weekQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema });

export const moveSessionSchema = z.object({ date: isoDateSchema });

export const dayRunSchema = z.object({
  id: z.string(),
  date: isoDateSchema,
  name: z.string(),
  km: z.number(),
  durationSec: z.number(),
  paceSec: z.number().nullable(),
  avgHr: z.number().nullable(),
});
export type DayRun = z.infer<typeof dayRunSchema>;
export const weekRunsSchema = z.object({ runs: z.array(dayRunSchema), hasActivities: z.boolean() });

export const exportWeekSchema = z.object({ from: isoDateSchema, to: isoDateSchema });

/* ---------- Helpers shared by both sides ---------- */

export function refPace(profile: Profile, ref: PaceRef): number {
  switch (ref) {
    case "5k":
      return profile.pace5k;
    case "10k":
      return profile.pace10k;
    case "hm":
      return profile.paceHm;
    case "m":
      return profile.paceM;
  }
}

/** Returns [fast, slow] pace in s/km for a target, or null when there is none. */
export function targetRange(profile: Profile, t: StepTarget): [number, number] | null {
  switch (t.type) {
    case "none":
      return null;
    case "easy":
      return [profile.easyFast, profile.easySlow];
    case "range":
      return [Math.min(t.fastSec, t.slowSec), Math.max(t.fastSec, t.slowSec)];
    case "pace": {
      const c = refPace(profile, t.ref) + t.offsetSec;
      return [c - profile.toleranceSec, c + profile.toleranceSec];
    }
  }
}

export function formatPace(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function parsePace(text: string): number | null {
  const m = /^\s*(\d{1,2})[:'’](\d{2})\s*$/.exec(text);
  if (!m) return null;
  const sec = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 ? sec : null;
}

export function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, "0")}`;
  if (!s) return `${m}'`;
  if (!m) return `${s}"`;
  return `${m}'${String(s).padStart(2, "0")}`;
}

const MID_EASY = (p: Profile) => (p.easyFast + p.easySlow) / 2;

/** Rough distance (m) and duration (s) estimate of a session, for display. */
export function estimate(profile: Profile, blocks: Block[]): { meters: number; seconds: number } {
  let meters = 0;
  let seconds = 0;
  const one = (s: Step) => {
    const r = targetRange(profile, s.target);
    const pace =
      r ? (r[0] + r[1]) / 2 : s.type === "recovery" || s.type === "rest" ? 0 : MID_EASY(profile);
    if (s.end.type === "time") {
      seconds += s.end.seconds;
      if (pace) meters += (s.end.seconds / pace) * 1000;
    } else if (s.end.type === "distance") {
      meters += s.end.meters;
      seconds += pace ? (s.end.meters / 1000) * pace : 0;
    }
  };
  for (const b of blocks) {
    if (b.kind === "step") one(b);
    else for (let i = 0; i < b.times; i++) b.steps.forEach(one);
  }
  return { meters: Math.round(meters), seconds: Math.round(seconds) };
}

/* ---------- Progression ---------- */

export const PROGRESS_RANGES = [12, 26, 52] as const;
export const progressQuerySchema = z.object({
  weeks: z.coerce.number().int().refine((n) => (PROGRESS_RANGES as readonly number[]).includes(n)).default(12),
});

export const progressWeekSchema = z.object({
  monday: isoDateSchema,
  plannedKm: z.number(),
  plannedSec: z.number(),
  plannedCount: z.number().int(),
  doneKm: z.number(),
  doneSec: z.number(),
  doneCount: z.number().int(),
  elevation: z.number(),
  /** Mean pace of the week's runs (s/km), null without runs. */
  paceSec: z.number().nullable(),
});
export type ProgressWeek = z.infer<typeof progressWeekSchema>;

export const progressActivitySchema = z.object({
  id: z.string(),
  name: z.string(),
  date: isoDateSchema,
  time: z.string(),
  km: z.number(),
  durationSec: z.number(),
  paceSec: z.number().nullable(),
  avgHr: z.number().nullable(),
  elevation: z.number().nullable(),
  plannedTitle: z.string().nullable(),
});
export type ProgressActivity = z.infer<typeof progressActivitySchema>;

const recordSchema = z.object({ value: z.number(), date: isoDateSchema }).nullable();

export const ZONE_KEYS = ["footing", "m", "hm", "10k", "5k"] as const;
const snapshotSchema = z
  .object({ paceSec: z.number(), hr: z.number().nullable(), cadence: z.number().nullable() })
  .nullable();
export const progressZoneSchema = z.object({
  key: z.enum(ZONE_KEYS),
  /** [fast, slow] s/km */
  range: z.tuple([z.number(), z.number()]),
  /** Same order as `weeks` of the progress response. */
  weeks: z.array(
    z.object({
      paceSec: z.number().nullable(),
      hr: z.number().nullable(),
      cadence: z.number().nullable(),
      minutes: z.number(),
    }),
  ),
  start: snapshotSchema,
  end: snapshotSchema,
  minutes: z.number(),
});
export type ProgressZone = z.infer<typeof progressZoneSchema>;

export const progressSchema = z.object({
  weeks: z.array(progressWeekSchema),
  days: z.array(z.object({ date: isoDateSchema, km: z.number() })),
  activities: z.array(progressActivitySchema),
  records: z.object({
    longestKm: recordSchema,
    bestPaceSec: recordSchema,
    biggestWeekKm: recordSchema,
    streakWeeks: z.number().int(),
  }),
  sync: z.object({ canSync: z.boolean(), lastSyncAt: z.string().nullable(), hasActivities: z.boolean() }),
  zones: z.array(progressZoneSchema),
  /** Runs whose laps are not imported yet (fetched a few dozen per sync). */
  lapsPending: z.number().int(),
  alerts: z.array(z.object({ kind: z.enum(["volume", "fatigue"]), title: z.string(), detail: z.string() })),
});
export type Progress = z.infer<typeof progressSchema>;

export const syncResultSchema = z.object({ added: z.number().int(), total: z.number().int(), lastSyncAt: z.string() });

/* ---------- Push & reminders ---------- */

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({
    p256dh: z.string().min(20).max(200),
    auth: z.string().min(8).max(100),
  }),
});
export const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) });
export const reminderSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure au format HH:MM"),
});
export const reminderStateSchema = reminderSchema.extend({ devices: z.number().int() });

/* ---------- Competitions ---------- */

export const competitionSchema = z.object({
  id: uuidSchema,
  season: z.string(),
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  title: z.string(),
  place: z.string().nullable(),
  categories: z.array(z.enum(CATEGORY_CODES)).nullable(),
  myCategory: z.enum(CATEGORY_CODES).nullable(),
  /** null: categories or birth date unknown. */
  eligible: z.boolean().nullable(),
  going: z.boolean(),
});
export type Competition = z.infer<typeof competitionSchema>;
export const competitionListSchema = z.object({ birthDate: isoDateSchema.nullable(), items: z.array(competitionSchema) });
export const goingSchema = z.object({ going: z.boolean() });

export const calendarRowSchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  title: z.string().trim().min(1).max(160),
  place: z.string().trim().max(80).nullable(),
  categories: z.array(z.enum(CATEGORY_CODES)).nullable(),
});
export const calendarPreviewSchema = z.object({
  season: z.string().regex(/^\d{4}-\d{4}$/),
  rows: z.array(calendarRowSchema),
  skipped: z.number().int(),
});
export const calendarSaveSchema = z.object({
  season: z.string().regex(/^\d{4}-\d{4}$/),
  rows: z.array(calendarRowSchema).min(1).max(300),
});
export const weekCompetitionsSchema = z.array(
  z.object({ id: uuidSchema, startDate: isoDateSchema, endDate: isoDateSchema, title: z.string(), place: z.string().nullable() }),
);
