import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { estimate, formatPace, isoDateSchema, type DayRun, type Session } from "@shared/schemas";
import { api } from "../lib/api";
import { addDays, dayNumber, mondayOf, shortDate, today, weekdayShort } from "../lib/dates";
import { sessionSummary } from "../lib/describe";
import { useApp } from "../App";
import { ProfileBar } from "../components/ProfileBar";
import { IconCheck, IconFlag, IconLeft, IconRight, IconSync, IconWatch } from "../components/Icons";
import { useDragToDay } from "../lib/useDragToDay";

const km1 = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const runText = (r: DayRun) => `${km1(r.km)} km${r.paceSec ? ` à ${formatPace(r.paceSec)} /km` : ""}`;

export function Week() {
  const params = useParams();
  const navigate = useNavigate();
  const { profile, garmin, toast } = useApp();
  const monday = mondayOf(isoDateSchema.safeParse(params.monday).success ? params.monday! : today());
  const sunday = addDays(monday, 6);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);

  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [races, setRaces] = useState<Array<{ id: string; startDate: string; endDate: string; title: string; place: string | null }>>([]);
  const [runs, setRuns] = useState<{ runs: DayRun[]; hasActivities: boolean }>({ runs: [], hasActivities: false });
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [weekBusy, setWeekBusy] = useState(false);

  const load = useCallback(() => {
    api.sessions(monday, sunday).then(setSessions, (e: Error) => {
      setSessions([]);
      toast(e.message, true);
    });
    api.runs(monday, sunday).then(setRuns, () => undefined);
    api.weekCompetitions(monday, sunday).then(setRaces, () => undefined);
  }, [monday, sunday, toast]);

  const move = useCallback(
    async (id: string, day: string) => {
      const before = sessions;
      setSessions((list) => list?.map((x) => (x.id === id ? { ...x, date: day } : x)) ?? list);
      try {
        const r = await api.moveSession(id, day);
        setSessions((list) => list?.map((x) => (x.id === id ? r.session : x)) ?? list);
        if (r.garmin === "moved") toast("Séance déplacée, calendrier Garmin mis à jour");
        else if (r.garmin === "failed") toast("Séance déplacée. Garmin n'a pas suivi : renvoie-la sur la montre", true);
        else toast("Séance déplacée");
        if (day < monday || day > sunday) load();
      } catch (e) {
        setSessions(before);
        toast((e as Error).message, true);
      }
    },
    [sessions, toast, load, monday, sunday],
  );
  const { drag, bind } = useDragToDay(move);

  useEffect(() => {
    setSessions(null);
    load();
  }, [load]);

  const totals = useMemo(() => {
    const all = sessions ?? [];
    const e = all.reduce(
      (acc, s) => {
        const x = estimate(profile, s.blocks);
        return { m: acc.m + x.meters, s: acc.s + x.seconds };
      },
      { m: 0, s: 0 },
    );
    return { count: all.length, km: e.m / 1000, hours: e.s / 3600, exported: all.filter((s) => s.exportedAt).length };
  }, [sessions, profile]);

  async function exportOne(s: Session) {
    setBusy((b) => new Set(b).add(s.id));
    try {
      await api.exportSession(s.id);
      toast(`${s.title} : envoyée sur Garmin`);
      load();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(s.id);
        return n;
      });
    }
  }

  async function exportWeek() {
    setWeekBusy(true);
    try {
      const { results } = await api.exportWeek(monday, sunday);
      const ok = results.filter((r) => r.ok).length;
      const failed = results.find((r) => !r.ok);
      toast(failed ? `${ok}/${totals.count} envoyées. ${failed.error ?? ""}` : `${ok} séances envoyées sur Garmin`, !!failed);
      load();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setWeekBusy(false);
    }
  }

  const go = (n: number) => navigate(`/semaine/${addDays(monday, n * 7)}`);

  return (
    <>
      <div className="week-head">
        <div>
          <h1 className="num">
            {shortDate(monday)} – {shortDate(sunday)}
          </h1>
          {monday !== mondayOf(today()) && (
            <button className="btn ghost small" style={{ marginTop: 10 }} onClick={() => navigate("/")}>
              Revenir à cette semaine
            </button>
          )}
        </div>
        <div className="week-nav">
          <button className="icon-btn" aria-label="Semaine précédente" onClick={() => go(-1)}>
            <IconLeft />
          </button>
          <button className="icon-btn" aria-label="Semaine suivante" onClick={() => go(1)}>
            <IconRight />
          </button>
        </div>
      </div>

      <div className="week-stats num">
        <div className="stat">
          <strong>{totals.km.toLocaleString("fr-FR", { maximumFractionDigits: 1 })}</strong>
          <span>km prévus</span>
        </div>
        {runs.hasActivities ? (
          <div className="stat">
            <strong>{km1(runs.runs.reduce((t, r) => t + r.km, 0))}</strong>
            <span>km faits</span>
          </div>
        ) : (
          <div className="stat">
            <strong>{totals.hours.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} h</strong>
            <span>de course</span>
          </div>
        )}
        <div className="stat">
          <strong>
            {totals.exported}/{totals.count}
          </strong>
          <span>sur la montre</span>
        </div>
      </div>

      {!garmin && (
        <p className="panel note">L'export Garmin n'est pas encore configuré sur le serveur (identifiants Garmin manquants).</p>
      )}

      {!!totals.count && <p className="note drag-hint">Appui long sur une séance pour la déplacer.</p>}

      <div className={`days${drag ? " dragging" : ""}`}>
        {days.map((d) => {
          const list = (sessions ?? []).filter((s) => s.date === d);
          const dayRuns = runs.runs.filter((r) => r.date === d);
          // Runs are matched to the day's sessions in order; extra runs are "free" runs.
          const extra = dayRuns.slice(list.length);
          const past = d < today();
          const dayRaces = races.filter((r) => r.startDate <= d && r.endDate >= d);
          return (
            <section
              key={d}
              data-day={d}
              className={`day${d === today() ? " today" : ""}${drag?.overDay === d && drag.fromDay !== d ? " drop" : ""}`}
              aria-label={d}
            >
              <div className="day-spine num">
                <small>{weekdayShort(d)}</small>
                <strong>{dayNumber(d)}</strong>
              </div>
              <div className="day-body">
                {sessions === null && <div className="day-empty">…</div>}
                {dayRaces.map((r) => (
                  <Link key={r.id} to="/competitions" className="race-chip">
                    <IconFlag />
                    <span>
                      <strong>{r.title}</strong>
                      {r.place ? ` ${r.place}` : ""}
                    </span>
                  </Link>
                ))}
                {sessions !== null && !list.length && !dayRuns.length && !dayRaces.length && (
                  <Link className="day-empty" to={`/nouvelle/${d}`}>
                    {drag ? "Déposer ici" : "Repos. Ajouter une séance"}
                  </Link>
                )}
                {list.map((s, i) => {
                  const isBusy = busy.has(s.id);
                  const run = dayRuns[i];
                  const isDragged = drag?.id === s.id;
                  return (
                    <article
                      key={s.id}
                      className={`card${isDragged ? " lifted" : ""}${run ? " is-done" : ""}`}
                      style={isDragged ? { transform: `translateY(${drag!.dy}px)` } : undefined}
                      {...bind(s.id, s.date)}
                    >
                      <div className="card-top">
                        <Link className="card-title" to={`/seance/${s.id}`} draggable={false}>
                          <strong>{s.title}</strong>
                          <span className="num">{sessionSummary(profile, s.blocks)}</span>
                        </Link>
                        <button
                          className={`icon-btn export-btn${s.exportedAt ? " done" : ""}${isBusy ? " busy" : ""}`}
                          aria-label={s.exportedAt ? `Renvoyer ${s.title} sur la montre` : `Envoyer ${s.title} sur la montre`}
                          title={s.exportedAt ? "Sur la montre. Toucher pour renvoyer" : "Envoyer sur la montre"}
                          disabled={isBusy || weekBusy || !garmin}
                          onClick={() => exportOne(s)}
                        >
                          {isBusy ? <IconSync /> : s.exportedAt ? <IconCheck /> : <IconWatch />}
                        </button>
                      </div>
                      <ProfileBar profile={profile} blocks={s.blocks} />
                      {run ? (
                        <p className="card-status done num">
                          <IconCheck /> Faite : {runText(run)}
                          {run.avgHr ? `, ${run.avgHr} bpm` : ""}
                        </p>
                      ) : past && runs.hasActivities ? (
                        <p className="card-status missed">Non faite</p>
                      ) : null}
                    </article>
                  );
                })}
                {extra.map((r) => (
                  <div key={r.id} className="free-run num">
                    <IconCheck />
                    <span>
                      <strong>{r.name}</strong> {runText(r)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {!!totals.count && (
        <div className="week-cta">
          <button className="btn" disabled={weekBusy || !garmin} onClick={exportWeek}>
            {weekBusy ? <span className="spinner" /> : <IconWatch />}
            {weekBusy ? "Envoi en cours…" : "Exporter toute la semaine"}
          </button>
        </div>
      )}
      {sessions !== null && !totals.count && (
        <div className="panel" style={{ marginTop: 18 }}>
          <h2>Semaine vide</h2>
          <p className="note">Importe la capture du plan de ton club pour remplir la semaine.</p>
          <Link className="btn" to="/importer">
            Importer une capture
          </Link>
        </div>
      )}
    </>
  );
}
