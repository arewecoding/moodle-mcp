import type { Env } from "../types.js";

/**
 * Self-contained signed file references (KTD6). A reference encodes everything
 * needed to re-resolve one Moodle-hosted file, plus an expiry and key id, and is
 * HMAC-SHA256 signed. Nothing is stored in KV, so a link works even when read
 * from another Cloudflare location right after it was minted (KV is eventually
 * consistent). The same token is both the get_file argument and the path segment
 * of the download link.
 */

/** A reference to one course-module file. */
export interface CourseModuleRef {
  /** kind: "cm" = course-module file. */
  k: "cm";
  /** course id */
  c: number;
  /** course-module id */
  m: number;
  /** index into that module's file list */
  i: number;
  /** expiry, unix seconds */
  e: number;
  /** signing key id */
  kid: string;
}

/** A reference to one attachment on a forum/announcement post. */
export interface ForumAttachmentRef {
  /** kind: "fa" = forum post attachment. */
  k: "fa";
  /** discussion id */
  d: number;
  /** post id */
  p: number;
  /** index into that post's attachment list */
  i: number;
  /** expiry, unix seconds */
  e: number;
  /** signing key id */
  kid: string;
}

export type FileRef = CourseModuleRef | ForumAttachmentRef;

function hasValidShape(ref: FileRef): boolean {
  if (ref.k === "cm") {
    return typeof ref.c === "number" && typeof ref.m === "number" && typeof ref.i === "number";
  }
  if (ref.k === "fa") {
    return typeof ref.d === "number" && typeof ref.p === "number" && typeof ref.i === "number";
  }
  return false;
}

const LINK_TTL_SECONDS = 15 * 60;

interface SigningKey {
  kid: string;
  secret: string;
}

function parseKeys(env: Env): SigningKey[] {
  return env.LINK_SIGNING_KEYS.split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      return { kid: pair.slice(0, idx), secret: pair.slice(idx + 1) };
    })
    .filter((k) => k.kid && k.secret);
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** The caller-supplied part of a reference (expiry and key id are added here). */
export type FileRefInput =
  | Omit<CourseModuleRef, "e" | "kid">
  | Omit<ForumAttachmentRef, "e" | "kid">;

/** Sign a file reference with the newest key; returns the token. */
export async function signFileRef(
  env: Env,
  ref: FileRefInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const keys = parseKeys(env);
  const key = keys[0];
  if (!key) throw new Error("No LINK_SIGNING_KEYS configured.");
  const full = { ...ref, e: now + LINK_TTL_SECONDS, kid: key.kid } as FileRef;
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify(full)));
  const sig = b64urlEncode(await hmac(key.secret, payload));
  return `${payload}.${sig}`;
}

export type VerifyResult =
  | { ok: true; ref: FileRef }
  | { ok: false; reason: "malformed" | "badsig" | "expired" };

/** Verify a token: signature against the named key, then expiry. */
export async function verifyFileRef(
  env: Env,
  token: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<VerifyResult> {
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const payload = token.slice(0, dot);
  const sigStr = token.slice(dot + 1);

  let ref: FileRef;
  try {
    ref = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as FileRef;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!ref || (ref.k !== "cm" && ref.k !== "fa") || !hasValidShape(ref)) {
    return { ok: false, reason: "malformed" };
  }

  const key = parseKeys(env).find((k) => k.kid === ref.kid);
  if (!key) return { ok: false, reason: "badsig" };

  const expected = await hmac(key.secret, payload);
  let provided: Uint8Array;
  try {
    provided = b64urlDecode(sigStr);
  } catch {
    return { ok: false, reason: "badsig" };
  }
  if (!constantTimeEqual(expected, provided)) return { ok: false, reason: "badsig" };
  if (typeof ref.e !== "number" || ref.e <= now) return { ok: false, reason: "expired" };
  return { ok: true, ref };
}
