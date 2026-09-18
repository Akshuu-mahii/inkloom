/**
 * Does the deployed Content-Security-Policy actually let the app run?
 *
 * The existing smoke suite asserts the policy CONTAINS the right origins. That
 * is not the same question, and under `strict-dynamic` it is close to
 * meaningless: when `strict-dynamic` is present, browsers ignore host
 * allowlists and `'self'` in `script-src` entirely, and execute only scripts
 * carrying the nonce plus whatever those scripts go on to load. A policy can
 * list every origin correctly and still block the whole bundle.
 *
 * `strict-dynamic` used to be production-only, which meant production would
 * have been the first place it ever ran — with staging showing a clean bill of
 * health from a laxer policy. It now applies on any HTTPS deployment, and this
 * file is what makes that safe: it drives a real browser and fails on a CSP
 * violation rather than on a missing substring.
 *
 * READ-ONLY. It loads public pages and waits for a widget; nothing signs up,
 * signs in or writes a row, so it is safe against production too.
 */
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

/** Console messages a CSP refusal produces, in the browsers we support. */
const CSP_VIOLATION = /content security policy|refused to (load|execute|connect)/i;

function watchForViolations(page: Page): string[] {
  const violations: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error" && CSP_VIOLATION.test(message.text())) {
      violations.push(message.text());
    }
  });
  page.on("pageerror", (error) => {
    if (CSP_VIOLATION.test(error.message)) violations.push(error.message);
  });
  return violations;
}

test.describe("the deployed CSP permits the application to run", () => {
  for (const path of ["/", "/pricing", "/auth/login", "/auth/signup"]) {
    test(`${path} loads with no CSP violation and a hydrated bundle`, async ({ page }) => {
      const violations = watchForViolations(page);

      await page.goto(path);
      /*
       * `domcontentloaded`, not `networkidle`. The signup page embeds Turnstile,
       * which keeps long-lived connections to Cloudflare open, so networkidle
       * is never reached there and the test times out having proved nothing.
       */
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2_000);

      expect(violations, `CSP blocked something on ${path}`).toEqual([]);

      /*
       * Proof the bundle actually EXECUTED, not merely that it downloaded.
       * Under strict-dynamic a blocked script still returns 200 over the wire,
       * so a network-level check would pass while the page stayed inert.
       * React Router only sets this once hydration has run.
       */
      const hydrated = await page.evaluate(
        () =>
          document.documentElement.hasAttribute("data-hydrated") ||
          "__reactRouterContext" in window,
      );
      expect(hydrated, `${path} did not hydrate — the bundle did not execute`).toBe(true);
    });
  }

  /*
   * What this asserts, and why it stops short of a completed token.
   *
   * Turnstile is the script strict-dynamic is most likely to break: it is not
   * in the served HTML at all — the widget component creates a `<script>`
   * element at runtime, which strict-dynamic permits only because the bundle
   * creating it is itself trusted. If the bundle ever loses its nonce, the
   * injected script is refused and `window.turnstile` never appears. That is
   * the CSP question, and it is fully decidable here.
   *
   * Whether the widget goes on to ISSUE a token is not a CSP question and is
   * not assertable from an arbitrary network. Cloudflare's challenge flow
   * resolves per-challenge subdomains (`brunhild.challenges.cloudflare.com`
   * and siblings); where those do not resolve — a filtered resolver, a
   * corporate DNS, this machine — the widget stalls on "Checking you're
   * human…" with no CSP error whatsoever. Asserting on the token would make
   * this test fail for reasons that have nothing to do with the deployment,
   * which is precisely the mistake of blaming the server for a client-side
   * failure. Token issuance is covered by the local e2e suite, which drives a
   * full signup.
   */
  test("Turnstile's injected script is permitted and executes", async ({ page }) => {
    const violations = watchForViolations(page);

    await page.goto("/auth/signup");
    await page.waitForLoadState("domcontentloaded");

    const loaded = await page
      .waitForFunction(() => "turnstile" in window, undefined, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    expect(violations, "CSP blocked Turnstile's script").toEqual([]);
    expect(loaded, "the dynamically injected Turnstile script did not execute").toBe(true);

    // The tag the component injects at runtime, present because it was allowed.
    await expect(page.locator("script#cf-turnstile-script")).toHaveCount(1);
  });

  test("the policy carries the directives it is supposed to", async ({ page }) => {
    const response = await page.goto("/");
    const csp = response?.headers()["content-security-policy"] ?? "";

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp, "HTTPS deployments must upgrade insecure subresources").toContain(
      "upgrade-insecure-requests",
    );
    expect(csp, "and must run the same script policy production will").toContain(
      "'strict-dynamic'",
    );
  });

  test("HSTS is present, and staging does not make production's commitments", async ({ page }) => {
    const response = await page.goto("/");
    const hsts = response?.headers()["strict-transport-security"] ?? "";

    expect(hsts, "an HTTPS deployment must send HSTS").toMatch(/max-age=\d+/);

    const maxAge = Number(hsts.match(/max-age=(\d+)/)?.[1] ?? 0);
    expect(maxAge, "a token max-age protects nobody").toBeGreaterThanOrEqual(31_536_000);

    /*
     * `preload` is a public list that takes months to leave and binds every
     * subdomain of the apex. It is a production decision, made once,
     * deliberately — not something a staging deploy should be able to set.
     */
    if (!page.url().includes("staging")) return;
    expect(hsts, "staging must not enrol the domain in preload").not.toContain("preload");
  });
});
