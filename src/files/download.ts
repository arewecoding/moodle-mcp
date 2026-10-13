import type { Env } from "../types.js";
import { MoodleClient } from "../moodle/client.js";
import { MoodleError } from "../moodle/errors.js";
import { verifyFileRef, type FileRef } from "./signing.js";
import { log } from "../ops/log.js";

/** A Moodle contents entry (subset we use). */
export interface MoodleFileEntry {
  type?: string;
  filename?: string;
  fileurl?: string;
  filesize?: number;
  mimetype?: string;
}

export interface MoodleModule {
  id: number;
  name?: string;
  modname?: string;
  url?: string;
  description?: string;
  contents?: MoodleFileEntry[];
}

export interface MoodleSection {
  id: number;
  name?: string;
  summary?: string;
  modules?: MoodleModule[];
}

export interface ResolvedFile {
  path: string;
  filename: string;
  mimetype: string;
  filesize: number;
}

/**
 * True when a Moodle contents `fileurl` is a file hosted on the configured
 * Moodle host under the pluginfile endpoint. Only such files may be signed and
 * served; external URL activities must never be (prevents sending the token to a
 * teacher-chosen host).
 */
export function isMoodleHostedFile(fileurl: string | undefined, baseUrl: string): boolean {
  if (!fileurl) return false;
  try {
    const u = new URL(fileurl);
    const base = new URL(baseUrl);
    if (u.origin !== base.origin) return false;
    return /^\/(webservice\/)?pluginfile\.php\//.test(u.pathname);
  } catch {
    return false;
  }
}

/** The path (no origin, no token) for a Moodle-hosted file url. */
export function pluginfilePath(fileurl: string): string {
  const u = new URL(fileurl);
  return u.pathname;
}

/** All Moodle-hosted file entries of a module, in order. */
export function hostedFilesOf(module: MoodleModule, baseUrl: string): MoodleFileEntry[] {
  return (module.contents ?? []).filter(
    (e) => e.type === "file" && isMoodleHostedFile(e.fileurl, baseUrl),
  );
}

/**
 * Re-resolve a signed reference to the actual file by re-reading the course's
 * contents through the allowlisted client (no KV lookup). Throws if the file is
 * no longer listed or is not Moodle-hosted.
 */
export async function resolveFileRef(moodle: MoodleClient, ref: FileRef): Promise<ResolvedFile> {
  const sections = await moodle.call<MoodleSection[]>("core_course_get_contents", {
    courseid: ref.c,
  });
  let module: MoodleModule | undefined;
  for (const s of sections) {
    module = (s.modules ?? []).find((m) => m.id === ref.m);
    if (module) break;
  }
  if (!module) throw new MoodleError("Referenced file is no longer available.");
  const files = hostedFilesOf(module, moodle.baseUrl);
  const entry = files[ref.i];
  if (!entry || !entry.fileurl) throw new MoodleError("Referenced file is no longer available.");
  return {
    path: pluginfilePath(entry.fileurl),
    filename: entry.filename ?? "file",
    mimetype: entry.mimetype ?? "application/octet-stream",
    filesize: entry.filesize ?? 0,
  };
}

const INLINE_TYPES = new Set(["application/pdf"]);
const SAFE_CONTENT_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
]);

export function safeContentType(mimetype: string): string {
  const base = mimetype.split(";")[0]?.trim().toLowerCase() ?? "";
  return SAFE_CONTENT_TYPES.has(base) ? base : "application/octet-stream";
}

/**
 * Handle GET /files/:token — verify the signed link and stream the file. No
 * bearer token required: the signed link is the capability. The Moodle token is
 * appended server-side inside fetchPluginFile and never appears here.
 */
export async function handleDownload(env: Env, token: string): Promise<Response> {
  const verdict = await verifyFileRef(env, token);
  if (!verdict.ok) {
    const status = verdict.reason === "expired" ? 410 : 403;
    log({ event: "download.reject", route: "/files", errorcode: verdict.reason, status });
    return new Response(verdict.reason === "expired" ? "Link expired." : "Invalid link.", { status });
  }

  const moodle = new MoodleClient(env.MOODLE_BASE_URL, env.MOODLE_TOKEN);
  let resolved: ResolvedFile;
  try {
    resolved = await resolveFileRef(moodle, verdict.ref);
  } catch {
    return new Response("File not available.", { status: 404 });
  }

  let upstream: Response;
  try {
    upstream = await moodle.fetchPluginFile(resolved.path);
  } catch (err) {
    log({ event: "download.fetchfail", route: "/files", note: moodle.redact((err as Error)?.message) });
    return new Response("Could not retrieve file.", { status: 502 });
  }

  const ct = safeContentType(resolved.mimetype || upstream.headers.get("content-type") || "");
  const disposition = INLINE_TYPES.has(ct) ? "inline" : "attachment";
  const safeName = resolved.filename.replace(/[^\w.\-]/g, "_");
  log({ event: "download.ok", route: "/files", status: 200 });
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": ct,
      "content-disposition": `${disposition}; filename="${safeName}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox",
    },
  });
}
