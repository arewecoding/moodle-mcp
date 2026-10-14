import { describe, it, expect, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env, UserProps } from "../../src/types.js";
import { mcpApiHandler } from "../../src/mcp/server.js";
import { stubFetch, moodleJson, type FetchStub } from "../_stubs.js";

const E = env as unknown as Env;
const BASE = E.MOODLE_BASE_URL;
const PROPS: UserProps = { googleSub: "1234567890", email: "me@example.com", name: "Test User" };

let stub: FetchStub | undefined;
afterEach(() => stub?.restore());

async function call(name: string, args: Record<string, unknown> = {}) {
  const req = new Request("https://worker.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const ctx = { props: PROPS } as unknown as ExecutionContext;
  const resp = await mcpApiHandler.fetch!(req, E, ctx);
  const json = (await resp.json()) as Record<string, unknown>;
  const result = json["result"] as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { isError: result?.isError === true, data, text };
}

const now = Math.floor(Date.now() / 1000);

describe("get_upcoming_deadlines", () => {
  it("merges action and calendar events, dedupes by id, converts to IST", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("get_action_events_by_timesort")) {
        return moodleJson({
          events: [{ id: 1, name: "Assignment 1 due", timesort: now + 3600, eventtype: "due", modulename: "assign", course: { fullname: "LLMs" } }],
        });
      }
      if (req.body.includes("get_calendar_upcoming_view")) {
        return moodleJson({
          events: [
            { id: 1, name: "Assignment 1 due", timestart: now + 3600 },
            { id: 2, name: "Midterm exam", timestart: now + 7200, eventtype: "course", course: { fullname: "Probability" } },
          ],
        });
      }
      return moodleJson({});
    });
    const { data } = await call("get_upcoming_deadlines", { days: 7 });
    const d = data as { count: number; events: Array<Record<string, unknown>> };
    expect(d.count).toBe(2);
    expect((d.events[0]!["name"] as { text: string }).text).toBe("Assignment 1 due");
    const names = d.events.map((e) => (e["name"] as { text: string }).text);
    expect(names).toContain("Midterm exam"); // course-level exam surfaces
    expect(String(d.events[0]!["time"])).toMatch(/\+05:30$/);
  });

  it("excludes events beyond the window and rejects bad days", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("get_action_events_by_timesort")) {
        return moodleJson({ events: [{ id: 9, name: "Far away", timesort: now + 400 * 86400 }] });
      }
      return moodleJson({ events: [] });
    });
    const inWindow = await call("get_upcoming_deadlines", { days: 14 });
    expect((inWindow.data as { count: number }).count).toBe(0);
    const bad = await call("get_upcoming_deadlines", { days: 999 });
    expect(bad.isError).toBe(true);
  });
});

describe("get_recent_announcements", () => {
  it("returns a cancellation post with untrusted text and an attachment ref (AE6)", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("timeline_classification")) {
        return moodleJson({ courses: [{ id: 1127, fullname: "LLMs" }] });
      }
      if (req.body.includes("get_forums_by_courses")) {
        return moodleJson([
          { id: 9, course: 1127, type: "news" },
          { id: 10, course: 1127, type: "general" },
        ]);
      }
      if (req.body.includes("get_forum_discussions")) {
        return moodleJson({
          discussions: [
            {
              discussion: 50,
              subject: "Tomorrow cancelled",
              message: "<p>Tomorrow's class is cancelled</p>",
              userfullname: "Prof X",
              timemodified: now - 3600,
              firstpost: 99,
              attachments: [
                { type: "file", filename: "notice.pdf", fileurl: `${BASE}/webservice/pluginfile.php/1/mod_forum/attachment/99/notice.pdf`, filesize: 100, mimetype: "application/pdf" },
              ],
            },
            { discussion: 51, subject: "Old news", message: "<p>old</p>", timemodified: now - 90 * 86400, firstpost: 80 },
          ],
        });
      }
      return moodleJson({});
    });
    const { data } = await call("get_recent_announcements", { days: 7 });
    const d = data as { count: number; announcements: Array<Record<string, unknown>> };
    expect(d.count).toBe(1); // old one excluded
    const a = d.announcements[0]!;
    expect((a["text"] as { untrusted: boolean; text: string }).untrusted).toBe(true);
    expect((a["text"] as { text: string }).text).toMatch(/cancelled/);
    expect((a["files"] as Array<{ ref: string }>)[0]!.ref).toContain(".");
  });
});

