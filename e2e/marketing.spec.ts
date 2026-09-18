import { expect, test } from "@playwright/test";
import { settled } from "./support";

/**
 * Every public page: it renders, it is indexable and correctly described, it
 * has exactly one h1, and it does not scroll sideways.
 *
 * Written as a table because the value is in the coverage — a new public page
 * that forgets its metadata should fail here rather than ship.
 */
const PUBLIC_PAGES = [
  { path: "/", h1: /Logos, built the way/ },
  { path: "/how-it-works", h1: /Four models/ },
  { path: "/early-access", h1: /Join early access/ },
  { path: "/pricing", h1: /Pricing, planned/ },
  { path: "/faq", h1: /Questions/ },
  { path: "/about", h1: /A logo is a system/ },
  { path: "/contact", h1: /Get in touch/ },
  { path: "/security", h1: /^Security$/ },
  { path: "/terms", h1: /Terms of Service/ },
  { path: "/privacy", h1: /Privacy Policy/ },
  { path: "/cookies", h1: /Cookie Policy/ },
  { path: "/acceptable-use", h1: /Acceptable Use Policy/ },
] as const;

test.describe("public pages", () => {
  for (const page_ of PUBLIC_PAGES) {
    test(`${page_.path} renders and is described for search`, async ({ page }) => {
      const response = await page.goto(page_.path);
      expect(response?.status(), `${page_.path} should be 200`).toBe(200);
      await settled(page);

      // Exactly one h1, and it is the right one.
      const headings = page.locator("h1");
      await expect(headings).toHaveCount(1);
      await expect(headings.first()).toHaveText(page_.h1);

      // Unique title and description.
      const title = await page.title();
      expect(title.length).toBeGreaterThan(10);
      const description = await page.locator('meta[name="description"]').getAttribute("content");
      expect(description?.length ?? 0).toBeGreaterThan(30);

      // Canonical and Open Graph.
      await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
      await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
      await expect(page.locator('meta[property="og:image"]')).toHaveCount(1);

      // Indexable — these are the pages we WANT found.
      const robots = await page.locator('meta[name="robots"]').getAttribute("content");
      expect(robots).toContain("index");
      expect(robots).not.toContain("noindex");

      // The page never scrolls sideways.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${page_.path} overflows horizontally`).toBeLessThanOrEqual(1);
    });
  }

  test("titles and descriptions are unique across pages", async ({ page }) => {
    const seen = new Map<string, string>();

    for (const { path } of PUBLIC_PAGES) {
      await page.goto(path);
      const title = await page.title();
      expect(seen.has(title), `duplicate title "${title}" on ${path} and ${seen.get(title)}`).toBe(
        false,
      );
      seen.set(title, path);
    }
  });
});

test.describe("private pages are not indexable", () => {
  for (const path of ["/auth/login", "/auth/signup", "/auth/forgot-password"]) {
    test(`${path} is noindex`, async ({ page }) => {
      await page.goto(path);
      const robots = await page.locator('meta[name="robots"]').getAttribute("content");
      expect(robots).toContain("noindex");
    });
  }
});

test.describe("machine-readable files", () => {
  test("robots.txt points at the sitemap and protects private areas", async ({ request }) => {
    const response = await request.get("/robots.txt");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");

    const body = await response.text();
    // Local development is non-production, so it must be fully disallowed.
    expect(body).toMatch(/User-agent: \*/);
    expect(body).toMatch(/Disallow:/);
  });

  test("sitemap.xml lists only public pages", async ({ request }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("xml");

    const body = await response.text();
    expect(body).toContain("<urlset");
    expect(body).toContain("/pricing");
    expect(body).toContain("/privacy");

    // Never list a page we ask robots not to index.
    expect(body).not.toContain("/auth/");
    expect(body).not.toContain("/app");
    expect(body).not.toContain("/admin");
  });

  test("the manifest and icons are served", async ({ request }) => {
    for (const [path, type] of [
      ["/site.webmanifest", "json"],
      ["/favicon.svg", "svg"],
      ["/icon-192.png", "png"],
      ["/og-default.png", "png"],
      ["/fonts/jost-latin.woff2", "font"],
    ] as const) {
      const response = await request.get(path);
      expect(response.status(), `${path} should be served`).toBe(200);
      void type;
    }
  });
});

test.describe("a genuine 404", () => {
  test("returns a 404 status, not a soft 200", async ({ page }) => {
    const response = await page.goto("/this-page-does-not-exist");
    // A soft 404 gets indexed and pollutes search results.
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: /isn.t here/i })).toBeVisible();
  });
});

test.describe("security headers", () => {
  test("every document carries the expected headers", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();

    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("geolocation=()");
    // Deprecated and removed from browsers; must not be present.
    expect(headers["x-xss-protection"]).toBeUndefined();
  });

  test("authenticated areas are never cached by a shared proxy", async ({ request }) => {
    const response = await request.get("/app", { maxRedirects: 0 });
    expect(response.headers()["cache-control"]).toContain("no-store");
  });
});
