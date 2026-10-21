import { useEffect, useState } from "react";
import { formatPace, parsePace, profileSchema, type Profile } from "@shared/schemas";
import { api } from "../lib/api";
import { useApp } from "../App";
import { AccessAdmin } from "../components/AccessAdmin";
import { ThemePicker } from "../components/ThemePicker";
import { Reminders } from "../components/Reminders";

const FIELDS: Array<{ key: keyof Profile; label: string }> = [
  { key: "pace5k", label: "Allure 5 km" },
  { key: "pace10k", label: "Allure 10 km" },
  { key: "paceHm", label: "Allure semi" },
  { key: "paceM", label: "Allure marathon" },
  { key: "easyFast", label: "Footing, le plus rapide" },
  { key: "easySlow", label: "Footing, le plus lent" },
];

type PaceKey = Exclude<keyof Profile, "toleranceSec">;

export function ProfilePage() {
  const { profile, setProfile, email, isAdmin, logout, toast } = useApp();
  const [text, setText] = useState<Record<string, string>>({});
  const [tolerance, setTolerance] = useState(profile.toleranceSec);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setText(Object.fromEntries(FIELDS.map((f) => [f.key, formatPace(profile[f.key])])));
    setTolerance(profile.toleranceSec);
  }, [profile]);

  async function save() {
    setError("");
    const values: Partial<Record<PaceKey, number>> = {};
    for (const f of FIELDS) {
      const v = parsePace(text[f.key] ?? "");
      if (v === null) return setError(`${f.label} : format attendu min:ss, par ex. 3:55`);
      values[f.key as PaceKey] = v;
    }
    const parsed = profileSchema.safeParse({ ...values, toleranceSec: tolerance });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Profil invalide");
    setBusy(true);
    try {
      setProfile(await api.saveProfile(parsed.data));
      toast("Allures enregistrées");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Mes allures</h1>
      <p className="lede">Les cibles de chaque séance sont calculées à partir d'elles au moment de l'export.</p>

      <div className="panel" style={{ marginTop: 22 }}>
        <div className="grid2">
          {FIELDS.map((f) => (
            <label key={f.key} className="field">
              <span>{f.label}</span>
              <input
                className="input num"
                inputMode="numeric"
                placeholder="3:55"
                value={text[f.key] ?? ""}
                onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Marge autour de l'allure cible</span>
          <select className="input" value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
            {[0, 3, 5, 8, 10, 15].map((t) => (
              <option key={t} value={t}>
                ± {t} s/km
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn block" disabled={busy} onClick={save}>
        {busy ? <span className="spinner" /> : "Enregistrer mes allures"}
      </button>

      <Reminders />

      <ThemePicker />

      {isAdmin && <AccessAdmin />}

      <div className="panel" style={{ marginTop: 28 }}>
        <p className="note" style={{ marginTop: 0 }}>Connecté avec {email}</p>
        <button className="btn ghost block" onClick={logout}>
          Se déconnecter
        </button>
      </div>
    </>
  );
}
