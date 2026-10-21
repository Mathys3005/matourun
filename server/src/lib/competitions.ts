import { categoryAt, type CategoryCode } from "../../../shared/categories.js";
import type { Competition } from "../../../shared/schemas.js";
import { q, tx } from "../db.js";
import { getProfile } from "./store.js";
import type { CalendarRow } from "./calendarDocx.js";
import seed from "../data/competitions-2026-2027.json";

/** First start: loads the 2026-2027 club calendar if no calendar was ever imported. */
export async function seedCompetitions() {
  const { rows } = await q<{ n: number }>(`SELECT count(*)::int AS n FROM competitions`);
  if (rows[0]!.n > 0) return;
  await replaceSeason(seed.season, seed.rows as CalendarRow[]);
}

export async function replaceSeason(season: string, rows: CalendarRow[]): Promise<number> {
  return tx(async (c) => {
    // Entries on competitions that stay identical (same date and title) are kept.
    const { rows: old } = await c.query<{ id: string; start_date: string; title: string }>(
      `SELECT id, to_char(start_date, 'YYYY-MM-DD') AS start_date, title FROM competitions WHERE season = $1`,
      [season],
    );
    const keep = new Map(old.map((o) => [`${o.start_date}|${o.title}`, o.id]));
    const kept = new Set<string>();
    for (const r of rows) {
      const id = keep.get(`${r.startDate}|${r.title}`);
      if (id && !kept.has(id)) {
        kept.add(id);
        await c.query(`UPDATE competitions SET end_date = $2, place = $3, categories = $4 WHERE id = $1`, [
          id,
          r.endDate,
          r.place,
          r.categories,
        ]);
      } else {
        await c.query(
          `INSERT INTO competitions (season, start_date, end_date, title, place, categories) VALUES ($1, $2, $3, $4, $5, $6)`,
          [season, r.startDate, r.endDate, r.title, r.place, r.categories],
        );
      }
    }
    const removed = old.filter((o) => !kept.has(o.id)).map((o) => o.id);
    if (removed.length) await c.query(`DELETE FROM competitions WHERE id = ANY($1::uuid[])`, [removed]);
    return rows.length;
  });
}

interface Row {
  id: string;
  season: string;
  start_date: string;
  end_date: string;
  title: string;
  place: string | null;
  categories: CategoryCode[] | null;
  going: boolean;
}

/**
 * Competitions open to the runner: their FFA category is computed at each competition's date
 * (it can change with the season). Without a birth date, nothing is filtered.
 */
export async function listCompetitions(userId: string, opts: { all?: boolean } = {}): Promise<{
  birthDate: string | null;
  items: Competition[];
}> {
  const profile = await getProfile(userId);
  const birthDate = profile.birthDate ?? null;
  const { rows } = await q<Row>(
    `SELECT c.id, c.season, to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(c.end_date, 'YYYY-MM-DD') AS end_date, c.title, c.place, c.categories,
            (e.user_id IS NOT NULL) AS going
       FROM competitions c
       LEFT JOIN competition_entries e ON e.competition_id = c.id AND e.user_id = $1
      ORDER BY c.start_date, c.title`,
    [userId],
  );
  const items = rows
    .map((r) => {
      const category = birthDate ? categoryAt(birthDate, r.start_date) : null;
      return {
        id: r.id,
        season: r.season,
        startDate: r.start_date,
        endDate: r.end_date,
        title: r.title,
        place: r.place,
        categories: r.categories,
        myCategory: category,
        eligible: category === null ? null : r.categories === null ? null : r.categories.includes(category),
        going: r.going,
      };
    })
    .filter((c) => opts.all || c.eligible !== false);
  return { birthDate, items };
}

export async function setGoing(userId: string, competitionId: string, going: boolean): Promise<boolean> {
  const { rows } = await q(`SELECT 1 FROM competitions WHERE id = $1`, [competitionId]);
  if (!rows.length) return false;
  if (going) {
    await q(`INSERT INTO competition_entries (user_id, competition_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      userId,
      competitionId,
    ]);
  } else {
    await q(`DELETE FROM competition_entries WHERE user_id = $1 AND competition_id = $2`, [userId, competitionId]);
  }
  return true;
}

/** Competitions a runner goes to between two dates (for the week view and reminders). */
export async function goingBetween(userId: string, from: string, to: string) {
  const { rows } = await q<{ id: string; start_date: string; end_date: string; title: string; place: string | null }>(
    `SELECT c.id, to_char(c.start_date, 'YYYY-MM-DD') AS start_date, to_char(c.end_date, 'YYYY-MM-DD') AS end_date,
            c.title, c.place
       FROM competitions c JOIN competition_entries e ON e.competition_id = c.id AND e.user_id = $1
      WHERE c.end_date >= $2::date AND c.start_date <= $3::date
      ORDER BY c.start_date`,
    [userId, from, to],
  );
  return rows.map((r) => ({ id: r.id, startDate: r.start_date, endDate: r.end_date, title: r.title, place: r.place }));
}
