import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../../src/types.js";
import {
  isAllowedRedirect,
  rejectRedirect,
  makeClientRegistrationCallback,
} from "../../src/auth/client-policy.js";

const E = env as unknown as Env;
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";

describe("redirect allowlist", () => {
  it("allows Claude's callback", () => {
    expect(isAllowedRedirect(E, CLAUDE)).toBe(true);
    expect(rejectRedirect(E, CLAUDE)).toBeNull();
  });

  it("rejects an unknown redirect URI", () => {
    expect(isAllowedRedirect(E, "https://evil.example/cb")).toBe(false);
    expect(rejectRedirect(E, "https://evil.example/cb")).toMatch(/allowlist/);
  });

  it("rejects a missing redirect URI", () => {
    expect(rejectRedirect(E, undefined)).toMatch(/missing/);
  });

  it("rejects an unknown redirect even while discovery is on (log-and-reject)", () => {
    const discovery = { ...E, GEMINI_REDIRECT_DISCOVERY: "on" } as Env;
    expect(rejectRedirect(discovery, "https://accounts.google.com/unknown")).not.toBeNull();
  });
});

describe("client registration callback", () => {
  it("allows registration with only allowlisted redirect URIs", () => {
    const cb = makeClientRegistrationCallback(E);
    expect(cb({ clientMetadata: { redirect_uris: [CLAUDE] } })).toBeUndefined();
  });

  it("rejects registration containing a non-allowlisted redirect URI", () => {
    const cb = makeClientRegistrationCallback(E);
    const res = cb({ clientMetadata: { redirect_uris: [CLAUDE, "https://evil.example/cb"] } });
    expect(res).toBeTruthy();
    expect(res!.status).toBe(403);
  });

  it("rejects registration with no redirect URIs", () => {
    const cb = makeClientRegistrationCallback(E);
    const res = cb({ clientMetadata: {} });
    expect(res).toBeTruthy();
    expect(res!.status).toBe(400);
  });
});
