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
          include: ["packages/*/src/**/*.test.ts"],
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
