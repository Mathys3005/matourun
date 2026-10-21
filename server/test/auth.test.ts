import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

const ADMIN = "admin@example.fr";
const MEMBER = "membre@example.fr";
const PASSWORD = "un-mot-de-passe-solide";
const SETUP_CODE = "code-de-setup-123";

let app: Express;
let q: (sql: string, params?: unknown[]) => Promise<unknown>;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/matourun_test?host=/tmp",
    DATABASE_SSL: "false",
    JWT_SECRET: "x".repeat(48),
    SETUP_CODE,
    APP_ORIGIN: "http://matourun.test",
  });
  const { resetEnvCache } = await import("../src/env.js");
  resetEnvCache();
  const dbm = await import("../src/db.js");
  closeDb = dbm.closeDb;
  q = dbm.q;
  await dbm.migrate();
  await dbm.q("TRUNCATE users, refresh_tokens, profiles, sessions, app_secrets CASCADE");
  app = (await import("../src/app.js")).createApp();
});

afterAll(async () => closeDb?.());

const ORIGIN = { Origin: "http://matourun.test" };
const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, ...ORIGIN });

function cookies(res: request.Response): Record<string, string> {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return Object.fromEntries(
    (raw ?? []).map((c) => {
      const [kv] = c.split(";");
      const i = kv!.indexOf("=");
      return [kv!.slice(0, i), kv!.slice(i + 1)];
    }),
  );
}

const status = (email: string) => request(app).post("/api/auth/status").set(ORIGIN).send({ email });
const setup = (email: string, setupCode: string, password = PASSWORD) =>
  request(app).post("/api/auth/setup").set(ORIGIN).send({ email, password, setupCode });

describe("first account (bootstrap)", () => {
  it("needs the server SETUP_CODE and makes the first account admin", async () => {
    expect((await status(ADMIN)).body).toEqual({ needsSetup: true });
    expect((await setup(ADMIN, "mauvais-code")).status).toBe(403);
    const r = await setup(ADMIN, SETUP_CODE);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ email: ADMIN, role: "admin" });
    expect(r.headers["set-cookie"]!.toString()).toMatch(/mr_rt=.*HttpOnly.*SameSite=Strict/i);
  });

  it("closes once an account exists", async () => {
    expect((await status("intrus@example.com")).body).toEqual({ needsSetup: false });
    expect((await setup("intrus@example.com", SETUP_CODE)).status).toBe(403);
    expect((await setup(ADMIN, SETUP_CODE, "autre-mot-de-passe!")).status).toBe(403);
  });
});

describe("sessions and tokens", () => {
  let access = "";
  let rt = "";
  let csrf = "";

  beforeAll(async () => {
    const r = await request(app).post("/api/auth/login").set(ORIGIN).send({ email: ADMIN, password: PASSWORD });
    access = r.body.accessToken;
    const c = cookies(r);
    rt = c.mr_rt!;
    csrf = c.mr_csrf!;
  });

  it("protects the API with the access token", async () => {
    expect((await request(app).get("/api/profile")).status).toBe(401);
    expect((await request(app).get("/api/profile").set("Authorization", "Bearer abc.def.ghi")).status).toBe(401);
    const r = await request(app).get("/api/profile").set(bearer(access));
    expect(r.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set(bearer(access))).body).toEqual({ email: ADMIN, role: "admin" });
  });

  it("blocks cross-origin writes", async () => {
    const r = await request(app).put("/api/profile").set("Origin", "https://evil.example").set("Authorization", `Bearer ${access}`).send({});
    expect(r.status).toBe(403);
  });

  it("requires the CSRF header to refresh, rotates and detects reuse", async () => {
    let r = await request(app).post("/api/auth/refresh").set(ORIGIN).set("Cookie", `mr_rt=${rt}; mr_csrf=${csrf}`);
    expect(r.status).toBe(403);
    r = await request(app).post("/api/auth/refresh").set(ORIGIN).set("Cookie", `mr_rt=${rt}; mr_csrf=${csrf}`).set("X-CSRF-Token", csrf);
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("admin");
    const next = cookies(r);
    expect(next.mr_rt).not.toBe(rt);
    r = await request(app).post("/api/auth/refresh").set(ORIGIN).set("Cookie", `mr_rt=${rt}; mr_csrf=${csrf}`).set("X-CSRF-Token", csrf);
    expect(r.status).toBe(401);
    r = await request(app).post("/api/auth/refresh").set(ORIGIN).set("Cookie", `mr_rt=${next.mr_rt}; mr_csrf=${next.mr_csrf}`).set("X-CSRF-Token", next.mr_csrf!);
    expect(r.status).toBe(401);
  });

  it("stores sessions safely and validates them", async () => {
    let r = await request(app)
      .post("/api/sessions")
      .set(bearer(access))
      .send({
        date: "2026-10-22",
        title: "'); DROP TABLE sessions; --",
        description: "<img src=x onerror=alert(1)>",
        blocks: [{ kind: "step", type: "warmup", end: { type: "time", seconds: 1800 }, target: { type: "easy" } }],
      });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe("'); DROP TABLE sessions; --");
    r = await request(app).get("/api/sessions?from=2026-10-19&to=2026-10-25").set(bearer(access));
    expect(r.body).toHaveLength(1);
    expect((await request(app).get("/api/sessions?from=2026-10-19&to=1;DROP").set(bearer(access))).status).toBe(400);
    expect((await request(app).get("/api/sessions/not-a-uuid").set(bearer(access))).status).toBe(400);
  });
});

