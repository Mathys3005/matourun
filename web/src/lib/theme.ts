export const THEMES = [
  { id: "violet", name: "Violet nuit", colors: ["#160e24", "#8a6cf0", "#ffffff"], bar: "#160e24" },
  { id: "ocean", name: "Océan", colors: ["#0b1626", "#4a86e8", "#c77d34"], bar: "#0b1626" },
  { id: "foret", name: "Forêt", colors: ["#0e1a14", "#34a874", "#9b7be8"], bar: "#0e1a14" },
  { id: "braise", name: "Braise", colors: ["#1c0f0d", "#e0694a", "#27a3b6"], bar: "#1c0f0d" },
  { id: "clair", name: "Clair", colors: ["#f5f2fb", "#6a52c4", "#008a9e"], bar: "#1f1533" },
] as const;
export type ThemeId = (typeof THEMES)[number]["id"];

const KEY = "mr_theme";

export function currentTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY);
    if (THEMES.some((x) => x.id === t)) return t as ThemeId;
  } catch {
    /* storage unavailable */
  }
  return "violet";
}

/** Per-device choice (a phone and a computer can differ). */
export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  if (id === "violet") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", id);
  const t = THEMES.find((x) => x.id === id)!;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.bar);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable: applies for this visit only */
  }
}
