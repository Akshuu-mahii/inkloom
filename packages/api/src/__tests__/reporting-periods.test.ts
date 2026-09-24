/**
 * Where the console's day, week and month begin.
 *
 * This arithmetic replaced rolling windows that were labelled as calendar
 * periods, and it is worth this much scrutiny for one reason: every failure
 * mode here is SILENT. An off-by-one-day boundary, a week that starts on
 * Sunday, an offset applied in the wrong direction — each produces a number
 * that is entirely plausible on the page and simply wrong, and none of them
 * throws. The only way to catch that is to state the expected instant for a
 * lot of specific moments and check them.
 *
 * Expected values are written as the UTC instant of local midnight, which for
 * +05:30 is 18:30 on the PREVIOUS UTC day. That relationship is the whole
 * subject of the test, so it is spelled out rather than computed.
 */
import { describe, expect, it } from "vitest";
import { periodStart, REPORTING_TIME_ZONE, type ReportingPeriod } from "../lib/reporting-periods";

/** The reporting zone's offset, in minutes, at a given instant. */
function offsetMinutes(at: Date): number {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const n = (t: string) => Number(local.find((p) => p.type === t)?.value ?? 0);
  return (
    (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) -
      Math.floor(at.getTime() / 1000) * 1000) /
    60_000
  );
}

