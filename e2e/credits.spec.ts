import { expect, test } from "@playwright/test";
import { settled, signUpAndVerify, uniqueEmail } from "./support";

/**
 * Access-code redemption and the credit ledger, through the browser.
 *
 * The concurrency guarantees are proven at the service layer in
 * `redemption.concurrency.test.ts`, where genuine simultaneity is possible.
 * These tests cover what a person actually experiences: the code works, the
 * balance moves, and a second attempt is refused rather than doubling it.
 */

const SEEDED_CODE = "INKLOOMHACKATHON";
const SEEDED_CREDITS = 20;
/** Balances are shown as dollar amounts; see `formatCredits` in components/ui. */
const SEEDED_DISPLAY = `$${SEEDED_CREDITS}`;

test.describe("redeeming an access code", () => {
  test("a verified user redeems the seeded code and the balance moves", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("redeem"));

    await page.goto("/app/redeem");
    await settled(page);

    await page.getByLabel("Access code").fill(SEEDED_CODE);
    await page.getByRole("button", { name: /Redeem code/ }).click();

    await expect(
      page.getByText(new RegExp(`\\${SEEDED_DISPLAY} in credits added`, "i")),
    ).toBeVisible({
      timeout: 20_000,
    });

    // The dashboard agrees.
    await page.goto("/app");
    await settled(page);
    await expect(page.getByText(SEEDED_DISPLAY).first()).toBeVisible();

    // And so does the ledger.
    await page.goto("/app/credits");
    await settled(page);
    await expect(page.getByRole("cell", { name: /Access code/ }).first()).toBeVisible();
    await expect(page.getByText(`+${SEEDED_DISPLAY}`).first()).toBeVisible();
  });

  test("the code is case- and separator-insensitive", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("normalise"));

    await page.goto("/app/redeem");
    await settled(page);

    // Lower case, hyphens and spaces all normalise to the same code.
    await page.getByLabel("Access code").fill("  inkloom-hackathon  ");
    await page.getByRole("button", { name: /Redeem code/ }).click();

    await expect(page.getByText(/credits added/i)).toBeVisible({ timeout: 20_000 });
  });

  test("a second redemption is refused and does not double the balance", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("double"));

    await page.goto("/app/redeem");
    await settled(page);

    await page.getByLabel("Access code").fill(SEEDED_CODE);
    await page.getByRole("button", { name: /Redeem code/ }).click();
    await expect(page.getByText(/credits added/i)).toBeVisible({ timeout: 20_000 });

    await page.getByLabel("Access code").fill(SEEDED_CODE);
    await page.getByRole("button", { name: /Redeem code/ }).click();
    await expect(page.getByText(/already been redeemed/i)).toBeVisible({ timeout: 20_000 });

    // Exactly one grant, not two.
    const balance = await page.evaluate(async () => {
      const r = await fetch("/api/v1/credits", { credentials: "same-origin" });
      const j = (await r.json()) as { data: { balance: number } };
      return j.data.balance;
    });
    expect(balance).toBe(SEEDED_CREDITS);
  });

  test("an unknown code gives a message that reveals nothing", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("unknown"));

    await page.goto("/app/redeem");
    await settled(page);

    await page.getByLabel("Access code").fill("TOTALLY-MADE-UP-CODE");
    await page.getByRole("button", { name: /Redeem code/ }).click();

    await expect(page.getByText(/invalid or unavailable/i)).toBeVisible({ timeout: 20_000 });
    // Must not hint at whether a campaign exists, is expired, or is exhausted.
    await expect(page.locator("body")).not.toContainText(/expired|exhausted|paused|limit/i);
  });

  test("an unverified account cannot redeem", async ({ page }) => {
    // Sign up but deliberately do NOT verify.
    await page.goto("/auth/signup");
    await settled(page);
    await page.getByLabel("Your name").fill("Unverified");
    await page.getByLabel("Email address").fill(uniqueEmail("unverified"));
    await page.getByLabel("Password").fill("a-perfectly-fine-passphrase");
    await page.getByRole("checkbox", { name: /I agree to the/ }).check();
    const submit = page.getByRole("button", { name: /Create account|Checking/ });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();
    await page.waitForURL(/check-email/);

    // Without a session there is nothing to redeem with; the route sends them
    // to sign in rather than showing a form that would fail.
    await page.goto("/app/redeem");
    await settled(page);
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});

test.describe("credit history", () => {
  test("shows the ledger and never a negative balance", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("history"));

    await page.goto("/app/redeem");
    await settled(page);
    await page.getByLabel("Access code").fill(SEEDED_CODE);
    await page.getByRole("button", { name: /Redeem code/ }).click();
    await expect(page.getByText(/credits added/i)).toBeVisible({ timeout: 20_000 });

    await page.goto("/app/credits");
    await settled(page);

    await expect(page.getByRole("heading", { name: "Credits" })).toBeVisible();
    // V1 is explicit that credits are not spendable yet.
    await expect(page.getByText(/Generation is not live yet/i)).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/-\d+ credits/);
  });
});
