import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../../src/types.js";
import {
  isMoodleHostedFile,
  handleDownload,
  hostedFilesOf,
  type MoodleModule,
} from "../../src/files/download.js";
import { signFileRef } from "../../src/files/signing.js";
import { stubFetch, moodleJson, type FetchStub } from "../_stubs.js";

const E = env as unknown as Env;
const BASE = E.MOODLE_BASE_URL; // https://moodle.example.test

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

const courseContents = (fileurl: string, filesize = 2000) => [
  {
    id: 1,
    name: "Topic 1",
    modules: [
      {
        id: 45,
        name: "Lecture 1",
        modname: "resource",
        contents: [
          { type: "file", filename: "lec1.pdf", fileurl, filesize, mimetype: "application/pdf" },
        ],
      },
    ],
  },
];

const HOSTED = `${BASE}/webservice/pluginfile.php/123/mod_resource/content/0/lec1.pdf`;

function routeMoodle(contents: unknown, fileBody = "PDFBYTES") {
  return stubFetch((req) => {
    if (req.url.includes("/webservice/rest/server.php")) return moodleJson(contents);
    if (req.url.includes("/pluginfile.php/")) {
      return new Response(fileBody, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response("unexpected", { status: 500 });
  });
}

describe("isMoodleHostedFile", () => {
  it("accepts a pluginfile URL on the configured host", () => {
    expect(isMoodleHostedFile(HOSTED, BASE)).toBe(true);
  });
  it("rejects an external host", () => {
    expect(isMoodleHostedFile("https://drive.google.com/file/d/x", BASE)).toBe(false);
  });
  it("rejects a non-pluginfile path on the host", () => {
    expect(isMoodleHostedFile(`${BASE}/mod/url/view.php?id=9`, BASE)).toBe(false);
  });
});

describe("hostedFilesOf", () => {
  it("excludes external URL-activity entries", () => {
    const mod: MoodleModule = {
      id: 9,
      contents: [
        { type: "url", fileurl: "https://example.com/paper.pdf" },
        { type: "file", fileurl: "https://evil.example/leak.pdf", filename: "leak.pdf" },
        { type: "file", fileurl: HOSTED, filename: "lec1.pdf" },
      ],
    };
    const files = hostedFilesOf(mod, BASE);
    expect(files.length).toBe(1);
    expect(files[0]!.filename).toBe("lec1.pdf");
  });
});

describe("handleDownload", () => {
  it("streams a valid signed link with safe headers and no token (AE4)", async () => {
    stub = routeMoodle(courseContents(HOSTED));
    const token = await signFileRef(E, { k: "cm", c: 1127, m: 45, i: 0 });
    const resp = await handleDownload(E, token);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toBe("application/pdf");
    expect(resp.headers.get("content-disposition")).toContain("inline");
    expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
    expect(resp.headers.get("cache-control")).toBe("private, no-store");
    expect(resp.headers.get("content-security-policy")).toBe("sandbox");
    const body = await resp.text();
    expect(body).toBe("PDFBYTES");
    // No token anywhere in the download request URL leaves the server? It must
    // be present on the upstream pluginfile GET only.
    const pluginReq = stub.calls.find((c) => c.url.includes("/pluginfile.php/"));
    expect(pluginReq!.url).toContain("token=test-moodle-token");
    // ...but never in the response we return to the agent:
    expect(JSON.stringify([...resp.headers])).not.toContain("test-moodle-token");
  });

  it("returns 410 for an expired link (AE2)", async () => {
    stub = routeMoodle(courseContents(HOSTED));
    const token = await signFileRef(E, { k: "cm", c: 1127, m: 45, i: 0 }, Math.floor(Date.now() / 1000) - 3600);
    const resp = await handleDownload(E, token);
    expect(resp.status).toBe(410);
    expect(stub.calls.length).toBe(0); // never contacts Moodle
  });

  it("returns 403 for a tampered link (AE3)", async () => {
    stub = routeMoodle(courseContents(HOSTED));
    const token = await signFileRef(E, { k: "cm", c: 1127, m: 45, i: 0 });
    const resp = await handleDownload(E, token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA"));
    expect([403, 410]).toContain(resp.status);
  });

  it("streams a forum-attachment (fa) ref by re-resolving the post", async () => {
    const attUrl = `${BASE}/webservice/pluginfile.php/1/mod_forum/attachment/99/notice.pdf`;
    stub = stubFetch((req) => {
      if (req.url.includes("/webservice/rest/server.php") && req.body.includes("get_discussion_posts")) {
        return moodleJson({
          posts: [
            { id: 99, attachments: [{ type: "file", filename: "notice.pdf", fileurl: attUrl, filesize: 100, mimetype: "application/pdf" }] },
          ],
        });
      }
      if (req.url.includes("/pluginfile.php/")) {
        return new Response("ATTACHMENT", { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return new Response("unexpected", { status: 500 });
    });
    const token = await signFileRef(E, { k: "fa", d: 50, p: 99, i: 0 });
    const resp = await handleDownload(E, token);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ATTACHMENT");
    const pluginReq = stub.calls.find((c) => c.url.includes("/pluginfile.php/"));
    expect(pluginReq!.url).toContain("token=test-moodle-token");
  });

  it("rejects a ref whose resolved file is not Moodle-hosted (token never sent elsewhere)", async () => {
    // Course contents lists only an external file for module 45, so index 0 of
    // hosted files does not exist -> 404, and no pluginfile fetch happens.
    stub = routeMoodle([
      { id: 1, modules: [{ id: 45, contents: [{ type: "file", fileurl: "https://evil.example/x.pdf", filename: "x.pdf" }] }] },
    ]);
    const token = await signFileRef(E, { k: "cm", c: 1127, m: 45, i: 0 });
    const resp = await handleDownload(E, token);
    expect(resp.status).toBe(404);
    expect(stub.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });
});
