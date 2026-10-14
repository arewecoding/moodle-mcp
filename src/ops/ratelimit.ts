/**
 * Thin wrapper over the Cloudflare Workers Rate Limiting binding (KTD/U9).
 * Keyed per user for tool calls and per IP for the open auth endpoints
 * (/register, /authorize), so one client cannot exhaust the shared KV or the
 * Moodle site. The binding is optional: if it is not configured (e.g. in tests),
 * every call is allowed, so rate limiting never becomes a correctness
 * dependency. It fails open on a binding error for the same reason.
 */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export async function withinRateLimit(
  limiter: RateLimiter | undefined,
  key: string,
): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key });
    return success;
  } catch {
    return true;
  }
}
