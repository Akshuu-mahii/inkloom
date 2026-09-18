/**
 * An outage must not be reported as a broken request.
 *
 * A database that cannot be reached used to surface as INTERNAL_ERROR / 500.
 * That status means "this request is defective, do not repeat it" — the one
 * thing an outage is not. Concretely it meant a user signing in during a
 * thirty-second Neon failover was told something was wrong with their attempt,
 * no proxy or browser was permitted to retry, and an uptime alert watching 5xx
 * could not tell a database restart from a bad deploy.
 *
 * The pull in the other direction is the reason this is worth testing rather
 * than assuming: if the detector is loose, an ordinary bug — a constraint
 * violation, a typo in SQL — starts answering 503 with a retry hint, and a
 * defect that should be screaming is dressed up as weather. Both directions are
 * asserted below.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { isDependencyUnavailable } from "@inkloom/core/errors";
import { errorResponse } from "../lib/response";

/** How Drizzle delivers a driver error: wrapped, with the real one underneath. */
const wrapped = (cause: unknown) => Object.assign(new Error("Failed query: select 1"), { cause });

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });

async function statusFor(error: unknown) {
  const app = new Hono();
  app.get("/", (c) => {
    c.set("requestId" as never, "req_test" as never);
    return errorResponse(c, error);
  });
  const response = await app.request("http://localhost/");
  return {
    status: response.status,
    retryAfter: response.headers.get("retry-after"),
    code: response.headers.get("x-error-code"),
    body: (await response.json()) as { error: { code: string; message: string } },
  };
}

// ===========================================================================

describe("failures that mean the database is unreachable", () => {
  const unreachable: Array<[string, unknown]> = [
    ["connection refused", pgError("ECONNREFUSED")],
    ["DNS failure", pgError("ENOTFOUND")],
    ["socket timeout", pgError("ETIMEDOUT")],
    ["connection_failure", pgError("08006")],
    ["too_many_connections", pgError("53300")],
    ["admin_shutdown", pgError("57P01")],
    ["still starting up", pgError("57P03")],
    ["a pool connection that died mid-query", new Error("Connection terminated unexpectedly")],
    ["a pool that could not hand one out", new Error("timeout exceeded when trying to connect")],
    ["wrapped by Drizzle", wrapped(pgError("ECONNREFUSED"))],
    ["wrapped twice", wrapped(wrapped(pgError("57P01")))],
  ];

  for (const [label, error] of unreachable) {
    it(`answers 503 for ${label}`, async () => {
      const result = await statusFor(error);
      expect(result.status).toBe(503);
      expect(result.code).toBe("SERVICE_UNAVAILABLE");
      expect(Number(result.retryAfter)).toBeGreaterThan(0);
    });
  }

  it("says nothing about the cause", async () => {
    const result = await statusFor(pgError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.4:5432"));
    const serialised = JSON.stringify(result.body);
    expect(serialised).not.toContain("ECONNREFUSED");
    expect(serialised).not.toContain("10.0.0.4");
  });
});

describe("failures that mean our code is wrong", () => {
  const defects: Array<[string, unknown]> = [
    ["a unique violation", pgError("23505", "duplicate key value")],
    ["a check violation", pgError("23514")],
    ["a missing relation", pgError("42P01", 'relation "widgets" does not exist')],
    ["a syntax error", pgError("42601")],
    ["a plain programming error", new TypeError("x is not a function")],
    [
      // Same symptom as an outage, opposite cause: the application closed its
      // own connection too early. It has happened, and it must keep screaming.
      "a pool we ended ourselves",
      new Error("Cannot use a pool after calling end on the pool"),
    ],
  ];

  for (const [label, error] of defects) {
    it(`still answers 500 for ${label}`, async () => {
      const result = await statusFor(error);
      expect(result.status).toBe(500);
      expect(result.code).toBe("INTERNAL_ERROR");
      expect(result.retryAfter).toBeNull();
    });
  }
});

describe("the detector itself", () => {
  it("does not recurse forever on a cycle", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isDependencyUnavailable(a)).toBe(false);
  });

  it("ignores non-objects", () => {
    expect(isDependencyUnavailable("ECONNREFUSED")).toBe(false);
    expect(isDependencyUnavailable(null)).toBe(false);
    expect(isDependencyUnavailable(undefined)).toBe(false);
  });
});
