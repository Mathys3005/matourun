import {
  formatPace,
  targetRange,
  type Block,
  type Profile,
  type Session,
  type Step,
} from "../../../shared/schemas.js";

/** Garmin Connect workout-service JSON (running). */

const STEP_TYPES = {
  warmup: { stepTypeId: 1, stepTypeKey: "warmup" },
  cooldown: { stepTypeId: 2, stepTypeKey: "cooldown" },
  interval: { stepTypeId: 3, stepTypeKey: "interval" },
  recovery: { stepTypeId: 4, stepTypeKey: "recovery" },
  rest: { stepTypeId: 5, stepTypeKey: "rest" },
} as const;

const RUNNING = { sportTypeId: 1, sportTypeKey: "running" };

/** s/km → m/s, rounded like Garmin's own editor. */
export const toSpeed = (secPerKm: number) => Math.round((1000 / secPerKm) * 10000) / 10000;

function endCondition(s: Step) {
  switch (s.end.type) {
    case "time":
      return {
        endCondition: { conditionTypeId: 2, conditionTypeKey: "time" },
        endConditionValue: s.end.seconds,
      };
    case "distance":
      return {
        endCondition: { conditionTypeId: 3, conditionTypeKey: "distance" },
        endConditionValue: s.end.meters,
        preferredEndConditionUnit: { unitKey: "meter" },
      };
    case "lap":
      return {
        endCondition: { conditionTypeId: 1, conditionTypeKey: "lap.button" },
        endConditionValue: null,
      };
  }
}

function target(profile: Profile, s: Step) {
  const r = targetRange(profile, s.target);
  if (!r) return { targetType: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target" } };
  const [fast, slow] = r;
  // Garmin expects the slower speed first.
  return {
    targetType: { workoutTargetTypeId: 6, workoutTargetTypeKey: "pace.zone" },
    targetValueOne: toSpeed(slow),
    targetValueTwo: toSpeed(fast),
  };
}

export function buildGarminWorkout(profile: Profile, session: Pick<Session, "title" | "description" | "blocks">) {
  let order = 0;
  let childId = 0;

  const step = (s: Step, child?: number) => ({
    type: "ExecutableStepDTO",
    stepOrder: ++order,
    ...(child ? { childStepId: child } : {}),
    stepType: STEP_TYPES[s.type],
    ...endCondition(s),
    ...target(profile, s),
    ...(s.note ? { description: s.note } : {}),
  });

  const block = (b: Block) => {
    if (b.kind === "step") return step(b);
    const id = ++childId;
    const group = {
      type: "RepeatGroupDTO",
      stepOrder: ++order,
      childStepId: id,
      stepType: { stepTypeId: 6, stepTypeKey: "repeat" },
      numberOfIterations: b.times,
      smartRepeat: false,
      endCondition: { conditionTypeId: 7, conditionTypeKey: "iterations" },
      endConditionValue: b.times,
      workoutSteps: [] as unknown[],
    };
    group.workoutSteps = b.steps.map((s) => step(s, id));
    return group;
  };

  return {
    sportType: RUNNING,
    workoutName: `MatouRun · ${session.title}`.slice(0, 80),
    description: session.description.slice(0, 500),
    workoutSegments: [
      { segmentOrder: 1, sportType: RUNNING, workoutSteps: session.blocks.map(block) },
    ],
  };
}

/** Human summary of a target, e.g. "3:50–4:00 /km". */
export function describeTarget(profile: Profile, s: Step): string {
  const r = targetRange(profile, s.target);
  return r ? `${formatPace(r[0])}–${formatPace(r[1])} /km` : "sans cible";
}
