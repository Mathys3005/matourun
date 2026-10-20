import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sessionInputSchema } from "@shared/schemas";
import { api, type DraftSession } from "../lib/api";
import { addDays, longDate, mondayOf, nextMonday } from "../lib/dates";
import { sessionSummary } from "../lib/describe";
import { useApp } from "../App";
import { ProfileBar } from "../components/ProfileBar";
import { IconTrash } from "../components/Icons";

/** Downscales the screenshot on the phone before upload (smaller, faster, EXIF stripped). */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Image illisible"))), "image/jpeg", 0.88),
  );
}

export function Import() {
  const { profile, toast } = useApp();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(nextMonday());
  const [group, setGroup] = useState("Adultes");
  const [drafts, setDrafts] = useState<DraftSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function read() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const img = await shrink(file);
      const { sessions } = await api.parseImport(img, startDate, group);
      setDrafts(sessions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!drafts?.length) return;
    setBusy(true);
    setError("");
    try {
      const valid = drafts.map((d) => sessionInputSchema.parse(d));
      await api.saveImport(valid);
      toast(`${valid.length} séances ajoutées au calendrier`);
      navigate(`/semaine/${mondayOf(valid[0]!.date)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const dayOptions = Array.from({ length: 14 }, (_, i) => addDays(startDate, i));

  return (
    <>
      <h1>Importer le plan</h1>
      <p className="lede">Envoie la capture du message du club, MatouRun le transforme en séances.</p>

      {!drafts && (
        <div style={{ marginTop: 22 }}>
          <label className="drop">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setError("");
              }}
            />
            {preview ? <img src={preview} alt="Capture choisie" /> : null}
            <span>
              <strong>{preview ? "Changer de capture" : "Choisir une capture"}</strong>
              <br />
              PNG, JPEG ou WebP
            </span>
          </label>

          <div className="grid2" style={{ marginTop: 16 }}>
            <label className="field">
              <span>Première séance le</span>
              <input className="input" type="date" value={startDate} onChange={(e) => e.target.value && setStartDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Groupe</span>
              <input className="input" value={group} maxLength={40} onChange={(e) => setGroup(e.target.value)} />
            </label>
          </div>

          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn block" disabled={!file || busy} onClick={read}>
            {busy ? (
              <>
                <span className="spinner" /> Lecture de la capture…
              </>
            ) : (
              "Lire la capture"
            )}
          </button>
        </div>
      )}

      {drafts && (
        <div className="import-preview">
          <p className="note">
            {drafts.length} séances trouvées. Vérifie le jour de chacune, tu pourras modifier le détail ensuite.
          </p>
          {drafts.map((d, i) => (
            <article key={i} className="card">
              <div className="card-top">
                <div className="card-title">
                  <strong>{d.title}</strong>
                  <span className="num">{sessionSummary(profile, d.blocks)}</span>
                </div>
                <button
                  className="icon-btn"
                  aria-label={`Retirer ${d.title}`}
                  onClick={() => setDrafts(drafts.filter((_, k) => k !== i))}
                >
                  <IconTrash />
                </button>
              </div>
              <ProfileBar profile={profile} blocks={d.blocks} />
              {d.description && <p className="note" style={{ margin: 0 }}>{d.description}</p>}
              <select
                className="input"
                aria-label={`Jour de ${d.title}`}
                value={d.date}
                onChange={(e) => setDrafts(drafts.map((x, k) => (k === i ? { ...x, date: e.target.value } : x)))}
              >
                {(dayOptions.includes(d.date) ? dayOptions : [d.date, ...dayOptions]).map((o) => (
                  <option key={o} value={o}>
                    {longDate(o)}
                  </option>
                ))}
              </select>
            </article>
          ))}
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn block" disabled={busy || !drafts.length} onClick={save}>
            {busy ? <span className="spinner" /> : `Ajouter ${drafts.length} séances au calendrier`}
          </button>
          <button className="btn ghost block" disabled={busy} onClick={() => setDrafts(null)}>
            Recommencer
          </button>
        </div>
      )}
    </>
  );
}
