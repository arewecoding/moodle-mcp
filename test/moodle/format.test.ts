import { describe, it, expect } from "vitest";
import { flattenParams, toIstIso, htmlToText, cap } from "../../src/moodle/format.js";

describe("flattenParams", () => {
  it("flattens arrays into Moodle bracket syntax", () => {
    const entries = flattenParams({ courseids: [1127, 1126] });
    const qs = entries.map(([k, v]) => `${k}=${v}`).join("&");
    expect(qs).toBe("courseids[0]=1127&courseids[1]=1126");
  });

  it("flattens nested objects and booleans", () => {
    const entries = flattenParams({ options: { onlyactive: true, flags: [false, "x"] } });
    const map = Object.fromEntries(entries);
    expect(map["options[onlyactive]"]).toBe("1");
    expect(map["options[flags][0]"]).toBe("0");
    expect(map["options[flags][1]"]).toBe("x");
  });

  it("drops null and undefined", () => {
    const entries = flattenParams({ a: null, b: undefined, c: 1 });
    expect(entries).toEqual([["c", "1"]]);
  });
});

describe("toIstIso", () => {
  it("returns null for 0 and non-numeric", () => {
    expect(toIstIso(0)).toBeNull();
    expect(toIstIso(-5)).toBeNull();
    expect(toIstIso("nope")).toBeNull();
    expect(toIstIso(null)).toBeNull();
  });

  it("formats a real timestamp with +05:30", () => {
    // 2026-01-15T00:00:00Z -> 05:30 IST same day
    const iso = toIstIso(1768435200);
    expect(iso).toBe("2026-01-15T05:30:00+05:30");
  });
});

describe("htmlToText", () => {
  it("strips tags, unescapes entities, and normalizes breaks", () => {
    const html = "<p>Hello &amp; welcome</p><br>Line&nbsp;two<div>three</div>";
    const text = htmlToText(html);
    expect(text).toContain("Hello & welcome");
    expect(text).toContain("Line two");
    expect(text).toContain("three");
    expect(text).not.toContain("<");
  });

  it("caps long text with an ellipsis", () => {
    const text = htmlToText("x".repeat(100), 10);
    expect(text.length).toBeLessThanOrEqual(11);
    expect(text.endsWith("…")).toBe(true);
  });

  it("returns empty for null/empty", () => {
    expect(htmlToText(null)).toBe("");
    expect(htmlToText("")).toBe("");
  });
});

describe("cap", () => {
  it("leaves short text and truncates long text", () => {
    expect(cap("abc", 10)).toBe("abc");
    expect(cap("abcdefghij", 3)).toBe("abc…");
  });
});
