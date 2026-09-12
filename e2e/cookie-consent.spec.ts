/**
 * The cookie notice, and whether the choice it offers is real.
 *
 * A consent banner is easy to get wrong in ways that are invisible from the
 * outside: sending the events anyway, treating a dismissal as a yes, or
 * covering the page so the only way past it is to accept. These tests check the
 * behaviour rather than the presence of a banner.
 *
 * Deliberately does NOT use `settled()`, which answers the notice for every
 * other spec — here the notice is the subject.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/** Analytics requests the page actually made. */
async function watchAnalytics(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/analytics")) seen.push(request.url());
  });
  return seen;
}

test.describe("cookie consent", () => {
  test("appears on a first visit and offers two equal choices", async ({ page }) => {
    await page.goto("/");

    const notice = page.getByRole("dialog", { name: /Cookies on Inkloom/i });
    await expect(notice).toBeVisible({ timeout: 20_000 });

    // Both options present. A banner with only "Accept" is not a choice.
    await expect(page.getByRole("button", { name: "Necessary only" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept analytics" })).toBeVisible();

    // Neither is hidden behind the other, and both are real buttons of a
    // comparable size — the usual dark pattern is a tiny or disguised reject.
    const reject = await page.getByRole("button", { name: "Necessary only" }).boundingBox();
    const accept = await page.getByRole("button", { name: "Accept analytics" }).boundingBox();
    expect(reject?.height).toBeCloseTo(accept?.height ?? 0, 0);
    expect((reject?.width ?? 0) / (accept?.width ?? 1)).toBeGreaterThan(0.6);
  });

  test("sends no analytics until it is accepted", async ({ page }) => {
    const seen = await watchAnalytics(page);

    await page.goto("/");
    await expect(page.getByRole("dialog", { name: /Cookies on Inkloom/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Necessary only" }).click();

    // Move around: this is where page-view events would fire.
    await page.goto("/pricing");
    await page.goto("/faq");
    await page.waitForTimeout(1_000);

    expect(seen, "declining must mean nothing is sent").toEqual([]);
  });

  test("does not cover the page while it is shown", async ({ page }) => {
    /*
     * It is fixed to the bottom, so without room being made for it the banner
     * sits on top of whatever is there — on a long form, the submit button.
     * Playwright reported it as "subtree intercepts pointer events"; a person
     * would have experienced a button that did nothing.
     */
    await page.goto("/contact");
    await expect(page.getByRole("dialog", { name: /Cookies on Inkloom/i })).toBeVisible({
      timeout: 20_000,
    });

    const padding = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.body).paddingBottom),
    );
    expect(padding, "the page must reserve space for the banner").toBeGreaterThan(40);
  });

  test("the choice survives a reload, and the notice does not return", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Accept analytics" }).click();
    await expect(page.getByRole("dialog", { name: /Cookies on Inkloom/i })).toBeHidden();

    await page.reload();
    await expect(page.getByRole("dialog", { name: /Cookies on Inkloom/i })).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("inkloom.cookie-choice"))).toBe(
      "accepted",
    );
  });

  test("the notice itself has no WCAG A/AA violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("dialog", { name: /Cookies on Inkloom/i })).toBeVisible({
      timeout: 20_000,
    });

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .include(".cookie-notice")
      .analyze();

    expect(
      results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}`),
      "the consent banner must be as accessible as the rest of the site",
    ).toEqual([]);
  });
});
