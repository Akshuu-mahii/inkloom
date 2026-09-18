/**
 * Deferred side effects.
 *
 * Two properties matter and they pull against each other. In a Worker the
 * response must not wait for an observational write. Everywhere else — the test
 * harness above all — the write must be finished before the call returns, or
 * every assertion about security events becomes a race that passes locally and
 * fails in CI.
 *
 * The third property is the quiet one: a deferred failure must never become an
 * unhandled rejection, and must never disappear silently either. These writes
 * exist so somebody can look at them later; one that vanished would be worse
 * than one that was never attempted.
 */
import { describe, expect, it, vi } from "vitest";
import { defer } from "../lib/defer";

type Ctx = Parameters<typeof defer>[0];

const logger = () => ({ warn: vi.fn(), child: vi.fn(), info: vi.fn(), error: vi.fn() });

/** A Hono context with a working executionCtx, as a Worker provides. */
const workerCtx = (log = logger()) => {
  const waitUntil = vi.fn();
  return {
    ctx: { get: () => log, executionCtx: { waitUntil } } as unknown as Ctx,
    waitUntil,
    log,
  };
};

/**
 * A context WITHOUT an execution context. Hono THROWS on access rather than
 * returning undefined, which is the behaviour the helper has to survive.
 */
const bareCtx = (log = logger()) =>
  ({
    ctx: {
      get: () => log,
      get executionCtx(): never {
        throw new Error("This context has no ExecutionContext");
      },
    } as unknown as Ctx,
    log,
  });

describe("in a Worker", () => {
  it("returns before the work finishes, and hands the work to waitUntil", async () => {
    const { ctx, waitUntil } = workerCtx();
    let done = false;
    const work = new Promise<void>((resolve) =>
      setTimeout(() => {
        done = true;
        resolve();
      }, 30),
    );

    await defer(ctx, work, "slow_write");

    expect(done, "the response did not wait for the write").toBe(false);
    expect(waitUntil).toHaveBeenCalledTimes(1);

    await work;
    expect(done).toBe(true);
  });

  it("swallows a rejection and logs it rather than crashing the isolate", async () => {
    const { ctx, waitUntil, log } = workerCtx();

    await defer(ctx, Promise.reject(new Error("insert failed")), "security_event");

    // The promise handed to waitUntil must already be protected.
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "deferred_write_failed",
      expect.objectContaining({ label: "security_event" }),
    );
  });
});

describe("without an execution context", () => {
  it("waits for the work, so tests assert against a settled database", async () => {
    const { ctx } = bareCtx();
    let done = false;
    const work = new Promise<void>((resolve) =>
      setTimeout(() => {
        done = true;
        resolve();
      }, 20),
    );

    await defer(ctx, work, "slow_write");

    expect(done, "the helper must not return early here").toBe(true);
  });

  it("still absorbs a rejection instead of throwing at the call site", async () => {
    const { ctx, log } = bareCtx();

    await expect(defer(ctx, Promise.reject(new Error("nope")), "thing")).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
