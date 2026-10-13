import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env, UserProps } from "../../src/types.js";
import { mcpApiHandler } from "../../src/mcp/server.js";
import { signFileRef } from "../../src/files/signing.js";
import { stubFetch, moodleJson, type FetchStub } from "../_stubs.js";

const E = env as unknown as Env;
const PROPS: UserProps = { googleSub: "1234567890", email: "me@example.com", name: "Test User" };

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

async function rpc(method: string, params?: unknown, opts?: { noAuth?: boolean }) {
  const req = new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const ctx = { props: opts?.noAuth ? undefined : PROPS } as unknown as ExecutionContext;
  const resp = await mcpApiHandler.fetch!(req, E, ctx);
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> };
}

function toolData(result: Record<string, unknown>): unknown {
  const content = (result["result"] as { content: Array<{ type: string; text?: string }> }).content;
  const text = content.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
function isError(result: Record<string, unknown>): boolean {
  return (result["result"] as { isError?: boolean })?.isError === true;
}

describe("MCP protocol", () => {
  it("rejects an unauthenticated request", async () => {
    const { json } = await rpc("tools/list", {}, { noAuth: true });
    expect(json["error"]).toBeTruthy();
  });

  it("initialize returns server info and protocol version", async () => {
    const { json } = await rpc("initialize", { protocolVersion: "2025-06-18" });
    const res = json["result"] as Record<string, unknown>;
    expect(res["protocolVersion"]).toBe("2025-06-18");
    expect((res["serverInfo"] as { name: string }).name).toBe("moodle-mcp");
  });

  it("tools/list advertises every tool as read-only and open-world", async () => {
    const { json } = await rpc("tools/list");
    const tools = (json["result"] as { tools: Array<{ name: string; annotations: Record<string, boolean> }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_my_info", "list_courses", "get_course_contents", "get_file"]));
    for (const t of tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.openWorldHint).toBe(true);
    }
  });

  it("unknown tool returns an error", async () => {
    const { json } = await rpc("tools/call", { name: "send_message", arguments: {} });
    expect(json["error"]).toBeTruthy();
  });
});

describe("list_courses", () => {
  it("maps fields and converts dates to IST", async () => {
    stub = stubFetch(() =>
      moodleJson({
        courses: [{ id: 1127, fullname: "LLMs", shortname: "LLM", progress: 50, enddate: 1768435200 }],
      }),
    );
    const { json } = await rpc("tools/call", { name: "list_courses", arguments: { classification: "all" } });
    const data = toolData(json) as { count: number; courses: Array<Record<string, unknown>> };
    expect(data.count).toBe(1);
    expect(data.courses[0]!["id"]).toBe(1127);
    expect((data.courses[0]!["fullname"] as { untrusted: boolean; text: string }).untrusted).toBe(true);
    expect(data.courses[0]!["enddate"]).toBe("2026-01-15T05:30:00+05:30");
  });

  it("rejects an invalid classification without calling Moodle", async () => {
    stub = stubFetch(() => moodleJson({ courses: [] }));
    const { json } = await rpc("tools/call", { name: "list_courses", arguments: { classification: "bogus" } });
    expect(isError(json)).toBe(true);
    expect(stub.calls.length).toBe(0);
  });
});

describe("error isolation (R17)", () => {
  it("a blocked function errors that one tool while others keep working", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("core_course_get_contents")) {
        return moodleJson({ exception: "x", errorcode: "accessexception", message: "no" });
      }
      return moodleJson({ fullname: "Test User", username: "tu", userid: 101, sitename: "Example University" });
    });
    const blocked = await rpc("tools/call", { name: "get_course_contents", arguments: { course_id: 1 } });
    expect(isError(blocked.json)).toBe(true);
    expect(JSON.stringify(toolData(blocked.json))).toMatch(/not enabled on this Moodle/);

    const ok = await rpc("tools/call", { name: "get_my_info", arguments: {} });
    expect(isError(ok.json)).toBe(false);
    expect((toolData(ok.json) as { userid: number }).userid).toBe(101);
  });
});

describe("get_file", () => {
  const BASE = E.MOODLE_BASE_URL;
  const hosted = (name: string) =>
    `${BASE}/webservice/pluginfile.php/123/mod_resource/content/0/${name}`;

  const contents = (name: string, size: number, mimetype: string) => [
    {
      id: 1,
      modules: [
        {
          id: 45,
          contents: [{ type: "file", filename: name, fileurl: hosted(name), filesize: size, mimetype }],
        },
      ],
    },
  ];

  it("returns a text file's contents inline plus a link", async () => {
    stub = stubFetch((req) => {
      if (req.url.includes("/webservice/rest/server.php")) return moodleJson(contents("notes.ipynb", 100, "application/json"));
      return new Response('{"cells":[]}', { status: 200, headers: { "content-type": "application/json" } });
    });
    const token = await signFileRef(E, { k: "cm", c: 1, m: 45, i: 0 });
    const { json } = await rpc("tools/call", { name: "get_file", arguments: { ref: token } });
    const content = (json["result"] as { content: Array<{ type: string; text?: string }> }).content;
    const text = content.map((c) => c.text ?? "").join("\n");
    expect(text).toContain("notes.ipynb");
    expect(text).toContain("/files/");
    expect(text).toContain('"cells"');
  });

  it("returns link-only for an oversized file (AE7)", async () => {
    stub = stubFetch((req) => {
      if (req.url.includes("/webservice/rest/server.php")) return moodleJson(contents("scan.pdf", 40_000_000, "application/pdf"));
      return new Response("PDF", { status: 200, headers: { "content-type": "application/pdf" } });
    });
    const token = await signFileRef(E, { k: "cm", c: 1, m: 45, i: 0 });
    const { json } = await rpc("tools/call", { name: "get_file", arguments: { ref: token } });
    const content = (json["result"] as { content: Array<{ type: string; text?: string }> }).content;
    expect(content.length).toBe(1);
    expect(content[0]!.text).toMatch(/larger than the inline limit/);
    // The oversized file is never fetched from Moodle.
    expect(stub.calls.some((c) => c.url.includes("/pluginfile.php/"))).toBe(false);
  });

  it("returns a PDF as an embedded resource under the cap", async () => {
    stub = stubFetch((req) => {
      if (req.url.includes("/webservice/rest/server.php")) return moodleJson(contents("lec1.pdf", 2000, "application/pdf"));
      return new Response("PDFBYTES", { status: 200, headers: { "content-type": "application/pdf" } });
    });
    const token = await signFileRef(E, { k: "cm", c: 1, m: 45, i: 0 });
    const { json } = await rpc("tools/call", { name: "get_file", arguments: { ref: token } });
    const content = (json["result"] as { content: Array<{ type: string; resource?: { mimeType: string; blob: string } }> }).content;
    const resource = content.find((c) => c.type === "resource");
    expect(resource).toBeTruthy();
    expect(resource!.resource!.mimeType).toBe("application/pdf");
    expect(typeof resource!.resource!.blob).toBe("string");
  });

  it("rejects an invalid ref", async () => {
    stub = stubFetch(() => moodleJson({}));
    const { json } = await rpc("tools/call", { name: "get_file", arguments: { ref: "not.a.valid.token" } });
    expect(isError(json)).toBe(true);
  });
});
