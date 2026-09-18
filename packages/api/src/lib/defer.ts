/**
 * Work that must happen, but that the caller must not wait for.
 *
 * Security events, analytics and similar observational writes are side effects:
 * the response does not depend on them, nobody reads their return value, and
 * `audit.security` already swallows its own failures. Awaiting them anyway put a
 * database round trip between the handler finishing and the user seeing
 * anything — on the hottest paths in the application, since the things worth
 * recording are exactly the things that happen a lot: every rate-limited
 * request, every failed login, every refused captcha.
 *
 * `waitUntil` is the Workers mechanism for this. It extends the isolate's
 * lifetime past the response, so the write still completes — it is not
 * fire-and-forget, which on Workers means "cancelled the moment you respond".
 *
 * WHAT DOES NOT BELONG HERE: anything inside a transaction (it would escape the
 * rollback), anything whose result the response reports, and the audit trail for
 * an action the user is told succeeded. An append-only audit record that might
 * not be there is not an audit record. This is for observations, not for
 * evidence.
 */
import type { Context } from "hono";
import type { Env } from "../context";

/**
 * Hand `work` to the runtime and return immediately.
 *
 * Returns a promise so callers can `await defer(...)` uniformly. In a Worker
 * that resolves at once and the write finishes in the background; where no
 * execution context exists — the test harness, or any runtime that does not
 * provide one — it resolves only when the work does, so tests stay
 * deterministic and assert against a settled database rather than a race.
 */
export function defer(c: Context<Env>, work: Promise<unknown>, label: string): Promise<void> {
  const settled = work.then(
    () => undefined,
    (error: unknown) => {
      // Never let a background failure become an unhandled rejection, and never
      // let it vanish silently either: the whole point of these writes is that
      // somebody can look at them later.
      c.get("logger")?.warn("deferred_write_failed", { label, error });
    },
  );

  /*
   * `c.executionCtx` THROWS when Hono has no execution context rather than
   * returning undefined, which is why this is a try/catch and not a null check.
   */
  try {
    c.executionCtx.waitUntil(settled);
    return Promise.resolve();
  } catch {
    return settled;
  }
}
