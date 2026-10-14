import type { ToolDef } from "./registry.js";
import { untrusted, UNTRUSTED_NOTE } from "../untrusted.js";
import { toIstIso } from "../../moodle/format.js";
import { ToolInputError } from "./profile.js";

interface CalEvent {
  id: number;
  name: string;
  timesort?: number;
  timestart?: number;
  eventtype?: string;
  modulename?: string;
  course?: { fullname?: string } | null;
}

export const deadlinesTools: ToolDef[] = [
  {
    name: "get_upcoming_deadlines",
    description:
      "Upcoming deadlines and calendar events across all enrolled courses, soonest first. " +
      "Includes activity deadlines (assignments, quizzes) and course/site events such as exams. " +
      "days: how far ahead to look (default 14).",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 120, description: "Look-ahead window in days (default 14)." },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const days = args["days"] === undefined ? 14 : Number(args["days"]);
      if (!Number.isInteger(days) || days < 1 || days > 120) {
        throw new ToolInputError("days must be an integer between 1 and 120.");
      }
      const now = Math.floor(Date.now() / 1000);
      const until = now + days * 86400;

      const byId = new Map<number, CalEvent & { when: number }>();
      const add = (events: CalEvent[]) => {
        for (const e of events) {
          const when = e.timesort ?? e.timestart ?? 0;
          if (when <= 0 || when > until) continue;
          if (!byId.has(e.id)) byId.set(e.id, { ...e, when });
        }
      };

      // Activity deadlines (things needing action), then course/site events.
      const action = await ctx.moodle.call<{ events: CalEvent[] }>(
        "core_calendar_get_action_events_by_timesort",
        { timesortfrom: now, limitnum: 50 },
      );
      add(action.events ?? []);
      const upcoming = await ctx.moodle.call<{ events: CalEvent[] }>(
        "core_calendar_get_calendar_upcoming_view",
      );
      add(upcoming.events ?? []);

      const events = [...byId.values()]
        .sort((a, b) => a.when - b.when)
        .map((e) => ({
          name: untrusted(e.name, 200),
          course: e.course?.fullname ? untrusted(e.course.fullname, 150) : null,
          time: toIstIso(e.when),
          type: e.eventtype ?? null,
          module: e.modulename ?? null,
        }));
      return { count: events.length, days, events, _note: UNTRUSTED_NOTE };
    },
  },
];
