import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../App";

function keyBytes(base64url: string): ArrayBuffer {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0)).buffer as ArrayBuffer;
}

const supported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** Morning reminder of the day's session, by web push. */
export function Reminders() {
  const { toast } = useApp();
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("07:30");
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.reminder().then((r) => {
      setEnabled(r.enabled);
      setTime(r.time);
    }, () => undefined);
    if (!supported()) return setSubscribed(false);
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((s) => setSubscribed(Boolean(s)), () => setSubscribed(false));
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const activate = () =>
    run(async () => {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notifications refusées : autorise-les dans les réglages du téléphone");
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await api.pushKey();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      await api.pushSubscribe(sub.toJSON());
      const r = await api.setReminder(true, time);
      setEnabled(r.enabled);
      setSubscribed(true);
      toast("Rappels activés sur cet appareil");
    });

  const deactivate = () =>
    run(async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast("Rappels désactivés sur cet appareil");
    });

  const save = (nextEnabled: boolean, nextTime: string) =>
    run(async () => {
      const r = await api.setReminder(nextEnabled, nextTime);
      setEnabled(r.enabled);
      setTime(r.time);
    });

  return (
    <section className="panel" style={{ marginTop: 28 }} aria-label="Rappels">
      <h2>Rappels</h2>
      <p className="note" style={{ marginTop: 0 }}>Une notification le matin des jours de séance, avec la séance du jour.</p>

      {!supported() ? (
        <p className="note">
          {isIos()
            ? "Sur iPhone, ajoute d'abord MatouRun à l'écran d'accueil (Partager, puis Sur l'écran d'accueil) et ouvre-le depuis l'icône."
            : "Ce navigateur ne gère pas les notifications web."}
        </p>
      ) : isIos() && !standalone() ? (
        <p className="note">
          Sur iPhone, les notifications ne marchent que depuis l'icône de l'écran d'accueil : Partager, puis Sur l'écran
          d'accueil.
        </p>
      ) : subscribed ? (
        <>
          <label className="row reminder-row">
            <span>Rappel le matin</span>
            <input
              type="checkbox"
              className="switch"
              checked={enabled}
              disabled={busy}
              onChange={(e) => save(e.target.checked, time)}
            />
          </label>
          <label className="field">
            <span>Heure du rappel</span>
            <input
              className="input num"
              type="time"
              value={time}
              disabled={busy || !enabled}
              onChange={(e) => e.target.value && setTime(e.target.value)}
              onBlur={() => save(enabled, time)}
            />
          </label>
          <div className="row">
            <button className="btn quiet small" disabled={busy} onClick={() => run(async () => { await api.pushTest(); toast("Notification envoyée"); })}>
              Tester
            </button>
            <button className="btn ghost small" disabled={busy} onClick={deactivate}>
              Désactiver sur cet appareil
            </button>
          </div>
        </>
      ) : (
        <button className="btn block" disabled={busy || subscribed === null} onClick={activate}>
          Activer les rappels sur cet appareil
        </button>
      )}
    </section>
  );
}
