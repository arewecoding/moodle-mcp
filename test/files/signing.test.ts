import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { signFileRef, verifyFileRef } from "../../src/files/signing.js";
import type { Env } from "../../src/types.js";

const E = env as unknown as Env;

describe("file ref signing", () => {
  it("signs and verifies a course-module file ref", async () => {
    const token = await signFileRef(E, { k: "cm", c: 1127, m: 45, i: 0 });
    const v = await verifyFileRef(E, token);
    expect(v.ok).toBe(true);
    if (v.ok && v.ref.k === "cm") {
      expect(v.ref.c).toBe(1127);
      expect(v.ref.m).toBe(45);
      expect(v.ref.i).toBe(0);
    } else {
      throw new Error("expected a cm ref");
    }
  });

  it("signs and verifies a forum-attachment ref", async () => {
    const token = await signFileRef(E, { k: "fa", d: 50, p: 99, i: 1 });
    const v = await verifyFileRef(E, token);
    expect(v.ok).toBe(true);
    if (v.ok && v.ref.k === "fa") {
      expect(v.ref.d).toBe(50);
      expect(v.ref.p).toBe(99);
      expect(v.ref.i).toBe(1);
    } else {
      throw new Error("expected an fa ref");
    }
  });

  it("rejects a tampered payload (changed course/module/index)", async () => {
    const token = await signFileRef(E, { k: "cm", c: 1127, m: 45, i: 0 });
    const [payload, sig] = token.split(".");
    // Flip a character in the payload.
    const broken = `${payload!.slice(0, -1)}${payload!.slice(-1) === "A" ? "B" : "A"}.${sig}`;
    const v = await verifyFileRef(E, broken);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(["badsig", "malformed"]).toContain(v.reason);
  });

  it("rejects a tampered signature", async () => {
    const token = await signFileRef(E, { k: "cm", c: 1127, m: 45, i: 1 });
    const [payload] = token.split(".");
    const v = await verifyFileRef(E, `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
    expect(v.ok).toBe(false);
  });

  it("rejects an expired ref", async () => {
    const past = Math.floor(Date.now() / 1000) - 60 * 60;
    const token = await signFileRef(E, { k: "cm", c: 1, m: 2, i: 0 }, past);
    const v = await verifyFileRef(E, token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("expired");
  });

  it("verifies with the previous kid after rotation, fails on a retired kid", async () => {
    // Sign under current single key k1.
    const token = await signFileRef(E, { k: "cm", c: 5, m: 6, i: 0 });
    // Rotate: k2 is now newest, k1 still present -> old token still verifies.
    const rotated = { ...E, LINK_SIGNING_KEYS: `k2:bmV3LWtleS1zZWNyZXQtdHdv,${E.LINK_SIGNING_KEYS}` } as Env;
    expect((await verifyFileRef(rotated, token)).ok).toBe(true);
    // Retire k1 entirely -> old token (kid k1) no longer verifies.
    const retired = { ...E, LINK_SIGNING_KEYS: "k2:bmV3LWtleS1zZWNyZXQtdHdv" } as Env;
    const v = await verifyFileRef(retired, token);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("badsig");
  });

  it("produces links well under 250 characters", async () => {
    const token = await signFileRef(E, { k: "cm", c: 999999, m: 888888, i: 42 });
    expect(`https://worker.example.workers.dev/files/${token}`.length).toBeLessThan(250);
  });
});
