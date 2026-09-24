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

test.describe("the widget renders but is slow to answer", () => {
  test("a rendered widget is not torn down for being slow", async ({ page }) => {
    /*
     * The bug this pins: the per-attempt timer used to run until a TOKEN
     * arrived, which is a much later event than the widget appearing. An
     * interaction-only widget can take well over the budget to produce one on a
     * cold load, so a perfectly healthy check was torn down and retried three
     * times and then reported unavailable — while a refresh, served from cache,
     * beat the clock and looked fine. "Broken first, fine after refresh" is
     * exactly what that looks like from the outside.
     *
     * Simulated by delaying the challenge fetch that follows the script, so the
     * widget renders promptly and the token does not.
     */
    await page.route("**challenges.cloudflare.com/**", async (route) => {
      if (route.request().url().includes("api.js")) {
        await route.continue();
        return;
      }
      // Everything after the script: slower than one attempt budget.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route.continue();
    });

    await page.goto("/auth/forgot-password");
    await settled(page);

    // It must never reach the failure state while the widget is alive.
    await expect(page.getByRole("button", { name: /Human check unavailable/ })).toHaveCount(0);

    await expect(page.getByRole("button", { name: /Send reset link/ })).toBeEnabled({
      timeout: 45_000,
    });
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

/**
 * The widget comes up, and then Turnstile never says anything again.
 *
 * This is the failure people actually reported, and it is the one shape the
 * suite above never covered: every case there ends with Turnstile answering
 * something — a token, an error, or an aborted request. Here it answers
 * nothing, which is what a challenge that stalls mid-flight looks like, and
 * what an interactive widget looks like to a form that cannot tell the two
 * apart.
 *
 * Turnstile is replaced with a stub for these tests. That is deliberate: the
 * real service cannot be made to stall on demand, and the behaviour under test
 * belongs to OUR component — what it does when the callbacks it is waiting for
 * do not arrive. Reaching a settled, explained, retryable state is the contract;
 * sitting on a disabled "Checking you're human…" forever is the bug.
 */
type StubBehaviour =
  | "silent"
  | "expire-then-silence"
  | "interactive"
  | "interactive-then-answered"
  | "expire-then-refresh"
  | "expire-twice-then-refresh"
  | "break-after-success"
  | "empty-script"
  | "render-throws"
  | "timeout-without-interactive";

/**
 * Serve a fake `api.js` in place of Cloudflare's.
 *
 * It renders something into the container and then behaves as instructed,
 * so each test drives one precise callback sequence.
 */
async function stubTurnstile(page: Page, behaviour: StubBehaviour): Promise<void> {
  await page.route("**challenges.cloudflare.com/**", async (route) => {
    if (!route.request().url().includes("api.js")) {
      await route.abort();
      return;
    }
    const behaviourJson = JSON.stringify(behaviour);
    await route.fulfill({
      contentType: "text/javascript",
      body: `
        var behaviour = ${behaviourJson};
        var self = window;
        self.__stubFields = self.__stubFields || [];
        // remove() and reset() both invalidate the outstanding token.
        self.__stubClear = function () {
          self.__stubFields.forEach(function (f) { if (f) f.value = ''; });
        };
        if (behaviour === 'empty-script') {
          // A blocker that answers 200 with nothing. The script "loads" and
          // leaves no global behind, which is indistinguishable from success
          // until something tries to use it.
        } else {
        window.turnstile = {
          render: function (el, opts) {
            if (behaviour === 'render-throws') { throw new Error('stub render failure'); }
            /*
             * The hidden input is not decoration — it IS the contract.
             *
             * The real widget writes its token into a field named
             * cf-turnstile-response inside its own container, which means the
             * token disappears whenever the widget is torn down. A stub without
             * it cannot exercise the one invariant that matters most: that the
             * submit button is never live over an empty field. The first draft
             * of this stub omitted it and the invariant test reported 62
             * violations against a form that was behaving perfectly.
             */
            el.innerHTML =
              '<div data-stub-widget="1">stub widget</div>' +
              '<input type="hidden" name="cf-turnstile-response" value="">';
            var field = el.querySelector('input[name="cf-turnstile-response"]');
            self.__stubFields.push(field);
            var token = function () {
              var value = 'stub-token-' + Date.now();
              field.value = value;
              opts.callback(value);
            };
            var expire = function () {
              // A spent token is gone from the field, exactly as it is really.
              field.value = '';
              opts['expired-callback'] && opts['expired-callback']();
            };
            if (behaviour === 'expire-then-silence') {
              // A token arrives, and then expires with no replacement ever.
              setTimeout(token, 200);
              setTimeout(expire, 1200);
            } else if (behaviour === 'expire-then-refresh') {
              // The ordinary five-minute expiry, with the auto-refresh working.
              setTimeout(token, 200);
              setTimeout(expire, 1200);
              setTimeout(token, 2200);
            } else if (behaviour === 'expire-twice-then-refresh') {
              setTimeout(token, 200);
              setTimeout(expire, 1000);
              setTimeout(token, 1800);
              setTimeout(expire, 2600);
              setTimeout(token, 3400);
            } else if (behaviour === 'break-after-success') {
              // Verified, and then the widget falls over.
              setTimeout(token, 200);
              setTimeout(function () { opts['error-callback'] && opts['error-callback'](600000); }, 1200);
            } else if (behaviour === 'interactive') {
              // Cloudflare decides a click is needed and says so, then the
              // person does not click and the interactive challenge times out.
              setTimeout(function () {
                opts['before-interactive-callback'] && opts['before-interactive-callback']();
              }, 200);
              setTimeout(function () {
                opts['timeout-callback'] && opts['timeout-callback']();
              }, 1200);
            } else if (behaviour === 'interactive-then-answered') {
              setTimeout(function () {
                opts['before-interactive-callback'] && opts['before-interactive-callback']();
              }, 200);
              setTimeout(function () {
                opts['after-interactive-callback'] && opts['after-interactive-callback']();
              }, 1000);
              setTimeout(token, 1400);
            } else if (behaviour === 'timeout-without-interactive') {
              // A timeout with no interactive prompt before it. There is no box
              // to point at, so the form must not invent one.
              setTimeout(function () {
                opts['timeout-callback'] && opts['timeout-callback']();
              }, 400);
            }
            // 'silent': render, then never call anything back.
            return 'stub-widget-id';
          },
          remove: function () { self.__stubClear(); },
          reset: function () { self.__stubClear(); },
        };
        }
      `,
    });
  });
}

test.describe("the widget renders and then goes quiet", () => {
  test("a stalled check reaches a settled, retryable answer", async ({ page }) => {
    // The ceiling is 60s + one reset + 30s, so the test has to outlast it.
    test.setTimeout(180_000);
    /*
     * The reported bug, reduced: the widget appears, no token ever comes, and
     * nothing else happens. The component cleared its only deadline the moment
     * the widget rendered, so there was nothing left to move it along — the
     * button read "Checking you're human…" indefinitely, with no error shown
     * and no retry offered. Refreshing landed in the same place.
     */
    await stubTurnstile(page, "silent");
    await page.goto("/auth/signup");
    await settled(page);

    // It must not sit on the busy label forever.
    const alert = page.getByRole("alert").filter({ hasText: /human check/i });
    await expect(alert).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: /try the check again/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Checking you're human/ })).toHaveCount(0);
  });

  test("a token that expires and is never replaced is reported", async ({ page }) => {
    test.setTimeout(180_000);
    /*
     * `expired-callback` put the form back to "pending" and there was no longer
     * any deadline or retry path alive to take it anywhere else, so a form that
     * had been perfectly usable became permanently unsendable — and, unlike the
     * case above, AFTER the person had already filled it in.
     */
    await stubTurnstile(page, "expire-then-silence");
    await page.goto("/auth/signup");
    await settled(page);

    // It works first...
    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 30_000,
    });
    // ...then the token expires and never returns. That must be said out loud.
    const alert = page.getByRole("alert").filter({ hasText: /human check/i });
    await expect(alert).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole("button", { name: /try the check again/i })).toBeVisible();
  });

  test("a challenge waiting on a click asks for the click", async ({ page }) => {
    /*
     * Cloudflare's own documentation is explicit that `timeout-callback` means
     * an interactive challenge went unanswered — "user action required" — not
     * that anything is broken. Treating it as a broken widget told the person
     * their ad-blocker was at fault and offered a retry that cannot help,
     * while the working widget sat directly above the message.
     */
    await stubTurnstile(page, "interactive");
    await page.goto("/auth/signup");
    await settled(page);

    // The button must say what is actually wanted...
    await expect(
      page.getByRole("button", { name: /tick the box|complete the check/i }),
    ).toBeVisible({ timeout: 30_000 });
    // ...and must NOT blame the network for a widget that is working.
    await expect(page.getByText(/couldn.t load/i)).toHaveCount(0);
  });
});

/**
 * The rest of the state machine.
 *
 * The three tests above cover the reported bug. These cover everything ELSE the
 * component can be told, because the contract is not "handle the failure we
 * heard about" — it is that every callback sequence Turnstile can produce ends
 * somewhere a person can act on. Each of these is a sequence that reaches a
 * live production form.
 */
test.describe("every sequence Turnstile can send ends somewhere usable", () => {
  /** Fill the signup form so its only remaining gate is the human check. */
  async function fillSignup(page: Page): Promise<void> {
    await page.getByLabel("Your name").fill("State Machine");
    await page.getByLabel("Email address").fill(uniqueEmail("states"));
    await page.getByLabel("Password").fill(STRONG_PASSWORD);
    await page.getByRole("checkbox", { name: /I agree to the/ }).check();
  }

  test("a challenge the person answers unlocks the form", async ({ page }) => {
    /*
     * The path the `interactive` state exists to serve, all the way through:
     * Cloudflare asks, the person answers, `after-interactive-callback` hands
     * the wait back to us, and a token follows. A form that could reach
     * "interactive" but never leave it would be worse than the bug it replaced.
     */
    await stubTurnstile(page, "interactive-then-answered");
    await page.goto("/auth/signup");
    await settled(page);

    await expect(page.getByRole("button", { name: /Complete the check above/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 30_000,
    });
  });

  test("an ordinary expiry recovers on its own, in silence", async ({ page }) => {
    /*
     * `refresh-expired` defaults to auto, so the overwhelmingly common expiry
     * is one Turnstile fixes itself. The person must never see an error for it
     * — the button simply re-locks for a moment and comes back.
     */
    await stubTurnstile(page, "expire-then-refresh");
    await page.goto("/auth/signup");
    await settled(page);

    const submit = page.getByRole("button", { name: /Create account/ });
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    // It goes away...
    await expect(page.getByRole("button", { name: /Checking you're human/ })).toBeVisible({
      timeout: 10_000,
    });
    // ...and comes back, with nothing alarming said along the way.
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByRole("alert").filter({ hasText: /human check/i })).toHaveCount(0);
  });

  test("a form left open long enough to expire twice still sends", async ({ page }) => {
    /*
     * Each stretch of waiting must get its OWN budget. An earlier draft spent
     * the allowance once and then failed instantly on the second expiry, which
     * would punish exactly the careful person who takes their time over a
     * password — the case this whole fix is about.
     */
    await stubTurnstile(page, "expire-twice-then-refresh");
    await page.goto("/auth/signup");
    await settled(page);
    await fillSignup(page);

    const submit = page.getByRole("button", { name: /Create account/ });
    await expect(submit).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(4_000);
    await expect(submit, "still sendable after two expiries").toBeEnabled();
    await expect(page.getByRole("alert").filter({ hasText: /human check/i })).toHaveCount(0);
  });

  test("a widget that breaks after verifying re-gates the button", async ({ page }) => {
    /*
     * The old `settled` latch made a successful attempt permanently immune to
     * failure reporting. A widget that verified and then errored left the
     * button ENABLED over a token that was no longer trustworthy, which is the
     * one direction this component must never fail in.
     *
     * The stub breaks on every attempt, so the settled end state is the one
     * asserted here — the intermediate verified/broken cycling is real
     * behaviour but not something to race against.
     */
    await stubTurnstile(page, "break-after-success");
    await page.goto("/auth/signup");
    await settled(page);

    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.getByRole("alert").filter({ hasText: /human check/i })).toBeVisible({
      timeout: 60_000,
    });
    // Scoped to the account form: "Continue with Google" is also a submit
    // button, and is nothing to do with the human check.
    await expect(page.getByRole("button", { name: /Human check unavailable/ })).toBeDisabled();
  });

  test("a timeout with no challenge behind it does not invent one", async ({ page }) => {
    /*
     * `timeout-callback` is only "your turn" if we were told the challenge was
     * interactive. Without that, telling somebody to complete a check that was
     * never drawn sends them looking for a box that does not exist.
     */
    await stubTurnstile(page, "timeout-without-interactive");
    await page.goto("/auth/signup");
    await settled(page);
    await page.waitForTimeout(3_000);

    await expect(page.getByRole("button", { name: /Complete the check above/ })).toHaveCount(0);
    // The account form's own button, not Google's — both are submit buttons.
    await expect(page.locator("form button.btn-primary")).toBeDisabled();
  });

  test("a script that loads but leaves nothing behind is reported", async ({ page }) => {
    /*
     * What a filter answering 200 with an empty body looks like: `load` fires,
     * so the absence of an `error` event proves nothing, and `window.turnstile`
     * is simply not there.
     */
    await stubTurnstile(page, "empty-script");
    await page.goto("/auth/signup");
    await settled(page);

    await expect(page.getByRole("alert").filter({ hasText: /human check/i })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole("button", { name: /try the check again/i })).toBeVisible();
  });

  test("a widget whose render throws is reported, not swallowed", async ({ page }) => {
    await stubTurnstile(page, "render-throws");
    await page.goto("/auth/signup");
    await settled(page);

    await expect(page.getByRole("alert").filter({ hasText: /human check/i })).toBeVisible({
      timeout: 60_000,
    });
  });

  test("navigating away mid-check does not break the next page", async ({ page }) => {
    /*
     * The component tears down timers and the widget on unmount. If that
     * cleanup were wrong, the damage would land on a LATER page — a stale timer
     * reporting failure into a form that is doing fine — which is the sort of
     * thing that only ever reproduces in production.
     */
    await stubTurnstile(page, "silent");
    await page.goto("/auth/signup");
    await settled(page);

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page
      .getByRole("link", { name: /Sign in/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/auth\/login/);
    await page.waitForTimeout(2_000);
    expect(errors, "unmount must not throw").toEqual([]);
  });

  test("the password reset form gets the same treatment", async ({ page }) => {
    await stubTurnstile(page, "interactive");
    await page.goto("/auth/forgot-password");
    await settled(page);

    await expect(page.getByRole("button", { name: /Complete the check above/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/couldn.t load/i)).toHaveCount(0);
  });

  test("the contact form gets the same treatment", async ({ page }) => {
    await stubTurnstile(page, "interactive");
    await page.goto("/contact");
    await settled(page);

    await expect(page.getByRole("button", { name: /Complete the check above/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/couldn.t load/i)).toHaveCount(0);
  });

  test("a verified check actually sends, end to end", async ({ page }) => {
    /*
     * The one that matters most: with the real Turnstile, a real signup must
     * still complete. Every test above stubs the service, so without this the
     * suite could be green over a component that no longer works at all.
     */
    await page.goto("/auth/signup");
    await settled(page);
    await fillSignup(page);

    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 45_000,
    });
    await page.getByRole("button", { name: /Create account/ }).click();
    await expect(page).toHaveURL(/\/auth\/check-email/, { timeout: 30_000 });
  });
});

test.describe("the button is never live over an empty token", () => {
  /**
   * The one invariant that matters more than any particular state.
   *
   * Everything else in this file is about reaching a settled answer. This is
   * about never reaching a WRONG one: an enabled submit button with no token
   * behind it sends the person into a guaranteed refusal that reads as an
   * accusation, which is the failure mode the whole component was built around.
   *
   * Sampled continuously rather than checked at the end, because the dangerous
   * window is a transient one — it opens while a widget is being torn down and
   * rebuilt, and closes again a moment later.
   */
  async function watchForLiveButtonWithoutToken(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as unknown as { __violations?: string[] };
      w.__violations = [];
      setInterval(() => {
        const button = document.querySelector(
          "form button.btn-primary",
        ) as HTMLButtonElement | null;
        const token = document.querySelector(
          '[name="cf-turnstile-response"]',
        ) as HTMLInputElement | null;
        if (button && !button.disabled && !(token?.value ?? "")) {
          w.__violations!.push(`${Date.now()}: "${button.innerText.trim()}" enabled, token empty`);
        }
      }, 50);
    });
  }

  const violations = (page: Page) =>
    page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);

  test("holds while a verified widget breaks and is rebuilt", async ({ page }) => {
    await stubTurnstile(page, "break-after-success");
    await page.goto("/auth/signup");
    await settled(page);
    await watchForLiveButtonWithoutToken(page);

    await expect(page.getByRole("alert").filter({ hasText: /human check/i })).toBeVisible({
      timeout: 60_000,
    });
    expect(await violations(page)).toEqual([]);
  });

  test("holds across an expiry and its refresh", async ({ page }) => {
    await stubTurnstile(page, "expire-twice-then-refresh");
    await page.goto("/auth/signup");
    await settled(page);
    await watchForLiveButtonWithoutToken(page);

    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 30_000,
    });
    await page.waitForTimeout(5_000);
    expect(await violations(page)).toEqual([]);
  });

  test("holds against the real Turnstile", async ({ page }) => {
    await page.goto("/auth/signup");
    await settled(page);
    await watchForLiveButtonWithoutToken(page);

    await expect(page.getByRole("button", { name: /Create account/ })).toBeEnabled({
      timeout: 45_000,
    });
    await page.waitForTimeout(3_000);
    expect(await violations(page)).toEqual([]);
  });
});
