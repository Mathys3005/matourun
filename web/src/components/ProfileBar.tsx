import { targetRange, type Block, type Profile, type Step } from "@shared/schemas";

const HEIGHTS = [26, 38, 58, 80, 100];

function zone(profile: Profile, s: Step): number {
  if (s.type === "recovery" || s.type === "rest") return 0;
  const r = targetRange(profile, s.target);
  if (!r) return s.type === "interval" ? 3 : 1;
  const mid = (r[0] + r[1]) / 2;
  if (mid <= profile.pace5k + 3) return 4;
  if (mid <= profile.pace10k + 12) return 3;
  if (mid <= profile.paceM + 10) return 2;
  return 1;
}

function weight(profile: Profile, s: Step): number {
  if (s.end.type === "time") return s.end.seconds;
  if (s.end.type === "distance") {
    const r = targetRange(profile, s.target);
    const pace = r ? (r[0] + r[1]) / 2 : profile.pace10k;
    return (s.end.meters / 1000) * pace;
  }
  return 300;
}

/** The session drawn as an effort profile, like a watch's workout graph. */
export function ProfileBar({ profile, blocks, big }: { profile: Profile; blocks: Block[]; big?: boolean }) {
  const steps: Step[] = blocks.flatMap((b) =>
    b.kind === "step" ? [b] : Array.from({ length: b.times }, () => b.steps).flat(),
  );
  if (!steps.length) return null;
  return (
    <div className={`profile-bar${big ? " big" : ""}`} aria-hidden>
      {steps.map((s, i) => {
        const z = zone(profile, s);
        return <i key={i} data-z={z} style={{ flex: `${weight(profile, s)} 1 0`, height: `${HEIGHTS[z]}%` }} />;
      })}
    </div>
  );
}
