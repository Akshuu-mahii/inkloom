/**
 * What happens when Cloudflare's Turnstile script cannot be reached.
 *
 * Every form that sends mail — signup, password reset, contact — holds its
 * submit button until Turnstile has minted a token. `challenges.cloudflare.com`
 * is a third party, so an ad-blocker, a DNS filter, a corporate proxy or a bad
 * minute of connectivity all end the same way: no token.
 *
 * These tests pin the two failures this file has already shipped:
 *
 *   1. An unbounded wait. The button sat disabled forever reading "Checking
 *      you're human…" with no error and no retry, because the script tag had a
 *      `load` handler and no `error` handler.
 *
 *   2. Then, over-correcting: releasing the button once the check gave up. The
 *      server fails closed on a missing token, so every one of those
 *      submissions was refused with "We couldn't verify that you're human" —
 *      an accusation for something outside the person's control. Observed for
 *      real: two signups four seconds apart, both refused with
 *      `missing-input-response`, on a connection where the widget went on to
 *      mint a perfectly good token about forty seconds later.
 *
 * So the contract is: retry, keep the button gated, and say plainly what is
 * wrong and what to do about it.
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

  test("signup explains the failure instead of blaming the person", async ({ page }) => {
    await page.goto("/auth/signup");
    await settled(page);

    await page.getByLabel("Your name").fill("Blocked Widget");
    await page.getByLabel("Email address").fill(uniqueEmail("blocked"));
    await page.getByLabel("Password").fill(STRONG_PASSWORD);
    await page.getByRole("checkbox", { name: /I agree to the/ }).check();

    // The wait is bounded: it must reach a settled answer, not hang.
    const alert = page.getByRole("alert").filter({ hasText: /human check couldn/i });
    await expect(alert).toBeVisible({ timeout: 40_000 });

    // It says whose fault it is not, and what to allow.
    await expect(alert).toContainText(/not something you did/i);
    await expect(alert).toContainText("challenges.cloudflare.com");

    // And the button stays shut rather than offering a guaranteed refusal.
    const submit = page.getByRole("button", { name: /Human check unavailable/ });
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
  });

  test("the human check offers a retry", async ({ page }) => {
    await page.goto("/auth/signup");
    await settled(page);
    await expect(page.getByRole("button", { name: /try the check again/i })).toBeVisible({
      timeout: 40_000,
    });
  });

  test("password reset reaches a settled answer, gated", async ({ page }) => {
    await page.goto("/auth/forgot-password");
    await settled(page);
    await page.getByLabel("Email address").fill(uniqueEmail("blocked-reset"));

    const submit = page.getByRole("button", { name: /Human check unavailable/ });
    await expect(submit).toBeVisible({ timeout: 40_000 });
    await expect(submit).toBeDisabled();
  });

  test("the contact form reaches a settled answer, gated", async ({ page }) => {
    await page.goto("/contact");
    await settled(page);

    const submit = page.getByRole("button", { name: /Human check unavailable/ });
    await expect(submit).toBeVisible({ timeout: 40_000 });
    await expect(submit).toBeDisabled();
  });
});

test.describe("the block is lifted", () => {
  test("the manual retry recovers, and the form becomes usable", async ({ page }) => {
    /*
     * The retry button is only worth offering if it actually works. Someone who
     * reads the message, turns off their ad-blocker and clicks it must end up
     * with a usable form — otherwise the advice is worse than no advice.
     */
    let blocking = true;
    await page.route("**challenges.cloudflare.com/**", async (route) => {
      if (blocking) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto("/auth/signup");
    await settled(page);

    const gated = page.getByRole("button", { name: /Human check unavailable/ });
    await expect(gated).toBeVisible({ timeout: 40_000 });
    await expect(gated).toBeDisabled();

    // The blocker comes off, and the person clicks the product's own retry.
    blocking = false;
    await page.getByRole("button", { name: /try the check again/i }).click();

    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 30_000,
    });
    // A real token, and the warning is gone.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (document.querySelector('[name="cf-turnstile-response"]') as HTMLInputElement | null)
              ?.value.length ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    await expect(page.getByRole("alert").filter({ hasText: /human check couldn/i })).toHaveCount(0);
  });
});

test.describe("Turnstile is slow but working", () => {
  test("a slow script is retried, not written off", async ({ page }) => {
    /*
     * The exact shape of the real failure: the first fetch never resolves, so
     * the first attempt times out. A single deadline would call that a dead
     * check. Retrying gets a token and the form works.
     */
    let seen = 0;
    await page.route("**challenges.cloudflare.com/**", async (route) => {
      seen += 1;
      if (seen === 1 && route.request().url().includes("api.js")) {
        // Hang past the per-attempt budget, then fail — the attempt is retried.
        await new Promise((resolve) => setTimeout(resolve, 9_000));
        await route.abort();
        return;
      }
      await route.continue();
    });

    await page.goto("/auth/signup");
    await settled(page);

    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 45_000,
    });
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

test.describe("Turnstile is reachable", () => {
  test("the gate still holds until a token exists", async ({ page }) => {
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
      timeout: 30_000,
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
