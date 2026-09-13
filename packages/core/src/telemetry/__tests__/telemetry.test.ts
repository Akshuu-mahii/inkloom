/**
 * Telemetry collection: the pure half.
 *
 * Bucketing, grouping, percentile arithmetic and the drain contract need no
 * database, so they live in the `unit` project and run on every change. The
 * merge across isolates happens in SQL and is proved in the integration file
 * beside this one — the projects are split because the integration project
 * disables file parallelism, and a database test running in `unit` truncates
 * tables out from under whatever else is running at the same time.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { bucketFor, drain, record, reset, routeGroupFor, shouldFlush } from "../collector";
import { percentileFrom } from "../flush";

beforeEach(() => {
  reset();
});

describe("route grouping", () => {
  it("never lets an identifier into the metrics table", () => {
    /*
     * The whole point of grouping. A raw path carries ids — who was looked at,
     * whose ledger was opened — and this table outlives and out-scopes anything
     * that should hold that. Those facts belong in the audit trail.
     */
    expect(routeGroupFor("/admin/users/usr_01H8XGJWBWBAQ4")).toBe("admin");
    expect(routeGroupFor("/api/v1/admin/users/usr_01H8XGJ")).toBe("api.admin");
    expect(routeGroupFor("/app/credits")).toBe("app");
    expect(routeGroupFor("/pricing")).toBe("marketing");
    expect(routeGroupFor("/auth/login")).toBe("auth");
  });

  it("follows the console to its secret mount point", () => {
    expect(routeGroupFor("/internal-admin-7f3a/users", "/internal-admin-7f3a")).toBe("admin");
    // ...and does not mistake a lookalike for it.
    expect(routeGroupFor("/internal-admin-7f3a-other", "/internal-admin-7f3a")).toBe("marketing");
  });
});

describe("collecting", () => {
  it("separates 429 from other 4xx", () => {
    // A rate-limit storm and a wave of malformed requests are different
    // situations; folding them together hides the first inside the second.
    record({ routeGroup: "api.auth", status: 429, durationMs: 5 });
    record({ routeGroup: "api.auth", status: 400, durationMs: 5 });
    record({ routeGroup: "api.auth", status: 500, durationMs: 5 });

    const [slot] = drain();
    expect(slot).toBeDefined();
    expect(slot!.status429).toBe(1);
    expect(slot!.status4xx).toBe(1);
    expect(slot!.status5xx).toBe(1);
  });

  it("puts durations in the right buckets", () => {
    expect(bucketFor(3)).toBe("5");
    expect(bucketFor(5)).toBe("5");
    expect(bucketFor(6)).toBe("10");
    expect(bucketFor(99)).toBe("100");
    expect(bucketFor(9_999)).toBe("inf");
  });

  it("writes nothing on its own and holds until a flush is due", () => {
    record({ routeGroup: "marketing", status: 200, durationMs: 12 });
    // Freshly reset, so the interval has not elapsed and one slot is far below
    // the volume ceiling: a single request must not trigger a database write.
    expect(shouldFlush()).toBe(false);
  });
});

describe("percentiles from merged buckets", () => {
  it("reports the bound the percentile falls under", () => {
    // 100 requests: 90 under 50ms, 9 under 250ms, 1 beyond everything.
    const buckets = { "50": 90, "250": 9, inf: 1 };
    expect(percentileFrom(buckets, 0.5)).toBe(50);
    expect(percentileFrom(buckets, 0.95)).toBe(250);
  });

  it("does not interpolate, because the data has no such precision", () => {
    // Everything landed in one bucket; the honest answer is that bound, not a
    // fabricated point inside it.
    expect(percentileFrom({ "100": 10 }, 0.5)).toBe(100);
    expect(percentileFrom({ "100": 10 }, 0.99)).toBe(100);
  });

  it("returns -1 when the tail runs past the last bucket", () => {
    expect(percentileFrom({ "5": 1, inf: 99 }, 0.95)).toBe(-1);
  });

  it("answers null for an hour with no traffic", () => {
    expect(percentileFrom({}, 0.5)).toBeNull();
  });
});

describe("flush safety", () => {
  it("drains so a failed write cannot double-count an hour", () => {
    record({ routeGroup: "app", status: 200, durationMs: 10 });
    const first = drain();
    const second = drain();

    expect(first).toHaveLength(1);
    // Losing a minute of telemetry is survivable by design. Counting it twice
    // would quietly corrupt every figure read off it afterwards.
    expect(second, "a second drain must not replay the first").toHaveLength(0);
  });
});
