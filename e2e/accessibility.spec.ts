import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { settled, signUpAndVerify, uniqueEmail } from "./support";

/**
 * Accessibility and mobile.
 *
 * axe-core catches the machine-checkable failures — contrast, labels, roles,
 * landmarks. The hand-written tests below cover what a scanner cannot see:
 * whether the page can actually be operated with a keyboard, whether errors
 * are announced, and whether meaning survives without colour.
 *
 * Scoped to WCAG 2.1 A and AA, which is the level the brief's requirements
 * describe.
 */
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const PAGES = [
  "/",
  "/examples",
  "/how-it-works",
  "/pricing",
  "/faq",
  "/contact",
  "/security",
  "/terms",
  "/auth/login",
  "/auth/signup",
];

test.describe("automated accessibility", () => {
  for (const path of PAGES) {
    test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
      await page.goto(path);
      await settled(page);

      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();

      // Report the actual problems rather than just a count.
      const summary = results.violations.map(
        (v) =>
          `${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s)\n    ${v.nodes[0]?.html?.slice(0, 120)}`,
      );
      expect(summary, `${path}:\n  ${summary.join("\n  ")}`).toEqual([]);
    });
  }

  test("the signed-in dashboard has no violations", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("a11y"));
    for (const path of ["/app", "/app/credits", "/app/redeem", "/app/profile", "/app/sessions"]) {
      await page.goto(path);
      await settled(page);
      const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
      const summary = results.violations.map((v) => `${v.id}: ${v.help}`);
      expect(summary, `${path}: ${summary.join(", ")}`).toEqual([]);
    }
  });
});

test.describe("keyboard operation", () => {
  test("the skip link is the first stop and jumps to the content", async ({ page }) => {
    await page.goto("/");
    await settled(page);

    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(focused).toBe("Skip to content");

    await page.keyboard.press("Enter");
    expect(page.url()).toContain("#main");
  });

  test("the whole signup form can be completed without a mouse", async ({ page }) => {
    await page.goto("/auth/signup");
    await settled(page);

    /*
     * Tab to each field in turn and type — no clicking anywhere.
     *
     * How many stops precede the form is a layout detail, not the thing under
     * test: the narrow layout collapses the aside and puts a focusable mark
     * above the form, so a hard-coded count passes on desktop and fails on a
     * phone for a page that is perfectly operable. Tab until the first field
     * has focus, then assert the order of the fields themselves.
     */
    await tabTo(page, '[name="name"]');
    await page.keyboard.type("Keyboard User");
    await page.keyboard.press("Tab");
    await page.keyboard.type(uniqueEmail("keyboard"));
    await page.keyboard.press("Tab");
    await page.keyboard.type("a-perfectly-fine-passphrase-1");

    const values = await page.evaluate(() => {
      const form = document.querySelector("form")!;
      return {
        name: (form.querySelector('[name="name"]') as HTMLInputElement).value,
        email: (form.querySelector('[name="email"]') as HTMLInputElement).value,
        password: (form.querySelector('[name="password"]') as HTMLInputElement).value.length,
      };
    });

    expect(values.name).toBe("Keyboard User");
    expect(values.email).toContain("@example.test");
    expect(values.password).toBeGreaterThan(10);
  });

  test("every interactive element shows a visible focus ring", async ({ page }) => {
    await page.goto("/");
    await settled(page);

    const invisible: string[] = [];
    const count = Math.min(await page.locator("a, button").count(), 20);

    for (let index = 0; index < count; index++) {
      const element = page.locator("a, button").nth(index);
      if (!(await element.isVisible())) continue;
      await element.focus();

      const style = await element.evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          outlineWidth: s.outlineStyle === "none" ? "0px" : s.outlineWidth,
          boxShadow: s.boxShadow,
        };
      });

      if (style.outlineWidth === "0px" && style.boxShadow === "none") {
        invisible.push((await element.textContent())?.trim().slice(0, 30) ?? `#${index}`);
      }
    }

    expect(invisible, `no visible focus on: ${invisible.join(", ")}`).toEqual([]);
  });

  test("the FAQ accordion opens with the keyboard", async ({ page }) => {
    await page.goto("/faq");
    await settled(page);

    const first = page.locator("details").first();
    await first.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(first).toHaveAttribute("open", "");
  });
});

