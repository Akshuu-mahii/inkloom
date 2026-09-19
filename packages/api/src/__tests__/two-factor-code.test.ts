/**
 * The shape of a two-factor code as it actually arrives.
 *
 * Every authenticator app displays a TOTP code in two groups — `210 661` — and
 * people copy what they see. The space then sits in the middle of the string,
 * where `.trim()` cannot reach it, and the code is rejected as wrong while
 * being read out correctly. There is no way to tell that from the screen: the
 * digits in the box match the digits in the app.
 *
 * It blocked enrolment and sign-in alike, since both endpoints share this
 * schema.
 */
import { describe, expect, it } from "vitest";
import { twoFactorSchema } from "../schemas/index";

const parse = (code: string) => twoFactorSchema.safeParse({ code });

describe("a TOTP code copied from an authenticator", () => {
  it("accepts the grouped form every app displays", () => {
    const result = parse("210 661");
    expect(result.success).toBe(true);
    expect(result.data?.code).toBe("210661");
  });

  it("survives a non-breaking space, which is what some apps actually render", () => {
    expect(parse("210 661").data?.code).toBe("210661");
  });

  it("still accepts the plain six digits", () => {
    expect(parse("210661").data?.code).toBe("210661");
  });

  it("strips surrounding whitespace as well", () => {
    expect(parse("  210 661 \n").data?.code).toBe("210661");
  });
});

describe("a backup code", () => {
  it("keeps its hyphen", () => {
    expect(parse("3NzQH-QaF1Y").data?.code).toBe("3NzQH-QaF1Y");
  });
});

describe("what is still refused", () => {
  it("rejects a string that is only whitespace", () => {
    expect(parse("      ").success).toBe(false);
  });

  it("rejects something too short to be either kind of code", () => {
    expect(parse("21").success).toBe(false);
  });

  // The length cap is a denial-of-service guard, not a format check, so it has
  // to survive the fact that stripping happens first.
  it("rejects a very long string even when most of it is spaces", () => {
    expect(parse(`${" ".repeat(100)}210661`).success).toBe(false);
  });
});
