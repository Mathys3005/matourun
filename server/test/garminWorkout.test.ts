import { describe, expect, it } from "vitest";
import { buildGarminWorkout, toSpeed } from "../src/lib/garminWorkout.js";
import { DEFAULT_PROFILE, estimate, sessionInputSchema, type Profile } from "../../shared/schemas.js";

const profile: Profile = { ...DEFAULT_PROFILE, pace10k: 235, pace5k: 225, easyFast: 320, easySlow: 340 };

describe("buildGarminWorkout", () => {
  it("converts the threshold session with the right pace windows", () => {
    const w = buildGarminWorkout(profile, {
      title: "Seuil 8-6-4-2-8",
      description: "",
      blocks: [
        { kind: "step", type: "warmup", end: { type: "time", seconds: 1800 }, target: { type: "easy" } },
        { kind: "step", type: "interval", end: { type: "time", seconds: 480 }, target: { type: "pace", ref: "10k", offsetSec: 20 } },
        { kind: "step", type: "recovery", end: { type: "time", seconds: 120 }, target: { type: "none" } },
        { kind: "step", type: "interval", end: { type: "time", seconds: 120 }, target: { type: "pace", ref: "5k", offsetSec: 0 } },
        { kind: "step", type: "cooldown", end: { type: "time", seconds: 600 }, target: { type: "easy" } },
      ],
    });
    const steps = w.workoutSegments[0]!.workoutSteps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(5);
    expect(steps[0]).toMatchObject({ targetValueOne: toSpeed(340), targetValueTwo: toSpeed(320) });
    // 10k (3:55) + 20" ± 5" → 4:10–4:20
    expect(steps[1]).toMatchObject({ endConditionValue: 480, targetValueOne: toSpeed(260), targetValueTwo: toSpeed(250) });
    expect(steps[2]).toMatchObject({ targetType: { workoutTargetTypeKey: "no.target" } });
    expect(steps[3]).toMatchObject({ targetValueOne: toSpeed(230), targetValueTwo: toSpeed(220) });
    expect(steps.map((s) => s.stepOrder)).toEqual([1, 2, 3, 4, 5]);
  });

  it("builds repeat groups with distance steps", () => {
    const w = buildGarminWorkout(profile, {
      title: "Piste",
      description: "",
      blocks: [
        {
          kind: "repeat",
          times: 6,
          steps: [
            { kind: "step", type: "interval", end: { type: "distance", meters: 400 }, target: { type: "none" }, note: "vite" },
            { kind: "step", type: "recovery", end: { type: "time", seconds: 90 }, target: { type: "none" } },
          ],
        },
      ],
    });
    const g = w.workoutSegments[0]!.workoutSteps[0] as Record<string, any>;
    expect(g).toMatchObject({ type: "RepeatGroupDTO", numberOfIterations: 6, stepOrder: 1, childStepId: 1 });
    expect(g.workoutSteps[0]).toMatchObject({
      stepOrder: 2,
      childStepId: 1,
      endCondition: { conditionTypeKey: "distance" },
      endConditionValue: 400,
      description: "vite",
    });
  });
});

describe("schemas", () => {
  it("rejects malformed and hostile input", () => {
    const bad = sessionInputSchema.safeParse({
      date: "2026-02-30x",
      title: "<script>alert(1)</script>".repeat(10),
      blocks: [{ kind: "step", type: "sprint", end: { type: "time", seconds: -1 }, target: { type: "none" } }],
    });
    expect(bad.success).toBe(false);
  });

  it("estimates distance roughly", () => {
    const e = estimate(profile, [
      { kind: "step", type: "warmup", end: { type: "time", seconds: 1800 }, target: { type: "easy" } },
    ]);
    expect(e.seconds).toBe(1800);
    expect(e.meters).toBeGreaterThan(5200);
    expect(e.meters).toBeLessThan(5700);
  });
});
