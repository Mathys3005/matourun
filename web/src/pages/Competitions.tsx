import { useCallback, useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { birthYears, categoryAt, categoryName, seasonYear } from "@shared/categories";
import { calendarPreviewSchema, type Competition } from "@shared/schemas";
import { api } from "../lib/api";
import { fromIso, today } from "../lib/dates";
import { useApp } from "../App";
import { IconCheck, IconFlag, IconPin } from "../components/Icons";

type View = "upcoming" | "mine" | "past";
type Preview = z.infer<typeof calendarPreviewSchema>;

const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
const dowFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });
const longFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

const daysUntil = (iso: string) => Math.round((fromIso(iso).getTime() - fromIso(today()).getTime()) / 86_400_000);
function countdown(start: string, end: string) {
  const d = daysUntil(start);
  if (d > 1) return `dans ${d} jours`;
  if (d === 1) return "demain";
  if (d === 0 || daysUntil(end) >= 0) return "aujourd'hui";
  return null;
}

/** Kind of event from its title, for a short label. */
function kindOf(title: string): string | null {
  const t = title.toLowerCase();
  if (t.includes("cross")) return "Cross";
  if (/salle|jesse owens/.test(t)) return "Salle";
  if (/lancer|combin|marche/.test(t)) return "Piste";
  if (/\bkm\b|\d\s?km|semi|marathon|foulées|tout court/.test(t)) return "Route";
  return null;
}

function dateRange(c: Competition) {
  const s = fromIso(c.startDate);
  if (c.endDate === c.startDate) return { day: String(s.getDate()), dow: dowFmt.format(s).replace(".", "") };
  return { day: `${s.getDate()}-${fromIso(c.endDate).getDate()}`, dow: "week-end" };
}

