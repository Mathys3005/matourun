import { useState, type FormEvent } from "react";
import { emailSchema, passwordSchema } from "@shared/schemas";
import { auth } from "../lib/api";

type Stage = "email" | "password" | "setup";

export function Login({ onSignedIn }: { onSignedIn: (email: string) => void }) {
  const [stage, setStage] = useState<Stage>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (stage === "email") {
        const parsed = emailSchema.safeParse(email);
        if (!parsed.success) throw new Error("Entre une adresse e-mail valide");
        setEmail(parsed.data);
        const { needsSetup } = await auth.status(parsed.data);
        setStage(needsSetup ? "setup" : "password");
      } else if (stage === "password") {
        onSignedIn(await auth.login(email, password));
      } else {
        const p = passwordSchema.safeParse(password);
        if (!p.success) throw new Error(p.error.issues[0]?.message ?? "Mot de passe invalide");
        if (password !== confirm) throw new Error("Les deux mots de passe ne correspondent pas");
        onSignedIn(await auth.setup(email, password, code));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <img className="login-mark" src="/icon.svg" alt="" />
      <h1>
        Matou<b>Run</b>
      </h1>
      <p className="lede">
        {stage === "setup"
          ? "Première connexion : choisis ton mot de passe."
          : "Ton plan de la semaine, directement sur ta montre."}
      </p>
      <form onSubmit={submit} noValidate>
        <label className="field">
          <span>E-mail</span>
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            disabled={stage !== "email"}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        {stage === "password" && (
          <label className="field">
            <span>Mot de passe</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}

        {stage === "setup" && (
          <>
            <label className="field">
              <span>Code de configuration</span>
              <input className="input" autoComplete="one-time-code" value={code} autoFocus onChange={(e) => setCode(e.target.value)} />
            </label>
            <label className="field">
              <span>Nouveau mot de passe (12 caractères minimum)</span>
              <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <label className="field">
              <span>Confirme le mot de passe</span>
              <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
          </>
        )}

        {error && <p className="error" role="alert">{error}</p>}

        <button className="btn block" disabled={busy}>
          {busy ? <span className="spinner" /> : stage === "email" ? "Continuer" : stage === "setup" ? "Créer mon mot de passe" : "Se connecter"}
        </button>
        {stage !== "email" && (
          <button
            type="button"
            className="btn ghost block"
            style={{ marginTop: 10 }}
            onClick={() => {
              setStage("email");
              setPassword("");
              setConfirm("");
              setError("");
            }}
          >
            Changer d'e-mail
          </button>
        )}
      </form>
    </main>
  );
}
