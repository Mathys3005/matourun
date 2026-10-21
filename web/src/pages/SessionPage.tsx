import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { isoDateSchema, sessionInputSchema, type Block, type Session } from "@shared/schemas";
import { api } from "../lib/api";
import { longDate, mondayOf, today } from "../lib/dates";
import { sessionSummary } from "../lib/describe";
import { useApp } from "../App";
import { ProfileBar } from "../components/ProfileBar";
import { BlocksEditor } from "../components/StepEditor";

const STARTER: Block[] = [
  { kind: "step", type: "warmup", end: { type: "time", seconds: 1200 }, target: { type: "easy" } },
];

export function SessionPage() {
  const { id, date } = useParams();
  const navigate = useNavigate();
  const { profile, garmin, toast } = useApp();
  const [session, setSession] = useState<Session | null>(null);
  const [title, setTitle] = useState("Footing");
  const [description, setDescription] = useState("");
  const [day, setDay] = useState(isoDateSchema.safeParse(date).success ? date! : today());
  const [blocks, setBlocks] = useState<Block[]>(STARTER);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    api.session(id).then(
      (s) => {
        setSession(s);
        setTitle(s.title);
        setDescription(s.description);
        setDay(s.date);
        setBlocks(s.blocks);
      },
      (e: Error) => setError(e.message),
    );
  }, [id]);

  const edit = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setDirty(true);
  };

  async function save(andExport = false) {
    setError("");
    const parsed = sessionInputSchema.safeParse({ date: day, title, description, blocks });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Séance invalide");
    setBusy(true);
    try {
      let saved: Session;
      if (dirty || !session) {
        saved = session ? await api.updateSession(session.id, parsed.data) : await api.createSession(parsed.data);
        setSession(saved);
        setDirty(false);
      } else {
        saved = session;
      }
      if (andExport) {
        await api.exportSession(saved.id);
        toast("Séance envoyée sur Garmin");
      } else {
        toast("Séance enregistrée");
      }
      navigate(`/semaine/${mondayOf(saved.date)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!session || !confirm(`Supprimer « ${session.title} » ? Elle sera aussi retirée de Garmin.`)) return;
    setBusy(true);
    try {
      await api.deleteSession(session.id);
      toast("Séance supprimée");
      navigate(`/semaine/${mondayOf(session.date)}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  if (id && !session && !error) return <p className="note">Chargement…</p>;

  return (
    <>
      <h1>{session ? "Séance" : "Nouvelle séance"}</h1>
      <p className="lede num">
        {longDate(day)}, {sessionSummary(profile, blocks)}
        {session?.exportedAt && !dirty ? ". Déjà sur la montre." : ""}
      </p>
      <div style={{ margin: "16px 0 20px" }}>
        <ProfileBar profile={profile} blocks={blocks} big />
      </div>

      <div className="panel">
        <label className="field">
          <span>Nom</span>
          <input className="input" maxLength={80} value={title} onChange={(e) => edit(setTitle)(e.target.value)} />
        </label>
        <label className="field">
          <span>Jour</span>
          <input className="input" type="date" value={day} onChange={(e) => e.target.value && edit(setDay)(e.target.value)} />
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Consigne</span>
          <input className="input" maxLength={500} value={description} onChange={(e) => edit(setDescription)(e.target.value)} />
        </label>
      </div>

      <h2>Étapes</h2>
      <BlocksEditor blocks={blocks} profile={profile} onChange={edit(setBlocks)} />

      {error && <p className="error" role="alert">{error}</p>}
      <div style={{ display: "grid", gap: 10, marginTop: 24 }}>
        <button className="btn block" disabled={busy || !garmin || !blocks.length} onClick={() => save(true)}>
          {busy ? <span className="spinner" /> : "Enregistrer et envoyer sur la montre"}
        </button>
        <button className="btn quiet block" disabled={busy} onClick={() => save(false)}>
          Enregistrer
        </button>
        {session && (
          <button className="btn danger block" disabled={busy} onClick={remove}>
            Supprimer la séance
          </button>
        )}
      </div>
    </>
  );
}
