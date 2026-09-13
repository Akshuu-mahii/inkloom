/**
 * Latency bucket arithmetic. Pure, and deliberately dependency-free.
 *
 * THIS FILE MUST NOT IMPORT ANYTHING. Not `@inkloom/db`, not drizzle, not a
 * logger — nothing.
 *
 * It is the one piece of telemetry the BROWSER needs, because the admin console
 * renders percentiles from histograms the API sends it. Everything else in this
 * directory is server-side and pulls in the database client behind it.
 *
 * That distinction was learned the hard way. `percentileFrom` originally lived
 * beside the collector and was imported into the console from
 * `@inkloom/core/telemetry`; that barrel re-exports the collector, which imports
 * `LATENCY_BUCKETS_MS` from `@inkloom/db`, which is the entire Drizzle schema
 * and the Postgres client. The bundler followed the chain and shipped 144KB of
 * server code to the browser in a chunk that then failed to load — so the four
 * console pages that imported it could not be opened at all, while server-side
 * rendering worked perfectly because the server can of course load a database
 * client. Every curl check passed; only a real browser navigation failed.
 *
 * Keeping this file importable from both sides, with no dependencies of its
 * own, is what stops that happening again.
 */

/**
 * Upper bounds in milliseconds for the latency histogram, plus an overflow.
 *
 * Chosen around what this application actually does: a marketing page render
 * lands near 15ms and a signup near 100ms, so the resolution is concentrated
 * between 10 and 250 where the interesting movement is. A change from 90ms to
 * 240ms is visible here; it would not be in evenly spaced buckets.
 */
export const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

/** Which bucket a duration falls in. Returns "inf" beyond the last bound. */
export function bucketFor(durationMs: number): string {
  for (const bound of LATENCY_BUCKETS_MS) {
    if (durationMs <= bound) return String(bound);
  }
  return "inf";
}

/**
 * Read a percentile back out of merged bucket counts.
 *
 * Returns the UPPER BOUND of the bucket the percentile falls in, which is a
 * deliberate over-estimate rather than an interpolation. Interpolating between
 * bounds invents precision the data does not contain; "p95 is at or under
 * 250ms" is a statement that is actually true.
 *
 * `null` means no traffic at all and `-1` means the tail ran past the largest
 * bucket. Those are different facts and callers must render them differently —
 * printing 0ms for either would read as excellent performance.
 */
export function percentileFrom(buckets: Record<string, number>, percentile: number): number | null {
  const total = Object.values(buckets).reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;

  const ordered = Object.entries(buckets)
    .map(([bound, count]) => ({ bound: bound === "inf" ? Infinity : Number(bound), count }))
    .sort((a, b) => a.bound - b.bound);

  const target = total * percentile;
  let seen = 0;
  for (const { bound, count } of ordered) {
    seen += count;
    if (seen >= target) return bound === Infinity ? -1 : bound;
  }
  return -1;
}
