import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env, UserProps } from "../../src/types.js";
import { mcpApiHandler } from "../../src/mcp/server.js";
import { handleDownload } from "../../src/files/download.js";
import { signFileRef } from "../../src/files/signing.js";
import { redact, stripTokenFromUrl } from "../../src/moodle/errors.js";
import { stubFetch, moodleJson, type FetchStub } from "../_stubs.js";

const E = env as unknown as Env;
const TOKEN = E.MOODLE_TOKEN; // "test-moodle-token" — the sentinel
const BASE = E.MOODLE_BASE_URL;
const PROPS: UserProps = { googleSub: "1234567890", email: "me@example.com", name: "Test User" };

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

async function toolCall(name: string, args: Record<string, unknown> = {}) {
  const req = new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ctx = { props: PROPS } as unknown as ExecutionContext;
  return mcpApiHandler.fetch!(req, E, ctx);
}

const hosted = `${BASE}/webservice/pluginfile.php/1/mod_resource/content/0/lec1.pdf`;
const courseContents = [
  {
    id: 1,
    summary: `notes <a href="${hosted}?token=${TOKEN}">lec1</a>`,
    modules: [
      {
        id: 45,
        modname: "resource",
        name: "Lecture 1",
        contents: [{ type: "file", filename: "lec1.pdf", fileurl: `${hosted}?token=${TOKEN}`, filesize: 2000, mimetype: "application/pdf" }],
      },
    ],
  },
];

describe("the Moodle token never leaks (AE4)", () => {
  it("is absent from tool outputs, refs, and links even when Moodle echoes it", async () => {
    stub = stubFetch((req) => {
      if (req.url.includes("/webservice/rest/server.php")) return moodleJson(courseContents);
      return new Response("PDFBYTES", { status: 200, headers: { "content-type": "application/pdf" } });
    });

    // get_course_contents: fileurls carry ?token= upstream; output must not.
    const cc = await toolCall("get_course_contents", { course_id: 1 });
    const ccText = await cc.text();
    expect(ccText).not.toContain(TOKEN);

    // get_file: content + link.
    const refToken = await signFileRef(E, { k: "cm", c: 1, m: 45, i: 0 });
    const gf = await toolCall("get_file", { ref: refToken });
    const gfText = await gf.text();
    expect(gfText).not.toContain(TOKEN);

    // get_references surfaces the hosted link, token-stripped.
    const refs = await toolCall("get_references", { course_id: 1 });
    expect(await refs.text()).not.toContain(TOKEN);

    // The download response (headers + body) carries no token.
    const dl = await handleDownload(E, refToken);
    expect(JSON.stringify([...dl.headers])).not.toContain(TOKEN);
    expect(await dl.text()).not.toContain(TOKEN);
  });

  it("error messages echoing the token come out redacted", async () => {
    stub = stubFetch(() =>
      moodleJson({ exception: "x", errorcode: "generalexceptionmessage", message: `failed with token=${TOKEN}` }),
    );
    const resp = await toolCall("list_courses", {});
    const text = await resp.text();
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("[REDACTED]");
  });

  it("redact() and stripTokenFromUrl() remove the token literal and query param", () => {
    expect(redact(`x ${TOKEN} y`, TOKEN)).not.toContain(TOKEN);
    expect(redact(`url?wstoken=${TOKEN}&a=1`)).toContain("wstoken=[REDACTED]");
    expect(stripTokenFromUrl(`${hosted}?token=${TOKEN}&x=1`)).not.toContain(TOKEN);
  });
});