export function Competitions() {
  const { profile, setProfile, isAdmin, toast } = useApp();
  const [data, setData] = useState<{ birthDate: string | null; items: Competition[] } | null>(null);
  const [view, setView] = useState<View>("upcoming");
  const [birth, setBirth] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const load = useCallback(() => api.competitions().then(setData, (e: Error) => toast(e.message, true)), [toast]);
  useEffect(() => {
    load();
  }, [load]);

  const now = today();
  const myCategory = data?.birthDate ? categoryAt(data.birthDate, now) : null;
  const season = seasonYear(now);

  const lists = useMemo(() => {
    const items = data?.items ?? [];
    return {
      upcoming: items.filter((c) => c.endDate >= now),
      mine: items.filter((c) => c.going && c.endDate >= now),
      past: items.filter((c) => c.endDate < now).reverse(),
    };
  }, [data, now]);
  const next = lists.mine[0] ?? null;

  async function saveBirth() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birth)) return toast("Choisis ta date de naissance", true);
    setBusy("birth");
    try {
      setProfile(await api.saveProfile({ ...profile, birthDate: birth }));
      await load();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function toggle(c: Competition) {
    setBusy(c.id);
    setData((d) => d && { ...d, items: d.items.map((x) => (x.id === c.id ? { ...x, going: !c.going } : x)) });
    try {
      await api.setGoing(c.id, !c.going);
      toast(c.going ? "Retirée de tes courses" : `${c.title} ajoutée à tes courses`);
    } catch (e) {
      setData((d) => d && { ...d, items: d.items.map((x) => (x.id === c.id ? { ...x, going: c.going } : x)) });
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setBusy("import");
    try {
      setPreview(await api.importCalendar(file));
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  async function savePreview() {
    if (!preview) return;
    setBusy("save");
    try {
      const r = await api.saveCalendar(preview);
      toast(`Calendrier ${preview.season} enregistré : ${r.saved} épreuves`);
      setPreview(null);
      await load();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  }

  const shown = lists[view];
  const groups = useMemo(() => {
    const m = new Map<string, Competition[]>();
    for (const c of shown) {
      const key = c.startDate.slice(0, 7);
      m.set(key, [...(m.get(key) ?? []), c]);
    }
    return [...m.entries()];
  }, [shown]);

  return (
    <>
      <h1>Compétitions</h1>
      {myCategory ? (
        <p className="lede">
          Catégorie {categoryName(myCategory)}, saison {season - 1}-{season}. Le calendrier du club est filtré pour toi.
        </p>
      ) : (
        <p className="lede">Le calendrier du club, filtré sur ta catégorie FFA.</p>
      )}

      {data && !data.birthDate && (
        <section className="panel" style={{ marginTop: 18 }}>
          <h2>Ta date de naissance</h2>
          <p className="note" style={{ marginTop: 0 }}>
            La catégorie FFA dépend de l'année de naissance et change le 1er septembre. Par exemple, en {season} les
            Espoirs sont nés de {birthYears("ES", season)[0]} à {birthYears("ES", season)[1]}.
          </p>
          <div className="row">
            <input className="input" type="date" value={birth} max={now} onChange={(e) => setBirth(e.target.value)} aria-label="Date de naissance" />
            <button className="btn" style={{ flex: "none" }} disabled={busy === "birth" || !birth} onClick={saveBirth}>
              Valider
            </button>
          </div>
          {birth && /^\d{4}-\d{2}-\d{2}$/.test(birth) && (
            <p className="note">Tu seras en {categoryName(categoryAt(birth, now))} cette saison.</p>
          )}
        </section>
      )}

      {next && (
        <section className="race-hero" aria-label="Prochaine course">
          <span className="hero-label">Prochaine course</span>
          <strong className="race-hero-title">{next.title}</strong>
          <span className="race-hero-when">
            {countdown(next.startDate, next.endDate)}, {longFmt.format(fromIso(next.startDate))}
            {next.place ? `, ${next.place}` : ""}
          </span>
        </section>
      )}

      <div className="segmented" role="radiogroup" aria-label="Affichage">
        {(
          [
            ["upcoming", "À venir"],
            ["mine", "Mes courses"],
            ["past", "Passées"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : undefined} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>

      {data === null && <p className="note">Chargement…</p>}
      {data && !shown.length && (
        <div className="panel note">
          {view === "mine"
            ? "Aucune course choisie. Touche « J'y vais » sur une compétition pour la suivre ici, dans ta semaine et en notification le jour J."
            : view === "past"
              ? "Aucune compétition passée cette saison."
              : "Aucune compétition à venir pour ta catégorie dans le calendrier du club."}
        </div>
      )}

      {groups.map(([month, list]) => (
        <section key={month} className="race-month" aria-label={month}>
          <h2>{monthFmt.format(fromIso(`${month}-01`))}</h2>
          <ul className="races">
            {list.map((c) => {
              const d = dateRange(c);
              const kind = kindOf(c.title);
              const when = countdown(c.startDate, c.endDate);
              const past = c.endDate < now;
              return (
                <li key={c.id} className={`race${c.going ? " going" : ""}${past ? " past" : ""}`}>
                  <div className="race-date num" aria-hidden>
                    <strong>{d.day}</strong>
                    <span>{d.dow}</span>
                  </div>
                  <div className="race-body">
                    <strong className="race-title">{c.title}</strong>
                    <span className="race-meta">
                      {c.place && (
                        <span className="race-place">
                          <IconPin />
                          {c.place}
                        </span>
                      )}
                      {kind && <span className="race-tag">{kind}</span>}
                      {!past && when && <span className="race-when">{when}</span>}
                    </span>
                    {c.eligible === null && c.myCategory && (
                      <span className="race-warn">Catégories non précisées dans le calendrier</span>
                    )}
                  </div>
                  {!past && (
                    <button
                      className={`race-go${c.going ? " on" : ""}`}
                      aria-pressed={c.going}
                      aria-label={c.going ? `Ne plus aller à ${c.title}` : `J'y vais : ${c.title}`}
                      disabled={busy === c.id}
                      onClick={() => toggle(c)}
                    >
                      {c.going ? <IconCheck /> : <IconFlag />}
                      <span>{c.going ? "J'y vais" : "J'y vais ?"}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {isAdmin && (
        <section className="panel" style={{ marginTop: 28 }} aria-label="Importer un calendrier">
          <h2>Nouveau calendrier</h2>
          <p className="note" style={{ marginTop: 0 }}>
            Importe le fichier Word du club (tableau Date, Intitulé, Cat, Lieux). Les courses déjà cochées sont conservées.
          </p>
          {!preview ? (
            <label className="btn quiet block file-btn">
              <input
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={(e) => {
                  importFile(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
              {busy === "import" ? <span className="spinner" /> : "Choisir le fichier .docx"}
            </label>
          ) : (
            <div className="import-preview">
              <p className="note num" style={{ margin: 0 }}>
                Saison {preview.season} : {preview.rows.length} épreuves
                {data?.birthDate &&
                  `, dont ${preview.rows.filter((r) => r.categories === null || r.categories.includes(categoryAt(data.birthDate!, r.startDate))).length} pour ta catégorie`}
                {preview.skipped ? `. ${preview.skipped} ligne(s) ignorée(s) (date illisible).` : "."}
              </p>
              <button className="btn block" disabled={busy === "save"} onClick={savePreview}>
                {busy === "save" ? <span className="spinner" /> : `Remplacer la saison ${preview.season}`}
              </button>
              <button className="btn ghost block" onClick={() => setPreview(null)}>
                Annuler
              </button>
            </div>
          )}
        </section>
      )}
    </>
  );
}
