import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { RateLimiter } from "./ops/ratelimit.js";

/** Worker environment: vars from wrangler.jsonc plus secrets and bindings. */
export interface Env {
  // Bindings
  OAUTH_KV: KVNamespace;
  /** Injected by OAuthProvider into the default/API handler env. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Optional Workers Rate Limiting binding (U9); absent in tests. */
  RATE_LIMITER?: RateLimiter;

  // Vars (wrangler.jsonc)
  MOODLE_BASE_URL: string;
  ALLOWED_REDIRECT_URIS: string;
  GEMINI_REDIRECT_DISCOVERY: string;
  INLINE_FILE_CAP_BYTES: string;

  // Secrets (wrangler secret put / .dev.vars)
  MOODLE_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ALLOWED_GOOGLE_SUB: string;
  COOKIE_ENCRYPTION_KEY: string;
  LINK_SIGNING_KEYS: string;
}

/**
 * Props stored with the OAuth grant and exposed to the MCP handler as ctx.props.
 * Identifies the single authorized user; carries no Moodle credential.
 */
export interface UserProps {
  googleSub: string;
  email: string;
  name: string;
}
