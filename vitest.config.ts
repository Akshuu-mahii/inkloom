import { defineConfig } from "vitest/config";
import { config } from "dotenv";

config({ path: ".env", quiet: true });

/**
 * Three projects, three levels of dependency:
 *
 *  unit         pure functions, no database, no network. Fast, always runnable.
 *  integration  real Postgres (`inkloom_test`), real transactions. This is
 *               where the concurrency guarantees are proven — a mocked
 *               database cannot demonstrate that two racing transactions
 *               produce exactly one redemption.
 *  security     real Postgres + a real Hono app instance, driven over fetch,
 *               asserting authorization, CSRF, origin and IDOR behaviour.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          /*
           * `apps/web` is here because it was not, and that is where the worst
           * deploy bug of the project lived: the API client fetching the
           * Worker's own hostname, which works under Vite and silently returns
           * an unparseable empty 404 once deployed. Nothing under apps/web was
           * covered by any project, so no test could have caught it.
           */
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/web/app/**/*.test.ts",
            // Operational tooling is code too. The backup verifier in
            // particular runs unattended against files nobody looks at until
            // the day they are the only copy left.
            "scripts/__tests__/**/*.test.ts",
          ],
          exclude: [
            "**/*.integration.test.ts",
            "**/*.concurrency.test.ts",
            "**/*.security.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "packages/*/src/**/*.integration.test.ts",
            "packages/*/src/**/*.concurrency.test.ts",
          ],
          environment: "node",
          setupFiles: ["./tests/setup-integration.ts"],
          // Each file gets its own schema-clean database state; running files
          // in parallel would let one file's truncation race another's insert.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "security",
          include: ["packages/*/src/**/*.security.test.ts", "tests/security/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./tests/setup-integration.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
