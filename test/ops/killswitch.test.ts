import { describe, it, expect, afterEach } from "vitest";
import { env, SELF } from "cloudflare:test";
import type { Env } from "../../src/types.js";
import { isKilled } from "../../src/ops/killswitch.js";

const E = env as unknown as Env;
const KEY = "killswitch:enabled";

afterEach(async () => {
  await E.OAUTH_KV.delete(KEY);
});

describe("kill switch", () => {
  it("isKilled is false by default and true when the flag is set", async () => {
    expect(await isKilled(E)).toBe(false);
    await E.OAUTH_KV.put(KEY, "1");
    expect(await isKilled(E)).toBe(true);
  });

  it("treats 0/false/empty as not killed", async () => {
    await E.OAUTH_KV.put(KEY, "0");
    expect(await isKilled(E)).toBe(false);
    await E.OAUTH_KV.put(KEY, "false");
    expect(await isKilled(E)).toBe(false);
  });

  it("returns 503 from the worker for every route when killed", async () => {
    await E.OAUTH_KV.put(KEY, "1");
    for (const path of ["/mcp", "/authorize", "/files/anything", "/health"]) {
      const resp = await SELF.fetch(`https://worker.example${path}`, { method: "GET" });
      expect(resp.status).toBe(503);
    }
  });
});
