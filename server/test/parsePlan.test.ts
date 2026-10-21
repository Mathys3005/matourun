import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgres://unused",
    JWT_SECRET: "x".repeat(40),
    SETUP_CODE: "12345678",
    GEMINI_API_KEY: "test-key",
  });
});
afterEach(() => vi.unstubAllGlobals());

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("parsePlanImage with Gemini", () => {
  it("validates and normalizes the model's JSON", async () => {
    const { resetEnvCache } = await import("../src/env.js");
    resetEnvCache();
    const plan = {
      sessions: [
        {
          title: "Seuil",
          description: "30' puis 8' allure 10k + 20\"",
          blocks: [
            { kind: "step", type: "warmup", end: { type: "time", seconds: 1800.0 }, target: { type: "easy" } },
            { kind: "step", type: "interval", end: { type: "time", seconds: 480 }, target: { type: "pace", ref: "10k", offsetSec: 20.4 } },
          ],
        },
      ],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify(plan) + "\n```" }] } }] })));
    vi.stubGlobal("fetch", fetchMock);
    const { parsePlanImage } = await import("../src/lib/parsePlan.js");
    const out = await parsePlanImage(PNG, "image/png", "Adultes");
    expect(out[0]!.blocks[1]).toMatchObject({ target: { offsetSec: 20 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("rejects malformed model output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"sessions":[{"title":"x","blocks":[{"kind":"evil"}]}]}' }] } }] }))));
    const { parsePlanImage } = await import("../src/lib/parsePlan.js");
    await expect(parsePlanImage(PNG, "image/png", "")).rejects.toMatchObject({ status: 422 });
  });
});
