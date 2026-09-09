import { describe, expect, it } from "vitest";
import { fingerprintCode, generateCode, isValidCodeShape, maskCode, normalizeCode } from "../code";

const PEPPER = "test-pepper-at-least-16-chars-long";

describe("normalizeCode", () => {
  it("upper-cases and strips separators so one code has one canonical form", () => {
    const canonical = "INKLOOMHACKATHON";
    for (const variant of [
      "INKLOOMHACKATHON",
      "inkloomhackathon",
      "Inkloom-Hackathon",
      "  inkloom hackathon  ",
      "INKLOOM_HACKATHON",
      "inkloom.hackathon",
      "INKLOOM–HACKATHON", // en dash, as pasted from a styled email
    ]) {
      expect(normalizeCode(variant)).toBe(canonical);
    }
  });

  it("strips zero-width and non-breaking characters pasted from email clients", () => {
    expect(normalizeCode("INK​LOOM HACK")).toBe("INKLOOMHACK");
  });

  it("normalises full-width characters to their ASCII equivalents", () => {
    // NFKC folding: a user typing on a CJK keyboard must not be locked out.
    expect(normalizeCode("ＩＮＫ123")).toBe("INK123");
  });

  it("returns an empty string for input with no alphanumerics", () => {
    expect(normalizeCode("---")).toBe("");
    expect(normalizeCode("   ")).toBe("");
  });
});

describe("isValidCodeShape", () => {
  it("rejects codes that are too short, too long, or empty", () => {
    expect(isValidCodeShape("")).toBe(false);
    expect(isValidCodeShape("ABC")).toBe(false);
    expect(isValidCodeShape("A".repeat(65))).toBe(false);
  });

  it("accepts codes within bounds", () => {
    expect(isValidCodeShape("ABC123")).toBe(true);
    expect(isValidCodeShape("INKLOOMHACKATHON")).toBe(true);
    expect(isValidCodeShape("A".repeat(64))).toBe(true);
  });
});

describe("fingerprintCode", () => {
  it("is deterministic for the same code and pepper", async () => {
    const a = await fingerprintCode("INKLOOMHACKATHON", PEPPER);
    const b = await fingerprintCode("INKLOOMHACKATHON", PEPPER);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never returns the plaintext code", async () => {
    const fp = await fingerprintCode("INKLOOMHACKATHON", PEPPER);
    expect(fp.toUpperCase()).not.toContain("INKLOOM");
  });

  it("produces a different fingerprint under a different pepper", async () => {
    // This is what makes a stolen database useless without the secret.
    const withA = await fingerprintCode("INKLOOMHACKATHON", PEPPER);
    const withB = await fingerprintCode("INKLOOMHACKATHON", "a-completely-different-pepper!!");
    expect(withA).not.toBe(withB);
  });

  it("distinguishes codes that differ by one character", async () => {
    const a = await fingerprintCode("INKLOOMHACKATHON", PEPPER);
    const b = await fingerprintCode("INKLOOMHACKATHOM", PEPPER);
    expect(a).not.toBe(b);
  });

  it("refuses a missing or weak pepper rather than silently using one", async () => {
    await expect(fingerprintCode("ABC123", "")).rejects.toThrow(/PEPPER/);
    await expect(fingerprintCode("ABC123", "short")).rejects.toThrow(/PEPPER/);
  });
});

describe("generateCode", () => {
  it("produces hyphen-grouped codes that normalise back to plain alphanumerics", () => {
    const code = generateCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(normalizeCode(code)).toHaveLength(12);
  });

  it("omits characters that are easy to misread", () => {
    // No I, L, O, U, B, S, 0, 1, 8 — a user reading a code aloud shouldn't fail.
    const joined = Array.from({ length: 200 }, () => normalizeCode(generateCode())).join("");
    for (const forbidden of ["I", "L", "O", "U", "B", "S", "0", "1", "8"]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("does not repeat across many generations", () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateCode()));
    expect(codes.size).toBe(2000);
  });

  it("honours a custom shape", () => {
    expect(generateCode(4, 5)).toMatch(/^[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
  });
});

describe("maskCode", () => {
  it("reveals only the ends of a long code", () => {
    const { masked, last4 } = maskCode("INKLOOMHACKATHON");
    expect(masked).toBe("INKL••••••••THON");
    expect(last4).toBe("THON");
    expect(masked).not.toContain("OOMHACKA");
  });

  it("reveals less for short codes, never more", () => {
    expect(maskCode("ABC123").masked).toBe("A••••3");
    expect(maskCode("ABCD1234").masked).toBe("AB••••34");
  });

  it("never returns the full code", () => {
    for (const code of ["ABC123", "ABCD1234", "INKLOOMHACKATHON", "A".repeat(40)]) {
      expect(maskCode(code).masked).not.toBe(code);
    }
  });
});
