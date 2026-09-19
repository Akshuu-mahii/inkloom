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

    const response = await page.request.fetch("/api/v1/me", {
      method: "DELETE",
      data: { currentPassword: STRONG_PASSWORD, understood: true },
      failOnStatusCode: false,
    });

    expect([404, 405]).toContain(response.status());

    // And the account is still perfectly usable afterwards.
    await page.goto("/app");
    await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible();
  });
});
