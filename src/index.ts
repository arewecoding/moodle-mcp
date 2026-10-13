import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types.js";
import { googleApp } from "./auth/google-handler.js";
import { makeClientRegistrationCallback } from "./auth/client-policy.js";
import { isKilled, killedResponse } from "./ops/killswitch.js";
import { mcpApiHandler } from "./mcp/server.js";

/**
 * The OAuthProvider is built lazily on the first request because its client
 * registration callback (the redirect allowlist, KTD3) needs the Worker env,
 * which is not available at module load. Subsequent requests reuse the instance.
 */
let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env, origin: string): OAuthProvider<Env> {
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApiHandler,
      // defaultHandler owns /authorize, /callback, /health, and the /files
      // download route (which needs no bearer token — the signed link is the
      // capability). The provider itself owns /token and /register and the
      // RFC 9728 / 8414 metadata endpoints.
      defaultHandler: googleApp as unknown as ExportedHandler<Env>,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["moodle.read"],
      // CIMD on (KTD3); the compatibility flag global_fetch_strictly_public is
      // set in wrangler.jsonc so CIMD document fetches go to the public internet.
      clientIdMetadataDocumentEnabled: true,
      clientRegistrationCallback: makeClientRegistrationCallback(env),
      // The protected resource is this server's /mcp URL; it must equal the URL
      // the user enters in the connector. Derived from the first request origin.
      resourceMetadata: {
        resource: `${origin}/mcp`,
        resource_name: "Moodle your site",
      },
    });
  }
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Kill switch (KTD9) wraps every route, including /mcp, /authorize, /files.
    if (await isKilled(env)) return killedResponse();
    const origin = new URL(request.url).origin;
    return getProvider(env, origin).fetch(request, env, ctx);
  },
};
