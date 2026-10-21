import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";

const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

const garminList = [
  { activityId: 11, activityName: "Seuil", startTimeLocal: `${day(0)} 07:30:00`, activityType: { typeKey: "running" }, distance: 12000, duration: 3000, movingDuration: 2940, averageHR: 158, elevationGain: 40 },
  { activityId: 12, activityName: "Vélo", startTimeLocal: `${day(-1)} 18:00:00`, activityType: { typeKey: "cycling" }, distance: 30000, duration: 3600 },
  { activityId: 13, activityName: "Trail", startTimeLocal: `${day(-8)} 09:00:00`, activityType: { typeKey: "trail_running" }, distance: 20000, duration: 7200, elevationGain: 600 },
  { activityId: "pas-un-nombre", startTimeLocal: "hier", activityType: { typeKey: "running" } },
  { activityId: 14, activityName: "Très ancienne", startTimeLocal: `${day(-400)} 09:00:00`, activityType: { typeKey: "running" }, distance: 5000, duration: 1500 },
];
const listCalls: string[] = [];
const splitCalls: string[] = [];

vi.mock("garmin-connect", () => ({
  default: {
    GarminConnect: class {
      private t: unknown = null;
      login = vi.fn();
      exportToken = () => this.t;
      loadToken(oauth1: unknown, oauth2: unknown) {
        this.t = { oauth1, oauth2 };
      }
      async get(url: string) {
        if (url.includes("/splits")) {
          splitCalls.push(url);
          // Run 11: 2 easy km, 3 km at 10k pace, 1 short sprint (ignored).
          return {
            lapDTOs: url.includes("/11/")
              ? [
                  { lapIndex: 1, distance: 1000, duration: 330, movingDuration: 330, averageHR: 140, averageRunCadence: 170 },
                  { lapIndex: 2, distance: 1000, duration: 325, movingDuration: 325, averageHR: 142, averageRunCadence: 171 },
                  { lapIndex: 3, distance: 1000, duration: 236, movingDuration: 236, averageHR: 170, averageRunCadence: 182 },
                  { lapIndex: 4, distance: 1000, duration: 234, movingDuration: 234, averageHR: 172, averageRunCadence: 183 },
                  { lapIndex: 5, distance: 1000, duration: 235, movingDuration: 235, averageHR: 174, averageRunCadence: 184 },
                  { lapIndex: 6, distance: 150, duration: 25, movingDuration: 25, averageHR: 160 },
                  { lapIndex: "bad" },
                ]
              : [],
          };
        }
        if (url.includes("activitylist-service")) {
          listCalls.push(url);
          return new URL(url).searchParams.get("start") === "0" ? garminList : [];
        }
        return {};
      }
      async post() {
        return {};
      }
      client = { delete: async () => ({}) };
    },
  },
}));

let app: Express;
let closeDb: () => Promise<void>;
const ORIGIN = { Origin: "http://matourun.test" };
let admin = "";
let member = "";

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/matourun_test?host=/tmp",
    DATABASE_SSL: "false",
    JWT_SECRET: "x".repeat(48),
    SETUP_CODE: "code-de-setup-123",
    APP_ORIGIN: "http://matourun.test",
    GARMIN_TOKENS: Buffer.from(
      JSON.stringify({ oauth1: { oauth_token: "a", oauth_token_secret: "b" }, oauth2: { access_token: "c", expires_at: 9e9 } }),
    ).toString("base64url"),
  });
  const { resetEnvCache } = await import("../src/env.js");
  resetEnvCache();
  const dbm = await import("../src/db.js");
  closeDb = dbm.closeDb;
  await dbm.migrate();
  await dbm.q("TRUNCATE users, refresh_tokens, profiles, sessions, app_secrets, activities CASCADE");
  app = (await import("../src/app.js")).createApp();

  admin = (await request(app).post("/api/auth/setup").set(ORIGIN).send({ email: "admin@example.fr", password: "mot-de-passe-admin", setupCode: "code-de-setup-123" })).body.accessToken;
  const inv = await request(app).post("/api/admin/users").set({ Authorization: `Bearer ${admin}`, ...ORIGIN }).send({ email: "membre@example.fr" });
  member = (await request(app).post("/api/auth/setup").set(ORIGIN).send({ email: "membre@example.fr", password: "mot-de-passe-membre", setupCode: inv.body.inviteCode })).body.accessToken;

  // A planned session today, to check the "planned vs done" match.
  await request(app)
    .post("/api/sessions")
    .set({ Authorization: `Bearer ${admin}`, ...ORIGIN })
    .send({ date: day(0), title: "Seuil 8-6-4-2-8", blocks: [{ kind: "step", type: "interval", end: { type: "time", seconds: 3600 }, target: { type: "easy" } }] });
});

