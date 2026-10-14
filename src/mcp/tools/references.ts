import type { ToolDef } from "./registry.js";
import { UNTRUSTED_NOTE } from "../untrusted.js";
import { htmlToText } from "../../moodle/format.js";
import { stripTokenFromUrl } from "../../moodle/errors.js";
import { signFileRef } from "../../files/signing.js";
import {
  isMoodleHostedFile,
  hostedFilesOf,
  type MoodleSection,
  type MoodleModule,
  type MoodleFileEntry,
} from "../../files/download.js";
import { ToolInputError } from "./profile.js";

type Kind = "moodle_file" | "google_drive" | "youtube" | "pdf_link" | "web_page";

interface RefLink {
  url: string;
  kind: Kind;
  ref?: string;
}

const HREF_RE = /(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const CITATION_RE = /\b(chapter|section|§|unit)\s*[\d.]+|\b\d+(?:st|nd|rd|th)\s+edition\b/i;

function classify(url: string, baseUrl: string): Kind | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (isMoodleHostedFile(url, baseUrl)) return "moodle_file";
  const host = u.host.toLowerCase();
  if (host.includes("drive.google.com") || host.includes("docs.google.com")) return "google_drive";
  if (host.includes("youtube.com") || host.includes("youtu.be")) return "youtube";
  if (u.pathname.toLowerCase().endsWith(".pdf")) return "pdf_link";
  return "web_page";
}

function extractHrefs(html: string | undefined): string[] {
  if (!html) return [];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  HREF_RE.lastIndex = 0;
  while ((m = HREF_RE.exec(html)) !== null) out.push(m[1] as string);
  return out;
}

function detectCitations(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 8 && CITATION_RE.test(trimmed)) found.push(trimmed.slice(0, 200));
  }
  return found;
}

export const referencesTools: ToolDef[] = [
  {
    name: "get_references",
    description:
      "Collect a course's external references in one list, each tagged by kind (web page, Google " +
      "Drive, YouTube, PDF link) from URL activities and from links in page/label/section text. " +
      "Moodle-hosted file links become readable `ref`s for get_file. Book/reading citations are " +
      "listed separately. Nothing is fetched — the agent opens external links itself.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: { type: "integer", description: "The course id (from list_courses)." },
      },
      required: ["course_id"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const courseId = Number(args["course_id"]);
      if (!Number.isInteger(courseId) || courseId <= 0) {
        throw new ToolInputError("course_id must be a positive integer.");
      }
      const sections = await ctx.moodle.call<MoodleSection[]>("core_course_get_contents", {
        courseid: courseId,
      });

      // Index Moodle-hosted files by normalized URL so a pluginfile link found in
      // text can become a readable get_file reference.
      const fileIndex = new Map<string, { m: number; i: number }>();
      const addHosted = (module: MoodleModule) => {
        hostedFilesOf(module, ctx.moodle.baseUrl).forEach((f, i) => {
          if (f.fileurl) fileIndex.set(normalize(f.fileurl), { m: module.id, i });
        });
      };

      const rawUrls = new Set<string>();
      const citations = new Set<string>();

      for (const s of sections) {
        for (const url of extractHrefs(s.summary)) rawUrls.add(url);
        if (s.summary) detectCitations(htmlToText(s.summary, 4000)).forEach((c) => citations.add(c));
        for (const m of s.modules ?? []) {
          addHosted(m);
          for (const url of extractHrefs(m.description)) rawUrls.add(url);
          if (m.description) detectCitations(htmlToText(m.description, 4000)).forEach((c) => citations.add(c));
          // mod_url stores the external target as a "url"-type contents entry.
          for (const entry of (m.contents ?? []) as MoodleFileEntry[]) {
            if (entry.type === "url" && entry.fileurl) rawUrls.add(entry.fileurl);
          }
        }
      }

      const byUrl = new Map<string, RefLink>();
      for (const url of rawUrls) {
        const kind = classify(url, ctx.moodle.baseUrl);
        if (!kind) continue;
        const key = normalize(url);
        if (byUrl.has(key)) continue;
        if (kind === "moodle_file") {
          const hit = fileIndex.get(key);
          if (hit) {
            byUrl.set(key, {
              url: stripTokenFromUrl(url),
              kind,
              ref: await signFileRef(ctx.env, { k: "cm", c: courseId, m: hit.m, i: hit.i }),
            });
          } else {
            // A Moodle file link we cannot map to a listed file; surface it
            // without a ref (the agent cannot open it without the token).
            byUrl.set(key, { url: stripTokenFromUrl(url), kind });
          }
        } else {
          byUrl.set(key, { url, kind });
        }
      }

      return {
        course_id: courseId,
        links: [...byUrl.values()],
        book_citations: [...citations],
        _note: UNTRUSTED_NOTE,
      };
    },
  },
];

/** Normalize a URL for dedup/matching: drop token/wstoken query params. */
function normalize(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("token");
    u.searchParams.delete("wstoken");
    return u.toString();
  } catch {
    return url;
  }
}
