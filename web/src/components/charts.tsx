import { useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { formatPace, type ProgressWeek } from "@shared/schemas";
import { addDays, fromIso } from "../lib/dates";

/* Hand-drawn SVG charts (no library: keeps the strict CSP and the bundle small).
   Colors come from CSS tokens: --viz-done, --viz-plan, --viz-seq-1..5. */

const W = 340;
const PAD = { top: 10, right: 8, bottom: 22, left: 30 };
const PLOT_W = W - PAD.left - PAD.right;

const monthFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
export const shortDay = (iso: string) => monthFmt.format(fromIso(iso)).replace(".", "");
const km1 = (n: number) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });

function niceMax(max: number, ticks = 3): { top: number; step: number } {
  if (max <= 0) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: step * Math.ceil(max / step), step };
}

/** Bar with a 4px rounded data end, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number) {
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

/** Keyboard + pointer selection shared by the charts (the readout above shows the selection). */
function useSelection(count: number, initial: number) {
  const [sel, setSel] = useState(initial);
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") setSel((s) => clamp(s - 1));
    else if (e.key === "ArrowRight") setSel((s) => clamp(s + 1));
    else if (e.key === "Home") setSel(0);
    else if (e.key === "End") setSel(count - 1);
    else return;
    e.preventDefault();
  };
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W - PAD.left;
    setSel(clamp(Math.floor((x / PLOT_W) * count)));
  };
  return { sel: clamp(sel), setSel, onKeyDown, pick };
}

function XLabels({ weeks, y }: { weeks: ProgressWeek[]; y: number }) {
  const n = weeks.length;
  const every = Math.max(1, Math.ceil(n / 5));
  const slot = PLOT_W / n;
  return (
    <>
      {weeks.map((w, i) => {
        if ((n - 1 - i) % every !== 0) return null;
        const x = PAD.left + slot * (i + 0.5);
        // Edge labels are anchored inward so they never run off the chart.
        const anchor = x + 22 > W ? "end" : x - 22 < PAD.left ? "start" : "middle";
        const ax = anchor === "end" ? W - 2 : anchor === "start" ? PAD.left : x;
        return (
          <text key={w.monday} x={ax} y={y} className="viz-tick" textAnchor={anchor}>
            {shortDay(w.monday)}
          </text>
        );
      })}
    </>
  );
}

function ChartFrame({
  title,
  legend,
  readout,
  children,
}: {
  title: string;
  legend?: ReactNode;
  readout: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="viz-card">
      <div className="viz-head">
        <h2>{title}</h2>
        {legend}
      </div>
      <p className="viz-readout num" aria-live="polite">
        {readout}
      </p>
      {children}
    </section>
  );
}

/* ---------- Weekly distance: done (columns) vs planned (target tick) ---------- */

export function WeeklyDistance({ weeks }: { weeks: ProgressWeek[] }) {
  const n = weeks.length;
  const H = 170;
  const plotH = H - PAD.top - PAD.bottom;
  const { top, step } = niceMax(Math.max(...weeks.map((w) => Math.max(w.doneKm, w.plannedKm)), 1));
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const slot = PLOT_W / n;
  const barW = Math.max(2, Math.min(20, slot * 0.72, slot - 2));
  const tickW = Math.min(slot - 1, barW + 8);
  const { sel, onKeyDown, pick } = useSelection(n, n - 1);
  const w = weeks[sel]!;

  return (
    <ChartFrame
      title="Kilomètres par semaine"
      legend={
        <div className="viz-legend">
          <span>
            <i className="key-rect done" /> Réalisé
          </span>
          <span>
            <i className="key-line plan" /> Prévu
          </span>
        </div>
      }
      readout={
        <>
          <strong>{km1(w.doneKm)} km</strong> réalisés
          {w.plannedKm > 0 ? `, ${km1(w.plannedKm)} km prévus` : ""}
          <span className="viz-when"> semaine du {shortDay(w.monday)}</span>
        </>
      }
    >
      <svg
        className="viz"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Kilomètres réalisés et prévus par semaine. Flèches gauche et droite pour parcourir les semaines."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={pick}
        onPointerDown={pick}
      >
        {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
          <g key={v}>
            <line className="viz-grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="viz-tick" x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {weeks.map((wk, i) => {
          const x = PAD.left + slot * i + (slot - barW) / 2;
          const cx = PAD.left + slot * (i + 0.5);
          return (
            <g key={wk.monday} className={i === sel ? "viz-sel" : undefined}>
              {i === sel && <rect className="viz-band" x={PAD.left + slot * i} y={PAD.top} width={slot} height={plotH} />}
              <path className="viz-done" d={barPath(x, y(wk.doneKm), barW, y(0) - y(wk.doneKm))} />
              {wk.plannedKm > 0 && (
                <line className="viz-plan" x1={cx - tickW / 2} x2={cx + tickW / 2} y1={y(wk.plannedKm)} y2={y(wk.plannedKm)} />
              )}
            </g>
          );
        })}
        <XLabels weeks={weeks} y={H - 6} />
      </svg>
    </ChartFrame>
  );
}

/* ---------- Mean pace per week (faster is higher) ---------- */

