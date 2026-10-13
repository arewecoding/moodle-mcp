import {
  BLOCKED_ERRORCODES,
  BlockedFunctionError,
  InvalidTokenError,
  MoodleError,
  redact,
} from "./errors.js";
import { flattenParams } from "./format.js";

const TIMEOUT_MS = 20_000;
const RETRY_BACKOFF_MS = 1_000;

/**
 * The only Moodle web-service functions this server may call. Every one is
 * read-only. No write function (messaging, posting, submitting, enrolment)
 * appears here; this list is the read-only boundary (R5).
 */
export const READONLY_FUNCTIONS = new Set([
  "core_webservice_get_site_info",
  "core_course_get_enrolled_courses_by_timeline_classification",
  "core_course_get_contents",
  "core_calendar_get_action_events_by_timesort",
  "core_calendar_get_calendar_upcoming_view",
  "mod_forum_get_forums_by_courses",
  "mod_forum_get_forum_discussions",
  "mod_forum_get_discussion_posts",
  "core_message_get_conversations",
  "core_message_get_conversation_messages",
  "gradereport_user_get_grade_items",
]);

export interface SiteInfo {
  fullname: string;
  username: string;
  userid: number;
  sitename: string;
}

/** Single allowlisted, redacting Moodle client. */
export class MoodleClient {
  readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly token: string;
  private userId: number | null = null;

  constructor(baseUrl: string, token: string) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (!/^https:\/\//i.test(trimmed)) {
      throw new Error("MOODLE_BASE_URL must start with https://");
    }
    if (!token) throw new Error("MOODLE_TOKEN is empty");
    this.baseUrl = trimmed;
    this.endpoint = `${trimmed}/webservice/rest/server.php`;
    this.token = token;
  }

  /** Scrub the token (and token= params) from arbitrary text. */
  redact(text: unknown): string {
    return redact(text, this.token);
  }

  /**
   * Call a read-only Moodle function. The token travels in the POST body only.
   * Throws a typed error on Moodle's HTTP-200 error objects.
   */
  async call<T = unknown>(
    wsfunction: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!READONLY_FUNCTIONS.has(wsfunction)) {
      throw new MoodleError(`Refusing to call non-allowlisted function: ${wsfunction}`, wsfunction);
    }

    const body = new URLSearchParams();
    body.set("wstoken", this.token);
    body.set("wsfunction", wsfunction);
    body.set("moodlewsrestformat", "json");
    for (const [k, v] of flattenParams(params)) body.append(k, v);

    let resp: Response | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        resp = await this.timedFetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
          redirect: "manual",
        });
        break;
      } catch (err) {
        lastErr = err;
        if (attempt === 0) await sleep(RETRY_BACKOFF_MS);
      }
    }
    if (!resp) {
      throw new MoodleError(
        `Network error calling ${wsfunction}: ${this.redact((lastErr as Error)?.message ?? lastErr)}`,
        wsfunction,
      );
    }

    if (resp.status === 0 || (resp.status >= 300 && resp.status < 400)) {
      throw new MoodleError(`Refusing to follow redirect for ${wsfunction}.`, wsfunction);
    }
    if (resp.status !== 200) {
      throw new MoodleError(`HTTP ${resp.status} from Moodle for ${wsfunction}.`, wsfunction);
    }

    let payload: unknown;
    try {
      payload = await resp.json();
    } catch {
      throw new MoodleError(`Moodle returned non-JSON for ${wsfunction}.`, wsfunction);
    }

    if (payload && typeof payload === "object" && ("exception" in payload || "errorcode" in payload)) {
      const obj = payload as { errorcode?: string; message?: string };
      const code = String(obj.errorcode ?? "").toLowerCase();
      const message = this.redact(obj.message ?? "");
      if (code === "invalidtoken") {
        throw new InvalidTokenError(
          "Moodle token is invalid or expired. Regenerate it, update the MOODLE_TOKEN secret, " +
            "reset the old key under Preferences > Security keys, then reconnect.",
        );
      }
      if (BLOCKED_ERRORCODES.has(code) || message.toLowerCase().includes("access control exception")) {
        throw new BlockedFunctionError(wsfunction);
      }
      throw new MoodleError(`Moodle error in ${wsfunction} (${code || "unknown"}): ${message}`, wsfunction);
    }

    return payload as T;
  }

  /** Cached site info; resolves and remembers the user id. */
  async siteInfo(): Promise<SiteInfo> {
    const info = await this.call<SiteInfo>("core_webservice_get_site_info");
    this.userId = Number(info.userid);
    return info;
  }

  async getUserId(): Promise<number> {
    if (this.userId === null) await this.siteInfo();
    return this.userId as number;
  }

  /**
   * Fetch a Moodle-hosted file. `pluginfilePath` is a path (no origin) under the
   * pluginfile endpoint; the URL is rebuilt from the configured host and the
   * token is appended here, server-side, never leaving this method. Any file
   * reference whose origin is not the configured host must be rejected before
   * calling this (see files/download.ts resolveFileRef).
   */
  async fetchPluginFile(pluginfilePath: string): Promise<Response> {
    const path = pluginfilePath.startsWith("/") ? pluginfilePath : `/${pluginfilePath}`;
    if (!/^\/(webservice\/)?pluginfile\.php\//.test(path)) {
      throw new MoodleError("Refusing to download a non-pluginfile path.");
    }
    const url = new URL(this.baseUrl + path);
    // Force the webservice variant, which authenticates by token rather than session.
    if (url.pathname.startsWith("/pluginfile.php/")) {
      url.pathname = "/webservice" + url.pathname;
    }
    url.searchParams.set("token", this.token);
    const resp = await this.timedFetch(url.toString(), { method: "GET", redirect: "manual" });
    if (resp.status >= 300 && resp.status < 400) {
      throw new MoodleError("Refusing to follow redirect while downloading a file.");
    }
    if (resp.status !== 200) {
      throw new MoodleError(`HTTP ${resp.status} downloading file.`);
    }
    return resp;
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
