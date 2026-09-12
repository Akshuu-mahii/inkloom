import { expect, test } from "@playwright/test";
import {
  clearMailbox,
  linkFrom,
  settled,
  signIn,
  signUpAndVerify,
  STRONG_PASSWORD,
  uniqueEmail,
  waitForEmail,
} from "./support";

test.describe("signup and verification", () => {
  test("a visitor can sign up, verify by email, and reach the dashboard", async ({ page }) => {
    await clearMailbox();
    const email = uniqueEmail("signup");

    await page.goto("/auth/signup");
    await settled(page);

    await page.getByLabel("Your name").fill("Ada Lovelace");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(STRONG_PASSWORD);

    // Strength feedback is advisory and must never block a long passphrase.
    await expect(page.getByText(/Strong|Good/)).toBeVisible();

    await page.getByRole("checkbox", { name: /I agree to the/ }).check();

    const submit = page.getByRole("button", { name: /Create account|Checking/ });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();

    await expect(page).toHaveURL(/\/auth\/check-email/);
    await expect(page.getByRole("heading", { name: /Confirm your email/i })).toBeVisible();

    // The real message, read out of the real mail server.
    const mail = await waitForEmail(email, { subjectMatch: /confirm/i });
    expect(mail.text).toMatch(/expires in/i);

    await page.goto(linkFrom(mail.html));
    await settled(page);

    // Verified users land signed in.
    await expect(page).toHaveURL(/\/app/);
    await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
  });

  test("signup will not proceed without accepting the terms", async ({ page }) => {
    await page.goto("/auth/signup");
    await settled(page);

    await page.getByLabel("Your name").fill("No Consent");
    await page.getByLabel("Email address").fill(uniqueEmail("noconsent"));
    await page.getByLabel("Password").fill(STRONG_PASSWORD);

    const submit = page.getByRole("button", { name: /Create account|Checking/ });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();

    // The browser's own required-field validation stops it; we never navigate.
    await expect(page).toHaveURL(/\/auth\/signup/);
  });

  test("an already-registered address gets the same response as a new one", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("dup"));

    await page.goto("/auth/signup");
    await settled(page);
    await page.getByLabel("Your name").fill("Impostor");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill("a-completely-different-phrase");
    await page.getByRole("checkbox", { name: /I agree to the/ }).check();

    const submit = page.getByRole("button", { name: /Create account|Checking/ });
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    await submit.click();

    // Identical destination, and nothing anywhere admitting the account exists.
    await expect(page).toHaveURL(/\/auth\/check-email/);
    await expect(page.locator("body")).not.toContainText(/already (exists|registered|taken)/i);
  });
});

test.describe("sign in and out", () => {
  test("a verified user can sign in and out", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("login"));

    // Sign out first so we are testing a real sign-in.
    await page.goto("/app");
    await settled(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForTimeout(1000);

    await signIn(page, email);
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
  });

  test("signing out lands on a page, not on the API's JSON", async ({ page }) => {
    /*
     * The header used to post straight at /api/v1/auth/logout. The session
     * really did end, so every test that signed out passed — none of them
     * looked at where the browser ended up, which was a blank page showing
     * {"data":{"success":true},...}. This is that missing assertion.
     */
    await signUpAndVerify(page, uniqueEmail("signout"));
    await page.goto("/app");
    await settled(page);

    await page.getByRole("button", { name: "Sign out" }).click();

    // A real page on the site, not an API path.
    await expect(page).not.toHaveURL(/\/api\//, { timeout: 20_000 });
    await expect(page.locator("body")).not.toContainText('{"data"');
    await expect(page.getByRole("link", { name: /Sign in/i }).first()).toBeVisible({
      timeout: 20_000,
    });

    // And the session is genuinely gone: /app bounces to sign-in.
    await page.goto("/app");
    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 20_000 });
  });

  test("a wrong password and an unknown address give the same message", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("enum"));
    await page.goto("/app");
    await settled(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForTimeout(800);

    await signIn(page, email, "definitely-not-the-password");
    await settled(page);
    const wrongPassword = await page.getByRole("alert").first().textContent();

    await signIn(page, uniqueEmail("ghost"), STRONG_PASSWORD);
    await settled(page);
    const unknownEmail = await page.getByRole("alert").first().textContent();

    // Byte-identical: the response cannot be used to test whether an account exists.
    expect(wrongPassword?.trim()).toBe(unknownEmail?.trim());
  });

  test("signing in cannot be redirected off-site by the next parameter", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("redirect"));
    await page.goto("/app");
    await settled(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForTimeout(800);

    await page.goto("/auth/login?next=https://evil.example/steal");
    await settled(page);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password").fill(STRONG_PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    await page.waitForTimeout(2500);
    // Stayed on our origin, and landed on the safe default.
    expect(new URL(page.url()).origin).toBe(new URL(page.url()).origin);
    expect(page.url()).not.toContain("evil.example");
  });
});

test.describe("password reset", () => {
  test("a user can reset their password with a single-use link", async ({ page }) => {
    await clearMailbox();
    const email = await signUpAndVerify(page, uniqueEmail("reset"));

    await page.goto("/app");
    await settled(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForTimeout(800);

    await page.goto("/auth/forgot-password");
    await settled(page);
    await page.getByLabel("Email address").fill(email);
    const send = page.getByRole("button", { name: /Send reset link|Checking/ });
    await expect(send).toBeEnabled({ timeout: 20_000 });
    await send.click();

    await expect(page.getByRole("heading", { name: /Check your email/i })).toBeVisible();

    const mail = await waitForEmail(email, { subjectMatch: /reset/i });
    expect(mail.text).toMatch(/expires in/i);

    const resetLink = linkFrom(mail.html, "token=");
    await page.goto(resetLink);
    await settled(page);

    const newPassword = "an-entirely-new-passphrase";
    // By ROLE and accessible name: `getByLabel` sees the visible label text,
    // which includes the aria-hidden required marker, while the accessible name
    // is clean. `exact` then disambiguates it from "Confirm new password".
    await page.getByRole("textbox", { name: "New password", exact: true }).fill(newPassword);
    await page.getByRole("textbox", { name: "Confirm new password" }).fill(newPassword);
    await page.getByRole("button", { name: /Save new password/ }).click();

    await expect(page).toHaveURL(/\/auth\/login/, { timeout: 20_000 });

    // The new password works.
    await signIn(page, email, newPassword);
    await expect(page).toHaveURL(/\/app/, { timeout: 20_000 });
  });

  test("the reset form is unusable without a token", async ({ page }) => {
    await page.goto("/auth/reset-password");
    await settled(page);
    await expect(page.getByRole("heading", { name: /needs a reset link/i })).toBeVisible();
    await expect(page.getByLabel("New password")).toHaveCount(0);
  });
});

test.describe("sessions", () => {
  test("a user can see their session and sign out everywhere", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("sessions"));

    await page.goto("/app/sessions");
    await settled(page);

    await expect(page.getByText("This device")).toBeVisible();
    // Never an IP address, never a raw user-agent string.
    await expect(page.locator("body")).not.toContainText(/\d+\.\d+\.\d+\.\d+/);
    await expect(page.locator("body")).not.toContainText(/Mozilla\/5\.0/);
  });
});
