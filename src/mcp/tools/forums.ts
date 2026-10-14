import type { ToolDef } from "./registry.js";
import { untrusted, UNTRUSTED_NOTE } from "../untrusted.js";
import { toIstIso } from "../../moodle/format.js";
import { ToolInputError } from "./profile.js";
import { signFileRef } from "../../files/signing.js";
import { hostedAttachmentsOf, type MoodleFileEntry } from "../../files/download.js";

interface Forum {
  id: number;
  course?: number;
  cmid?: number;
  name?: string;
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
  numreplies?: number;
  firstpost?: number;
  attachments?: MoodleFileEntry[];
}

interface Post {
  id: number;
  subject?: string;
  message?: string;
  author?: { fullname?: string } | null;
  userfullname?: string;
  timecreated?: number;
  attachments?: MoodleFileEntry[];
  messageattachments?: MoodleFileEntry[];
}

function toCourseIds(args: Record<string, unknown>): number[] {
  const raw = args["course_ids"];
  if (!Array.isArray(raw)) throw new ToolInputError("course_ids must be an array of course ids.");
  const ids = raw.map(Number);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new ToolInputError("course_ids must all be positive integers.");
  }
  return ids;
}

async function attachmentRefs(
  ctx: Parameters<ToolDef["handler"]>[1],
  discussionId: number,
  postId: number,
  attachments: MoodleFileEntry[] | undefined,
): Promise<Array<{ filename: string; size_bytes: number; ref: string }>> {
  const hosted = hostedAttachmentsOf({ attachments: attachments ?? [] }, ctx.moodle.baseUrl);
  return Promise.all(
    hosted.map(async (f, i) => ({
      filename: f.filename ?? "file",
      size_bytes: f.filesize ?? 0,
      ref: await signFileRef(ctx.env, { k: "fa", d: discussionId, p: postId, i }),
    })),
  );
}

export const forumsTools: ToolDef[] = [
  {
    name: "list_forums",
    description: "List the forums in the given courses (id, name, type).",
    inputSchema: {
      type: "object",
      properties: {
        course_ids: { type: "array", items: { type: "integer" }, description: "Course ids." },
      },
      required: ["course_ids"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const courseids = toCourseIds(args);
      const data = await ctx.moodle.call<Forum[]>("mod_forum_get_forums_by_courses", { courseids });
      const forums = (data ?? []).map((f) => ({
        id: f.id,
        course_id: f.course ?? null,
        cmid: f.cmid ?? null,
        name: untrusted(f.name ?? "", 200),
        type: f.type ?? null,
      }));
      return { count: forums.length, forums, _note: UNTRUSTED_NOTE };
    },
  },
  {
    name: "get_forum_discussions",
    description:
      "List discussions in a forum (newest first), with the opening post's text and author. " +
      "page is 0-based; per_page defaults to 20 (max 50).",
    inputSchema: {
      type: "object",
      properties: {
        forum_id: { type: "integer", description: "The forum id (from list_forums)." },
        page: { type: "integer", minimum: 0, description: "0-based page (default 0)." },
        per_page: { type: "integer", minimum: 1, maximum: 50, description: "Per page (default 20)." },
      },
      required: ["forum_id"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const forumId = Number(args["forum_id"]);
      if (!Number.isInteger(forumId) || forumId <= 0) {
        throw new ToolInputError("forum_id must be a positive integer.");
      }
      const page = args["page"] === undefined ? 0 : Number(args["page"]);
      const perPage = args["per_page"] === undefined ? 20 : Math.max(1, Math.min(Number(args["per_page"]), 50));
      const data = await ctx.moodle.call<{ discussions: Discussion[] }>(
        "mod_forum_get_forum_discussions",
        { forumid: forumId, page, perpage: perPage },
      );
      const discussions = await Promise.all(
        (data.discussions ?? []).map(async (d) => {
          const discussionId = d.discussion ?? d.id ?? 0;
          const files =
            d.firstpost && d.attachments
              ? await attachmentRefs(ctx, discussionId, d.firstpost, d.attachments)
              : [];
          return {
            discussion_id: discussionId,
            subject: untrusted(d.subject ?? d.name ?? "", 200),
            author: untrusted(d.userfullname ?? "", 120),
            message: untrusted(d.message, 800),
            created: toIstIso(d.created),
            modified: toIstIso(d.timemodified),
            replies: d.numreplies ?? null,
            ...(files.length ? { files } : {}),
          };
        }),
      );
      return { forum_id: forumId, page, discussions, _note: UNTRUSTED_NOTE };
    },
  },
  {
    name: "get_discussion_posts",
    description: "Read the posts in a discussion, with author, text, time, and any file attachments.",
    inputSchema: {
      type: "object",
      properties: {
        discussion_id: { type: "integer", description: "The discussion id (from get_forum_discussions)." },
      },
      required: ["discussion_id"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const discussionId = Number(args["discussion_id"]);
      if (!Number.isInteger(discussionId) || discussionId <= 0) {
        throw new ToolInputError("discussion_id must be a positive integer.");
      }
      const data = await ctx.moodle.call<{ posts: Post[] }>("mod_forum_get_discussion_posts", {
        discussionid: discussionId,
      });
      const posts = await Promise.all(
        (data.posts ?? []).map(async (p) => {
          const files = await attachmentRefs(
            ctx,
            discussionId,
            p.id,
            [...(p.attachments ?? []), ...(p.messageattachments ?? [])],
          );
          return {
            id: p.id,
            subject: p.subject ? untrusted(p.subject, 200) : null,
            author: untrusted(p.author?.fullname ?? p.userfullname ?? "", 120),
            message: untrusted(p.message, 1200),
            time: toIstIso(p.timecreated),
            ...(files.length ? { files } : {}),
          };
        }),
      );
      return { discussion_id: discussionId, posts, _note: UNTRUSTED_NOTE };
    },
  },
];
