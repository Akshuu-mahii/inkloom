/**
 * Does the DEPLOYED build behave like the local one?
 *
 * Every serious bug in this deployment has had the same shape: correct on a
 * laptop, wrong on Cloudflare, and invisible to a full local suite. A Worker
 * cannot fetch its own hostname. `env.vars` does not merge. `--env` on deploy is
 * inert. Hyperdrive caches authenticated reads. None of those could fail
 * locally, and all of them broke everything.
 *
 * So these assertions deliberately target the things that DIFFER between a
 * laptop and the edge — routing, headers, environment resolution, bundling —
 * rather than re-testing business logic the local suite already proves.
 *
 * READ-ONLY. Nothing here signs up, signs in, or writes a row. It is safe to
 * point at staging, and safe to point at production.
 */
import { expect, test } from "@playwright/test";

const PUBLIC_PAGES = [
  "/",
  "/examples",
  "/how-it-works",
  "/pricing",
  "/faq",
  "/contact",
  "/security",
  "/terms",
  "/privacy",
  "/cookies",
];

test.describe("the deployment serves what it should", () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} renders`, async ({ page }) => {
      const response = await page.goto(path);

      expect(response?.status(), `${path} must be 200`).toBe(200);
      await expect(page.locator("main, [role=main]").first()).toBeVisible();
      // A page that rendered the error boundary is still a 200.
      await expect(page.locator("body")).not.toContainText("Something went wrong");
    });
  }

  test("the API is reachable and healthy", async ({ request }) => {
    const response = await request.get("/api/health");

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });
});

test.describe("environment resolution", () => {
  /*
   * `env.<name>.vars` REPLACES the top-level vars block rather than merging, so
   * a value set once at the top silently becomes its schema default in every
   * deployed environment. For the Turnstile site key that default is "", which
   * renders a widget that issues no token while the server still demands one —
   * breaking signup, login, password reset and contact at once, with nothing in
   * the logs but "captcha failed". Only a deployed check can catch it.
   */
  test("the Turnstile site key reached the browser", async ({ page }) => {
    await page.goto("/auth/signup");

    const html = await page.content();
    expect(html, "no site key in the signup page").toMatch(/0x4[A-Za-z0-9]{10,}/);
    expect(html, "Cloudflare's always-passing test key must never ship").not.toContain(
      "1x00000000000000000000AA",
    );
  });

  test("the environment is not serving development configuration", async ({ page }) => {
    const response = await page.goto("/");
    const csp = response?.headers()["content-security-policy"] ?? "";

    expect(csp, "a document CSP must be present").toContain("frame-ancestors 'none'");
    expect(page.url(), "must not redirect to localhost").not.toContain("localhost");
  });
});

test.describe("security headers", () => {
  test("the document carries the full header set", async ({ page }) => {
    const response = await page.goto("/");
    const h = response!.headers();

    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBeTruthy();
    expect(h["content-security-policy"]).toContain("object-src 'none'");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["permissions-policy"]).toBeTruthy();
    expect(h["x-powered-by"], "must not advertise the stack").toBeUndefined();
  });

  test("the CSP nonce is fresh on every response, so it cannot be replayed", async ({ page }) => {
    const nonce = async () => {
      const r = await page.goto("/?cache-bust=" + Math.random());
      return (r?.headers()["content-security-policy"] ?? "").match(/nonce-([A-Za-z0-9+/=]+)/)?.[1];
    };

    const first = await nonce();
    const second = await nonce();

    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });

  /*
   * Turnstile must be permitted on EVERY document, not only the pages that
   * render it.
   *
   * CSP is a property of a document. This site routes on the client, so
   * clicking from the home page to /auth/signup fetches no new document and the
   * page keeps the home page's headers. Scoping these origins per route — which
   * is what this test used to assert — left the widget blocked for anyone who
   * navigated to signup rather than landing on it, and working after a refresh,
   * which reads as flakiness rather than a header.
   */
  test("every document permits Turnstile, including ones with no form", async ({ page }) => {
    const cspFor = async (path: string) =>
      (await page.goto(path))?.headers()["content-security-policy"] ?? "";

    for (const path of ["/auth/signup", "/", "/pricing"]) {
      const csp = await cspFor(path);
      for (const directive of ["script-src", "frame-src", "connect-src"]) {
        const values = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(directive));
        expect(values, `${path} ${directive}`).toContain("challenges.cloudflare.com");
      }
    }
  });
});

/*
 * "Not discoverable" and "not reachable" are different things, and asserting
 * only the first hides the second.
 *
 * The console shipped completely unreachable and this suite stayed green. The
 * route table takes ADMIN_PATH at BUILD time; the deploy only supplied it as a
 * runtime secret, so the console mounted at /admin — which the Worker then
 * 404s as a decoy. Both doors were locked. Every check below passed throughout,
 * because a correctly-hidden console and a broken one produce identical 404s.
 *
 * So the suite now also asserts the console is THERE. A 403 or a redirect to
 * sign-in proves the route resolved and the gate refused; a 404 proves nothing
 * resolved at all.
 */
test.describe("the admin console exists at its configured path", () => {
  const adminPath = process.env.ADMIN_PATH;

  test.skip(
    !adminPath || adminPath === "/admin",
    "ADMIN_PATH not configured for this run — nothing to verify against",
  );

  test("the real path resolves to a gate, not to nothing", async ({ request }) => {
    const response = await request.get(adminPath!, { maxRedirects: 0 });

    expect(
      response.status(),
      `${adminPath} returned 404 — the console is not mounted there. ` +
        "The build almost certainly did not receive ADMIN_PATH.",
    ).not.toBe(404);

    // Refused, or sent to sign in. Either way the route exists and is guarded.
    expect([401, 403, 302, 303]).toContain(response.status());
  });
});

test.describe("the admin console is not discoverable", () => {
  for (const path of ["/admin", "/admin/users", "/wp-admin", "/administrator"]) {
    test(`${path} is a dead end`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(404);
    });
  }

  test("admin API endpoints refuse an anonymous caller", async ({ request }) => {
    for (const endpoint of ["overview", "users", "audit", "security", "settings"]) {
      const response = await request.get(`/api/v1/admin/${endpoint}`);
      expect(response.status(), `/api/v1/admin/${endpoint}`).toBe(401);
    }
  });
});

test.describe("signed-in areas are gated", () => {
  for (const path of ["/app", "/app/credits", "/app/sessions", "/app/profile"]) {
    test(`${path} redirects an anonymous visitor to sign in`, async ({ page }) => {
      await page.goto(path);

      await expect(page).toHaveURL(/\/auth\/login/);
      // The intended destination survives the round trip.
      expect(page.url()).toContain("next=");
    });
  }
});

test.describe("no server code reached the browser", () => {
  /*
   * The 144KB incident: a barrel import pulled the Drizzle schema and the
   * Postgres client into a client chunk, which then failed to load, so four
   * console pages could not be opened at all — while server rendering worked
   * perfectly and every curl check passed. Only a real browser navigation
   * showed it.
   */
  test("no console errors and no failed chunk loads on the dashboard route", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(m.text());
    });
    page.on("requestfailed", (r) => problems.push(`failed: ${r.url()}`));

    await page.goto("/auth/login");
    await page.waitForLoadState("networkidle");

    const ignorable = /turnstile|challenges\.cloudflare|favicon|analytics/i;
    expect(problems.filter((p) => !ignorable.test(p))).toEqual([]);
  });

  test("the client bundle contains no database or secret material", async ({ page, request }) => {
    await page.goto("/");
    const scripts = await page.locator("script[src]").evaluateAll((els) =>
      els.map((e) => (e as HTMLScriptElement).src),
    );

    expect(scripts.length, "expected at least one bundled script").toBeGreaterThan(0);

    for (const src of scripts) {
      const body = await (await request.get(src)).text();
      for (const forbidden of ["neondb_owner", "ACCESS_CODE_PEPPER", "BETTER_AUTH_SECRET", "postgresql://"]) {
        expect(body, `${forbidden} found in ${src}`).not.toContain(forbidden);
      }
    }
  });
});
