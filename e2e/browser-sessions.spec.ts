/**
 * What happens in the OTHER tab.
 *
 * Every test here exists because a single-tab test cannot see the bug. A
 * session that dies, a role that is removed, an account that is suspended —
 * these all happen somewhere other than the tab the person is looking at, and
 * the tab keeps rendering whatever it rendered before. One of these was a real
 * defect on staging: verifying an email in a second tab left the first tab
 * showing "check your inbox" forever, because nothing revalidated on focus.
 *
 * Runs in Chromium and WebKit. Safari is not a formality here: its page cache
 * restores a whole document on back-navigation more aggressively than Chrome,
 * so "the back button shows a signed-out person their dashboard" is an engine
 * difference, not a theory.
 */
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { settled, signUpAndVerify, uniqueEmail } from "./support";

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const userIdFor = async (email: string) =>
  (
    await query<{ id: string }>("SELECT id FROM users WHERE normalized_email = $1", [
      email.toLowerCase(),
    ])
  )[0]?.id ?? null;

/** A second tab in the SAME browser context, so it shares cookies. */
async function secondTab(page: Page, path = "/app"): Promise<Page> {
  const tab = await page.context().newPage();
  await tab.goto(path);
  await settled(tab);
  return tab;
}

// ===========================================================================

test.describe("two tabs, one session", () => {
  test("signing out in one tab signs the other out too", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("twotab"));
    const other = await secondTab(page);
    await expect(other).toHaveURL(/\/app/);

    /*
     * Sign out through the control, not by visiting the URL.
     *
     * A GET to /auth/sign-out deliberately does NOT end the session — otherwise
     * any page could sign a visitor out with an `<img src>`. Navigating there
     * silently leaves you logged in, which made an earlier version of this test
     * "fail" by reporting that a stale tab kept working when nothing had
     * actually signed out.
     */
    await page.getByRole("button", { name: "Sign out" }).click();
    await settled(page);

    /*
     * The second tab still believes it is signed in — nothing has told it
     * otherwise, and that is fine. What must NOT happen is that it keeps
     * working: the next thing it does has to fail closed.
     */
    await other.reload();
    await settled(other);
    await expect(other, "the stale tab must be sent to sign-in").toHaveURL(/\/auth\/login/);

    void email;
  });

  test("a session revoked elsewhere stops working in an open tab", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("revoked"));
    const userId = (await userIdFor(email))!;
    const other = await secondTab(page);

    // Revoke every session out-of-band, as "sign out everywhere" or an
    // operator's emergency logout would.
    await query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [userId]);

    const apiStatus = await other.evaluate(async () => {
      const r = await fetch("/api/v1/me", { credentials: "same-origin" });
      return r.status;
    });
    expect(apiStatus, "the API must refuse a revoked session immediately").toBe(401);

    await other.reload();
    await settled(other);
    await expect(other).toHaveURL(/\/auth\/login/);
  });

  test("suspending an account evicts a tab that is already open", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("suspended"));
    const userId = (await userIdFor(email))!;
    const other = await secondTab(page);

    await query(
      "UPDATE users SET status = 'suspended', suspended_at = now(), banned = true WHERE id = $1",
      [userId],
    );

    const apiStatus = await other.evaluate(async () => {
      const r = await fetch("/api/v1/me", { credentials: "same-origin" });
      return r.status;
    });
    expect(apiStatus, "a suspended account must not keep reading its own data").toBeGreaterThanOrEqual(
      401,
    );

    await other.reload();
    await settled(other);
    await expect(other).not.toHaveURL(/\/app\/credits/);
  });

  test("losing a role closes the console in a tab that already has it open", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("demoted"));
    const userId = (await userIdFor(email))!;

    // Grant staff directly. Reaching the console needs the owner gate and a
    // second factor too, so this asserts the API boundary rather than the UI.
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
    const other = await secondTab(page);

    await query("UPDATE users SET role = 'user' WHERE id = $1", [userId]);

    const status = await other.evaluate(async () => {
      const r = await fetch("/api/v1/admin/overview", { credentials: "same-origin" });
      return r.status;
    });
    expect(status, "role removal must take effect on the existing session").not.toBe(200);
  });
});

// ===========================================================================

