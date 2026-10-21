/** Date helpers working on local calendar days as "YYYY-MM-DD". */

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function addDays(iso: string, n: number): string {
  const d = fromIso(iso);
  d.setDate(d.getDate() + n);
  return toIso(d);
}

export function mondayOf(iso: string): string {
  const d = fromIso(iso);
  const shift = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - shift);
  return toIso(d);
}

export const today = () => toIso(new Date());

export function nextMonday(): string {
  const m = mondayOf(today());
  return m === today() ? m : addDays(m, 7);
}

const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });
const longFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const shortFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

export const weekdayShort = (iso: string) => dayFmt.format(fromIso(iso)).replace(".", "");
export const longDate = (iso: string) => longFmt.format(fromIso(iso));
export const shortDate = (iso: string) => shortFmt.format(fromIso(iso)).replace(".", "");
export const dayNumber = (iso: string) => fromIso(iso).getDate();
