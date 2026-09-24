/**
 * Calendar periods for the operations console.
 *
 * The console used to describe every period as a rolling window wearing a
 * calendar label: "Signups today" meant `created_at >= now() - 24 hours`, which
 * is a window sliding backwards all day. At nine in the evening it was still
 * counting people who joined at nine the previous evening, so the number FELL
 * as the day went on — the opposite of what the label promises — and no tile
 * could be reconciled against any other.
 *
 * Extracted from the route so the boundary arithmetic can be tested directly.
 * Getting a day boundary subtly wrong is exactly the kind of defect that never
 * announces itself: every number stays plausible and every number is wrong.
 */

/**
 * The timezone the console's calendar periods are cut on.
 *
 * A calendar day needs somewhere to start, and UTC would put the boundary at
 * half past five in the morning for the people reading this console — so a
 * signup at 03:00 would land in "yesterday" while everyone involved considered
 * it today. The operators, the audience and the database region are all in
 * India, so this is where the day breaks.
 *
 * If that stops being true, this is the one line to change: every period is
 * derived from it.
 *
 * Note for anyone asserting on this: `Intl` canonicalises the name, and
 * workerd resolves it to the legacy spelling "Asia/Calcutta". Same zone, same
 * +05:30, different string. Compare offsets, never names.
 */
export const REPORTING_TIME_ZONE = "Asia/Kolkata";

export type ReportingPeriod = "day" | "week" | "month";

/**
 * The instant a calendar period began, in the reporting timezone.
 *
 * Returned as a real `Date` so it goes into a query as a bound parameter and
 * the planner can still use `users_created_at_idx`, rather than as SQL date
 * arithmetic an index cannot be matched against.
 *
 * Weeks start on MONDAY, matching Postgres' `date_trunc('week', …)` and the way
 * everyone here talks about "this week".
 */
export function periodStart(now: Date, period: ReportingPeriod): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REPORTING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);

  /*
   * The zone's offset, derived rather than hardcoded.
   *
   * The difference between the local wall clock read back as if it were UTC and
   * the real UTC instant IS the offset, which means this works for any zone and
   * for either side of a daylight-saving change without a table of rules. The
   * seconds are truncated on both sides so sub-second drift cannot round the
   * offset to something a minute out.
   */
  const offsetMs =
    Date.UTC(at("year"), at("month") - 1, at("day"), at("hour"), at("minute"), at("second")) -
    Math.floor(now.getTime() / 1000) * 1000;

  // Midnight local, expressed as the UTC instant that local midnight is.
  const startOfDay = Date.UTC(at("year"), at("month") - 1, at("day")) - offsetMs;

  if (period === "day") return new Date(startOfDay);
  if (period === "month") return new Date(Date.UTC(at("year"), at("month") - 1, 1) - offsetMs);

  const weekday = new Date(startOfDay + offsetMs).getUTCDay();
  const sinceMonday = (weekday + 6) % 7;
  return new Date(startOfDay - sinceMonday * 86_400_000);
}