describe("get_messages", () => {
  it("lists a conversation with sender and text, read-only", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("get_site_info")) {
        return moodleJson({ fullname: "Me", username: "me", userid: 101, sitename: "Example University" });
      }
      if (req.body.includes("get_conversations")) {
        return moodleJson({
          conversations: [
            {
              id: 1,
              members: [{ id: 101, fullname: "Me" }, { id: 200, fullname: "Prof Y" }],
              messages: [{ id: 5, useridfrom: 200, text: "See you in class", timecreated: now }],
            },
          ],
        });
      }
      return moodleJson({});
    });
    const { data } = await call("get_messages", {});
    const d = data as { conversations: Array<{ with: Array<{ text: string }>; messages: Array<{ from: { text: string }; text: { text: string } }> }> };
    expect(d.conversations[0]!.with[0]!.text).toBe("Prof Y");
    expect(d.conversations[0]!.messages[0]!.from.text).toBe("Prof Y");
    expect(d.conversations[0]!.messages[0]!.text.text).toBe("See you in class");
  });
});

describe("forums", () => {
  it("lists forums, discussions with attachment refs, and posts", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("get_forums_by_courses")) {
        return moodleJson([{ id: 9, course: 1127, cmid: 3, name: "Announcements", type: "news" }]);
      }
      if (req.body.includes("get_forum_discussions")) {
        return moodleJson({
          discussions: [{ discussion: 50, subject: "Welcome", message: "<p>hi</p>", userfullname: "Prof", created: now, timemodified: now, numreplies: 2, firstpost: 99, attachments: [{ type: "file", filename: "syllabus.pdf", fileurl: `${BASE}/webservice/pluginfile.php/1/mod_forum/attachment/99/syllabus.pdf`, filesize: 500, mimetype: "application/pdf" }] }],
        });
      }
      if (req.body.includes("get_discussion_posts")) {
        return moodleJson({ posts: [{ id: 99, subject: "Welcome", message: "<p>hi</p>", author: { fullname: "Prof" }, timecreated: now, attachments: [] }] });
      }
      return moodleJson({});
    });
    const forums = await call("list_forums", { course_ids: [1127] });
    expect((forums.data as { forums: Array<{ type: string }> }).forums[0]!.type).toBe("news");

    const disc = await call("get_forum_discussions", { forum_id: 9 });
    const dd = disc.data as { discussions: Array<{ files?: Array<{ ref: string }>; subject: { text: string } }> };
    expect(dd.discussions[0]!.subject.text).toBe("Welcome");
    expect(dd.discussions[0]!.files![0]!.ref).toContain(".");

    const posts = await call("get_discussion_posts", { discussion_id: 50 });
    expect((posts.data as { posts: Array<{ id: number }> }).posts[0]!.id).toBe(99);
  });

  it("rejects bad inputs without calling Moodle", async () => {
    stub = stubFetch(() => moodleJson({}));
    const r = await call("get_forum_discussions", { forum_id: -1 });
    expect(r.isError).toBe(true);
    expect(stub.calls.length).toBe(0);
  });
});

