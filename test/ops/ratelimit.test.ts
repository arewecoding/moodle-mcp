import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env, UserProps } from "../../src/types.js";
import { withinRateLimit, type RateLimiter } from "../../src/ops/ratelimit.js";
import { mcpApiHandler } from "../../src/mcp/server.js";
import { stubFetch, moodleJson, type FetchStub } from "../_stubs.js";

const E = env as unknown as Env;
const PROPS: UserProps = { googleSub: "1234567890", email: "me@example.com", name: "Test User" };

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

/** Fake limiter allowing the first N calls per key, then denying. */
function fakeLimiter(allowed: number): RateLimiter {
  const counts = new Map<string, number>();
  return {
    limit: async ({ key }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= allowed };
    },
  };
}

describe("withinRateLimit", () => {
  it("allows everything when no limiter is configured", async () => {
    expect(await withinRateLimit(undefined, "k")).toBe(true);
  });

  it("fails open if the limiter throws", async () => {
    const throwing: RateLimiter = { limit: async () => { throw new Error("boom"); } };
    expect(await withinRateLimit(throwing, "k")).toBe(true);
  });

  it("enforces the limit per key", async () => {
    const l = fakeLimiter(1);
    expect(await withinRateLimit(l, "a")).toBe(true);
    expect(await withinRateLimit(l, "a")).toBe(false);
    expect(await withinRateLimit(l, "b")).toBe(true);
  });
});

describe("tool calls honor the rate limit", () => {
  it("returns a tool error once the per-user limit is exceeded", async () => {
    stub = stubFetch(() => moodleJson({ courses: [] }));
    const envLimited = { ...E, RATE_LIMITER: fakeLimiter(1) } as Env;
    const callOnce = async () => {
      const req = new Request("https://worker.example/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_courses", arguments: {} } }),
      });
      const ctx = { props: PROPS } as unknown as ExecutionContext;
      const resp = await mcpApiHandler.fetch!(req, envLimited, ctx);
      return (await resp.json()) as { result: { isError?: boolean; content: Array<{ text?: string }> } };
    };
    const first = await callOnce();
    expect(first.result.isError).toBeUndefined();
    const second = await callOnce();
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0]!.text).toMatch(/Rate limit/);
  });
});
