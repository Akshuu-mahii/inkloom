/**
 * Merging partial views from several isolates, against a real Postgres.
 *
 * The property that matters: several isolates reporting the same hour must
 * produce one correct total, not the last writer's view. The merge happens in
 * SQL, so testing it against a mock would test the mock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { connectTestDb, type TestDb } from "../../../../../tests/helpers/db";
import { reset } from "../collector";
import { writeSlot } from "../flush";

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
