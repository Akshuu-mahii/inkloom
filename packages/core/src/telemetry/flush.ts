/**
 * Writing accumulated metrics out.
 *
 * Every statement here is additive, because several Worker isolates serve
 * traffic at once and each reports its own partial view of the same hour. A
 * plain INSERT would lose all but one; a read-modify-write would race. So it is
 * one `INSERT … ON CONFLICT DO UPDATE` per slot, adding to whatever is there.
 *
 * The jsonb maps are merged in SQL rather than in TypeScript for the same
 * reason: merging in code would mean reading the existing row first, and two
 * isolates flushing at once would then each overwrite the other's histogram.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@inkloom/db/client";
import { newId } from "@inkloom/db";
import type { Logger } from "../util/logger";
import { drain, shouldFlush, type MetricSlot } from "./collector";

// Re-exported so server callers keep one import; the implementation is pure and
// lives in ./buckets so the browser can use it without dragging the database in.
export { percentileFrom } from "./buckets";

/**
 * Add two `{bucket: count}` maps inside Postgres.
 *
 * There is no jsonb "+" operator, so this expands both sides to rows, sums by
 * key and rebuilds the object. Expensive-looking and genuinely cheap: these
 * objects hold at most eleven keys, and this runs once per flush, not once per
 * request.
 */
function addJsonb(column: ReturnType<typeof sql>, incoming: Record<string, number>) {
  return sql`(
    SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb)
    FROM (
      SELECT k, SUM(v)::int AS v
      FROM (
        SELECT key AS k, value::text::int AS v FROM jsonb_each(${column})
        UNION ALL
        SELECT key AS k, value::text::int AS v FROM jsonb_each(${JSON.stringify(incoming)}::jsonb)
      ) merged
      GROUP BY k
    ) summed
  )`;
}

/** Write one accumulated slot, adding to any row already recorded for that hour. */
export async function writeSlot(db: Database, slot: MetricSlot): Promise<void> {
  await db.execute(sql`
    INSERT INTO request_metrics (
      id, day, hour, route_group, requests,
      status_2xx, status_3xx, status_4xx, status_429, status_5xx,
      duration_ms_total, duration_ms_max, latency_buckets, error_codes
    ) VALUES (
      ${newId("rqm")}, ${slot.day}::date, ${slot.hour}, ${slot.routeGroup}, ${slot.requests},
      ${slot.status2xx}, ${slot.status3xx}, ${slot.status4xx}, ${slot.status429}, ${slot.status5xx},
      ${slot.durationMsTotal}, ${slot.durationMsMax},
      ${JSON.stringify(slot.latencyBuckets)}::jsonb, ${JSON.stringify(slot.errorCodes)}::jsonb
    )
    ON CONFLICT (day, hour, route_group) DO UPDATE SET
      requests          = request_metrics.requests          + EXCLUDED.requests,
      status_2xx        = request_metrics.status_2xx        + EXCLUDED.status_2xx,
      status_3xx        = request_metrics.status_3xx        + EXCLUDED.status_3xx,
      status_4xx        = request_metrics.status_4xx        + EXCLUDED.status_4xx,
      status_429        = request_metrics.status_429        + EXCLUDED.status_429,
      status_5xx        = request_metrics.status_5xx        + EXCLUDED.status_5xx,
      duration_ms_total = request_metrics.duration_ms_total + EXCLUDED.duration_ms_total,
      -- The max is the one figure that must NOT be summed.
      duration_ms_max   = GREATEST(request_metrics.duration_ms_max, EXCLUDED.duration_ms_max),
      latency_buckets   = ${addJsonb(sql`request_metrics.latency_buckets`, slot.latencyBuckets)},
      error_codes       = ${addJsonb(sql`request_metrics.error_codes`, slot.errorCodes)},
      updated_at        = now()
  `);
}

/**
 * Flush if it is time to, otherwise do nothing.
 *
 * Returns the number of slots written so a caller can log or assert on it.
 * Never throws: telemetry failing must not turn a served request into an error,
 * which is exactly what would happen if this rejected inside the `waitUntil`
 * that calls it.
 */
export async function flushIfDue(db: Database, logger: Logger, eager = false): Promise<number> {
  if (!shouldFlush(Date.now(), eager)) return 0;

  const slots = drain();
  let written = 0;

  for (const slot of slots) {
    try {
      await writeSlot(db, slot);
      written += 1;
    } catch (error) {
      // One bad slot must not cost the others. Counted as lost and moved past.
      logger.warn("metrics_flush_slot_failed", {
        error: error instanceof Error ? error.message : String(error),
        routeGroup: slot.routeGroup,
        day: slot.day,
        hour: slot.hour,
      });
    }
  }

  if (written > 0) logger.debug("metrics_flushed", { slots: written });
  return written;
}
