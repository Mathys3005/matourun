import {
  estimate,
  formatDuration,
  formatPace,
  targetRange,
  type Block,
  type Profile,
  type Step,
} from "@shared/schemas";

export const STEP_LABELS: Record<Step["type"], string> = {
  warmup: "Échauffement",
  interval: "Course",
  recovery: "Récupération",
  rest: "Repos",
  cooldown: "Retour au calme",
};

export const REF_LABELS = { "5k": "5 km", "10k": "10 km", hm: "semi", m: "marathon" } as const;

export function endText(s: Step): string {
  if (s.end.type === "time") return formatDuration(s.end.seconds);
  if (s.end.type === "distance")
    return s.end.meters >= 1000 ? `${(s.end.meters / 1000).toLocaleString("fr-FR")} km` : `${s.end.meters} m`;
  return "jusqu'au Lap";
}

export function targetText(profile: Profile, s: Step): string {
  const r = targetRange(profile, s.target);
  if (!r) return s.type === "recovery" || s.type === "rest" ? "marche ou arrêt" : "sans cible";
  return `${formatPace(r[0])}–${formatPace(r[1])} /km`;
}

export function sessionSummary(profile: Profile, blocks: Block[]): string {
  const { meters, seconds } = estimate(profile, blocks);
  const parts: string[] = [];
  if (seconds) parts.push(formatDuration(seconds));
  if (meters) parts.push(`${(meters / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`);
  return parts.join(", ") || "Séance à compléter";
}

/** "mm:ss" (or minutes) → seconds. */
export function parseClock(text: string): number | null {
  const t = text.trim().replace(/['’]/g, ":").replace(/"$/, "");
  if (/^\d+$/.test(t)) return Number(t) * 60;
  const m = /^(\d{1,3}):(\d{1,2})$/.exec(t);
  if (!m || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
