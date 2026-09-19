/**
 * "Has the schedule come round yet?"
 *
 * This decides whether a missing scheduled run is a defect or simply an
 * environment deployed after today's trigger time. Get it wrong in one
 * direction and the production gate cries wolf every time something is
 * deployed in the afternoon; get it wrong in the other and a cron that has
 * silently stopped firing reports as "not yet".
 */
import { describe, expect, it } from "vitest";
import { lastOccurrence } from "../cron-acceptance";

const at = (iso: string) => new Date(iso);

describe("the most recent 03:20 UTC", () => {
  it("is today, when now is past it", () => {
    expect(lastOccurrence(3, 20, at("2026-09-19T12:28:00Z")).toISOString()).toBe(
      "2026-09-19T03:20:00.000Z",
    );
  });

  it("is yesterday, when now is before it", () => {
    expect(lastOccurrence(3, 20, at("2026-09-19T01:00:00Z")).toISOString()).toBe(
      "2026-09-18T03:20:00.000Z",
    );
  });

  it("is now, on the exact minute", () => {
    expect(lastOccurrence(3, 20, at("2026-09-19T03:20:00Z")).toISOString()).toBe(
      "2026-09-19T03:20:00.000Z",
    );
  });

  it("steps back across a month boundary", () => {
    expect(lastOccurrence(3, 20, at("2026-10-01T02:00:00Z")).toISOString()).toBe(
      "2026-09-30T03:20:00.000Z",
    );
  });

  it("steps back across a year boundary", () => {
    expect(lastOccurrence(3, 20, at("2027-01-01T00:05:00Z")).toISOString()).toBe(
      "2026-12-31T03:20:00.000Z",
    );
  });

  // The machine running this is not necessarily on UTC, and a check that
  // quietly used local time would be right in London and wrong in Mumbai.
  it("is computed in UTC regardless of the host's timezone", () => {
    const result = lastOccurrence(3, 20, at("2026-09-19T12:28:00Z"));
    expect(result.getUTCHours()).toBe(3);
    expect(result.getUTCMinutes()).toBe(20);
  });
});

describe("the decision it drives", () => {
  // Production migrated at 12:00 and the trigger is 03:20: the most recent
  // occurrence predates the environment, so nothing has been missed.
  it("says the chance has not arrived for an environment deployed after the trigger", () => {
    const existedSince = at("2026-09-19T12:00:00Z");
    expect(lastOccurrence(3, 20, at("2026-09-19T15:48:00Z")) > existedSince).toBe(false);
  });

  it("says the chance HAS arrived once the trigger time has passed again", () => {
    const existedSince = at("2026-09-19T12:00:00Z");
    expect(lastOccurrence(3, 20, at("2026-09-20T09:00:00Z")) > existedSince).toBe(true);
  });
});
