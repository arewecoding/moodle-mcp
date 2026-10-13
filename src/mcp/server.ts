import type { Env, UserProps } from "../types.js";
import { MoodleClient } from "../moodle/client.js";
import { MoodleError } from "../moodle/errors.js";
import { log } from "../ops/log.js";
import { READONLY_ANNOTATIONS, type ToolContext, type ToolDef } from "./tools/registry.js";
import { profileTools, ToolInputError } from "./tools/profile.js";
import { contentsTools } from "./tools/contents.js";
import { fileTools } from "./tools/files.js";

const SERVER_INFO = { name: "moodle-mcp", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

/** The full read-only tool set. U7/U8 append their tools to these arrays. */
const TOOLS: ToolDef[] = [...profileTools, ...contentsTools, ...fileTools];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: unknown, res: unknown): Response {
  return json({ jsonrpc: "2.0", id, result: res });
}
function rpcError(id: unknown, code: number, message: string): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * MCP Streamable HTTP endpoint for /mcp. Stateless: each POST carries one
 * JSON-RPC message. Only runs for requests the OAuthProvider already
 * authenticated, so ctx.props is the single authorized user.
 */
export const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as unknown as { props?: UserProps }).props;
    if (!props) return rpcError(null, -32001, "Unauthenticated.");

    if (request.method === "GET") {
      // No server-initiated SSE stream is offered; tools are request/response.
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let msg: JsonRpcRequest;
    try {
      msg = (await request.json()) as JsonRpcRequest;
    } catch {
      return rpcError(null, -32700, "Parse error.");
    }

    const { id, method, params } = msg;

    // Notifications (no id) are acknowledged with 202 and no body.
    if (id === undefined || id === null) {
      return new Response(null, { status: 202 });
    }

    switch (method) {
      case "initialize":
        return result(id, {
          protocolVersion:
            typeof params?.["protocolVersion"] === "string"
              ? (params["protocolVersion"] as string)
              : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case "ping":
        return result(id, {});

      case "tools/list":
        return result(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: READONLY_ANNOTATIONS,
          })),
        });

      case "tools/call":
        return await callTool(id, params, env, props, request, ctx);

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  },
};

async function callTool(
  id: unknown,
  params: Record<string, unknown> | undefined,
  env: Env,
  props: UserProps,
  request: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const name = typeof params?.["name"] === "string" ? (params["name"] as string) : "";
  const args = (params?.["arguments"] as Record<string, unknown>) ?? {};
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);

  const moodle = new MoodleClient(env.MOODLE_BASE_URL, env.MOODLE_TOKEN);
  const toolCtx: ToolContext = { env, props, moodle, request };
  const started = Date.now();
  try {
    const data = await tool.handler(args, toolCtx);
    log({ event: "tool.ok", tool: name, ms: Date.now() - started });
    return result(id, toolResult(data));
  } catch (err) {
    // Tool errors (blocked function, invalid token, bad input) are returned as
    // tool-level errors so the model sees a clear message and other tools keep
    // working (R17/R18). They are never protocol crashes.
    const message = toolErrorMessage(err, moodle);
    const errorcode = err instanceof MoodleError ? "moodle" : err instanceof ToolInputError ? "input" : "error";
    log({ event: "tool.err", tool: name, errorcode, ms: Date.now() - started });
    void ctx;
    return result(id, toolResult({ error: message }, true));
  }
}

function toolErrorMessage(err: unknown, moodle: MoodleClient): string {
  if (err instanceof MoodleError || err instanceof ToolInputError) return err.message;
  return `Unexpected error: ${moodle.redact((err as Error)?.message ?? err)}`;
}

/**
 * Wrap a tool's return value as MCP tool content. A tool may return raw MCP
 * content items via `{ _mcpContent: [...] }` (used by get_file for attachments);
 * otherwise the value is JSON-stringified into one text block.
 */
function toolResult(data: unknown, isError = false): Record<string, unknown> {
  if (data && typeof data === "object" && "_mcpContent" in data) {
    return {
      content: (data as { _mcpContent: unknown[] })._mcpContent,
      ...(isError ? { isError: true } : {}),
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