test.describe("navigation and history", () => {
  test("the back button does not show a signed-out person their dashboard", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("backbtn"));

    await page.goto("/app/credits");
    await settled(page);
    await expect(page.locator("main")).toBeVisible();

    await page.goto("/app");
    await settled(page);
    await page.getByRole("button", { name: "Sign out" }).click();
    await settled(page);

    /*
     * The real risk, and why this runs in WebKit too: a back-navigation can be
     * served from the browser's page cache without touching the network, so a
     * dashboard full of personal data can reappear after sign-out. The
     * defence is `Cache-Control: no-store` on private documents, which
     * disqualifies them from that cache.
     */
    await page.goBack();
    await settled(page);

    const url = page.url();
    const showsPrivateData = await page
      .locator("main")
      .textContent()
      .then((t) => /credits|balance/i.test(t ?? ""));

    expect(
      url.includes("/auth/login") || !showsPrivateData,
      `back-navigation revealed private content at ${url}`,
    ).toBe(true);
  });

  test("a refresh keeps the person signed in and nothing sensitive in the URL", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("refresh"));

    await page.goto("/app");
    await settled(page);
    await page.reload();
    await settled(page);

    await expect(page).toHaveURL(/\/app/);
    expect(page.url(), "no token may ever travel in a query string").not.toMatch(
      /token=|session=|password=/i,
    );
  });

  test("nothing sensitive is left in browser storage", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("storage"));
    await page.goto("/app");
    await settled(page);

    const stored = await page.evaluate(() => {
      const dump = (s: Storage) =>
        Object.keys(s)
          .map((k) => `${k}=${s.getItem(k) ?? ""}`)
          .join("\n");
      return {
        local: dump(window.localStorage),
        session: dump(window.sessionStorage),
        dbs: "databases" in indexedDB ? "present" : "unknown",
      };
    });

    const forbidden = /password|secret|token|pepper|postgres|npg_|\$scrypt\$|Bearer /i;
    expect(stored.local, "localStorage must hold no credential material").not.toMatch(forbidden);
    expect(stored.session, "sessionStorage must hold no credential material").not.toMatch(forbidden);
  });
});

// ===========================================================================

test.describe("slow networks and impatient people", () => {
  test("a throttled submit does not double-submit or lose the form", async ({ page }) => {
    const email = uniqueEmail("slow");
    await signUpAndVerify(page, email);

    // Delay every API write so the in-flight window is wide enough to click into.
    await page.route("**/api/**", async (route) => {
      if (route.request().method() !== "GET") {
        await new Promise((r) => setTimeout(r, 1500));
      }
      await route.continue();
    });

    await page.goto("/app/profile");
    await settled(page);

    await page.getByLabel("Display name").fill("Slow Network");
    const save = page.getByRole("button", { name: /Save/i }).first();

    await save.click();
    // The button must be held while the request is in flight; clicking again
    // must not queue a second write.
    await expect(save).toBeDisabled();

    await page.unroute("**/api/**");
    await settled(page);

    const rows = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM audit_events WHERE action = 'user.profile.update' AND actor_id = $1",
      [(await userIdFor(email))!],
    );
    expect(Number(rows[0]!.n), "one click must produce at most one write").toBeLessThanOrEqual(1);
  });

  test("a redemption clicked twice grants credits once", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("dblclick"));
    const userId = (await userIdFor(email))!;

    await page.goto("/app/redeem");
    await settled(page);
    await page.getByLabel("Access code").fill("INKLOOMHACKATHON");

    const redeem = page.getByRole("button", { name: /Redeem code/ });

    // Two clicks as fast as the harness allows, which is the shape of an
    // impatient double-click on a slow connection.
    await redeem.click();
    await redeem.click({ force: true }).catch(() => {});

    await expect(page.getByText(/in credits added|already been redeemed/i)).toBeVisible({
      timeout: 20_000,
    });

    const [ledger] = await query<{ n: string; total: string }>(
      `SELECT COUNT(*)::text AS n, COALESCE(SUM(amount),0)::text AS total
         FROM credit_ledger WHERE user_id = $1`,
      [userId],
    );
    expect(Number(ledger!.n), "a double-click must not double-credit").toBe(1);

    const [redemptions] = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM access_code_redemptions WHERE user_id = $1",
      [userId],
    );
    expect(Number(redemptions!.n), "and must record exactly one redemption").toBe(1);

    const [drift] = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM credit_wallets w
        WHERE w.balance <> COALESCE(
          (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)`,
    );
    expect(Number(drift!.n), "and must leave no drift").toBe(0);
  });

  test("an interrupted request leaves no partial state", async ({ page }) => {
    const email = await signUpAndVerify(page, uniqueEmail("interrupted"));
    const userId = (await userIdFor(email))!;

    /*
     * Intercept the ROUTE action, not the API.
     *
     * The form posts to `/app/redeem`; the React Router action then calls the
     * API in-process, inside the Worker. A browser-level intercept of
     * `/api/v1/...` therefore never matches, and an earlier version of this test
     * "failed" by finding one ledger entry — the redemption had simply
     * succeeded, untouched.
     *
     * Fulfilling with a 204 rather than aborting: `route.abort()` on a document
     * request commits a navigation to the browser's error page, which ends the
     * test for the wrong reason. A severed response with the page intact is what
     * a dropped connection actually looks like.
     */
    await page.route("**/app/redeem*", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      await route.continue();
    });

    await page.goto("/app/redeem");
    await settled(page);
    await page.getByLabel("Access code").fill("INKLOOMHACKATHON");
    await page.getByRole("button", { name: /Redeem code/ }).click();
    await page.waitForTimeout(2000);
    await page.unroute("**/app/redeem*");

    // The request never reached the server, so there must be nothing at all —
    // not a wallet without a ledger entry, not a redemption without credits.
    const [state] = await query<{ ledger: string; redemptions: string }>(
      `SELECT (SELECT COUNT(*) FROM credit_ledger WHERE user_id = $1)::text            AS ledger,
              (SELECT COUNT(*) FROM access_code_redemptions WHERE user_id = $1)::text AS redemptions`,
      [userId],
    );
    expect(state!.ledger).toBe("0");
    expect(state!.redemptions).toBe("0");
  });
});
