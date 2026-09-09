import { test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { settled, signUpAndVerify, STRONG_PASSWORD, uniqueEmail } from "../support";
import { secretFromUri, totp } from "../totp";

/**
 * Screenshot pass over the admin area.
 *
 * Not an assertion suite — its job is to produce artefacts a human can review,
 * and to fail loudly if a page errors while doing so.
 */
test("capture admin screens", async ({ page }) => {
  test.setTimeout(120_000);
  const out = process.env.SHOT_DIR ?? "test-results/screens";
  const email = await signUpAndVerify(page, uniqueEmail("shot"));

  execFileSync("pnpm", ["bootstrap:superadmin", "--email", email, "--force"], {
    input: `${email}\n`,
    stdio: "pipe",
    env: process.env,
  });

  const enrol = await page.evaluate(async (password) => {
    const r = await fetch("/api/auth/two-factor/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password, issuer: "Inkloom" }),
    });
    return r.text();
  }, STRONG_PASSWORD);

  const secret = secretFromUri((JSON.parse(enrol) as { totpURI: string }).totpURI);
  await page.evaluate(async (code) => {
    await fetch("/api/auth/two-factor/verify-totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ code, trustDevice: false }),
    });
  }, totp(secret));

  await page.setViewportSize({ width: 1440, height: 1000 });

  for (const [path, name, fullPage] of [
    ["/admin", "admin-overview", true],
    ["/admin/users", "admin-users", false],
    ["/admin/access-codes", "admin-campaigns", false],
    ["/admin/system", "admin-system", true],
    ["/app", "app-dashboard", false],
    ["/app/credits", "app-credits", false],
  ] as const) {
    await page.goto(path);
    await settled(page);
    await page.waitForTimeout(700);
    const body = (await page.textContent("body")) ?? "";
    if (/Something went wrong|Two-factor authentication required/i.test(body)) {
      throw new Error(`${path} did not render: ${body.slice(0, 120)}`);
    }
    await page.screenshot({ path: `${out}/${name}.png`, fullPage });
  }
});
