import { describe, it, expect, afterEach } from "vitest";
import { MoodleClient } from "../../src/moodle/client.js";
import { InvalidTokenError, BlockedFunctionError, MoodleError } from "../../src/moodle/errors.js";
import { stubFetch, moodleJson, type FetchStub } from "../_stubs.js";

const BASE = "https://moodle.example.test";
const TOKEN = "secret-token-value";

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

function client() {
  return new MoodleClient(BASE, TOKEN);
}

describe("MoodleClient.call", () => {
  it("POSTs with wstoken in the body, not the URL", async () => {
    stub = stubFetch(() => moodleJson({ fullname: "Test User", userid: 101 }));
    await client().call("core_webservice_get_site_info");
    const c = stub.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe(`${BASE}/webservice/rest/server.php`);
    expect(c.url).not.toContain(TOKEN);
    expect(c.body).toContain(`wstoken=${TOKEN}`);
    expect(c.body).toContain("moodlewsrestformat=json");
  });

  it("refuses a non-allowlisted function before any network call", async () => {
    stub = stubFetch(() => moodleJson({}));
    await expect(client().call("core_message_send_instant_messages" as never)).rejects.toThrow(
      MoodleError,
    );
    expect(stub.calls.length).toBe(0);
  });

  it("flattens array params into bracket syntax", async () => {
    stub = stubFetch(() => moodleJson({ courses: [] }));
    await client().call("mod_forum_get_forums_by_courses", { courseids: [1127, 1126] });
    const body = stub.calls[0]!.body;
    expect(body).toContain("courseids%5B0%5D=1127");
    expect(body).toContain("courseids%5B1%5D=1126");
  });

  it("maps invalidtoken to InvalidTokenError with regeneration guidance", async () => {
    stub = stubFetch(() => moodleJson({ exception: "x", errorcode: "invalidtoken", message: "bad" }));
    await expect(client().call("core_webservice_get_site_info")).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it("maps accessexception to BlockedFunctionError naming the function", async () => {
    stub = stubFetch(() =>
      moodleJson({ exception: "x", errorcode: "accessexception", message: "no" }),
    );
    await expect(
      client().call("gradereport_user_get_grade_items", { courseid: 1, userid: 1 }),
    ).rejects.toThrow(/gradereport_user_get_grade_items/);
    await expect(
      client().call("gradereport_user_get_grade_items", { courseid: 1, userid: 1 }),
    ).rejects.toBeInstanceOf(BlockedFunctionError);
  });

  it("retries once on network failure then throws a token-free error", async () => {
    let n = 0;
    stub = stubFetch(() => {
      n++;
      throw new Error(`connect fail ${TOKEN}`);
    });
    let err: Error | undefined;
    try {
      await client().call("core_webservice_get_site_info");
    } catch (e) {
      err = e as Error;
    }
    expect(n).toBe(2);
    expect(err?.message).not.toContain(TOKEN);
    expect(err?.message).toContain("[REDACTED]");
  });

  it("refuses to follow a redirect", async () => {
    stub = stubFetch(() => new Response(null, { status: 302, headers: { location: "https://evil" } }));
    await expect(client().call("core_webservice_get_site_info")).rejects.toThrow(/redirect/i);
  });

  it("rejects a non-https base URL at construction", () => {
    expect(() => new MoodleClient("http://moodle.example.test", TOKEN)).toThrow(/https/);
  });
});

describe("MoodleClient.fetchPluginFile", () => {
  it("rewrites to the webservice path and appends the token server-side", async () => {
    stub = stubFetch(() => new Response("PDFBYTES", { status: 200 }));
    await client().fetchPluginFile("/pluginfile.php/123/mod_resource/content/0/lec1.pdf");
    const c = stub.calls[0]!;
    expect(c.url).toContain(`${BASE}/webservice/pluginfile.php/123/`);
    expect(c.url).toContain(`token=${TOKEN}`);
  });

  it("refuses a non-pluginfile path", async () => {
    stub = stubFetch(() => new Response("x"));
    await expect(client().fetchPluginFile("/evil/path")).rejects.toThrow(/pluginfile/);
    expect(stub.calls.length).toBe(0);
  });
});
