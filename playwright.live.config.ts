import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests against a DEPLOYED environment.
 *
 * Separate from `playwright.config.ts` on purpose, and the differences are the
 * whole point:
 *
 *   - NO globalSetup/globalTeardown. Those raise rate limits by writing to the
 *     database, which is correct against a disposable local database and quite
 *     wrong against a live one.
 *   - NO webServer. The target is already running; nothing is started or
 *     stopped.
 *   - Read-only by construction. Nothing here signs up, signs in, or writes a
 *     row, so it can be pointed at staging — or, carefully, at production —
 *     without leaving a trace beyond a few log lines.
 *
 * It exists to answer one question the local suite cannot: does the deployed
 * build behave the way the local one does? Almost every bug in this project's
 * deployment has been of exactly that shape — correct locally, wrong once
 * deployed, and invisible to 400 passing local tests.
 *
 *   pnpm test:live                                  # defaults to staging
 *   LIVE_BASE_URL=https://inkloom.art pnpm test:live
 */
const BASE_URL = process.env.LIVE_BASE_URL ?? "https://staging.inkloom.art";

export default defineConfig({
  testDir: "./e2e/live",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 1,
  // A deployed target is shared and rate-limited; a stampede of workers would
  // measure the limiter rather than the app.
  workers: 2,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
});
