import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const login = vi.fn(async () => {
  throw new Error('ERROR: (429), Too Many Requests, "Rate limited"');
});

vi.mock("garmin-connect", () => ({
  default: {
    GarminConnect: class {
      login = login;
      exportToken = () => ({ oauth1: {}, oauth2: {} });
      loadToken() {}
      async get() {
        return {};
      }
      async post() {
        return {};
      }
      client = { delete: async () => ({}) };
    },
  },
}));

let closeDb: () => Promise<void>;

beforeAll(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/matourun_test?host=/tmp",
    DATABASE_SSL: "false",
    JWT_SECRET: "x".repeat(48),
    SETUP_CODE: "12345678",
    GARMIN_EMAIL: "runner@example.com",
    GARMIN_PASSWORD: "secret",
  });
  const { resetEnvCache } = await import("../src/env.js");
  resetEnvCache();
  const dbm = await import("../src/db.js");
  closeDb = dbm.closeDb;
  await dbm.migrate();
  await dbm.q("DELETE FROM app_secrets");
});

afterAll(async () => closeDb?.());

describe("Garmin sign-in cooldown", () => {
  it("signs in once, then refuses new attempts during the cooldown", async () => {
    const { createWorkout } = await import("../src/lib/garminClient.js");
    await expect(createWorkout({})).rejects.toMatchObject({ status: 429 });
    await expect(createWorkout({})).rejects.toMatchObject({
      status: 429,
      message: expect.stringMatching(/Nouvel essai possible à \d{2}:\d{2}/),
    });
    await expect(createWorkout({})).rejects.toMatchObject({ status: 429 });
    expect(login).toHaveBeenCalledTimes(1);
  });
});