/** The local wall-clock reading of an instant, as "YYYY-MM-DD HH:mm". */
function localWallClock(at: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${v("year")}-${v("month")}-${v("day")} ${v("hour")}:${v("minute")}`;
}

describe("the runtime actually knows the reporting zone", () => {
  it("is a real +05:30 zone, not a silent fallback to UTC", () => {
    /*
     * The failure this guards is specific and nasty: a runtime without full
     * ICU data accepts an unknown timezone name and quietly formats in UTC.
     * Every period would then be cut five and a half hours early with nothing
     * to indicate it. Verified separately inside workerd, which canonicalises
     * the name to the legacy "Asia/Calcutta" — so this asserts the OFFSET,
     * never the string.
     */
    expect(offsetMinutes(new Date("2026-09-24T15:27:00Z"))).toBe(330);
    expect(offsetMinutes(new Date("2026-01-15T00:00:00Z"))).toBe(330);
    expect(offsetMinutes(new Date("2026-07-15T00:00:00Z"))).toBe(330);
  });
});

describe("the calendar day", () => {
  const cases: Array<[string, string, string]> = [
    // [instant, expected day start, what the instant is locally]
    ["2026-09-24T15:27:00Z", "2026-09-23T18:30:00.000Z", "Thu 20:57"],
    ["2026-09-24T18:29:59Z", "2026-09-23T18:30:00.000Z", "Thu 23:59:59 — last second of the day"],
    ["2026-09-24T18:30:00Z", "2026-09-24T18:30:00.000Z", "Fri 00:00:00 — the boundary itself"],
    ["2026-09-24T18:30:01Z", "2026-09-24T18:30:00.000Z", "Fri 00:00:01"],
    ["2026-09-24T20:00:00Z", "2026-09-24T18:30:00.000Z", "Fri 01:30 — after UTC midnight"],
    ["2026-09-25T00:00:00Z", "2026-09-24T18:30:00.000Z", "Fri 05:30 — UTC midnight is mid-morning"],
    ["2026-09-25T18:29:00Z", "2026-09-24T18:30:00.000Z", "Fri 23:59"],
    ["2026-12-31T20:00:00Z", "2026-12-31T18:30:00.000Z", "Fri 01:30 on 1 Jan — new year"],
    ["2026-02-28T19:00:00Z", "2026-02-28T18:30:00.000Z", "1 Mar — non-leap rollover"],
    ["2028-02-29T19:00:00Z", "2028-02-29T18:30:00.000Z", "1 Mar — leap day rollover"],
    ["2028-02-28T19:00:00Z", "2028-02-28T18:30:00.000Z", "29 Feb — the leap day itself"],
  ];

  it.each(cases)("%s → %s (%s)", (instant, expected) => {
    expect(periodStart(new Date(instant), "day").toISOString()).toBe(expected);
  });

  it("always lands exactly on local midnight", () => {
    for (let hour = 0; hour < 24 * 40; hour += 1) {
      const at = new Date(Date.UTC(2026, 8, 1) + hour * 3_600_000);
      expect(localWallClock(periodStart(at, "day")), `for ${at.toISOString()}`).toMatch(/ 00:00$/);
    }
  });

  it("is never in the future and never more than a day behind", () => {
    for (let minute = 0; minute < 60 * 24 * 10; minute += 7) {
      const at = new Date(Date.UTC(2026, 8, 1) + minute * 60_000);
      const start = periodStart(at, "day").getTime();
      expect(start, `for ${at.toISOString()}`).toBeLessThanOrEqual(at.getTime());
      expect(at.getTime() - start).toBeLessThan(86_400_000);
    }
  });
});

describe("the calendar week", () => {
  const cases: Array<[string, string, string]> = [
    ["2026-09-21T02:00:00Z", "2026-09-20T18:30:00.000Z", "Mon 07:30 — the week just began"],
    ["2026-09-20T18:30:00Z", "2026-09-20T18:30:00.000Z", "Mon 00:00 — the boundary itself"],
    ["2026-09-20T18:29:00Z", "2026-09-13T18:30:00.000Z", "Sun 23:59 — still last week"],
    ["2026-09-24T15:27:00Z", "2026-09-20T18:30:00.000Z", "Thu"],
    [
      "2026-09-20T17:00:00Z",
      "2026-09-13T18:30:00.000Z",
      "Sun 22:30 — Sunday belongs to the week before",
    ],
    ["2026-01-01T12:00:00Z", "2025-12-28T18:30:00.000Z", "Thu 1 Jan — week spans the year"],
  ];

  it.each(cases)("%s → %s (%s)", (instant, expected) => {
    expect(periodStart(new Date(instant), "week").toISOString()).toBe(expected);
  });

  it("always lands on a Monday at local midnight", () => {
    for (let hour = 0; hour < 24 * 60; hour += 1) {
      const at = new Date(Date.UTC(2026, 7, 1) + hour * 3_600_000);
      const start = periodStart(at, "week");
      expect(localWallClock(start), `for ${at.toISOString()}`).toMatch(/ 00:00$/);
      // Read the weekday in the reporting zone, not the runtime's own.
      const weekday = new Intl.DateTimeFormat("en-GB", {
        timeZone: REPORTING_TIME_ZONE,
        weekday: "long",
      }).format(start);
      expect(weekday, `for ${at.toISOString()}`).toBe("Monday");
    }
  });

  it("is never more than seven days behind", () => {
    for (let hour = 0; hour < 24 * 60; hour += 1) {
      const at = new Date(Date.UTC(2026, 7, 1) + hour * 3_600_000);
      const start = periodStart(at, "week").getTime();
      expect(start).toBeLessThanOrEqual(at.getTime());
      expect(at.getTime() - start).toBeLessThan(7 * 86_400_000);
    }
  });
});

describe("the calendar month", () => {
  const cases: Array<[string, string, string]> = [
    ["2026-09-24T15:27:00Z", "2026-08-31T18:30:00.000Z", "24 Sep"],
    ["2026-09-01T00:10:00Z", "2026-08-31T18:30:00.000Z", "1 Sep 05:40"],
    ["2026-08-31T18:30:00Z", "2026-08-31T18:30:00.000Z", "1 Sep 00:00 — the boundary itself"],
    ["2026-08-31T18:29:00Z", "2026-07-31T18:30:00.000Z", "31 Aug 23:59 — still August"],
    ["2026-12-31T20:00:00Z", "2026-12-31T18:30:00.000Z", "1 Jan — new year, new month"],
    ["2028-02-29T19:00:00Z", "2028-02-29T18:30:00.000Z", "1 Mar after a leap day"],
  ];

  it.each(cases)("%s → %s (%s)", (instant, expected) => {
    expect(periodStart(new Date(instant), "month").toISOString()).toBe(expected);
  });

  it("always lands on the first of a month at local midnight", () => {
    for (let day = 0; day < 400; day += 1) {
      const at = new Date(Date.UTC(2026, 0, 1, 9) + day * 86_400_000);
      const start = periodStart(at, "month");
      expect(localWallClock(start), `for ${at.toISOString()}`).toMatch(/-01 00:00$/);
    }
  });
});

describe("the periods nest", () => {
  it("day is inside week is inside month, at every hour of a long run", () => {
    /*
     * The invariant the console depends on: "today" can never exceed "this
     * week". It is not automatic — a Sunday under a Sunday-start week, or a
     * month boundary mid-week, are exactly where a naive implementation
     * inverts them.
     *
     * Month is NOT always inside week (a week can start in the previous
     * month), so only the two relationships that actually hold are asserted.
     */
    for (let hour = 0; hour < 24 * 400; hour += 5) {
      const at = new Date(Date.UTC(2026, 0, 1) + hour * 3_600_000);
      const day = periodStart(at, "day").getTime();
      const week = periodStart(at, "week").getTime();
      const month = periodStart(at, "month").getTime();
      expect(week, `week must not start after today, at ${at.toISOString()}`).toBeLessThanOrEqual(
        day,
      );
      expect(month, `month must not start after today, at ${at.toISOString()}`).toBeLessThanOrEqual(
        day,
      );
    }
  });

  it("is stable: the same instant always gives the same answer", () => {
    const at = new Date("2026-09-24T15:27:00Z");
    for (const period of ["day", "week", "month"] as ReportingPeriod[]) {
      const first = periodStart(at, period).toISOString();
      for (let i = 0; i < 50; i += 1) {
        expect(periodStart(new Date(at), period).toISOString()).toBe(first);
      }
    }
  });

  it("does not mutate the date it is given", () => {
    const at = new Date("2026-09-24T15:27:00Z");
    const before = at.getTime();
    periodStart(at, "day");
    periodStart(at, "week");
    periodStart(at, "month");
    expect(at.getTime()).toBe(before);
  });

  it("moves forward exactly once a day, at the boundary and nowhere else", () => {
    /*
     * Walked minute by minute across two local midnights. The day start must
     * change exactly twice in that span — not zero times (a frozen boundary)
     * and not more (a boundary that jitters, which is what a rounding error in
     * the offset looks like).
     */
    let changes = 0;
    let previous = periodStart(new Date(Date.UTC(2026, 8, 23, 12)), "day").getTime();
    for (let minute = 1; minute <= 60 * 48; minute += 1) {
      const at = new Date(Date.UTC(2026, 8, 23, 12) + minute * 60_000);
      const start = periodStart(at, "day").getTime();
      if (start !== previous) {
        changes += 1;
        expect(localWallClock(at), "the day may only turn over at local midnight").toMatch(
          / 00:00$/,
        );
        previous = start;
      }
    }
    expect(changes).toBe(2);
  });
});