test.describe("meaning does not depend on colour", () => {
  test("status pills always carry a word", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("pills"));
    await page.goto("/app");
    await settled(page);

    const pills = page.locator(".pill");
    const count = await pills.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index++) {
      const text = (await pills.nth(index).textContent())?.trim() ?? "";
      expect(text.length, "a status pill must carry text, not just colour").toBeGreaterThan(1);
    }
  });

  test("form errors are announced, not just coloured", async ({ page }) => {
    await page.goto("/auth/login");
    await settled(page);

    await page.getByLabel("Email address").fill("nobody@example.test");
    await page.getByLabel("Password").fill("wrong-password-here");
    await page.getByRole("button", { name: "Sign in" }).click();

    // role="alert" is what makes a screen reader announce it immediately.
    const alert = page.getByRole("alert").first();
    await expect(alert).toBeVisible({ timeout: 20_000 });
    expect((await alert.textContent())?.trim().length ?? 0).toBeGreaterThan(10);
  });
});

test.describe("reduced motion", () => {
  test("the hero mark does not animate when reduced motion is requested", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/");
    await settled(page);

    const animation = await page
      .locator("svg path.loop-path")
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { name: s.animationName, offset: s.strokeDashoffset };
      });

    // Either no animation at all, or already at its final state.
    expect(animation.name === "none" || animation.offset === "0px").toBe(true);
    await context.close();
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the marketing navigation works on a phone", async ({ page }) => {
    await page.goto("/");
    await settled(page);

    const menu = page.getByRole("button", { name: "Menu" });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("aria-expanded", "false");

    await menu.click();
    await expect(page.getByRole("button", { name: "Close" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // Scoped to the opened menu: "Pricing" also appears in the footer, and an
    // unscoped role query matches both.
    await page.locator("#mobile-nav").getByRole("link", { name: "Pricing" }).click();
    await expect(page).toHaveURL(/\/pricing/);
  });

  test("no page scrolls sideways on a phone", async ({ page }) => {
    for (const path of ["/", "/pricing", "/examples", "/auth/signup", "/faq", "/terms"]) {
      await page.goto(path);
      await settled(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${path} overflows on mobile`).toBeLessThanOrEqual(1);
    }
  });

  test("touch targets are big enough to hit", async ({ page }) => {
    await page.goto("/");
    await settled(page);

    const small: string[] = [];
    const buttons = page.locator("a.btn, button");
    const count = await buttons.count();

    for (let index = 0; index < count; index++) {
      const element = buttons.nth(index);
      if (!(await element.isVisible())) continue;
      const box = await element.boundingBox();
      // 44px is the WCAG 2.1 target-size guidance.
      if (box && box.height < 44) {
        small.push(
          `${(await element.textContent())?.trim().slice(0, 24)} (${Math.round(box.height)}px)`,
        );
      }
    }

    expect(small, `touch targets under 44px: ${small.join(", ")}`).toEqual([]);
  });

  test("the dashboard is usable on a phone", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("mobile"));
    await page.goto("/app");
    await settled(page);

    await expect(page.getByRole("heading", { name: /Welcome back/i })).toBeVisible();
    await page.getByRole("link", { name: "Redeem a code" }).first().click();
    await expect(page).toHaveURL(/\/app\/redeem/);
    await expect(page.getByLabel("Access code")).toBeVisible();
  });
});

/**
 * Press Tab until `selector` holds focus.
 *
 * Bounded, so a form that cannot be reached by keyboard fails the test rather
 * than hanging it.
 */
async function tabTo(page: Page, selector: string, maxPresses = 12): Promise<void> {
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press("Tab");
    const onTarget = await page.evaluate(
      (sel) => document.activeElement === document.querySelector(sel),
      selector,
    );
    if (onTarget) return;
  }
  throw new Error(`"${selector}" was not reachable with ${maxPresses} Tab presses`);
}
