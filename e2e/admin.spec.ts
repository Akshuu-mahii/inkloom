import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { settled, signUpAndVerify, STRONG_PASSWORD, uniqueEmail } from "./support";
import { secretFromUri, totp } from "./totp";

/**
 * Admin flows.
 *
 * The 2FA here is REAL: the test enrols through Better Auth's own endpoints,
 * reads the shared secret out of the `otpauth://` URI, and generates genuine
 * TOTP codes. Faking it by setting `two_factor_enabled = true` in the database
 * would produce an account claiming a second factor with no secret behind it —
 * sign-in would then correctly become impossible, and the test would prove
 * nothing.
 */

/** Promote an account through the same one-time CLI an operator would use. */
function bootstrapSuperAdmin(email: string) {
  execFileSync("pnpm", ["bootstrap:superadmin", "--email", email, "--force"], {
    cwd: process.cwd(),
    stdio: "pipe",
    input: `${email}\n`,
    env: process.env,
  });
}

/** Enrol TOTP for the signed-in account and return the secret. */
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

  const parsed = JSON.parse(enrol.body) as { totpURI?: string };
  expect(parsed.totpURI, "enable should return a TOTP URI").toBeTruthy();
  const secret = secretFromUri(parsed.totpURI!);

  // Better Auth requires the first code before it marks 2FA as verified.
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

test.describe("admin access control", () => {
  test("an ordinary user gets the restricted screen and is refused by the API", async ({
    page,
  }) => {
    await signUpAndVerify(page, uniqueEmail("plain"));

    await page.goto("/admin");
    await settled(page);

    /*
     * A generic restricted screen, not a redirect to /app.
     *
     * The redirect was replaced deliberately: it confirmed to a prober that
     * they were at least authenticated, and it differed from what a signed-out
     * visitor saw. Signed out, ordinary user, staff-without-2FA and
     * staff-who-are-not-the-owner now all get this same page, so the response
     * distinguishes nothing.
     */
    await expect(page.getByRole("heading", { name: "Restricted" })).toBeVisible();
    await expect(page.getByText("Audit log")).toHaveCount(0);

    // The API is the real control, and it refuses independently of the UI.
    const refused = await page.evaluate(async () => {
      const paths = [
        "/api/v1/admin/overview",
        "/api/v1/admin/users",
        "/api/v1/admin/access-codes",
        "/api/v1/admin/credits/ledger",
        "/api/v1/admin/audit",
        "/api/v1/admin/settings",
      ];
      const results: Record<string, number> = {};
      for (const path of paths) {
        const response = await fetch(path, { credentials: "same-origin" });
        results[path] = response.status;
      }
      return results;
    });

    for (const [path, status] of Object.entries(refused)) {
      expect(status, `${path} must refuse an ordinary user`).toBeGreaterThanOrEqual(401);
      expect(status, `${path} must not be a server error`).toBeLessThan(500);
    }
  });

  test("an admin without 2FA is blocked until they enrol", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("noadmin2fa"));
    bootstrapSuperAdmin(email);

    await page.goto("/admin");
    await settled(page);

    await expect(
      page.getByRole("heading", { name: /Two-factor authentication required/i }),
    ).toBeVisible();

    // And the API says the same thing, so the wall is not merely cosmetic.
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/v1/admin/overview", { credentials: "same-origin" });
      const body = (await response.json()) as { error?: { code?: string } };
      return { status: response.status, code: body.error?.code };
    });
    expect(status.code).toBe("TWO_FACTOR_REQUIRED");
  });
});

