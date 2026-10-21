import { useCallback, useEffect, useRef, useState } from "react";
import { formatDuration, formatPace, type Progress as ProgressData } from "@shared/schemas";
import { api } from "../lib/api";
import { fromIso } from "../lib/dates";
import { useApp } from "../App";
import { Consistency, PaceTrend, WeeklyDistance, shortDay } from "../components/charts";
import { IconSync } from "../components/Icons";

const RANGES = [
  { weeks: 12, label: "12 semaines" },
  { weeks: 26, label: "6 mois" },
  { weeks: 52, label: "1 an" },
] as const;

const AUTO_SYNC_AFTER_MS = 3 * 3600_000;
const km1 = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const rel = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

function since(iso: string): string {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 60) return rel.format(-Math.max(min, 0), "minute");
  if (min < 48 * 60) return rel.format(-Math.round(min / 60), "hour");
  return rel.format(-Math.round(min / 1440), "day");
}

function hours(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
}

export function Progress() {
  const { toast } = useApp();
  const [weeks, setWeeks] = useState<number>(12);
  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const autoTried = useRef(false);

  const load = useCallback(
    (n: number) => {
      setLoading(true);
      return api
        .progress(n)
        .then(setData, (e: Error) => toast(e.message, true))
        .finally(() => setLoading(false));
    },
    [toast],
  );

  const sync = useCallback(
    async (quiet = false) => {
      setSyncing(true);
      try {
        const r = await api.syncProgress();
        if (!quiet) toast(r.added ? `${r.added} nouvelle${r.added > 1 ? "s" : ""} sortie${r.added > 1 ? "s" : ""} importée${r.added > 1 ? "s" : ""}` : "Sorties Garmin à jour");
        await load(weeks);
      } catch (e) {
        if (!quiet) toast((e as Error).message, true);
      } finally {
        setSyncing(false);
      }
    },
    [load, toast, weeks],
  );

  useEffect(() => {
    load(weeks);
  }, [load, weeks]);

  // Quiet catch-up sync when the data is a few hours old.
  useEffect(() => {
    if (!data || autoTried.current || !data.sync.canSync) return;
    autoTried.current = true;
    const last = data.sync.lastSyncAt ? Date.parse(data.sync.lastSyncAt) : 0;
    if (Date.now() - last > AUTO_SYNC_AFTER_MS) sync(true);
  }, [data, sync]);

  const current = data?.weeks.at(-1);
  const ratio = current && current.plannedKm > 0 ? Math.min(1, current.doneKm / current.plannedKm) : null;

  return (
    <div className={loading && data ? "refetching" : undefined}>
      <h1>Progression</h1>

      <div className="segmented" role="radiogroup" aria-label="Période">
        {RANGES.map((r) => (
          <button
            key={r.weeks}
            role="radio"
            aria-checked={weeks === r.weeks}
            className={weeks === r.weeks ? "on" : undefined}
            onClick={() => setWeeks(r.weeks)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {data?.sync.canSync && (
        <div className="sync-row">
          <span className="note">
            {data.sync.lastSyncAt ? `Sorties Garmin importées ${since(data.sync.lastSyncAt)}` : "Sorties Garmin pas encore importées"}
          </span>
          <button className={`btn ghost small${syncing ? " busy" : ""}`} disabled={syncing} onClick={() => sync()}>
            <IconSync /> {syncing ? "Import…" : "Synchroniser"}
          </button>
        </div>
      )}

      {!data && loading && <p className="note">Chargement…</p>}

      {data && current && (
        <>
          <section className="hero-week" aria-label="Cette semaine">
            <span className="hero-label">Cette semaine</span>
            <div className="hero-figure">
              <strong>{km1(current.doneKm)}</strong>
              <span>km</span>
            </div>
            {current.plannedKm > 0 && (
              <>
                <p className="note">sur {km1(current.plannedKm)} km prévus</p>
                <div
                  className="meter"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((ratio ?? 0) * 100)}
                  aria-label="Part du volume prévu réalisée"
                >
                  <i style={{ width: `${(ratio ?? 0) * 100}%` }} />
                </div>
              </>
            )}
            <div className="hero-stats num">
              <div>
                <strong>{hours(current.doneSec)}</strong>
                <span>de course</span>
              </div>
              <div>
                <strong>
                  {current.doneCount}
                  {current.plannedCount ? `/${current.plannedCount}` : ""}
                </strong>
                <span>{current.plannedCount ? "séances faites" : "sorties"}</span>
              </div>
              <div>
                <strong>{current.elevation} m</strong>
                <span>de dénivelé</span>
              </div>
            </div>
          </section>

          {!data.sync.hasActivities && (
            <div className="panel note">
              {data.sync.canSync
                ? "Aucune sortie importée pour l'instant. Touche Synchroniser pour récupérer tes courses Garmin ; en attendant, seul le volume prévu s'affiche."
                : "Les sorties Garmin s'importent sur le compte relié à la montre. Ici, seul le volume prévu s'affiche."}
            </div>
          )}

          <WeeklyDistance key={`d${weeks}`} weeks={data.weeks} />
          <PaceTrend key={`p${weeks}`} weeks={data.weeks} />
          {data.sync.hasActivities && <Consistency key={`c${weeks}`} weeks={data.weeks} days={data.days} />}

          {data.sync.hasActivities && (
            <section className="records" aria-label="Records de la période">
              <h2>Records de la période</h2>
              <div className="record-grid num">
                <div className="record">
                  <span>Plus longue sortie</span>
                  <strong>{data.records.longestKm ? `${km1(data.records.longestKm.value)} km` : "–"}</strong>
                  {data.records.longestKm && <small>{shortDay(data.records.longestKm.date)}</small>}
                </div>
                <div className="record">
                  <span>Meilleure allure, 5 km et plus</span>
                  <strong>{data.records.bestPaceSec ? `${formatPace(data.records.bestPaceSec.value)} /km` : "–"}</strong>
                  {data.records.bestPaceSec && <small>{shortDay(data.records.bestPaceSec.date)}</small>}
                </div>
                <div className="record">
                  <span>Plus grosse semaine</span>
                  <strong>{data.records.biggestWeekKm ? `${km1(data.records.biggestWeekKm.value)} km` : "–"}</strong>
                  {data.records.biggestWeekKm && <small>semaine du {shortDay(data.records.biggestWeekKm.date)}</small>}
                </div>
                <div className="record">
                  <span>Semaines d'affilée</span>
                  <strong>{data.records.streakWeeks}</strong>
                  <small>avec au moins une sortie</small>
                </div>
              </div>
            </section>
          )}

          {data.activities.length > 0 && (
            <section aria-label="Dernières sorties">
              <h2>Dernières sorties</h2>
              <ul className="runs">
                {data.activities.map((a) => (
                  <li key={a.id} className="run">
                    <div className="run-head">
                      <strong>{a.name}</strong>
                      <span className="note">
                        {dayFmt.format(fromIso(a.date)).replace(/\./g, "")}, {a.time}
                      </span>
                    </div>
                    <div className="run-stats num">
                      <div>
                        <strong>{km1(a.km)} km</strong>
                        <span>distance</span>
                      </div>
                      <div>
                        <strong>{a.paceSec ? formatPace(a.paceSec) : "–"}</strong>
                        <span>allure /km</span>
                      </div>
                      <div>
                        <strong>{formatDuration(a.durationSec)}</strong>
                        <span>durée</span>
                      </div>
                      {a.avgHr !== null && (
                        <div>
                          <strong>{a.avgHr}</strong>
                          <span>bpm moy.</span>
                        </div>
                      )}
                    </div>
                    {a.plannedTitle && <p className="run-plan">Prévu ce jour-là : {a.plannedTitle}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="data-table">
            <summary>Voir les données semaine par semaine</summary>
            <div className="table-scroll">
              <table className="num">
                <thead>
                  <tr>
                    <th scope="col">Semaine</th>
                    <th scope="col">Réalisé</th>
                    <th scope="col">Prévu</th>
                    <th scope="col">Sorties</th>
                    <th scope="col">Allure</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.weeks].reverse().map((w) => (
                    <tr key={w.monday}>
                      <th scope="row">{shortDay(w.monday)}</th>
                      <td>{km1(w.doneKm)} km</td>
                      <td>{w.plannedKm ? `${km1(w.plannedKm)} km` : "–"}</td>
                      <td>{w.doneCount}</td>
                      <td>{w.paceSec ? formatPace(w.paceSec) : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
