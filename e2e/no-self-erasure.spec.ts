/**
 * Erasing your own account is not something the product offers.
 *
 * It used to: a form on /app/profile, one confirmation away from "export my
 * data". It was removed on purpose — an irreversible action sitting beside a
 * routine one is a support burden long before it is a feature — and /privacy
 * says what it always said, that erasure happens when someone writes and asks.
 *
 * This is the guard against it coming back unnoticed, from either direction:
 * a control reappearing on the page, or the endpoint being reachable by anyone
 * who knows it is there. An unlinked endpoint is still an endpoint.
 */
import { expect, test } from "@playwright/test";
import { STRONG_PASSWORD, signUpAndVerify } from "./support";

test.describe("self-service erasure is gone", () => {
  test("the profile page offers no way to delete the account", async ({ page }) => {
    await signUpAndVerify(page);
    await page.goto("/app/profile");

    await expect(page.getByRole("heading", { name: /profile/i }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /erase|delete my account/i })).toHaveCount(0);
    await expect(page.getByText(/erase this account/i)).toHaveCount(0);
  });

  test("DELETE on the account endpoint is not served", async ({ page }) => {
    await signUpAndVerify(page);

    /*
     * The Origin header is what makes this assertion mean anything.
     *
     * Without it the request is turned away by the origin check at 403 before
     * routing is ever consulted, so the test passed or failed on whether CSRF
     * worked — it could not distinguish "there is no such endpoint" from "there
     * is one, behind a header we forgot to send". That is the opposite of what
     * this file exists to prove. Sent as a real same-origin call, the request
     * reaches the router and the router has nothing for it.
     */
    const response = await page.request.fetch(new URL("/api/v1/me", page.url()).toString(), {
      method: "DELETE",
      headers: { origin: new URL(page.url()).origin },
      data: { currentPassword: STRONG_PASSWORD, understood: true },
      failOnStatusCode: false,
    });

    expect(
      [404, 405],
      `DELETE /api/v1/me answered ${response.status()}; anything other than "no such route" ` +
        "means self-service erasure is reachable again",
    ).toContain(response.status());

    // And the account is still perfectly usable afterwards.
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  });
});
