import type { Env, UserProps } from "../../types.js";
import type { MoodleClient } from "../../moodle/client.js";

/** Context handed to every tool handler. */
export interface ToolContext {
  env: Env;
  props: UserProps;
  moodle: MoodleClient;
  request: Request;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** Shared annotations advertised on every tool: read-only, talks to Moodle. */
export const READONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: true } as const;
