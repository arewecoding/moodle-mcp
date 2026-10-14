import type { ToolDef } from "./registry.js";
import { untrusted, UNTRUSTED_NOTE } from "../untrusted.js";
import { ToolInputError } from "./profile.js";

interface GradeItem {
  itemname?: string | null;
  itemtype?: string;
  gradeformatted?: string;
  grademin?: number;
  grademax?: number;
  percentageformatted?: string;
}

export const gradesTools: ToolDef[] = [
  {
    name: "get_grades",
    description: "Your grade items for a course: item name, grade, range, and percentage.",
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
      const userid = await ctx.moodle.getUserId();
      const data = await ctx.moodle.call<{ usergrades: Array<{ gradeitems: GradeItem[] }> }>(
        "gradereport_user_get_grade_items",
        { courseid: courseId, userid },
      );
      const items = [];
      for (const ug of data.usergrades ?? []) {
        for (const g of ug.gradeitems ?? []) {
          const name = g.itemname ?? (g.itemtype === "course" ? "Course total" : null);
          items.push({
            item: name ? untrusted(name, 150) : null,
            type: g.itemtype ?? null,
            grade: g.gradeformatted ?? null,
            range: `${g.grademin ?? ""}–${g.grademax ?? ""}`,
            percentage: g.percentageformatted ?? null,
          });
        }
      }
      return { course_id: courseId, items, _note: UNTRUSTED_NOTE };
    },
  },
];