afterAll(async () => closeDb?.());

const as = (t: string) => ({ Authorization: `Bearer ${t}`, ...ORIGIN });

describe("Progression", () => {
  it("syncs only well-formed runs from the last year, idempotently", async () => {
    let r = await request(app).post("/api/progress/sync").set(as(admin));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, total: 2 });
    expect(listCalls).toHaveLength(1);
    expect(splitCalls).toHaveLength(2); // laps of both runs

    // A second sync right away doesn't hit Garmin.
    r = await request(app).post("/api/progress/sync").set(as(admin));
    expect(r.status).toBe(200);
    expect(listCalls).toHaveLength(1);
  });

  it("aggregates planned vs done per week", async () => {
    const r = await request(app).get("/api/progress?weeks=12").set(as(admin));
    expect(r.status).toBe(200);
    const { weeks, activities, records, days, sync } = r.body;
    expect(weeks).toHaveLength(12);
    const current = weeks[11];
    expect(current.doneKm).toBe(12);
    expect(current.doneCount).toBe(1);
    expect(current.plannedCount).toBe(1);
    expect(current.plannedKm).toBeGreaterThan(10);
    expect(current.paceSec).toBe(245); // 2940 s / 12 km
    const totalDone = weeks.reduce((s: number, w: { doneKm: number }) => s + w.doneKm, 0);
    expect(totalDone).toBe(32);
    expect(activities[0]).toMatchObject({ name: "Seuil", km: 12, plannedTitle: "Seuil 8-6-4-2-8", avgHr: 158 });
    expect(records.longestKm.value).toBe(20);
    expect(records.bestPaceSec.value).toBe(245);
    expect(records.streakWeeks).toBeGreaterThanOrEqual(1);
    expect(days.map((d: { date: string }) => d.date)).toContain(day(0));
    expect(sync).toMatchObject({ canSync: true, hasActivities: true });
  });

  it("isolates the laps run at 10k pace and the easy runs", async () => {
    const r = await request(app).get("/api/progress?weeks=12").set(as(admin));
    const zone = (k: string) => r.body.zones.find((z: { key: string }) => z.key === k);
    const tenK = zone("10k").weeks[11];
    expect(tenK).toMatchObject({ paceSec: 235, hr: 172, cadence: 183, minutes: 12 });
    expect(zone("5k").minutes).toBe(0);
    // The trail run (no laps, easy average pace) counts as a footing.
    expect(zone("footing").minutes).toBe(120);
    expect(r.body.lapsPending).toBe(0);
  });

  it("keeps each person's data and Garmin sync to themselves", async () => {
    expect((await request(app).post("/api/progress/sync").set(as(member))).status).toBe(403);
    const r = await request(app).get("/api/progress?weeks=26").set(as(member));
    expect(r.status).toBe(200);
    expect(r.body.activities).toEqual([]);
    expect(r.body.sync).toMatchObject({ canSync: false, hasActivities: false });
    expect((await request(app).get("/api/progress?weeks=7").set(as(member))).status).toBe(400);
  });
});
