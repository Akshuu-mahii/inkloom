import { defineConfig, devices } from "@playwright/test";
import { config } from "dotenv";

config({ path: ".env", quiet: true });

const PORT = Number(process.env.E2E_PORT ?? 5173);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * End-to-end tests.
 *
 * These drive a REAL browser against a REAL Worker and a REAL database. Nothing
 * is stubbed: signup genuinely writes a user, the verification email genuinely
 * arrives in Mailpit and is genuinely read back, and redemption genuinely moves
 * the credit ledger.
 *
 * The tests reuse an already-running dev server when one is present, so an
 * author can keep `pnpm dev` open; CI starts its own.
 */
export default defineConfig({
  testDir: "./e2e",
  /*
   * `e2e/live` targets a DEPLOYED url and has its own config. Without this it
   * would be picked up here too and run against localhost, where its assertions
   * about the deployed environment are meaningless — and, worse, where the
   * global setup would raise rate limits before pointing a suite at a remote
   * host.
   */
  testIgnore: "**/live/**",
  // Raises rate limits through the product's own override setting so the suite
  // does not spend its run being throttled by the limiter it shares with prod.
  globalSetup: "./e2e/global-setup.ts",
  // ...and puts them back, pass or fail. Without this the raised limits stayed
  // in the database after the run and quietly disarmed the abuse controls.
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Serial: the suite creates and mutates shared rows (feature flags, campaigns)
  // and parallel workers would race each other rather than the code under test.
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Every action waits for the element to be actionable; hydration is handled
    // explicitly by the `settled()` helper in e2e/support.ts.
    actionTimeout: 15_000,
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      // Mobile only runs the journeys where layout genuinely differs.
      testMatch: /(mobile|accessibility)\.spec\.ts/,
    },
    /*
     * WebKit, for the engine Safari actually uses.
     *
     * Scoped to the journeys where engine differences bite rather than the
     * whole suite, because the whole suite in a second engine roughly doubles
     * CI time for very little added signal. What IS worth running twice:
     * anything touching cookies and session lifetime — Safari's ITP caps
     * script-writable cookie lifetime and is stricter about SameSite and
     * third-party contexts than Chrome, so a session bug can exist in exactly
     * one engine — plus the multi-tab and back/forward-cache behaviour, where
     * WebKit's page cache genuinely differs.
     */
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: /(auth|account-erasure|browser-sessions)\.spec\.ts/,
    },
  ],

  webServer: {
    command: "pnpm --filter @inkloom/web dev",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
