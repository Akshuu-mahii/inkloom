/**
 * Every console tab must open by CLICKING it, not merely by navigating to it.
 *
 * This exists because of a bug that every server-side check passed. The four
 * analytical pages imported `percentileFrom` from `@inkloom/core/telemetry`,
 * whose barrel re-exports the collector, which imports `@inkloom/db` — so the
 * bundler shipped 144KB of Drizzle schema and Postgres client into a browser
 * chunk that then failed to load. Server rendering worked perfectly, because
 * the server can obviously load a database client: `curl` returned 200 for the
 * page AND for the `.data` endpoint. Only a real click in a real browser failed.
 *
 * So the assertion is specifically a click, and specifically that no client-side
 * error is raised while doing it.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { adminPath, STRONG_PASSWORD, signUpAndVerify, uniqueEmail } from "./support";
import { secretFromUri, totp } from "./totp";

const TABS = ["Activity", "Emails", "Performance", "Infrastructure"] as const;

function bootstrapSuperAdmin(email: string) {
  execFileSync("pnpm", ["bootstrap:superadmin", "--email", email, "--force"], {
    cwd: process.cwd(),
    stdio: "pipe",
    input: `${email}\n`,
    env: process.env,
  });
}

/**
 * Enrol a REAL second factor.
 *
 * Setting `two_factor_enabled = true` directly would produce an account
 * claiming a factor with no secret behind it — sign-in would then correctly
 * become impossible and the test would prove nothing.
 */
async function enrolTwoFactor(page: Page): Promise<string> {
  const enrol = await page.evaluate(async (password) => {
    const response = await fetch("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password, issuer: "Inkloom" }),
    });
    return { status: response.status, body: await response.text() };
  }, STRONG_PASSWORD);
  expect(enrol.status, `2FA enable failed: ${enrol.body}`).toBeLessThan(300);

  const secret = secretFromUri((JSON.parse(enrol.body) as { totpURI: string }).totpURI);
  const verify = await page.evaluate(async (code) => {
    const response = await fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ code, trustDevice: false }),
    });
    return { status: response.status, body: await response.text() };
  }, totp(secret));
  expect(verify.status, `TOTP verify failed: ${verify.body}`).toBeLessThan(300);
  return secret;
}

test("every console tab opens when clicked, with no client-side error", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    /*
     * One known warning is excluded, and only this one.
     *
     * React's hydration-mismatch notice appears on /admin and /admin/users too,
     * both of which predate these pages — measured, not assumed. It is a real
     * (minor) pre-existing issue and deserves its own fix; failing here on it
     * would make this test red for a reason it was not written to catch, which
     * is how a useful test becomes one people skip.
     */
    if (message.text().includes("A tree hydrated but some attributes")) return;
    failures.push(`console: ${message.text()}`);
  });

  const email = await signUpAndVerify(page, uniqueEmail("tabs"));
  await enrolTwoFactor(page);
  bootstrapSuperAdmin(email);

  await page.goto(adminPath());
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();

  for (const tab of TABS) {
    await page.getByRole("link", { name: tab, exact: true }).click();
    await expect(page.getByRole("heading", { name: tab, level: 1 })).toBeVisible({
      timeout: 15_000,
    });
  }

  expect(failures, "a click must not raise a client-side error").toEqual([]);
});