describe("invitations and admin", () => {
  let admin = "";
  let adminId = "";
  let member = "";
  let memberRt = "";
  let memberCsrf = "";
  let memberId = "";

  beforeAll(async () => {
    const r = await request(app).post("/api/auth/login").set(ORIGIN).send({ email: ADMIN, password: PASSWORD });
    admin = r.body.accessToken;
    const users = await request(app).get("/api/admin/users").set(bearer(admin));
    adminId = users.body.find((u: { email: string }) => u.email === ADMIN).id;
  });

  it("invites a member with a one-time code", async () => {
    const r = await request(app).post("/api/admin/users").set(bearer(admin)).send({ email: MEMBER.toUpperCase() });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: MEMBER, role: "member", status: "invited" });
    expect(r.body.inviteCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    memberId = r.body.user.id;
    const code: string = r.body.inviteCode;

    expect((await status(MEMBER)).body).toEqual({ needsSetup: true });
    expect((await setup(MEMBER, SETUP_CODE)).status).toBe(403);
    expect((await setup(MEMBER, "AAAA-BBBB-CCCC")).status).toBe(403);

    // Lower case and no dashes are accepted.
    const ok = await setup(MEMBER, code.toLowerCase().replace(/-/g, ""));
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("member");
    member = ok.body.accessToken;
    const c = cookies(ok);
    memberRt = c.mr_rt!;
    memberCsrf = c.mr_csrf!;

    // The code is consumed.
    expect((await setup(MEMBER, code, "encore-un-autre-mdp")).status).toBe(403);
    expect((await request(app).post("/api/admin/users").set(bearer(admin)).send({ email: MEMBER })).status).toBe(409);
  });

  it("keeps the admin area to admins", async () => {
    expect((await request(app).get("/api/admin/users").set(bearer(member))).status).toBe(403);
    expect((await request(app).post("/api/admin/users").set(bearer(member)).send({ email: "x@y.fr" })).status).toBe(403);
    const list = await request(app).get("/api/admin/users").set(bearer(admin));
    expect(list.body.map((u: { email: string }) => u.email).sort()).toEqual([ADMIN, MEMBER]);
  });

  it("refuses expired invitations", async () => {
    const r = await request(app).post("/api/admin/users").set(bearer(admin)).send({ email: "tard@example.fr" });
    await q(`UPDATE users SET invite_expires_at = now() - interval '1 minute' WHERE email = $1`, ["tard@example.fr"]);
    expect((await setup("tard@example.fr", r.body.inviteCode)).status).toBe(403);
    const list = await request(app).get("/api/admin/users").set(bearer(admin));
    expect(list.body.find((u: { email: string }) => u.email === "tard@example.fr").status).toBe("expired");
    const again = await request(app).post(`/api/admin/users/${r.body.user.id}/invite`).set(bearer(admin));
    expect(again.status).toBe(200);
    expect((await setup("tard@example.fr", again.body.inviteCode)).status).toBe(200);
  });

  it("removes access immediately", async () => {
    expect((await request(app).delete(`/api/admin/users/${adminId}`).set(bearer(admin))).status).toBe(400);
    expect((await request(app).delete(`/api/admin/users/${memberId}`).set(bearer(admin))).status).toBe(204);
    expect((await request(app).get("/api/profile").set(bearer(member))).status).toBe(401);
    const r = await request(app)
      .post("/api/auth/refresh")
      .set(ORIGIN)
      .set("Cookie", `mr_rt=${memberRt}; mr_csrf=${memberCsrf}`)
      .set("X-CSRF-Token", memberCsrf);
    expect(r.status).toBe(401);
    expect((await request(app).post("/api/auth/login").set(ORIGIN).send({ email: MEMBER, password: PASSWORD })).status).toBe(401);
  });
});

describe("brute force", () => {
  it("locks after repeated failures", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post("/api/auth/login").set(ORIGIN).send({ email: ADMIN, password: "faux-mot-de-passe" });
      expect(r.status).toBe(401);
    }
    const r = await request(app).post("/api/auth/login").set(ORIGIN).send({ email: ADMIN, password: PASSWORD });
    expect(r.status).toBe(429);
  });
});
