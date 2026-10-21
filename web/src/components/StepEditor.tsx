import { useEffect, useState } from "react";
import {
  PACE_REFS,
  STEP_TYPES,
  type Block,
  type Profile,
  type Repeat,
  type Step,
  type StepEnd,
  type StepTarget,
} from "@shared/schemas";
import { REF_LABELS, STEP_LABELS, clock, parseClock, targetText } from "../lib/describe";
import { IconDown, IconPlus, IconTrash, IconUp } from "./Icons";

type TargetKind = "none" | "easy" | (typeof PACE_REFS)[number];

function targetKind(t: StepTarget): TargetKind {
  if (t.type === "pace") return t.ref;
  if (t.type === "easy") return "easy";
  return "none";
}

function ClockInput({ seconds, onChange, label }: { seconds: number; onChange: (s: number) => void; label: string }) {
  const [text, setText] = useState(clock(seconds));
  useEffect(() => {
    if (parseClock(text) !== seconds) setText(clock(seconds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);
  return (
    <input
      className="input num"
      inputMode="numeric"
      aria-label={label}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseClock(e.target.value);
        if (v && v > 0 && v <= 6 * 3600) onChange(v);
      }}
      onBlur={() => setText(clock(seconds))}
    />
  );
}

function StepRow({
  step,
  profile,
  onChange,
  onRemove,
  onMove,
}: {
  step: Step;
  profile: Profile;
  onChange: (s: Step) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const setEnd = (end: StepEnd) => onChange({ ...step, end });
  const kind = targetKind(step.target);
  const offset = step.target.type === "pace" ? step.target.offsetSec : 0;

  return (
    <div className="step" data-type={step.type}>
      <div className="step-head">
        <select
          className="input"
          aria-label="Type d'étape"
          value={step.type}
          onChange={(e) => {
            const type = e.target.value as Step["type"];
            const target: StepTarget = type === "recovery" || type === "rest" ? { type: "none" } : step.target;
            onChange({ ...step, type, target });
          }}
        >
          {STEP_TYPES.map((t) => (
            <option key={t} value={t}>
              {STEP_LABELS[t]}
            </option>
          ))}
        </select>
        <div className="step-tools">
          <button type="button" className="icon-btn" aria-label="Monter" onClick={() => onMove(-1)}>
            <IconUp />
          </button>
          <button type="button" className="icon-btn" aria-label="Descendre" onClick={() => onMove(1)}>
            <IconDown />
          </button>
          <button type="button" className="icon-btn" aria-label="Supprimer l'étape" onClick={onRemove}>
            <IconTrash />
          </button>
        </div>
      </div>

      <div className="row">
        <select
          className="input"
          aria-label="Fin de l'étape"
          value={step.end.type}
          onChange={(e) => {
            const v = e.target.value;
            setEnd(v === "time" ? { type: "time", seconds: 300 } : v === "distance" ? { type: "distance", meters: 400 } : { type: "lap" });
          }}
        >
          <option value="time">Durée</option>
          <option value="distance">Distance</option>
          <option value="lap">Bouton Lap</option>
        </select>
        {step.end.type === "time" && (
          <ClockInput label="Durée (min:s)" seconds={step.end.seconds} onChange={(seconds) => setEnd({ type: "time", seconds })} />
        )}
        {step.end.type === "distance" && (
          <input
            className="input num"
            inputMode="numeric"
            aria-label="Distance en mètres"
            value={step.end.meters}
            onChange={(e) => {
              const m = Number(e.target.value.replace(/\D/g, ""));
              if (m > 0 && m <= 100_000) setEnd({ type: "distance", meters: m });
            }}
          />
        )}
        {step.end.type === "lap" && <span className="note">jusqu'à l'appui</span>}
      </div>

      <div className="row">
        <select
          className="input"
          aria-label="Cible d'allure"
          value={kind}
          onChange={(e) => {
            const v = e.target.value as TargetKind;
            const target: StepTarget =
              v === "none" ? { type: "none" } : v === "easy" ? { type: "easy" } : { type: "pace", ref: v, offsetSec: offset };
            onChange({ ...step, target });
          }}
        >
          <option value="none">Sans cible</option>
          <option value="easy">Footing facile</option>
          {PACE_REFS.map((r) => (
            <option key={r} value={r}>
              Allure {REF_LABELS[r]}
            </option>
          ))}
        </select>
        {step.target.type === "pace" && (
          <select
            className="input"
            aria-label="Décalage d'allure"
            value={offset}
            onChange={(e) => onChange({ ...step, target: { ...(step.target as Extract<StepTarget, { type: "pace" }>), offsetSec: Number(e.target.value) } })}
          >
            {Array.from({ length: 31 }, (_, i) => (i - 6) * 5).map((o) => (
              <option key={o} value={o}>
                {o === 0 ? "pile" : o > 0 ? `+${o}" /km` : `${o}" /km`}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="target-hint num">{targetText(profile, step)}</div>
      <input
        className="input"
        placeholder="Note (facultatif)"
        maxLength={120}
        value={step.note ?? ""}
        onChange={(e) => onChange({ ...step, note: e.target.value || undefined })}
      />
    </div>
  );
}

const newStep = (type: Step["type"] = "interval"): Step => ({
  kind: "step",
  type,
  end: { type: "time", seconds: type === "warmup" || type === "cooldown" ? 600 : 120 },
  target: type === "warmup" || type === "cooldown" ? { type: "easy" } : { type: "none" },
});

function move<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function BlocksEditor({
  blocks,
  profile,
  onChange,
}: {
  blocks: Block[];
  profile: Profile;
  onChange: (b: Block[]) => void;
}) {
  const set = (i: number, b: Block) => onChange(blocks.map((x, k) => (k === i ? b : x)));
  const remove = (i: number) => onChange(blocks.filter((_, k) => k !== i));

  return (
    <div className="steps">
      {blocks.map((b, i) =>
        b.kind === "step" ? (
          <StepRow
            key={i}
            step={b}
            profile={profile}
            onChange={(s) => set(i, s)}
            onRemove={() => remove(i)}
            onMove={(d) => onChange(move(blocks, i, d))}
          />
        ) : (
          <RepeatBox
            key={i}
            repeat={b}
            profile={profile}
            onChange={(r) => set(i, r)}
            onRemove={() => remove(i)}
            onMove={(d) => onChange(move(blocks, i, d))}
          />
        ),
      )}
      <div className="add-row">
        <button type="button" className="btn quiet small" onClick={() => onChange([...blocks, newStep()])}>
          <IconPlus /> Étape
        </button>
        <button
          type="button"
          className="btn quiet small"
          onClick={() =>
            onChange([...blocks, { kind: "repeat", times: 5, steps: [newStep("interval"), newStep("recovery")] }])
          }
        >
          <IconPlus /> Répétition
        </button>
      </div>
    </div>
  );
}

function RepeatBox({
  repeat,
  profile,
  onChange,
  onRemove,
  onMove,
}: {
  repeat: Repeat;
  profile: Profile;
  onChange: (r: Repeat) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const setSteps = (steps: Step[]) => onChange({ ...repeat, steps });
  return (
    <div className="repeat">
      <div className="repeat-head">
        <span>Répéter</span>
        <input
          className="input num"
          inputMode="numeric"
          aria-label="Nombre de répétitions"
          value={repeat.times}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, ""));
            if (n >= 1 && n <= 50) onChange({ ...repeat, times: n });
          }}
        />
        <span>fois</span>
        <span className="step-tools">
          <button type="button" className="icon-btn" aria-label="Monter" onClick={() => onMove(-1)}>
            <IconUp />
          </button>
          <button type="button" className="icon-btn" aria-label="Descendre" onClick={() => onMove(1)}>
            <IconDown />
          </button>
          <button type="button" className="icon-btn" aria-label="Supprimer la répétition" onClick={onRemove}>
            <IconTrash />
          </button>
        </span>
      </div>
      {repeat.steps.map((s, i) => (
        <StepRow
          key={i}
          step={s}
          profile={profile}
          onChange={(n) => setSteps(repeat.steps.map((x, k) => (k === i ? n : x)))}
          onRemove={() => repeat.steps.length > 1 && setSteps(repeat.steps.filter((_, k) => k !== i))}
          onMove={(d) => setSteps(move(repeat.steps, i, d))}
        />
      ))}
      <div className="add-row">
        <button type="button" className="btn quiet small" onClick={() => setSteps([...repeat.steps, newStep("recovery")])}>
          <IconPlus /> Étape dans la répétition
        </button>
      </div>
    </div>
  );
}
