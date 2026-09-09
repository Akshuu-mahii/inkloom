/**
 * What happens when Cloudflare's Turnstile script cannot be reached.
 *
 * Every form that sends mail — signup, password reset, contact — holds its
 * submit button disabled until Turnstile has minted a token. That gate is
 * correct for the two or three seconds the widget normally needs, and wrong
 * after that: `challenges.cloudflare.com` is a third-party host, and an
 * ad-blocker, a DNS filter, a corporate proxy or a bad minute of connectivity
 * all end the same way — no token, ever.
 *
 * Without a bound on the wait, the user is left holding a greyed-out button
 * reading "Checking you're human…" with no error, no retry and no explanation.
 * They conclude the product is broken, which is the report that produced these
 * tests.
 *
 * The server still fails closed on a missing token. Nothing here weakens that;
 * these tests are about not stranding a person in front of an inert control.
 */
import { expect, test, type Page } from "@playwright/test";
import { settled, STRONG_PASSWORD, uniqueEmail } from "./support";

/** Make the Turnstile script unreachable, the way a blocker or a filter does. */
async function blockTurnstile(page: Page): Promise<void> {
  await page.route("**challenges.cloudflare.com/**", (route) => route.abort());
}

test.describe("Turnstile is unreachable", () => {
  test.beforeEach(async ({ page }) => {
    await blockTurnstile(page);
  });

  test("signup does not strand the user behind a dead button", async ({ page }) => {
    await page.goto("/auth/signup");
    await settled(page);

    await page.getByLabel("Your name").fill("Blocked Widget");
    await page.getByLabel("Email address").fill(uniqueEmail("blocked"));
    await page.getByLabel("Password").fill(STRONG_PASSWORD);
    await page.getByRole("checkbox", { name: /I agree to the/ }).check();

    // The wait must be bounded. Anything else is an indefinite hang.
    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 20_000,
    });

    // And the person must be told why, rather than left guessing.
    await expect(page.getByRole("alert").filter({ hasText: /human check/i })).toBeVisible();
  });

  test("the human check offers a retry", async ({ page }) => {
    await page.goto("/auth/signup");
    await settled(page);

    const retry = page.getByRole("button", { name: /try the check again/i });
    await expect(retry).toBeVisible({ timeout: 20_000 });
  });

  test("password reset does not strand the user behind a dead button", async ({ page }) => {
    await page.goto("/auth/forgot-password");
    await settled(page);

    await page.getByLabel("Email address").fill(uniqueEmail("blocked-reset"));

    await expect(page.getByRole("button", { name: /Send reset link/ })).toBeEnabled({
      timeout: 20_000,
    });
  });

  test("the contact form does not strand the user behind a dead button", async ({ page }) => {
    await page.goto("/contact");
    await settled(page);

    await expect(page.getByRole("button", { name: /Send message/ })).toBeEnabled({
      timeout: 20_000,
    });
  });
});

test.describe("Turnstile is reachable", () => {
  test("the gate still holds until a token exists", async ({ page }) => {
    // The original reason for the gate has not gone away: a fast typist must
    // not be able to submit into a guaranteed rejection while the widget is
    // still working. With the script reachable, the button starts disabled.
    let released: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      released = resolve;
    });
    await page.route("**challenges.cloudflare.com/**", async (route) => {
      await held;
      await route.continue();
    });

    await page.goto("/auth/signup");
    await settled(page);

    await expect(page.getByRole("button", { name: /Checking you're human/ })).toBeDisabled();

    released?.();
    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 20_000,
    });
    // A real token, not a bypass.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null)
              ?.value.length ?? 0,
        ),
      )
      .toBeGreaterThan(0);
  });
});
