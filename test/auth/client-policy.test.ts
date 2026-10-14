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

  it("allows a redirect added via EXTRA_REDIRECT_URIS (secret) and still rejects others", () => {
    const gemini = "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123-moodle";
    const withExtra = { ...E, EXTRA_REDIRECT_URIS: gemini } as Env;
    expect(isAllowedRedirect(withExtra, gemini)).toBe(true);
    expect(isAllowedRedirect(withExtra, CLAUDE)).toBe(true); // committed default still works
    expect(isAllowedRedirect(withExtra, "https://evil.example/cb")).toBe(false);
  });

  it("rejects a missing redirect URI", () => {
    expect(rejectRedirect(E, undefined)).toMatch(/missing/);
  });

  it("allows all of Gemini's user-bound redirects for this owner's sub, rejects other subs/hosts", () => {
    // Test env ALLOWED_GOOGLE_SUB = 1234567890. Gemini sends 3 hosts x 2 prefixes.
    const hosts = [
      "oauth-redirect.googleusercontent.com",
      "oauth-redirect-sandbox.googleusercontent.com",
      "oauth-redirect-test.googleusercontent.com",
    ];
    for (const h of hosts) {
      for (const p of ["r", "a"]) {
        expect(isAllowedRedirect(E, `https://${h}/${p}/user_bound_custom-mcp-1234567890-moodle_x`)).toBe(true);
      }
    }
    // Another account's sub is rejected on every host/prefix.
    expect(isAllowedRedirect(E, "https://oauth-redirect.googleusercontent.com/a/user_bound_custom-mcp-9999999999-x")).toBe(false);
    // A look-alike host is rejected.
    expect(isAllowedRedirect(E, "https://evil.googleusercontent.com/r/user_bound_custom-mcp-1234567890-x")).toBe(false);
    // A different path shape is rejected.
    expect(isAllowedRedirect(E, "https://oauth-redirect.googleusercontent.com/x/user_bound_custom-mcp-1234567890-x")).toBe(false);
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
