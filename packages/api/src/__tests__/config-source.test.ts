/**
 * Where the database URL comes from in a deployed Worker.
 *
 * This exists because of a real outage on the first staging deploy. Locally and
 * under test, `DATABASE_URL` is always present — `.dev.vars` sets it — so every
 * check passed. Deployed, it is not present at all: Hyperdrive hands the Worker
 * a binding *object* with a `connectionString`, and nothing sets the variable
 * the config schema requires. The Worker threw
 * `DATABASE_URL: expected string, received undefined` on its first request and
 * returned 500 for every route.
 *
 * The lesson these tests hold in place is that the deployed shape of the
 * environment differs from the local one, and only the deployed shape matters.
 */
import { describe, expect, it } from "vitest";
import { configSource } from "../index";

const hyperdrive = (connectionString: string) => ({ HYPERDRIVE: { connectionString } });

describe("configSource", () => {
  it("derives DATABASE_URL from the Hyperdrive binding when the variable is absent", () => {
    const env = hyperdrive("postgresql://user:pw@hyperdrive.local/inkloom");

    expect(configSource(env).DATABASE_URL).toBe("postgresql://user:pw@hyperdrive.local/inkloom");
  });

  it("is the exact shape a deployed Worker presents", () => {
    // No DATABASE_URL key at all, which is what broke: not empty, not null.
    const env: Record<string, unknown> = {
      INKLOOM_ENV: "staging",
      HYPERDRIVE: { connectionString: "postgresql://u:p@origin/db" },
    };

    expect("DATABASE_URL" in env).toBe(false);
    expect(configSource(env).DATABASE_URL).toBe("postgresql://u:p@origin/db");
  });

  it("prefers an explicit DATABASE_URL, so local development is unchanged", () => {
    const env = {
      ...hyperdrive("postgresql://from-binding/db"),
      DATABASE_URL: "postgresql://explicit/db",
    };

    expect(configSource(env).DATABASE_URL).toBe("postgresql://explicit/db");
  });

  it("treats an empty DATABASE_URL as absent rather than overriding with nothing", () => {
    const env = { ...hyperdrive("postgresql://from-binding/db"), DATABASE_URL: "" };

    expect(configSource(env).DATABASE_URL).toBe("postgresql://from-binding/db");
  });

  /*
   * Identity matters as much as the value.
   *
   * The config cache upstream is a WeakMap keyed on the env object, which
   * Workers hand back by identity for the life of an isolate. Returning a fresh
   * object when nothing needed deriving would miss that cache on every request
   * and re-parse and re-validate the whole configuration each time.
   */
  it("returns the same object when no derivation is needed", () => {
    const env = { DATABASE_URL: "postgresql://explicit/db" };

    expect(configSource(env)).toBe(env);
  });

  it("returns the same object when there is nothing to derive from", () => {
    const env = { INKLOOM_ENV: "test" };

    expect(configSource(env)).toBe(env);
  });

  it("does not mutate the Worker's env object", () => {
    const env = hyperdrive("postgresql://u:p@origin/db");

    configSource(env);

    expect("DATABASE_URL" in env).toBe(false);
  });

  it.each([
    ["binding missing entirely", {}],
    ["binding present but empty", { HYPERDRIVE: {} }],
    ["connection string empty", { HYPERDRIVE: { connectionString: "" } }],
  ])("leaves the env untouched when the %s, so config fails loudly", (_label, env) => {
    expect(configSource(env).DATABASE_URL).toBeUndefined();
  });
});
