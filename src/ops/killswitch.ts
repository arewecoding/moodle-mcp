import type { Env } from "../types.js";

const KILL_KEY = "killswitch:enabled";

/**
 * Layered kill switch (KTD9). When this KV flag is set, every route returns 503.
 * Set it with:  wrangler kv key put --binding OAUTH_KV killswitch:enabled 1
 * Clear it with: wrangler kv key delete --binding OAUTH_KV killswitch:enabled
 */
export async function isKilled(env: Env): Promise<boolean> {
  const v = await env.OAUTH_KV.get(KILL_KEY);
  return v !== null && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

export function killedResponse(): Response {
  return new Response("Service temporarily disabled.", {
    status: 503,
    headers: { "content-type": "text/plain" },
  });
}
