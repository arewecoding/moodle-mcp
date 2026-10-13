import type { ToolDef } from "./registry.js";
import { untrusted, UNTRUSTED_NOTE } from "../untrusted.js";
import { stripTokenFromUrl } from "../../moodle/errors.js";
import { signFileRef } from "../../files/signing.js";
import { hostedFilesOf, type MoodleSection } from "../../files/download.js";
import { ToolInputError } from "./profile.js";

export const contentsTools: ToolDef[] = [
  {
    name: "get_course_contents",
    description:
      "List a course's sections and activities. Each Moodle-hosted file carries a signed `ref` " +
      "you can pass to get_file to read it. External links are returned as plain URLs.",
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

      const out = [];
      for (const s of sections) {
        const modules = [];
        for (const m of s.modules ?? []) {
          const files = hostedFilesOf(m, ctx.moodle.baseUrl);
          const fileRefs = await Promise.all(
            files.map(async (f, i) => ({
              filename: f.filename ?? "file",
              size_bytes: f.filesize ?? 0,
              ref: await signFileRef(ctx.env, { k: "cm", c: courseId, m: m.id, i }),
            })),
          );
          const mod: Record<string, unknown> = {
            id: m.id,
            name: untrusted(m.name ?? "", 200),
            modname: m.modname,
          };
          if (m.url) mod["url"] = stripTokenFromUrl(m.url);
          if (fileRefs.length > 0) mod["files"] = fileRefs;
          modules.push(mod);
        }
        out.push({ id: s.id, name: untrusted(s.name ?? "", 200), modules });
      }
      return { course_id: courseId, sections: out, _note: UNTRUSTED_NOTE };
    },
  },
];
