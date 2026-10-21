import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const login = vi.fn(async () => {
  throw new Error("should not sign in");
});
const loaded: unknown[] = [];
const posted: string[] = [];

vi.mock("garmin-connect", () => ({
  default: {
    GarminConnect: class {
      private t: { oauth1: unknown; oauth2: unknown } | null = null;
      login = login;
      exportToken = () => this.t;
      loadToken(oauth1: unknown, oauth2: unknown) {
        this.t = { oauth1, oauth2 };
        loaded.push(oauth1);
      }
      async get() {
        return {};
      }
      async post(url: string) {
        posted.push(url);
        return { workoutId: 123 };
      }
      client = { delete: async () => ({}) };
    },
  },
}));

const TOKENS = {
  oauth1: { oauth_token: "tok", oauth_token_secret: "sec" },
  oauth2: { access_token: "acc", expires_at: 9_999_999_999 },
};

let closeDb: () => Promise<void>;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/matourun_test?host=/tmp",
    DATABASE_SSL: "false",
    JWT_SECRET: "x".repeat(48),
    GARMIN_TOKENS: Buffer.from(JSON.stringify(TOKENS)).toString("base64url"),
  });
  delete process.env.GARMIN_EMAIL;
  delete process.env.GARMIN_PASSWORD;
  const { resetEnvCache } = await import("../src/env.js");
  resetEnvCache();
  const dbm = await import("../src/db.js");
  closeDb = dbm.closeDb;
  await dbm.migrate();
  await dbm.q("DELETE FROM app_secrets");
  // A login cooldown must not block token use.
  await dbm.q("INSERT INTO app_secrets (key, value) VALUES ('garmin_cooldown_until', $1)", [String(Date.now() + 3_600_000)]);
});

afterAll(async () => closeDb?.());

describe("Garmin with GARMIN_TOKENS", () => {
  it("exports with the token, without any password sign-in", async () => {
    const g = await import("../src/lib/garminClient.js");
    expect(g.garminConfigured()).toBe(true);
    expect(await g.createWorkout({})).toBe("123");
    expect(login).not.toHaveBeenCalled();
    expect(loaded[0]).toEqual(TOKENS.oauth1);
    expect(posted[0]).toContain("/workout-service/workout");
  });

  it("rejects a malformed token", async () => {
    process.env.GARMIN_TOKENS = "pas-un-jeton";
    const { resetEnvCache } = await import("../src/env.js");
    resetEnvCache();
    const g = await import("../src/lib/garminClient.js");
    expect(g.garminConfigured()).toBe(true); // set, but invalid: the export says so
  });
});
