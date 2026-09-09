/**
 * Integration-test setup.
 *
 * Points every test at TEST_DATABASE_URL — a database that is separate from the
 * one `pnpm dev` uses — applies migrations once, and refuses to run at all if
 * the target looks like anything other than a local, disposable database.
 * Production data must never reach a developer's machine, and a test run must
 * never be able to truncate a real table.
 */
import { execFileSync } from "node:child_process";
import { beforeAll } from "vitest";

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Run `docker compose up -d` and `cp .env.example .env`.",
  );
}

const parsed = new URL(url);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

if (!LOCAL_HOSTS.has(parsed.hostname)) {
  throw new Error(
    `Refusing to run tests against a non-local database host: ${parsed.hostname}. ` +
      "Integration tests truncate tables.",
  );
}
if (!parsed.pathname.slice(1).includes("test")) {
  throw new Error(
    `Refusing to run tests against database "${parsed.pathname.slice(1)}": ` +
      'the name must contain "test". Integration tests truncate tables.',
  );
}

beforeAll(() => {
  execFileSync("pnpm", ["--filter", "@inkloom/db", "migrate"], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: url },
  });
}, 60_000);