describe("get_grades", () => {
  it("maps grade items", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("get_site_info")) return moodleJson({ userid: 101, fullname: "Me", username: "me", sitename: "X" });
      if (req.body.includes("gradereport_user_get_grade_items")) {
        return moodleJson({ usergrades: [{ gradeitems: [{ itemname: "Quiz 1", itemtype: "mod", gradeformatted: "8.0", grademin: 0, grademax: 10, percentageformatted: "80 %" }] }] });
      }
      return moodleJson({});
    });
    const { data } = await call("get_grades", { course_id: 1127 });
    const items = (data as { items: Array<Record<string, unknown>> }).items;
    expect((items[0]!["item"] as { text: string }).text).toBe("Quiz 1");
    expect(items[0]!["grade"]).toBe("8.0");
    expect(items[0]!["range"]).toBe("0–10");
  });

  it("surfaces a blocked function as a friendly tool error (R17)", async () => {
    stub = stubFetch((req) => {
      if (req.body.includes("get_site_info")) return moodleJson({ userid: 101 });
      return moodleJson({ exception: "x", errorcode: "nopermissions", message: "no" });
    });
    const r = await call("get_grades", { course_id: 1127 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not enabled on this Moodle/);
  });
});

describe("get_references", () => {
  it("classifies links, maps a Moodle file to a ref, finds citations, drops bad schemes", async () => {
    const hostedPdf = `${BASE}/webservice/pluginfile.php/1/mod_resource/content/0/lec1.pdf`;
    stub = stubFetch((req) => {
      if (req.body.includes("core_course_get_contents")) {
        return moodleJson([
          {
            id: 1,
            summary: '<a href="https://youtu.be/abc123">lecture video</a> and <a href="javascript:alert(1)">bad</a>',
            modules: [
              {
                id: 45,
                modname: "resource",
                contents: [{ type: "file", filename: "lec1.pdf", fileurl: hostedPdf, filesize: 2000, mimetype: "application/pdf" }],
              },
              {
                id: 46,
                modname: "label",
                description: `Read Bishop PRML Chapter 4.1 and see <a href="https://arxiv.org/pdf/2301.00001.pdf">the paper</a> and <a href="https://drive.google.com/file/d/xyz">slides</a>. Notes: <a href="${hostedPdf}">lec1</a>`,
              },
              {
                id: 47,
                modname: "url",
                contents: [{ type: "url", fileurl: "https://example.com/reading" }],
              },
            ],
          },
        ]);
      }
      return moodleJson({});
    });
    const { data } = await call("get_references", { course_id: 1127 });
    const d = data as { links: Array<{ url: string; kind: string; ref?: string }>; book_citations: string[] };
    const kinds = Object.fromEntries(d.links.map((l) => [l.kind, l]));
    expect(kinds["youtube"]).toBeTruthy();
    expect(kinds["pdf_link"]).toBeTruthy();
    expect(kinds["google_drive"]).toBeTruthy();
    expect(kinds["web_page"]).toBeTruthy();
    // The Moodle-hosted file link maps to a readable ref.
    expect(kinds["moodle_file"]!.ref).toBeTruthy();
    // javascript: link dropped.
    expect(d.links.some((l) => l.url.startsWith("javascript:"))).toBe(false);
    // Book citation detected.
    expect(d.book_citations.some((c) => /Chapter 4\.1/.test(c))).toBe(true);
    // No outbound fetch to any reference host.
    expect(stub.calls.some((c) => /youtu\.be|arxiv|drive\.google|example\.com/.test(c.url))).toBe(false);
  });
});

describe("tools/list", () => {
  it("advertises all ten tools, each read-only", async () => {
    const req = new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const ctx = { props: PROPS } as unknown as ExecutionContext;
    const resp = await mcpApiHandler.fetch!(req, E, ctx);
    const json = (await resp.json()) as { result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> } };
    const names = json.result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_my_info", "list_courses", "get_course_contents", "get_file",
        "get_upcoming_deadlines", "get_recent_announcements", "get_messages",
        "list_forums", "get_forum_discussions", "get_discussion_posts", "get_grades", "get_references",
      ]),
    );
    for (const t of json.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
    // Every advertised tool is a read: its name starts with get_ or list_.
    for (const n of names) expect(n).toMatch(/^(get|list)_/);
  });
});
