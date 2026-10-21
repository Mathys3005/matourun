import { useEffect, useState, type FormEvent } from "react";
import { emailSchema, type AdminUser, type Role } from "@shared/schemas";
import { api } from "../lib/api";
import { useApp } from "../App";

const STATUS: Record<AdminUser["status"], string> = {
  active: "Actif",
  invited: "Invitation en attente",
  expired: "Invitation expirée",
};

interface Invite {
  email: string;
  code: string;
  expiresAt: string;
}

function inviteMessage(i: Invite) {
  return `Tu as accès à MatouRun : ${location.origin}\nConnecte-toi avec ${i.email} et le code d'invitation ${i.code} (valable jusqu'au ${new Date(i.expiresAt).toLocaleDateString("fr-FR")}).`;
}

/** Admin-only: who can sign in, invitations and removal. */
export function AccessAdmin() {
  const { email: me, toast } = useApp();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.users().then(setUsers, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  async function run(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) return setError("Entre une adresse e-mail valide");
    run(async () => {
      const r = await api.inviteUser(parsed.data, role);
      setInvite({ email: r.user.email, code: r.inviteCode, expiresAt: r.expiresAt });
      setEmail("");
      setRole("member");
      await load();
    });
  }

  async function copy() {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(inviteMessage(invite));
      toast("Message copié");
    } catch {
      toast("Copie impossible, recopie le code à la main", true);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 28 }}>
      <h2>Qui a accès</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Les séances de tous les membres sont envoyées sur le compte Garmin du serveur.
      </p>

      <ul className="user-list">
        {users === null && <li className="note">Chargement…</li>}
        {users?.map((u) => (
          <li key={u.id} className="user-row">
            <div className="user-main">
              <strong>{u.email}</strong>
              <span className={`user-status ${u.status}`}>
                {STATUS[u.status]}
                {u.role === "admin" ? ", administrateur" : ""}
              </span>
            </div>
            {u.status !== "active" && (
              <button
                className="btn ghost small"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await api.reinviteUser(u.id);
                    setInvite({ email: r.user.email, code: r.inviteCode, expiresAt: r.expiresAt });
                    await load();
                  })
                }
              >
                Nouveau code
              </button>
            )}
            {u.email !== me && (
              <button
                className="btn danger small"
                disabled={busy}
                onClick={() => {
                  if (!confirm(`Retirer l'accès de ${u.email} ? Ses séances seront supprimées.`)) return;
                  run(async () => {
                    await api.removeUser(u.id);
                    if (invite?.email === u.email) setInvite(null);
                    toast("Accès retiré");
                    await load();
                  });
                }}
              >
                Retirer
              </button>
            )}
          </li>
        ))}
      </ul>

      {invite && (
        <div className="invite-box" role="status">
          <span>Code d'invitation pour {invite.email}</span>
          <strong className="num">{invite.code}</strong>
          <span className="note">
            Valable jusqu'au {new Date(invite.expiresAt).toLocaleDateString("fr-FR")}, utilisable une seule fois. Il ne
            sera plus affiché.
          </span>
          <button className="btn small" onClick={copy}>
            Copier le message d'invitation
          </button>
        </div>
      )}

      <form onSubmit={submit} noValidate style={{ marginTop: 18 }}>
        <label className="field">
          <span>Inviter quelqu'un</span>
          <input
            className="input"
            type="email"
            placeholder="adresse@exemple.fr"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Rôle</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Membre</option>
            <option value="admin">Administrateur (peut gérer les accès)</option>
          </select>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn block" disabled={busy || !email}>
          {busy ? <span className="spinner" /> : "Inviter"}
        </button>
      </form>
    </section>
  );
}
