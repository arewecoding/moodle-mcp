import type { ToolDef } from "./registry.js";
import { untrusted, UNTRUSTED_NOTE } from "../untrusted.js";
import { toIstIso } from "../../moodle/format.js";

interface TimelineCourse {
  id: number;
  fullname: string;
  shortname: string;
  progress?: number | null;
  enddate?: number;
}

const VALID_CLASSIFICATIONS = ["all", "inprogress", "future", "past"];

export const profileTools: ToolDef[] = [
  {
    name: "get_my_info",
    description:
      "Return the signed-in Moodle user's full name, username, numeric user id, and site name.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const info = await ctx.moodle.siteInfo();
      return {
        fullname: untrusted(info.fullname, 200),
        username: info.username,
        userid: info.userid,
        sitename: untrusted(info.sitename, 200),
        _note: UNTRUSTED_NOTE,
      };
    },
  },
  {
    name: "list_courses",
    description:
      "List the user's enrolled courses. classification: all (default), inprogress, future, or past.",
    inputSchema: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: VALID_CLASSIFICATIONS,
          description: "Which courses to list; defaults to all.",
        },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const classification = typeof args["classification"] === "string" ? args["classification"] : "all";
      if (!VALID_CLASSIFICATIONS.includes(classification)) {
        throw new ToolInputError(
          `classification must be one of: ${VALID_CLASSIFICATIONS.join(", ")}`,
        );
      }
      const data = await ctx.moodle.call<{ courses: TimelineCourse[] }>(
        "core_course_get_enrolled_courses_by_timeline_classification",
        { classification },
      );
      const courses = (data.courses ?? []).map((c) => ({
        id: c.id,
        fullname: untrusted(c.fullname, 200),
        shortname: untrusted(c.shortname, 100),
        progress: c.progress ?? null,
        enddate: toIstIso(c.enddate),
      }));
      return { count: courses.length, courses, _note: UNTRUSTED_NOTE };
    },
  },
];

/** Thrown when a tool's arguments are invalid; surfaced as a tool error, not a crash. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}
