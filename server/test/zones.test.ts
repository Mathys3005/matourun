import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "../../shared/schemas.js";
import { Acc, startEnd, zoneBounds, zoneOfPace } from "../src/lib/zones.js";

const profile = { ...DEFAULT_PROFILE, pace5k: 225, pace10k: 235, paceHm: 250, paceM: 265, easyFast: 320, easySlow: 340 };
const b = zoneBounds(profile);

describe("pace zones", () => {
  it("attributes each pace to the closest reference", () => {
    expect(zoneOfPace(224, b)).toBe("5k"); // 3:44
    expect(zoneOfPace(236, b)).toBe("10k"); // 3:56
    expect(zoneOfPace(248, b)).toBe("hm");
    expect(zoneOfPace(270, b)).toBe("m");
    expect(zoneOfPace(330, b)).toBe("footing");
    expect(zoneOfPace(400, b)).toBeNull(); // walking / jog recovery
    expect(zoneOfPace(150, b)).toBeNull(); // sprint, out of every zone
  });

  it("weights pace, HR and cadence by time", () => {
    const a = new Acc()
      .add({ km: 1, sec: 240, hr: 170, cadence: 180 })
      .add({ km: 1, sec: 230, hr: 160, cadence: null });
    expect(a.snapshot()).toEqual({ paceSec: 235, hr: Math.round((170 * 240 + 160 * 230) / 470), cadence: 180 });
  });

  it("compares the first and last weeks with data", () => {
    const week = (sec: number, hr: number) => new Acc().add({ km: 2, sec, hr, cadence: 176 });
    const weeks = [week(480, 172), new Acc(), week(476, 170), week(470, 168), week(466, 165)];
    const { start, end } = startEnd(weeks);
    expect(start!.paceSec).toBe(239); // first 2 weeks with data: 956 s / 4 km
    expect(end!.paceSec).toBe(234); // last 2 weeks with data
    expect(end!.hr! < start!.hr!).toBe(true);
    expect(startEnd([week(480, 172)]).start).toBeNull();
  });
});
