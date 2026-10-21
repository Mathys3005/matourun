import { useState } from "react";
import { formatPace, type ProgressWeek, type ProgressZone } from "@shared/schemas";
import { MetricTrend, shortDay } from "./charts";

const LABELS: Record<ProgressZone["key"], string> = {
  footing: "Footing",
  m: "Marathon",
  hm: "Semi",
  "10k": "10 km",
  "5k": "5 km",
};

type Snapshot = NonNullable<ProgressZone["start"]>;

function verdict(start: Snapshot, end: Snapshot): string {
  const dp = end.paceSec - start.paceSec; // negative = faster
  const dh = start.hr !== null && end.hr !== null ? end.hr - start.hr : null;
  if (Math.abs(dp) <= 2 && dh !== null && dh <= -3) return "Même allure avec une fréquence cardiaque plus basse : ton endurance progresse.";
  if (dp <= -3 && (dh === null || dh <= 1)) return "Plus rapide sans monter en fréquence cardiaque : la forme progresse.";
  if (dp <= -3) return "Plus rapide, mais avec une fréquence cardiaque plus haute : tu cours plus fort sur cette allure.";
  if (dp >= 3 && dh !== null && dh >= 3) return "Plus lent avec une fréquence cardiaque plus haute : signe possible de fatigue.";
  if (dp >= 3) return "Allure en baisse sur la période.";
  if (dh !== null && dh >= 3) return "Même allure mais fréquence cardiaque plus haute que en début de période.";
  return "Stable sur la période.";
}

function paceDelta(d: number) {
  if (Math.abs(d) < 1) return "identique";
  return `${Math.abs(d)} s/km plus ${d < 0 ? "rapide" : "lent"}`;
}
const duration = (min: number) =>
  min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
const signed = (d: number, unit: string) => (d === 0 ? "identique" : `${d > 0 ? "+" : "−"}${Math.abs(d)} ${unit}`);

export function ZoneEvolution({
  zones,
  weeks,
  lapsPending,
}: {
  zones: ProgressZone[];
  weeks: ProgressWeek[];
  lapsPending: number;
}) {
  // Start on the zone with the most running time after footing, if any.
  const [key, setKey] = useState<ProgressZone["key"]>("footing");
  const zone = zones.find((z) => z.key === key)!;
  const lastWithData = zone.weeks.reduce((acc, w, i) => (w.paceSec !== null ? i : acc), weeks.length - 1);
  const [sel, setSel] = useState(lastWithData);
  const week = weeks[sel];
  const { start, end } = zone;

  const choose = (k: ProgressZone["key"]) => {
    setKey(k);
    const z = zones.find((x) => x.key === k)!;
    setSel(z.weeks.reduce((acc, w, i) => (w.paceSec !== null ? i : acc), weeks.length - 1));
  };

  return (
    <section className="zone-evo" aria-label="Évolution par allure">
      <h2>Évolution par allure</h2>
      <div className="chips" role="radiogroup" aria-label="Allure">
        {zones.map((z) => (
          <button
            key={z.key}
            role="radio"
            aria-checked={z.key === key}
            className={`${z.key === key ? "on" : ""}${z.minutes === 0 ? " empty" : ""}`}
            onClick={() => choose(z.key)}
          >
            {LABELS[z.key]}
          </button>
        ))}
      </div>
      <p className="note zone-scope num">
        {key === "footing"
          ? `Sorties faciles : au moins 80 % du temps entre ${formatPace(zone.range[0])} et ${formatPace(zone.range[1])} /km.`
          : `Tours d'au moins une minute courus entre ${formatPace(zone.range[0])} et ${formatPace(zone.range[1])} /km, dans toutes tes séances.`}
        {zone.minutes > 0 && ` ${duration(zone.minutes)} sur la période.`}
      </p>

      {zone.minutes === 0 ? (
        <div className="panel note">
          Rien couru à cette allure sur la période.
          {lapsPending > 0 && ` Le détail des tours de ${lapsPending} sortie${lapsPending > 1 ? "s" : ""} reste à importer : touche Synchroniser.`}
        </div>
      ) : (
        <>
          {start && end ? (
            <div className="verdict">
              <p className="verdict-text">{verdict(start, end)}</p>
              <div className="verdict-grid num">
                <div>
                  <span>Allure</span>
                  <strong>
                    {formatPace(start.paceSec)} → {formatPace(end.paceSec)}
                  </strong>
                  <small>{paceDelta(end.paceSec - start.paceSec)}</small>
                </div>
                <div>
                  <span>FC moyenne</span>
                  <strong>{start.hr !== null && end.hr !== null ? `${start.hr} → ${end.hr}` : "–"}</strong>
                  {start.hr !== null && end.hr !== null && <small>{signed(end.hr - start.hr, "bpm")}</small>}
                </div>
                <div>
                  <span>Cadence</span>
                  <strong>{start.cadence !== null && end.cadence !== null ? `${start.cadence} → ${end.cadence}` : "–"}</strong>
                  {start.cadence !== null && end.cadence !== null && <small>{signed(end.cadence - start.cadence, "pas/min")}</small>}
                </div>
              </div>
              <p className="note verdict-foot">Début de période comparé à la fin (premières et dernières semaines avec des données).</p>
            </div>
          ) : (
            <p className="note">Il faut au moins deux semaines avec des données pour comparer.</p>
          )}

          <div className="viz-card metrics">
            <p className="viz-readout num" aria-live="polite">
              Semaine du {week ? shortDay(week.monday) : "–"}
              {zone.weeks[sel]?.minutes ? `, ${duration(zone.weeks[sel]!.minutes)} à cette allure` : ", rien à cette allure"}
            </p>
            <MetricTrend
              title="Allure (min/km)"
              weeks={weeks}
              values={zone.weeks.map((w) => w.paceSec)}
              format={(v) => `${formatPace(v)} /km`}
              tick={formatPace}
              invert
              sel={sel}
              onSelect={setSel}
            />
            <MetricTrend
              title="Fréquence cardiaque (bpm)"
              weeks={weeks}
              values={zone.weeks.map((w) => w.hr)}
              format={(v) => `${Math.round(v)} bpm`}
              sel={sel}
              onSelect={setSel}
            />
            <MetricTrend
              title="Cadence (pas/min)"
              weeks={weeks}
              values={zone.weeks.map((w) => w.cadence)}
              format={(v) => `${Math.round(v)} pas/min`}
              sel={sel}
              onSelect={setSel}
            />
          </div>
        </>
      )}
    </section>
  );
}
