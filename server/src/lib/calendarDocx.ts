import JSZip from "jszip";
import { parseCategoryCell, type CategoryCode } from "../../../shared/categories.js";
import { HttpError } from "../middleware/security.js";

/* Reads a club competition calendar written as a Word table:
   Date | Intitulé | Cat | Lieu (column order found from the header row).
   No AI: the table is read as is. The file is untrusted: size limits on the zip and
   on the XML, no entity expansion (plain regex over the text runs). */

export interface CalendarRow {
  startDate: string;
  endDate: string;
  title: string;
  place: string | null;
  categories: CategoryCode[] | null;
}

const MAX_XML_BYTES = 5 * 1024 * 1024;

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

function cellText(cellXml: string): string {
  const paragraphs = cellXml.split(/<\/w:p>/).map((p) =>
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] === undefined ? " " : decode(m[1]))).join(""),
  );
  return paragraphs
    .join(" ")
    .replace(/[ \s]+/g, " ")
    .trim();
}

function tables(xml: string): string[][][] {
  return [...xml.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>/g)].map((t) =>
    [...t[1]!.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
      [...r[0].matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((c) => cellText(c[1]!)),
    ),
  );
}

/** Season start year from a title like "saison 2026/2027" or "2026-27". */
export function seasonFromText(text: string): number | null {
  const m = /(20\d\d)\s*[/-]\s*(20)?(\d\d)/.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  return Number(m[3]) === (start + 1) % 100 ? start : null;
}

/** "25/10", "16-17/01", "06-07/02", "3/1" → ISO start and end dates. */
export function parseDateCell(cell: string, seasonStart: number): { start: string; end: string } | null {
  const m = /^(\d{1,2})(?:\s*[-–au]+\s*(\d{1,2}))?\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?$/.exec(cell.trim());
  if (!m) return null;
  const d1 = Number(m[1]);
  const d2 = m[2] ? Number(m[2]) : d1;
  const month = Number(m[3]);
  if (month < 1 || month > 12 || d1 < 1 || d2 < d1 || d2 > 31) return null;
  let year = month >= 8 ? seasonStart : seasonStart + 1;
  if (m[4]) year = m[4].length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
  const iso = (d: number) => {
    const date = new Date(Date.UTC(year, month - 1, d));
    return date.getUTCMonth() === month - 1 ? date.toISOString().slice(0, 10) : null;
  };
  const start = iso(d1);
  const end = iso(d2);
  return start && end ? { start, end } : null;
}

export async function readCalendarDocx(
  file: Buffer,
  fallbackSeasonStart: number,
): Promise<{ seasonStart: number; rows: CalendarRow[]; skipped: number }> {
  if (file.subarray(0, 4).toString("binary") !== "PK\u0003\u0004") throw new HttpError(415, "Ce n'est pas un fichier Word (.docx)");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new HttpError(415, "Fichier Word illisible");
  }
  const entry = zip.file("word/document.xml");
  const size = (entry as unknown as { _data?: { uncompressedSize?: number } })?._data?.uncompressedSize ?? 0;
  if (!entry || size > MAX_XML_BYTES) throw new HttpError(415, "Fichier Word illisible ou trop volumineux");
  const xml = await entry.async("string");
  if (xml.length > MAX_XML_BYTES) throw new HttpError(415, "Fichier Word trop volumineux");

  const bodyText = cellText(xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, ""));
  const seasonStart = seasonFromText(bodyText) ?? fallbackSeasonStart;

  for (const table of tables(xml)) {
    const headerIndex = table.findIndex((r) => r.some((c) => /^date/i.test(c)) && r.some((c) => /^cat/i.test(c)));
    if (headerIndex < 0) continue;
    const header = table[headerIndex]!.map((c) => c.toLowerCase());
    const col = {
      date: header.findIndex((c) => c.startsWith("date")),
      title: header.findIndex((c) => /intitul|épreuve|epreuve|nom|compétition|competition/.test(c)),
      cat: header.findIndex((c) => c.startsWith("cat")),
      place: header.findIndex((c) => /lieu|ville|endroit/.test(c)),
    };
    if (col.title < 0) continue;

    const rows: CalendarRow[] = [];
    let skipped = 0;
    for (const r of table.slice(headerIndex + 1)) {
      const title = (r[col.title] ?? "").trim();
      const dateCell = (r[col.date] ?? "").trim();
      if (!title && !dateCell) continue; // empty filler rows
      const dates = parseDateCell(dateCell, seasonStart);
      if (!dates || !title) {
        skipped++;
        continue;
      }
      const place = col.place >= 0 ? (r[col.place] ?? "").trim() : "";
      rows.push({
        startDate: dates.start,
        endDate: dates.end,
        title: title.slice(0, 160),
        place: place && place !== "?" ? place.slice(0, 80) : null,
        categories: col.cat >= 0 ? parseCategoryCell(r[col.cat] ?? "") : null,
      });
    }
    if (rows.length) return { seasonStart, rows, skipped };
  }
  throw new HttpError(422, "Aucun tableau Date / Intitulé / Catégorie trouvé dans ce fichier");
}
