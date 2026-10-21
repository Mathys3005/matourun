import { z } from "zod";
import {
  profileSchema,
  sessionSchema,
  parsedSessionSchema,
  isoDateSchema,
  meSchema,
  roleSchema,
  adminUserSchema,
  inviteSchema,
  progressSchema,
  syncResultSchema,
  weekRunsSchema,
  reminderStateSchema,
  competitionListSchema,
  calendarPreviewSchema,
  weekCompetitionsSchema,
  type Role,
  type Profile,
  type Session,
  type SessionInput,
} from "@shared/schemas";

/* The access token lives only in memory (never in localStorage), so an XSS
   can't read a long-lived credential. The refresh token is an httpOnly cookie. */
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onLoggedOut: () => void = () => undefined;

export function setLoggedOutHandler(fn: () => void) {
  onLoggedOut = fn;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)mr_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : "";
}

const sessionResponse = z.object({ accessToken: z.string(), email: z.string(), role: roleSchema });
export type Me = z.infer<typeof meSchema>;

async function authPost(path: string, body?: unknown): Promise<Response> {
  return fetch(`/api/auth/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function readError(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { error?: string; issues?: { message: string }[] } | null;
  const detail = data?.issues?.[0]?.message;
  return new ApiError(res.status, detail ? `${data?.error} : ${detail}` : (data?.error ?? "Erreur réseau"));
}

/* Offline: the refresh call can't reach the server. The app then shows the data the
   service worker cached at the last visit, read-only. */
let offline = false;
export const isOffline = () => offline;
const ME_KEY = "mr_me";

function rememberMe(me: Me) {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify(me));
  } catch {
    /* storage unavailable */
  }
}
function cachedMe(): Me | null {
  try {
    const parsed = meSchema.safeParse(JSON.parse(localStorage.getItem(ME_KEY) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function refresh(): Promise<string | null> {
  refreshing ??= (async () => {
    const res = await authPost("refresh").catch(() => null);
    offline = res === null;
    if (!res?.ok) {
      accessToken = null;
      return false;
    }
    accessToken = sessionResponse.parse(await res.json()).accessToken;
    return true;
  })().finally(() => (refreshing = null));
  return (await refreshing) ? accessToken : null;
}

async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const send = () =>
    fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
    });
  const OFFLINE_MSG = "Hors ligne : réessaie quand tu auras du réseau";
  let res = await send().catch(() => {
    throw new ApiError(0, OFFLINE_MSG);
  });
  if (res.status === 401) {
    if (!(await refresh())) {
      if (offline) throw new ApiError(0, OFFLINE_MSG);
      onLoggedOut();
      throw new ApiError(401, "Session expirée");
    }
    res = await send().catch(() => {
      throw new ApiError(0, OFFLINE_MSG);
    });
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return schema.parse(undefined);
  // Every response is validated before the UI uses it.
  return schema.parse(await res.json());
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

/* ---------- Auth ---------- */

export const auth = {
  async status(email: string) {
    const res = await authPost("status", { email });
    if (!res.ok) throw await readError(res);
    return z.object({ needsSetup: z.boolean() }).parse(await res.json());
  },
  async login(email: string, password: string) {
    const res = await authPost("login", { email, password });
    if (!res.ok) throw await readError(res);
    const s = sessionResponse.parse(await res.json());
    accessToken = s.accessToken;
    rememberMe({ email: s.email, role: s.role });
    return { email: s.email, role: s.role } as Me;
  },
  async setup(email: string, password: string, setupCode: string) {
    const res = await authPost("setup", { email, password, setupCode });
    if (!res.ok) throw await readError(res);
    const s = sessionResponse.parse(await res.json());
    accessToken = s.accessToken;
    rememberMe({ email: s.email, role: s.role });
    return { email: s.email, role: s.role } as Me;
  },
  async logout() {
    await authPost("logout").catch(() => null);
    accessToken = null;
    try {
      localStorage.removeItem(ME_KEY);
    } catch {
      /* storage unavailable */
    }
    // Forget the API responses cached for offline use.
    navigator.serviceWorker?.controller?.postMessage({ type: "logout" });
  },
  async resume(): Promise<Me | null> {
    if (await refresh()) {
      const me = await request("/auth/me", { method: "GET" }, meSchema);
      rememberMe(me);
      return me;
    }
    return offline ? cachedMe() : null;
  },
};

/* ---------- Data ---------- */

const datedParsed = parsedSessionSchema.extend({ date: isoDateSchema });
export type DraftSession = z.infer<typeof datedParsed>;

export const api = {
  config: () => request("/config", { method: "GET" }, z.object({ garmin: z.boolean() })),
  profile: () => request("/profile", { method: "GET" }, profileSchema),
  saveProfile: (p: Profile) => request("/profile", json("PUT", p), profileSchema),
  sessions: (from: string, to: string) =>
    request(
      `/sessions?${new URLSearchParams({ from, to })}`,
      { method: "GET" },
      z.array(sessionSchema),
    ),
  session: (id: string) => request(`/sessions/${encodeURIComponent(id)}`, { method: "GET" }, sessionSchema),
  createSession: (s: SessionInput) => request("/sessions", json("POST", s), sessionSchema),
  updateSession: (id: string, s: SessionInput) =>
    request(`/sessions/${encodeURIComponent(id)}`, json("PUT", s), sessionSchema),
  moveSession: (id: string, date: string) =>
    request(
      `/sessions/${encodeURIComponent(id)}/date`,
      json("PATCH", { date }),
      z.object({ session: sessionSchema, garmin: z.enum(["none", "moved", "failed"]) }),
    ),
  runs: (from: string, to: string) =>
    request(`/runs?${new URLSearchParams({ from, to })}`, { method: "GET" }, weekRunsSchema),
  deleteSession: (id: string) =>
    request(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, z.undefined()),
  parseImport: (image: Blob, startDate: string, group: string) => {
    const form = new FormData();
    form.append("startDate", startDate);
    form.append("group", group);
    form.append("image", image, "plan.jpg");
    return request(
      "/import/parse",
      { method: "POST", body: form },
      z.object({ sessions: z.array(datedParsed) }),
    );
  },
  parseImportText: (text: string, startDate: string, group: string) =>
    request(
      "/import/parse-text",
      json("POST", { text, startDate, group }),
      z.object({ sessions: z.array(datedParsed) }),
    ),
  saveImport: (sessions: SessionInput[]) =>
    request("/import/save", json("POST", { sessions }), z.array(sessionSchema)),
  exportSession: (id: string) =>
    request(
      `/sessions/${encodeURIComponent(id)}/export`,
      json("POST"),
      z.object({ id: z.string(), workoutId: z.string(), date: z.string() }),
    ),
  progress: (weeks: number) =>
    request(`/progress?${new URLSearchParams({ weeks: String(weeks) })}`, { method: "GET" }, progressSchema),
  syncProgress: () => request("/progress/sync", json("POST"), syncResultSchema),
  pushKey: () => request("/push/key", { method: "GET" }, z.object({ publicKey: z.string() })),
  pushSubscribe: (sub: PushSubscriptionJSON) => request("/push/subscribe", json("POST", sub), z.undefined()),
  pushUnsubscribe: (endpoint: string) => request("/push/unsubscribe", json("POST", { endpoint }), z.undefined()),
  pushTest: () => request("/push/test", json("POST"), z.object({ sent: z.number() })),
  reminder: () => request("/push/reminder", { method: "GET" }, reminderStateSchema),
  setReminder: (enabled: boolean, time: string) =>
    request("/push/reminder", json("PUT", { enabled, time }), reminderStateSchema),
  competitions: (all = false) =>
    request(`/competitions${all ? "?all=1" : ""}`, { method: "GET" }, competitionListSchema),
  setGoing: (id: string, going: boolean) =>
    request(`/competitions/${encodeURIComponent(id)}/going`, json("PUT", { going }), z.undefined()),
  importCalendar: (file: File) => {
    const form = new FormData();
    form.append("file", file, "calendrier.docx");
    return request("/competitions/import", { method: "POST", body: form }, calendarPreviewSchema);
  },
  saveCalendar: (preview: z.infer<typeof calendarPreviewSchema>) =>
    request(
      "/competitions/save",
      json("POST", { season: preview.season, rows: preview.rows }),
      z.object({ saved: z.number() }),
    ),
  weekCompetitions: (from: string, to: string) =>
    request(`/week-competitions?${new URLSearchParams({ from, to })}`, { method: "GET" }, weekCompetitionsSchema),
  users: () => request("/admin/users", { method: "GET" }, z.array(adminUserSchema)),
  inviteUser: (email: string, role: Role) =>
    request("/admin/users", json("POST", { email, role }), inviteSchema),
  reinviteUser: (id: string) =>
    request(`/admin/users/${encodeURIComponent(id)}/invite`, json("POST"), inviteSchema),
  removeUser: (id: string) =>
    request(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" }, z.undefined()),
  exportWeek: (from: string, to: string) =>
    request(
      "/export/week",
      json("POST", { from, to }),
      z.object({ results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })) }),
    ),
};

export type { Session, Profile };
