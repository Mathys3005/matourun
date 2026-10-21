import type { Profile } from "../../../shared/schemas.js";

/* Pace zones from the runner's reference paces. Boundaries sit halfway between
   two references, so a lap is attributed to the closest reference pace. */

export const ZONE_KEYS = ["footing", "m", "hm", "10k", "5k"] as const;
export type ZoneKey = (typeof ZONE_KEYS)[number];

export interface ZoneBounds {
  /** [fast, slow] pace range in s/km, inclusive of fast, exclusive of slow. */
  ranges: Record<ZoneKey, [number, number]>;
}

const mid = (a: number, b: number) => (a + b) / 2;

export function zoneBounds(p: Profile): ZoneBounds {
  const b1 = mid(p.pace5k, p.pace10k);
  const b2 = mid(p.pace10k, p.paceHm);
  const b3 = mid(p.paceHm, p.paceM);
  const b4 = mid(p.paceM, p.easyFast);
  return {
    ranges: {
      "5k": [p.pace5k - 45, b1],
      "10k": [b1, b2],
      hm: [b2, b3],
      m: [b3, b4],
      // Slower than the slowest easy pace + 45 s is walking or jogging recovery: ignored.
      footing: [b4, p.easySlow + 45],
    },
  };
}

export function zoneOfPace(pace: number, b: ZoneBounds): ZoneKey | null {
  for (const k of ZONE_KEYS) {
    const [fast, slow] = b.ranges[k];
    if (pace >= fast && pace < slow) return k;
  }
  return null;
}

/** Laps shorter than this are too noisy (HR lag, GPS) to say anything about a pace. */
export const MIN_LAP_SEC = 60;
export const MIN_LAP_M = 200;
/** A run is a "footing" when this share of its time is at easy pace. */
export const FOOTING_SHARE = 0.8;

export interface Sample {
  km: number;
  sec: number;
  hr: number | null;
  cadence: number | null;
}

/** Time-weighted accumulator: pace = time / distance; HR and cadence weighted by time. */
export class Acc {
  km = 0;
  sec = 0;
  hrSum = 0;
  hrSec = 0;
  cadSum = 0;
  cadSec = 0;

  add(s: Sample) {
    this.km += s.km;
    this.sec += s.sec;
    if (s.hr) {
      this.hrSum += s.hr * s.sec;
      this.hrSec += s.sec;
    }
    if (s.cadence) {
      this.cadSum += s.cadence * s.sec;
      this.cadSec += s.sec;
    }
    return this;
  }

  merge(o: Acc) {
    this.km += o.km;
    this.sec += o.sec;
    this.hrSum += o.hrSum;
    this.hrSec += o.hrSec;
    this.cadSum += o.cadSum;
    this.cadSec += o.cadSec;
    return this;
  }

  get empty() {
    return this.km < 0.2 || this.sec < MIN_LAP_SEC;
  }

  snapshot() {
    if (this.empty) return null;
    return {
      paceSec: Math.round(this.sec / this.km),
      hr: this.hrSec ? Math.round(this.hrSum / this.hrSec) : null,
      cadence: this.cadSec ? Math.round(this.cadSum / this.cadSec) : null,
    };
  }
}

/**
 * Start vs end of the period: the first and last weeks with data (up to 3 each,
 * never overlapping). Null with fewer than 2 weeks of data.
 */
export function startEnd(weeks: Acc[]) {
  const withData = weeks.filter((w) => !w.empty);
  if (withData.length < 2) return { start: null, end: null };
  const k = Math.min(3, Math.floor(withData.length / 2));
  const sum = (list: Acc[]) => list.reduce((a, w) => a.merge(w), new Acc());
  return { start: sum(withData.slice(0, k)).snapshot(), end: sum(withData.slice(-k)).snapshot() };
}
