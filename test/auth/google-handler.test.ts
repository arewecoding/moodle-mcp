import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { SELF } from "cloudflare:test";
import { generateKeyPair, exportJWK, SignJWT, type KeyLike, type JWK } from "jose";
import { stubFetch, type FetchStub } from "../_stubs.js";

const ORIGIN = "https://worker.example";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const AUD = "test-google-client-id.apps.googleusercontent.com";
const ALLOWED_SUB = "1234567890";

let privateKey: KeyLike;
let publicJwk: JWK;

beforeAll(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = { ...(await exportJWK(kp.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
});

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

async function makeIdToken(sub: string, nonce: string, emailVerified = true): Promise<string> {
  return new SignJWT({ email: "user@example.com", email_verified: emailVerified, name: "User", nonce })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(AUD)
    .setIssuedAt()
    .setExpirationTime("5m")
    .setSubject(sub)
    .sign(privateKey);
}

/** Stub Google's token endpoint (returns our signed id_token) and JWKS. */
function stubGoogle(idTokenFor: (nonce: string) => Promise<string>, capturedNonce: () => string) {
  stub = stubFetch(async (req) => {
    if (req.url.includes("oauth2.googleapis.com/token")) {
      const idToken = await idTokenFor(capturedNonce());
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.url.includes("googleapis.com/oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });
}

async function registerClient(): Promise<string> {
  const resp = await SELF.fetch(`${ORIGIN}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [CLAUDE],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Test Client",
    }),
  });
  expect(resp.status).toBeLessThan(400);
  const body = (await resp.json()) as { client_id: string };
  return body.client_id;
}

/** Drive /authorize and capture the state cookie + the nonce handed to Google. */
async function authorize(clientId: string): Promise<{ cookie: string; googleState: string; nonce: string }> {
  // A fixed PKCE pair (challenge for verifier "abc123..."); the provider only
  // needs a well-formed S256 challenge at /authorize.
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const url =
    `${ORIGIN}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(CLAUDE)}&scope=moodle.read&state=clientstate` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  const resp = await SELF.fetch(url, { redirect: "manual" });
  expect(resp.status).toBe(302);
  const location = resp.headers.get("location")!;
  expect(location).toContain("accounts.google.com");
  const g = new URL(location);
  const setCookie = resp.headers.get("set-cookie")!;
  const cookie = setCookie.split(";")[0]!;
  return { cookie, googleState: g.searchParams.get("state")!, nonce: g.searchParams.get("nonce")! };
}

describe("Google single-account OAuth (AE1)", () => {
  it("rejects a Google account whose sub is not the allowed one", async () => {
    const clientId = await registerClient();
    const { cookie, googleState, nonce } = await authorize(clientId);
    stubGoogle((n) => makeIdToken("9999999999", n), () => nonce);

    const resp = await SELF.fetch(`${ORIGIN}/callback?code=abc&state=${googleState}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(resp.status).toBe(403);
  });

  it("rejects the allowed sub when email is unverified", async () => {
    const clientId = await registerClient();
    const { cookie, googleState, nonce } = await authorize(clientId);
    stubGoogle((n) => makeIdToken(ALLOWED_SUB, n, false), () => nonce);

    const resp = await SELF.fetch(`${ORIGIN}/callback?code=abc&state=${googleState}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(resp.status).toBe(403);
  });

  it("admits the allowed sub and redirects back to the client with a code", async () => {
    const clientId = await registerClient();
    const { cookie, googleState, nonce } = await authorize(clientId);
    stubGoogle((n) => makeIdToken(ALLOWED_SUB, n), () => nonce);

    const resp = await SELF.fetch(`${ORIGIN}/callback?code=abc&state=${googleState}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    const loc = resp.headers.get("location")!;
    expect(loc.startsWith(CLAUDE)).toBe(true);
    expect(loc).toContain("code=");
  });

  it("rejects a state that does not match the cookie", async () => {
    const clientId = await registerClient();
    const { cookie, nonce } = await authorize(clientId);
    stubGoogle((n) => makeIdToken(ALLOWED_SUB, n), () => nonce);

    const resp = await SELF.fetch(`${ORIGIN}/callback?code=abc&state=WRONGSTATE`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(resp.status).toBe(400);
  });
});

describe("protected resource metadata and discovery", () => {
  it("challenges unauthenticated /mcp with a 401 pointing at resource metadata", async () => {
    const resp = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(resp.status).toBe(401);
    expect(resp.headers.get("www-authenticate") ?? "").toMatch(/resource_metadata/i);
  });

  it("serves protected-resource metadata whose resource is the /mcp URL", async () => {
    const resp = await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { resource: string };
    expect(body.resource).toBe(`${ORIGIN}/mcp`);
  });

  it("advertises S256 PKCE and CIMD support in authorization-server metadata", async () => {
    const resp = await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      code_challenge_methods_supported?: string[];
      token_endpoint_auth_methods_supported?: string[];
    };
    expect(body.code_challenge_methods_supported).toContain("S256");
    expect(body.token_endpoint_auth_methods_supported).toContain("none");
  });
});
