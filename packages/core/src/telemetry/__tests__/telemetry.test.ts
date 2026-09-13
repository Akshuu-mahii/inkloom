/**
 * Telemetry collection and merging.
 *
 * The property that matters is that several isolates reporting the same hour
 * produce one correct total, not the last writer's partial view. Everything
 * here is written against a real Postgres because the merge happens in SQL —
 * testing it against a mock would test the mock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { connectTestDb, type TestDb } from "../../../../../tests/helpers/db";
import { silentLogger } from "../../util/logger";
import { bucketFor, drain, record, reset, routeGroupFor, shouldFlush } from "../collector";
import { percentileFrom, writeSlot } from "../flush";

let t: TestDb;

beforeAll(() => {
  t = connectTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.execute(sql`TRUNCATE TABLE request_metrics`);
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

describe("merging partial views from several isolates", () => {
  async function readSlot() {
    const result = await t.db.execute<{
      requests: number;
      status_5xx: number;
      duration_ms_max: number;
      latency_buckets: Record<string, number>;
      error_codes: Record<string, number>;
    }>(sql`SELECT * FROM request_metrics`);
    return result.rows[0];
  }

  const base = { day: "2026-09-13", hour: 14, routeGroup: "app" };

  it("adds counters rather than replacing them", async () => {
    // Two isolates, same hour, same group — the exact case a plain INSERT loses.
    await writeSlot(t.db, {
      ...base,
      requests: 10,
      status2xx: 9,
      status3xx: 0,
      status4xx: 0,
      status429: 0,
      status5xx: 1,
      durationMsTotal: 500,
      durationMsMax: 120,
      latencyBuckets: { "50": 9, "250": 1 },
      errorCodes: { DB_TIMEOUT: 1 },
    });
    await writeSlot(t.db, {
      ...base,
      requests: 5,
      status2xx: 5,
      status3xx: 0,
      status4xx: 0,
      status429: 0,
      status5xx: 0,
      durationMsTotal: 100,
      durationMsMax: 40,
      latencyBuckets: { "50": 4, "100": 1 },
      errorCodes: { RATE_LIMITED: 3 },
    });

    const row = await readSlot();
    expect(row?.requests, "one row, both isolates' traffic").toBe(15);
    expect(row?.status_5xx).toBe(1);
    // The max is the one figure that must not be summed.
    expect(row?.duration_ms_max, "max is the greatest, not the total").toBe(120);
    expect(row?.latency_buckets).toEqual({ "50": 13, "100": 1, "250": 1 });
    expect(row?.error_codes).toEqual({ DB_TIMEOUT: 1, RATE_LIMITED: 3 });
  });

  it("keeps different hours and groups apart", async () => {
    const slot = {
      requests: 1,
      status2xx: 1,
      status3xx: 0,
      status4xx: 0,
      status429: 0,
      status5xx: 0,
      durationMsTotal: 10,
      durationMsMax: 10,
      latencyBuckets: { "10": 1 },
      errorCodes: {},
    };
    await writeSlot(t.db, { ...slot, day: "2026-09-13", hour: 14, routeGroup: "app" });
    await writeSlot(t.db, { ...slot, day: "2026-09-13", hour: 15, routeGroup: "app" });
    await writeSlot(t.db, { ...slot, day: "2026-09-13", hour: 14, routeGroup: "marketing" });

    const result = await t.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM request_metrics`,
    );
    expect(Number(result.rows[0]?.count), "three distinct slots").toBe(3);
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
  it("drains so a failed write cannot double-count an hour", async () => {
    record({ routeGroup: "app", status: 200, durationMs: 10 });
    const first = drain();
    const second = drain();

    expect(first).toHaveLength(1);
    // Losing a minute of telemetry is survivable by design. Counting it twice
    // would quietly corrupt every figure read off it afterwards.
    expect(second, "a second drain must not replay the first").toHaveLength(0);
    expect(silentLogger).toBeDefined();
  });
});
