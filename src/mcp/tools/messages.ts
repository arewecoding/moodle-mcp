import type { ToolDef } from "./registry.js";
import { untrusted, UNTRUSTED_NOTE } from "../untrusted.js";
import { toIstIso } from "../../moodle/format.js";
import { ToolInputError } from "./profile.js";

interface ConvMessage {
  id: number;
  useridfrom: number;
  text?: string;
  timecreated?: number;
}
interface ConvMember {
  id: number;
  fullname?: string;
}
interface Conversation {
  id: number;
  name?: string | null;
  members?: ConvMember[];
  messages?: ConvMessage[];
}

export const messagesTools: ToolDef[] = [
  {
    name: "get_messages",
    description:
      "Read your recent Moodle direct-message conversations (read-only — there is no way to " +
      "reply). Returns each conversation's other participant and its latest messages with sender " +
      "and time. limit: max conversations (default 10).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max conversations (default 10)." },
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const limit = args["limit"] === undefined ? 10 : Number(args["limit"]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new ToolInputError("limit must be an integer between 1 and 50.");
      }
      const userid = await ctx.moodle.getUserId();
      const data = await ctx.moodle.call<{ conversations: Conversation[] }>(
        "core_message_get_conversations",
        { userid, limitnum: limit },
      );

      const conversations = (data.conversations ?? []).slice(0, limit).map((conv) => {
        const members = new Map((conv.members ?? []).map((m) => [m.id, m.fullname ?? "Unknown"]));
        const others = (conv.members ?? []).filter((m) => m.id !== userid).map((m) => m.fullname ?? "Unknown");
        const messages = (conv.messages ?? []).map((m) => ({
          from: untrusted(members.get(m.useridfrom) ?? "Unknown", 120),
          text: untrusted(m.text, 500),
          time: toIstIso(m.timecreated),
        }));
        return {
          id: conv.id,
          name: conv.name ? untrusted(conv.name, 150) : null,
          with: others.map((o) => untrusted(o, 120)),
          messages,
        };
      });
      return { count: conversations.length, conversations, _note: UNTRUSTED_NOTE };
    },
  },
];
