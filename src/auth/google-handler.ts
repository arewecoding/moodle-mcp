import { Hono } from "hono";
import { EncryptJWT, jwtDecrypt, jwtVerify, createRemoteJWKSet } from "jose";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env, UserProps } from "../types.js";
import { rejectRedirect } from "./client-policy.js";
import { handleDownload } from "../files/download.js";
import { log } from "../ops/log.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const STATE_COOKIE = "mcp_oauth_state";
const STATE_TTL_SECONDS = 600;

type HonoEnv = { Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } };

interface StatePayload {
  req: AuthRequest;
  nonce: string;
  state: string;
  callback: string;
}

async function cookieKey(env: Env): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.COOKIE_ENCRYPTION_KEY));
  return new Uint8Array(digest);
}

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function originOf(req: Request): string {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
function googleJwks() {
  if (!jwksCache) jwksCache = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return jwksCache;
}

export const googleApp = new Hono<HonoEnv>();

googleApp.get("/health", (c) => c.text("ok"));

/**
 * Signed file download (U5/KTD6). No bearer token required — the signed link is
 * the capability. Verification, re-resolution, and streaming live in
 * handleDownload; the Moodle token is appended server-side and never leaks here.
 */
googleApp.get("/files/:token", (c) => handleDownload(c.env, c.req.param("token")));

/**
 * Step 1 of the OAuth round trip. Parse and validate the MCP client's request
 * (OAuthProvider checks the client and PKCE), re-check the redirect allowlist,
 * stash the request in an encrypted short-lived cookie, and bounce to Google.
 */
googleApp.get("/authorize", async (c) => {
  const env = c.env;
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch {
    return c.text("Invalid authorization request.", 400);
  }

  const reason = rejectRedirect(env, authReq.redirectUri);
  if (reason) return c.text(`Authorization refused: ${reason}.`, 403);

  const nonce = randomToken();
  const state = randomToken();
  const callback = `${originOf(c.req.raw)}/callback`;
  const payload: StatePayload = { req: authReq, nonce, state, callback };

  const jwe = await new EncryptJWT({ p: payload as unknown as Record<string, unknown> })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${STATE_TTL_SECONDS}s`)
    .encrypt(await cookieKey(env));

  c.header(
    "Set-Cookie",
    `${STATE_COOKIE}=${jwe}; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=${STATE_TTL_SECONDS}`,
  );

  const g = new URL(GOOGLE_AUTH_URL);
  g.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  g.searchParams.set("redirect_uri", callback);
  g.searchParams.set("response_type", "code");
  g.searchParams.set("scope", "openid email profile");
  g.searchParams.set("state", state);
  g.searchParams.set("nonce", nonce);
  g.searchParams.set("access_type", "online");
  g.searchParams.set("prompt", "select_account");
  return c.redirect(g.toString(), 302);
});

/**
 * Step 2. Google redirects back here. Verify the state cookie, exchange the
 * code, verify the ID token (iss/aud/exp/nonce/email_verified), admit only the
 * single configured Google sub (KTD2), then complete the MCP authorization.
 */
googleApp.get("/callback", async (c) => {
  const env = c.env;
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  if (!code || !returnedState) return c.text("Missing code or state.", 400);

  const raw = getCookie(c.req.raw, STATE_COOKIE);
  if (!raw) return c.text("Missing or expired sign-in state.", 400);

  let payload: StatePayload;
  try {
    const { payload: decoded } = await jwtDecrypt(raw, await cookieKey(env));
    payload = (decoded as { p: StatePayload }).p;
  } catch {
    return c.text("Invalid sign-in state.", 400);
  }
  if (returnedState !== payload.state) return c.text("State mismatch.", 400);

  // Exchange the code for tokens.
  const tokenResp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: payload.callback,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResp.ok) {
    log({ event: "google.token.fail", status: tokenResp.status });
    return c.text("Google sign-in failed.", 401);
  }
  const tokens = (await tokenResp.json()) as { id_token?: string };
  if (!tokens.id_token) return c.text("Google returned no ID token.", 401);

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, googleJwks(), {
      audience: env.GOOGLE_CLIENT_ID,
    });
    claims = verified.payload as Record<string, unknown>;
  } catch {
    return c.text("Could not verify Google identity.", 401);
  }

  const iss = String(claims["iss"] ?? "");
  if (!GOOGLE_ISSUERS.includes(iss)) return c.text("Untrusted token issuer.", 401);
  if (String(claims["nonce"] ?? "") !== payload.nonce) return c.text("Nonce mismatch.", 401);
  if (claims["email_verified"] !== true) return c.text("Email not verified.", 403);

  const sub = String(claims["sub"] ?? "");
  if (!sub || sub !== env.ALLOWED_GOOGLE_SUB) {
    log({ event: "google.sub.denied" });
    return c.text("This Google account is not permitted to use this connector.", 403);
  }

  const props: UserProps = {
    googleSub: sub,
    email: String(claims["email"] ?? ""),
    name: String(claims["name"] ?? ""),
  };

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: payload.req,
    userId: sub,
    metadata: {},
    scope: payload.req.scope,
    props,
  });

  c.header("Set-Cookie", `${STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/callback; Max-Age=0`);
  return c.redirect(redirectTo, 302);
});

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}
