import type { Env } from "../types.js";
import { log } from "../ops/log.js";

/**
 * Redirect-URI allowlist (KTD3). Client registration is open by protocol (DCR +
 * CIMD), but closed by this allowlist: a client may register and authorize only
 * with a redirect URI on the list. Claude's callback ships on day one; Gemini's
 * is appended once U6 logs it. Unknown URIs are always rejected; while
 * GEMINI_REDIRECT_DISCOVERY is "on" they are also logged so the operator can
 * read Gemini's real callback and add it. No authorization code is ever issued
 * to an unvetted host.
 */

export function allowedRedirectUris(env: Env): string[] {
  // The committed ALLOWED_REDIRECT_URIS carries generic callbacks (Claude's).
  // EXTRA_REDIRECT_URIS is an optional secret for account-specific callbacks
  // (e.g. Gemini's user-bound redirect), so they never land in the repo.
  return `${env.ALLOWED_REDIRECT_URIS},${env.EXTRA_REDIRECT_URIS ?? ""}`
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Gemini's consumer "custom MCP" connector registers user-bound redirects whose
 * path carries the signed-in account's Google sub. It sends several at once:
 * three Google OAuth-redirect hosts (prod, sandbox, test) crossed with two path
 * prefixes (`/r/` and `/a/`), e.g.
 * `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-<sub>-<server-id>`.
 * We recognise them by pattern rather than exact strings (the displayed "copy
 * redirect URI" value does not byte-match what Gemini sends, and the set may
 * vary). It is safe: the path must contain THIS owner's sub (ALLOWED_GOOGLE_SUB)
 * — an attacker's Gemini would carry their own sub — and completeAuthorization
 * still only runs for the allowed sub (KTD2).
 */
const GEMINI_REDIRECT_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
  "oauth-redirect-test.googleusercontent.com",
]);

export function isGeminiUserBoundRedirect(env: Env, uri: string): boolean {
  const sub = (env.ALLOWED_GOOGLE_SUB ?? "").trim();
  if (!sub || !/^[0-9]+$/.test(sub)) return false;
  try {
    const u = new URL(uri);
    return (
      u.protocol === "https:" &&
      GEMINI_REDIRECT_HOSTS.has(u.host.toLowerCase()) &&
      new RegExp(`^/[ra]/user_bound_custom-mcp-${sub}-`).test(u.pathname)
    );
  } catch {
    return false;
  }
}

export function isAllowedRedirect(env: Env, uri: string): boolean {
  const allow = allowedRedirectUris(env);
  return allow.includes(uri.trim()) || isGeminiUserBoundRedirect(env, uri);
}

/** True while discovery mode is on (first Gemini connect only). */
export function discoveryOn(env: Env): boolean {
  return env.GEMINI_REDIRECT_DISCOVERY.trim().toLowerCase() === "on";
}

/**
 * Reject a redirect URI that is not allowlisted. Returns a short reason string
 * when the URI must be rejected, or null when it is allowed. Logs the rejected
 * URI's host only while discovery is on, so the operator can learn Gemini's
 * callback without the full URI ever being accepted.
 */
export function rejectRedirect(env: Env, uri: string | undefined): string | null {
  if (!uri) return "missing redirect_uri";
  if (isAllowedRedirect(env, uri)) return null;
  if (discoveryOn(env)) {
    // Discovery mode (setup only): log the full redirect URI so the operator can
    // read a new client's callback (e.g. Gemini's) and add it to the allowlist.
    log({ event: "redirect.unknown", note: `discovery redirect_uri=${uri} host=${hostOf(uri) ?? "invalid"}` });
  }
  return "redirect_uri not allowlisted";
}

/**
 * Dynamic Client Registration callback for OAuthProvider. Rejects registration
 * unless every requested redirect URI is allowlisted. Shape matches
 * ClientRegistrationCallbackResult (return undefined to allow).
 */
export function makeClientRegistrationCallback(env: Env) {
  return (options: {
    clientMetadata: Record<string, unknown>;
  }): { code?: string; description?: string; status?: number } | undefined => {
    const uris = options.clientMetadata["redirect_uris"];
    const list = Array.isArray(uris) ? (uris as unknown[]).map(String) : [];
    // Diagnostic: log exactly what a client registers (redirect URIs are callback
    // URLs, not secrets). Helps pin a connector's real redirect during setup.
    log({ event: "register.attempt", note: `redirect_uris=[${list.join(" | ")}]` });
    if (list.length === 0) {
      return { code: "invalid_redirect_uri", description: "redirect_uris required", status: 400 };
    }
    for (const uri of list) {
      const reason = rejectRedirect(env, uri);
      if (reason) {
        return { code: "invalid_redirect_uri", description: reason, status: 403 };
      }
    }
    return undefined;
  };
}
