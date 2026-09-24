/**
 * How a refused redemption is filed.
 *
 * This looks like a trivial lookup, and it is — but the console counted these
 * events and called the total "blocked attempts" in alert red, so the
 * classification is the difference between "people are mistyping their codes"
 * and "we are under attack". Both readings drive different responses, and only
 * one of them was available.
 *
 * The real guard is the `satisfies Record<RedemptionFailureReason, …>` on the
 * map itself, which makes an unclassified reason a COMPILE error. These tests
 * cover what the compiler cannot: that the judgement is the right way round.
 */
import { describe, expect, it } from "vitest";
import { refusalSeverity, type RedemptionFailureReason } from "../redemption";

/** Every member of the union, listed so a new one fails here too. */
const ALL_REASONS: RedemptionFailureReason[] = [
  "unknown_code",
  "paused",
  "revoked",
  "expired",
  "not_started",
  "limit_reached",
  "duplicate",
  "domain_not_allowed",
  "email_unverified",
  "user_suspended",
  "redemption_disabled",
  "malformed",
];

describe("refusals are filed by how notable they are", () => {
  it.each(ALL_REASONS)("classifies %s as something", (reason) => {
    expect(["info", "warning"]).toContain(refusalSeverity(reason));
  });

  it.each([
    ["unknown_code", "a typo, which is what most of these are"],
    ["duplicate", "they already have their credits"],
    ["email_unverified", "they simply got here in the wrong order"],
    ["redemption_disabled", "we switched it off, not them"],
    ["paused", "the campaign's state, not the person's conduct"],
    ["revoked", "the campaign's state, not the person's conduct"],
    ["expired", "the campaign's state, not the person's conduct"],
    ["not_started", "the campaign's state, not the person's conduct"],
    ["limit_reached", "the campaign ran out, which is our problem"],
  ] as Array<[RedemptionFailureReason, string]>)("%s is info — %s", (reason) => {
    expect(refusalSeverity(reason)).toBe("info");
  });

  it.each([
    ["domain_not_allowed", "an address outside the campaign's audience"],
    ["user_suspended", "a suspended account still trying"],
    ["malformed", "a payload that never had the shape of a code"],
  ] as Array<[RedemptionFailureReason, string]>)("%s is a warning — %s", (reason) => {
    expect(refusalSeverity(reason)).toBe("warning");
  });

  it("leaves most refusals benign, which is the whole correction", () => {
    /*
     * If this ratio ever inverts, the console is back to reporting an attack
     * every time somebody fumbles a code. Stated as a count rather than a
     * feeling so the next person changing this has to mean it.
     */
    const benign = ALL_REASONS.filter((r) => refusalSeverity(r) === "info");
    expect(benign.length).toBe(9);
    expect(ALL_REASONS.length - benign.length).toBe(3);
  });

  it("covers the whole union, with nothing falling through", () => {
    for (const reason of ALL_REASONS) {
      expect(refusalSeverity(reason), `${reason} must be classified`).toBeDefined();
    }
    expect(new Set(ALL_REASONS).size, "no duplicates in the list above").toBe(ALL_REASONS.length);
  });
});
