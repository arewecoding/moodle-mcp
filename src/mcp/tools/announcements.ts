import type { ToolDef } from "./registry.js";
import { untrusted, UNTRUSTED_NOTE } from "../untrusted.js";
import { toIstIso } from "../../moodle/format.js";
import { ToolInputError } from "./profile.js";
import { signFileRef } from "../../files/signing.js";
import { hostedAttachmentsOf, type MoodleFileEntry } from "../../files/download.js";

interface TimelineCourse {
  id: number;
  fullname: string;
}
interface Forum {
  id: number;
  course?: number;
  type?: string;
}
interface Discussion {
  id?: number;
  discussion?: number;
  name?: string;
  subject?: string;
  message?: string;
  userfullname?: string;
  created?: number;
  timemodified?: number;
  firstpost?: number;
  attachments?: MoodleFileEntry[];
}

export const announcementsTools: ToolDef[] = [
  {
    name: "get_recent_announcements",
    description:
      "Recent announcements (news-forum posts) across your in-progress courses, newest first, " +
      "with the full post text — use this to find cancellations or schedule changes. " +
      "days: look-back window (default 7). Optionally restrict to course_ids.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 90, description: "Look-back window in days (default 7)." },
        course_ids: { type: "array", items: { type: "integer" }, description: "Restrict to these courses (optional)." },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const days = args["days"] === undefined ? 7 : Number(args["days"]);
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        throw new ToolInputError("days must be an integer between 1 and 90.");
      }
      const since = Math.floor(Date.now() / 1000) - days * 86400;

      // Resolve the course set and names.
      const courseNames = new Map<number, string>();
      let courseIds: number[];
      if (Array.isArray(args["course_ids"])) {
        courseIds = (args["course_ids"] as unknown[]).map(Number);
        if (courseIds.some((n) => !Number.isInteger(n) || n <= 0)) {
          throw new ToolInputError("course_ids must all be positive integers.");
        }
      } else {
        const data = await ctx.moodle.call<{ courses: TimelineCourse[] }>(
          "core_course_get_enrolled_courses_by_timeline_classification",
          { classification: "inprogress" },
        );
        courseIds = (data.courses ?? []).map((c) => {
          courseNames.set(c.id, c.fullname);
          return c.id;
        });
      }
      if (courseIds.length === 0) return { count: 0, announcements: [], _note: UNTRUSTED_NOTE };

      // News forums for those courses.
      const forums = await ctx.moodle.call<Forum[]>("mod_forum_get_forums_by_courses", {
        courseids: courseIds,
      });
      const newsForums = (forums ?? []).filter((f) => f.type === "news");

      const announcements = [];
      for (const forum of newsForums) {
        const data = await ctx.moodle.call<{ discussions: Discussion[] }>(
          "mod_forum_get_forum_discussions",
          { forumid: forum.id, page: 0, perpage: 10 },
        );
        for (const d of data.discussions ?? []) {
          const when = d.timemodified ?? d.created ?? 0;
          if (when < since) continue;
          const discussionId = d.discussion ?? d.id ?? 0;
          const hosted = hostedAttachmentsOf({ attachments: d.attachments ?? [] }, ctx.moodle.baseUrl);
          const files =
            d.firstpost && hosted.length
              ? await Promise.all(
                  hosted.map(async (f, i) => ({
                    filename: f.filename ?? "file",
                    size_bytes: f.filesize ?? 0,
                    ref: await signFileRef(ctx.env, { k: "fa", d: discussionId, p: d.firstpost as number, i }),
                  })),
                )
              : [];
          announcements.push({
            course_id: forum.course ?? null,
            course: forum.course && courseNames.has(forum.course)
              ? untrusted(courseNames.get(forum.course) as string, 150)
              : null,
            subject: untrusted(d.subject ?? d.name ?? "", 200),
            author: untrusted(d.userfullname ?? "", 120),
            text: untrusted(d.message, 1500),
            posted: toIstIso(when),
            _sort: when,
            ...(files.length ? { files } : {}),
          });
        }
      }

      announcements.sort((a, b) => b._sort - a._sort);
      const cleaned = announcements.map(({ _sort, ...rest }) => {
        void _sort;
        return rest;
      });
      return { count: cleaned.length, announcements: cleaned, _note: UNTRUSTED_NOTE };
    },
  },
];
