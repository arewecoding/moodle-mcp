/**
 * Typed Moodle errors and token redaction.
 *
 * Moodle returns HTTP 200 even on errors, with a JSON body carrying
 * `exception`, `errorcode`, and `message`. The client maps those to these
 * typed errors. Every message is scrubbed of the token before it is thrown.
 */

export class MoodleError extends Error {
  readonly wsfunction?: string;
  constructor(message: string, wsfunction?: string) {
    super(message);
    this.name = "MoodleError";
    this.wsfunction = wsfunction;
  }
}

/** Token is invalid or expired; do not retry. */
export class InvalidTokenError extends MoodleError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

/** Function is not enabled on this Moodle site (access/permission/availability). */
export class BlockedFunctionError extends MoodleError {
  constructor(wsfunction: string) {
    super(`This function is not enabled on this Moodle site: ${wsfunction}`, wsfunction);
    this.name = "BlockedFunctionError";
  }
}

export const BLOCKED_ERRORCODES = new Set([
  "accessexception",
  "nopermissions",
  "servicenotavailable",
  "webservicenotavailable",
  "functionnotenabled",
  "servicenotworking",
]);

const SECRET_PARAM_RE = /\b(wstoken|token)=([^&\s"']+)/gi;

/**
 * Remove the token from any text: the literal value plus any `token=`/`wstoken=`
 * query value. Safe to call on arbitrary error text before logging or returning.
 */
export function redact(text: unknown, token?: string): string {
  let out = String(text);
  if (token && token.length > 0) {
    out = out.split(token).join("[REDACTED]");
  }
  return out.replace(SECRET_PARAM_RE, (_m, k: string) => `${k}=[REDACTED]`);
}

/** Drop token/wstoken query params from a URL so it is safe to surface. */
export function stripTokenFromUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete("token");
    u.searchParams.delete("wstoken");
    return u.toString();
  } catch {
    return redact(rawUrl);
  }
}