test.describe("admin with two-factor", () => {
  test("a super admin can enrol 2FA, sign in with a code, and run the platform", async ({
    page,
  }) => {
    const email = await signUpAndVerify(page, uniqueEmail("superadmin"));
    bootstrapSuperAdmin(email);

    const secret = await enrolTwoFactor(page);

    // --- Sign out and back in, THROUGH the 2FA challenge -------------------
    await page.goto("/app");
    await settled(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForTimeout(1200);

    await page.goto("/auth/login");
    await settled(page);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(STRONG_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // A password alone does not produce a session.
    await page.waitForURL(/\/auth\/two-factor/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /Enter your code/i })).toBeVisible();

    await settled(page);
    await page.getByLabel("Six-digit code").fill(totp(secret));
    await page.getByRole("button", { name: /Verify and sign in/ }).click();
    await page.waitForTimeout(2500);

    // --- Overview -----------------------------------------------------------
    await page.goto("/admin");
    await settled(page);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Early-access funnel" })).toBeVisible();

    // --- Create a campaign, and see the code exactly once -------------------
    await page.goto("/admin/access-codes/new");
    await settled(page);

    const campaignName = `E2E campaign ${Date.now()}`;
    await page.getByLabel("Campaign name").fill(campaignName);
    await page.getByLabel("Credits per redemption").fill("42");
    await page.getByLabel(/Reason for creating/).fill("End-to-end test campaign");
    await page.getByRole("button", { name: /Create campaign/ }).click();

    await expect(page.getByRole("heading", { name: /Campaign created/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/will never be shown again/i)).toBeVisible();

    const revealed = await page.locator(".identifier").first().textContent();
    expect(revealed?.trim().length ?? 0).toBeGreaterThan(6);

    // Revisiting the campaign must NOT show the code again.
    await page.goto("/admin/access-codes");
    await settled(page);
    await expect(page.getByText(campaignName)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(revealed!.trim());

    // --- Adjust credits, with a mandatory reason ---------------------------
    await page.goto("/admin/users");
    await settled(page);
    await page.getByLabel("Search users").fill(email);
    await page.getByRole("button", { name: "Search" }).click();
    await settled(page);
    await page.getByRole("link", { name: email }).first().click();
    // Wait for the DETAIL route specifically: without this the id below can be
    // read off the list URL while the navigation is still in flight.
    await page.waitForURL(/\/admin\/users\/usr_/, { timeout: 20_000 });
    await settled(page);

    const userId = new URL(page.url()).pathname.split("/").pop()!;
    expect(userId).toMatch(/^usr_/);

    await page.goto(`/admin/credits?userId=${userId}`);
    await settled(page);
    await page.getByLabel("Amount").fill("250");
    await page.getByLabel("Reason").fill("End-to-end test grant");
    await page.getByRole("button", { name: /Apply adjustment/ }).click();

    await expect(page.getByText(/Adjustment applied/i)).toBeVisible({ timeout: 20_000 });

    // --- The action is in the audit log ------------------------------------
    await page.goto("/admin/audit");
    await settled(page);
    await expect(page.getByText("admin.credits.adjust").first()).toBeVisible();
    await expect(page.getByText("End-to-end test grant").first()).toBeVisible();

    // --- Reconciliation reports no drift -----------------------------------
    await page.goto("/admin/credits");
    await settled(page);
    await page.getByRole("button", { name: /Run reconciliation/ }).click();
    await expect(page.getByText(/Every balance matches its ledger/i)).toBeVisible({
      timeout: 20_000,
    });
  });

  test("credits cannot be adjusted without a reason", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("noreason"));
    bootstrapSuperAdmin(email);
    const secret = await enrolTwoFactor(page);
    void secret;

    await page.goto("/admin/credits");
    await settled(page);

    await page.getByLabel("User id").fill("usr_01AAAAAAAAAAAAAAAAAAAAAAAA");
    await page.getByLabel("Amount").fill("100");
    // Reason left empty on purpose.
    await page.getByRole("button", { name: /Apply adjustment/ }).click();

    // Required-field validation keeps us on the page; nothing was adjusted.
    await expect(page).toHaveURL(/\/admin\/credits/);
    await expect(page.getByText(/Adjustment applied/i)).toHaveCount(0);
  });
});
