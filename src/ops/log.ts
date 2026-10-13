/**
 * Minimal structured logging. Logs only non-sensitive operational facts:
 * route, tool name, Moodle function, error code, latency. Never logs headers,
 * env, props, request bodies, upstream URLs, or the token (KTD10).
 */
export interface LogFields {
  event: string;
  route?: string;
  tool?: string;
  wsfunction?: string;
  status?: number;
  errorcode?: string;
  ms?: number;
  note?: string;
}

const ALLOWED_KEYS: Array<keyof LogFields> = [
  "event",
  "route",
  "tool",
  "wsfunction",
  "status",
  "errorcode",
  "ms",
  "note",
];

/** Emit a single JSON log line with only the allowlisted fields present. */
export function log(fields: LogFields): void {
  const safe: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    const v = fields[key];
    if (v !== undefined) safe[key] = v;
  }
  // Only whitelisted scalars reach here; no secret-bearing value is ever passed in.
  console.log(JSON.stringify(safe));
}
