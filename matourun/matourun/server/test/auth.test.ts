import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";

const EMAIL = "mathys.ledanois@free.fr";
const PASSWORD = "un-mot-de-passe-solide";

let app: Express;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/matourun_test?host=/tmp",
    DATABASE_SSL: "false",
    AUTHORIZED_EMAILS: EMAIL,
    JWT_SECRET: "x".repeat(48),
    SETUP_CODE: "code-de-setup-123",
    APP_ORIGIN: "http://matourun.test",
  });
  const dbm = await import("../src/db.js");
  closeDb = dbm.closeDb;
  await dbm.migrate();
  await dbm.q("TRUNCATE users, refresh_tokens, profiles, sessions, app_secrets CASCADE");
  app = (await import("../src/app.js")).createApp();
});

afterAll(async () => closeDb?.());

const ORIGIN = { Origin: "http://matourun.test" };

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

describe("auth flow", () => {
  let access = "";
  let rt = "";
  let csrf = "";

  it("refuses unauthorized e-mails and wrong setup codes", async () => {
    let r = await request(app).post("/api/auth/status").set(ORIGIN).send({ email: "intrus@example.com" });
    expect(r.body).toEqual({ needsSetup: false });
    r = await request(app)
      .post("/api/auth/setup")
      .set(ORIGIN)
      .send({ email: "intrus@example.com", password: PASSWORD, setupCode: "code-de-setup-123" });
    expect(r.status).toBe(403);
    r = await request(app).post("/api/auth/setup").set(ORIGIN).send({ email: EMAIL, password: PASSWORD, setupCode: "mauvais" });
    expect(r.status).toBe(403);
  });

  it("lets the authorized user set a password once", async () => {
    let r = await request(app).post("/api/auth/status").set(ORIGIN).send({ email: EMAIL });
    expect(r.body).toEqual({ needsSetup: true });
    r = await request(app).post("/api/auth/setup").set(ORIGIN).send({ email: EMAIL, password: PASSWORD, setupCode: "code-de-setup-123" });
    expect(r.status).toBe(200);
    expect(r.body.accessToken).toBeTruthy();
    const c = cookies(r);
    expect(r.headers["set-cookie"]!.toString()).toMatch(/mr_rt=.*HttpOnly.*SameSite=Strict/i);
    rt = c.mr_rt!;
    csrf = c.mr_csrf!;
    access = r.body.accessToken;
    r = await request(app).post("/api/auth/setup").set(ORIGIN).send({ email: EMAIL, password: "autre-mot-de-passe!", setupCode: "code-de-setup-123" });
    expect(r.status).toBe(409);
  });

  it("protects the API with the access token", async () => {
    expect((await request(app).get("/api/profile")).status).toBe(401);
    expect((await request(app).get("/api/profile").set("Authorization", "Bearer abc.def.ghi")).status).toBe(401);
    const r = await request(app).get("/api/profile").set("Authorization", `Bearer ${access}`);
    expect(r.status).toBe(200);
    expect(r.body.pace10k).toBeTypeOf("number");
  });

  it("blocks cross-origin writes", async () => {
    const r = await request(app)
      .put("/api/profile")
      .set("Origin", "https://evil.example")
      .set("Authorization", `Bearer ${access}`)
      .send({});
    expect(r.status).toBe(403);
  });

  it("requires the CSRF header to refresh, rotates and detects reuse", async () => {
    let r = await request(app).post("/api/auth/refresh").set(ORIGIN).set("Cookie", `mr_rt=${rt}; mr_csrf=${csrf}`);
    expect(r.status).toBe(403);
    r = await request(app)
      .post("/api/auth/refresh")
      .set(ORIGIN)
      .set("Cookie", `mr_rt=${rt}; mr_csrf=${csrf}`)
      .set("X-CSRF-Token", csrf);
    expect(r.status).toBe(200);
    const next = cookies(r);
    expect(next.mr_rt).not.toBe(rt);
    // Replaying the old token kills the whole family, including the new one.
    r = await request(app).post("/api/auth/refresh").set(ORIGIN).set("Cookie", `mr_rt=${rt}; mr_csrf=${csrf}`).set("X-CSRF-Token", csrf);
    expect(r.status).toBe(401);
    r = await request(app)
      .post("/api/auth/refresh")
      .set(ORIGIN)
      .set("Cookie", `mr_rt=${next.mr_rt}; mr_csrf=${next.mr_csrf}`)
      .set("X-CSRF-Token", next.mr_csrf!);
    expect(r.status).toBe(401);
  });

  it("logs in, locks after repeated failures", async () => {
    let r = await request(app).post("/api/auth/login").set(ORIGIN).send({ email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(200);
    access = r.body.accessToken;
    for (let i = 0; i < 5; i++) {
      r = await request(app).post("/api/auth/login").set(ORIGIN).send({ email: EMAIL, password: "faux-mot-de-passe" });
      expect(r.status).toBe(401);
    }
    r = await request(app).post("/api/auth/login").set(ORIGIN).send({ email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(429);
  });

  it("stores sessions safely and validates them", async () => {
    const auth = { Authorization: `Bearer ${access}`, ...ORIGIN };
    let r = await request(app)
      .post("/api/sessions")
      .set(auth)
      .send({
        date: "2026-10-22",
        title: "'); DROP TABLE sessions; --",
        description: "<img src=x onerror=alert(1)>",
        blocks: [{ kind: "step", type: "warmup", end: { type: "time", seconds: 1800 }, target: { type: "easy" } }],
      });
    expect(r.status).toBe(201);
    expect(r.body.title).toBe("'); DROP TABLE sessions; --");
    r = await request(app).get("/api/sessions?from=2026-10-19&to=2026-10-25").set(auth);
    expect(r.body).toHaveLength(1);
    r = await request(app).get("/api/sessions?from=2026-10-19&to=1;DROP").set(auth);
    expect(r.status).toBe(400);
    r = await request(app).get("/api/sessions/not-a-uuid").set(auth);
    expect(r.status).toBe(400);
  });
});
