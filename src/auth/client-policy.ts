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
  return env.ALLOWED_REDIRECT_URIS.split(",")
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

export function isAllowedRedirect(env: Env, uri: string): boolean {
  const allow = allowedRedirectUris(env);
  return allow.includes(uri.trim());
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
    log({ event: "redirect.unknown", note: `discovery: host=${hostOf(uri) ?? "invalid"}` });
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
