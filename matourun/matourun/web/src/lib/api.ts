import { z } from "zod";
import {
  profileSchema,
  sessionSchema,
  parsedSessionSchema,
  isoDateSchema,
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

const sessionResponse = z.object({ accessToken: z.string(), email: z.string() });

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

export async function refresh(): Promise<string | null> {
  refreshing ??= (async () => {
    const res = await authPost("refresh").catch(() => null);
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
  let res = await send();
  if (res.status === 401) {
    if (!(await refresh())) {
      onLoggedOut();
      throw new ApiError(401, "Session expirée");
    }
    res = await send();
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
    return s.email;
  },
  async setup(email: string, password: string, setupCode: string) {
    const res = await authPost("setup", { email, password, setupCode });
    if (!res.ok) throw await readError(res);
    const s = sessionResponse.parse(await res.json());
    accessToken = s.accessToken;
    return s.email;
  },
  async logout() {
    await authPost("logout").catch(() => null);
    accessToken = null;
  },
  async resume(): Promise<string | null> {
    if (!(await refresh())) return null;
    return request("/auth/me", { method: "GET" }, z.object({ email: z.string() })).then((r) => r.email);
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
  saveImport: (sessions: SessionInput[]) =>
    request("/import/save", json("POST", { sessions }), z.array(sessionSchema)),
  exportSession: (id: string) =>
    request(
      `/sessions/${encodeURIComponent(id)}/export`,
      json("POST"),
      z.object({ id: z.string(), workoutId: z.string(), date: z.string() }),
    ),
  exportWeek: (from: string, to: string) =>
    request(
      "/export/week",
      json("POST", { from, to }),
      z.object({ results: z.array(z.object({ id: z.string(), ok: z.boolean(), error: z.string().optional() })) }),
    ),
};

export type { Session, Profile };
