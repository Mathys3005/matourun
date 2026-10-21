import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { DEFAULT_PROFILE, type Profile } from "@shared/schemas";
import { api, auth, setLoggedOutHandler, type Me } from "./lib/api";
import { IconCalendar, IconChart, IconImport, IconUser } from "./components/Icons";
import { Login } from "./pages/Login";
import { Week } from "./pages/Week";
import { Import } from "./pages/Import";
import { SessionPage } from "./pages/SessionPage";
import { ProfilePage } from "./pages/ProfilePage";
import { Progress } from "./pages/Progress";

interface AppState {
  email: string;
  isAdmin: boolean;
  profile: Profile;
  setProfile: (p: Profile) => void;
  garmin: boolean;
  logout: () => Promise<void>;
  toast: (text: string, bad?: boolean) => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside provider");
  return v;
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    setLoggedOutHandler(() => setMe(null));
    auth.resume().then(setMe, () => setMe(null));
  }, []);

  if (me === undefined) return <div className="login" aria-busy="true" />;
  if (!me) return <Login onSignedIn={setMe} />;
  return <SignedIn me={me} onLogout={() => setMe(null)} />;
}

function SignedIn({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [garmin, setGarmin] = useState(true);
  const [toastMsg, setToast] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    api.profile().then(setProfile).catch(() => undefined);
    api.config().then((c) => setGarmin(c.garmin)).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toastMsg]);

  const toast = useCallback((text: string, bad = false) => setToast({ text, bad }), []);
  const logout = useCallback(async () => {
    await auth.logout();
    onLogout();
  }, [onLogout]);

  return (
    <Ctx.Provider value={{ email: me.email, isAdmin: me.role === "admin", profile, setProfile, garmin, logout, toast }}>
      <Shell>
        <Routes>
          <Route path="/" element={<Week />} />
          <Route path="/semaine/:monday" element={<Week />} />
          <Route path="/importer" element={<Import />} />
          <Route path="/seance/:id" element={<SessionPage />} />
          <Route path="/nouvelle/:date" element={<SessionPage />} />
          <Route path="/progression" element={<Progress />} />
          <Route path="/profil" element={<ProfilePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Shell>
      {toastMsg && (
        <div className={`toast${toastMsg.bad ? " bad" : ""}`} role="status">
          {toastMsg.text}
        </div>
      )}
    </Ctx.Provider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <>
      <main className="shell">
        <header className="topbar">
          <Link to="/" className="brand" aria-label="MatouRun, accueil">
            <img src="/icon.svg" alt="" />
            <span>
              Matou<b>Run</b>
            </span>
          </Link>
        </header>
        {children}
      </main>
      <nav className="tabbar" aria-label="Navigation">
        <NavLink to="/" end className={({ isActive }) => (isActive || location.pathname.startsWith("/semaine") ? "active" : "")}>
          <IconCalendar />
          Semaine
        </NavLink>
        <NavLink to="/importer">
          <IconImport />
          Importer
        </NavLink>
        <NavLink to="/progression">
          <IconChart />
          Progrès
        </NavLink>
        <NavLink to="/profil">
          <IconUser />
          Profil
        </NavLink>
      </nav>
    </>
  );
}