export function PaceTrend({ weeks }: { weeks: ProgressWeek[] }) {
  const n = weeks.length;
  const H = 150;
  const plotH = H - PAD.top - PAD.bottom;
  const paces = weeks.map((w) => w.paceSec).filter((p): p is number => p !== null);
  const lastWithPace = weeks.reduce((acc, w, i) => (w.paceSec !== null ? i : acc), n - 1);
  const { sel, onKeyDown, pick } = useSelection(n, lastWithPace);
  if (paces.length < 2) return null;

  const lo = Math.floor((Math.min(...paces) - 5) / 15) * 15;
  const hi = Math.ceil((Math.max(...paces) + 5) / 15) * 15;
  const y = (p: number) => PAD.top + ((p - lo) / (hi - lo)) * plotH; // smaller (faster) = higher
  const slot = PLOT_W / n;
  const cx = (i: number) => PAD.left + slot * (i + 0.5);
  const ticks = [lo, Math.round((lo + hi) / 2), hi];

  let d = "";
  let pen = false;
  weeks.forEach((w, i) => {
    if (w.paceSec === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${cx(i)},${y(w.paceSec)} `;
    pen = true;
  });
  const w = weeks[sel]!;

  return (
    <ChartFrame
      title="Allure moyenne"
      legend={<span className="viz-note">plus haut = plus rapide</span>}
      readout={
        w.paceSec !== null ? (
          <>
            <strong>{formatPace(w.paceSec)} /km</strong>
            <span className="viz-when"> semaine du {shortDay(w.monday)}</span>
          </>
        ) : (
          <>
            Pas de sortie <span className="viz-when">semaine du {shortDay(w.monday)}</span>
          </>
        )
      }
    >
      <svg
        className="viz"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Allure moyenne par semaine. Flèches gauche et droite pour parcourir les semaines."
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={pick}
        onPointerDown={pick}
      >
        {ticks.map((p) => (
          <g key={p}>
            <line className="viz-grid" x1={PAD.left} x2={W - PAD.right} y1={y(p)} y2={y(p)} />
            <text className="viz-tick" x={PAD.left - 6} y={y(p) + 3.5} textAnchor="end">
              {formatPace(p)}
            </text>
          </g>
        ))}
        <line className="viz-crosshair" x1={cx(sel)} x2={cx(sel)} y1={PAD.top} y2={PAD.top + plotH} />
        <path className="viz-line" d={d} />
        {weeks.map((wk, i) =>
          wk.paceSec !== null ? (
            <circle key={wk.monday} className={`viz-dot${i === sel ? " on" : ""}`} cx={cx(i)} cy={y(wk.paceSec)} r={i === sel ? 5 : 4} />
          ) : null,
        )}
        <XLabels weeks={weeks} y={H - 6} />
      </svg>
    </ChartFrame>
  );
}

/* ---------- Consistency grid: one cell per day, darker = more km ---------- */

const BINS = [5, 10, 15, 20];
const binOf = (km: number) => (km <= 0 ? 0 : 1 + BINS.filter((b) => km >= b).length);
const DAYS = ["L", "M", "M", "J", "V", "S", "D"];
const longDayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });

export function Consistency({ weeks, days }: { weeks: ProgressWeek[]; days: { date: string; km: number }[] }) {
  const n = weeks.length;
  const kmByDate = new Map(days.map((d) => [d.date, d.km]));
  const gap = 2;
  // Day initials only when the cells are big enough to carry them.
  const roomy = (W - 16 - PAD.right) / n - gap >= 9;
  const left = roomy ? 16 : 0;
  const cell = Math.min(24, (W - left - PAD.right) / n - gap);
  const H = 7 * (cell + gap) + 4;
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const lastDay = days.at(-1)?.date ?? todayIso;
  const [sel, setSel] = useState<string>(lastDay);
  const km = kmByDate.get(sel) ?? 0;

  const keyNav = (e: KeyboardEvent) => {
    const delta = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!delta) return;
    e.preventDefault();
    const next = addDays(sel, delta);
    if (next >= weeks[0]!.monday && next <= todayIso) setSel(next);
  };

  return (
    <ChartFrame
      title="Régularité"
      legend={
        <div className="viz-legend seq" aria-hidden>
          <span>0</span>
          {[0, 1, 2, 3, 4, 5].map((b) => (
            <i key={b} className={`seq-${b}`} />
          ))}
          <span>20+ km</span>
        </div>
      }
      readout={
        <>
          <strong>{km > 0 ? `${km1(km)} km` : "Repos"}</strong>
          <span className="viz-when"> {longDayFmt.format(fromIso(sel))}</span>
        </>
      }
    >
      <svg
        className="viz"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Grille de régularité, un carré par jour. Flèches pour parcourir les jours."
        tabIndex={0}
        onKeyDown={keyNav}
      >
        {DAYS.map((d, r) =>
          roomy && r % 2 === 0 ? (
            <text key={r} className="viz-tick" x={0} y={r * (cell + gap) + cell / 2 + 3.5}>
              {d}
            </text>
          ) : null,
        )}
        {weeks.map((wk, c) =>
          DAYS.map((_, r) => {
            const date = addDays(wk.monday, r);
            if (date > todayIso) return null;
            const b = binOf(kmByDate.get(date) ?? 0);
            return (
              <rect
                key={date}
                className={`seq-${b}${date === sel ? " on" : ""}`}
                x={left + c * (cell + gap)}
                y={r * (cell + gap)}
                width={cell}
                height={cell}
                rx={Math.min(3, cell / 3)}
                onPointerDown={() => setSel(date)}
                onPointerEnter={(e) => e.pointerType === "mouse" && setSel(date)}
              />
            );
          }),
        )}
      </svg>
    </ChartFrame>
  );
}
