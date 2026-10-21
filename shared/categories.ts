/* FFA age categories (athle.fr). A season runs from 1 September to 31 August and is
   named after the year it ends in; the category depends only on the birth year:
   age = seasonYear - birthYear. Example, season 2027: Espoirs = born 2005 to 2007. */

export const CATEGORIES = [
  { code: "BB", name: "Baby Athlé", min: 0, max: 6 },
  { code: "EA", name: "Éveil Athlétique", min: 7, max: 9 },
  { code: "PO", name: "Poussins (U12)", min: 10, max: 11 },
  { code: "BE", name: "Benjamins (U14)", min: 12, max: 13 },
  { code: "MI", name: "Minimes (U16)", min: 14, max: 15 },
  { code: "CA", name: "Cadets (U18)", min: 16, max: 17 },
  { code: "JU", name: "Juniors (U20)", min: 18, max: 19 },
  { code: "ES", name: "Espoirs (U23)", min: 20, max: 22 },
  { code: "SE", name: "Seniors", min: 23, max: 34 },
  { code: "MA", name: "Masters", min: 35, max: 200 },
] as const;

export type CategoryCode = (typeof CATEGORIES)[number]["code"];
export const CATEGORY_CODES = CATEGORIES.map((c) => c.code) as unknown as readonly [CategoryCode, ...CategoryCode[]];

/** Season year of a date (YYYY-MM-DD): from September on, it's next year's season. */
export function seasonYear(isoDate: string): number {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7));
  return m >= 9 ? y + 1 : y;
}

export function categoryAt(birthDate: string, onDate: string): CategoryCode {
  const age = seasonYear(onDate) - Number(birthDate.slice(0, 4));
  return (CATEGORIES.find((c) => age >= c.min && age <= c.max) ?? CATEGORIES[0]).code;
}

export const categoryName = (code: CategoryCode) => CATEGORIES.find((c) => c.code === code)?.name ?? code;

/** Birth years of a category for a season, e.g. ES in 2027 -> [2005, 2007]. */
export function birthYears(code: CategoryCode, season: number): [number, number] {
  const c = CATEGORIES.find((x) => x.code === code)!;
  return [season - Math.min(c.max, 120), season - c.min];
}

/**
 * Club calendars write categories as glued letters: "CJESMa", "EA,P,B,M", "BMCJESMa", "Toutes".
 * Longest tokens first so "EA" (éveils) isn't read as "E" (espoirs) and "Ma" isn't "M".
 * Returns null when the cell is empty (categories not given).
 */
const TOKENS: Array<[string, CategoryCode]> = [
  ["EA", "EA"],
  ["PO", "PO"],
  ["Ma", "MA"],
  ["BB", "BB"],
  ["P", "PO"],
  ["B", "BE"],
  ["M", "MI"],
  ["C", "CA"],
  ["J", "JU"],
  ["E", "ES"],
  ["S", "SE"],
];

export function parseCategoryCell(cell: string): CategoryCode[] | null {
  const text = cell.replace(/\s+/g, "");
  if (!text) return null;
  if (/^tou(te)?s$/i.test(text)) return CATEGORIES.map((c) => c.code);
  const out = new Set<CategoryCode>();
  let i = 0;
  while (i < text.length) {
    if (/[,;/+&-]/.test(text[i]!)) {
      i++;
      continue;
    }
    const tok = TOKENS.find(([t]) => text.startsWith(t, i));
    if (!tok) return null; // unknown notation: keep the competition, flagged as "not specified"
    out.add(tok[1]);
    i += tok[0].length;
  }
  return out.size ? [...out] : null;
}
