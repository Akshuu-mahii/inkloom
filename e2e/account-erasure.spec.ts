/**
 * Erasing an account, driven through the browser like a real person.
 *
 * The integration suite already proves the mechanics against the database. This
 * exists for the half that cannot be tested from there: that the control is
 * reachable at all, that it takes a password, that the session actually dies in
 * a real browser holding a real cookie, and that the person is bounced out of
 * the dashboard rather than left staring at a page whose loader now 401s.
 *
 * The account is given genuine history first — a redeemed code, so there is a
 * credit ledger entry and an audit trail. That is the entire difficulty of the
 * feature: `DELETE FROM users` cascades onto `audit_events`, which is
 * append-only and refuses, so an account that has actually been used cannot be
 * deleted at all. A test on a fresh account would pass without ever meeting the
 * problem this feature exists to solve.
 */
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { settled, signIn, signUpAndVerify, STRONG_PASSWORD, uniqueEmail } from "./support";

const SEEDED_CODE = "INKLOOMHACKATHON";

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL,
  });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/** Sign up, verify, and redeem the seeded code so the account has real history. */
async function accountWithHistory(page: Page) {
  const email = await signUpAndVerify(page, uniqueEmail("erase"));

  await page.goto("/app/redeem");
  await settled(page);
  await page.getByLabel("Access code").fill(SEEDED_CODE);
  await page.getByRole("button", { name: /Redeem code/ }).click();
  await expect(page.getByText(/in credits added/i)).toBeVisible({ timeout: 20_000 });

  const [row] = await query<{ id: string }>(
    "SELECT id FROM users WHERE normalized_email = $1",
    [email.toLowerCase()],
  );

  const [history] = await query<{ ledger: string; audit: string }>(
    `SELECT (SELECT COUNT(*) FROM credit_ledger WHERE user_id = $1)::text AS ledger,
            (SELECT COUNT(*) FROM audit_events  WHERE actor_id = $1)::text AS audit`,
    [row!.id],
  );

  // If this ever fails the test below is testing the easy case, not the real one.
  expect(Number(history!.ledger), "the account must have ledger history").toBeGreaterThan(0);
  expect(Number(history!.audit), "the account must have audit history").toBeGreaterThan(0);

  return { email, userId: row!.id };
}

async function openEraseForm(page: Page) {
  await page.goto("/app/profile");
  await settled(page);
  await page.getByRole("button", { name: "Erase my account" }).click();
}

// ===========================================================================

test.describe("erasing an account from the dashboard", () => {
  test("a user with real history can erase their account and can never sign in again", async ({
    page,
  }) => {
    const { email, userId } = await accountWithHistory(page);

    await openEraseForm(page);
    await page.getByLabel("Confirm your password").fill(STRONG_PASSWORD);
    await page.getByRole("checkbox", { name: /I understand this permanently/ }).check();
    await page.getByRole("button", { name: /Erase my account permanently/i }).click();

    // Bounced out of the dashboard: the session is gone, so staying would mean
    // rendering a page whose loader can only fail.
    await page.waitForURL(/erased=1/, { timeout: 20_000 });

    // The browser still holds whatever cookie it had. It must now be worthless.
    await page.goto("/app");
    await settled(page);
    await expect(page).toHaveURL(/\/auth\/login/);

    // The old password no longer signs in.
    await signIn(page, email);
    await settled(page);
    await expect(page).not.toHaveURL(/\/app/);

    const [row] = await query<{ status: string; email: string; name: string }>(
      "SELECT status, email, name FROM users WHERE id = $1",
      [userId],
    );
    expect(row!.status).toBe("deleted");
    expect(row!.email).not.toContain(email.split("@")[0]!);
    expect(row!.name).toBe("Deleted account");
  });

  test("the ledger and audit trail survive the person", async ({ page }) => {
    const { userId } = await accountWithHistory(page);

    const [before] = await query<{ ledger: string; audit: string }>(
      `SELECT (SELECT COUNT(*) FROM credit_ledger WHERE user_id = $1)::text AS ledger,
              (SELECT COUNT(*) FROM audit_events  WHERE actor_id = $1)::text AS audit`,
      [userId],
    );

    await openEraseForm(page);
    await page.getByLabel("Confirm your password").fill(STRONG_PASSWORD);
    await page.getByRole("checkbox", { name: /I understand this permanently/ }).check();
    await page.getByRole("button", { name: /Erase my account permanently/i }).click();
    await page.waitForURL(/erased=1/, { timeout: 20_000 });

    const [after] = await query<{ ledger: string; audit: string }>(
      `SELECT (SELECT COUNT(*) FROM credit_ledger WHERE user_id = $1)::text AS ledger,
              (SELECT COUNT(*) FROM audit_events  WHERE actor_id = $1)::text AS audit`,
      [userId],
    );

    expect(after!.ledger, "no ledger row may be removed").toBe(before!.ledger);
    expect(Number(after!.audit), "audit history may only grow").toBeGreaterThanOrEqual(
      Number(before!.audit),
    );

    // And nowhere did erasure quietly create an accounting discrepancy.
    const [drift] = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM credit_wallets w
        WHERE w.balance <> COALESCE(
          (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)`,
    );
    expect(Number(drift!.n)).toBe(0);
  });

  test("the wrong password erases nothing", async ({ page }) => {
    const { userId } = await accountWithHistory(page);

    await openEraseForm(page);
    await page.getByLabel("Confirm your password").fill("not-the-password");
    await page.getByRole("checkbox", { name: /I understand this permanently/ }).check();
    await page.getByRole("button", { name: /Erase my account permanently/i }).click();

    await expect(page.getByText(/could not erase your account/i)).toBeVisible({ timeout: 20_000 });

    // Still signed in, still active — a borrowed laptop cannot do this.
    const [row] = await query<{ status: string }>("SELECT status FROM users WHERE id = $1", [
      userId,
    ]);
    expect(row!.status).toBe("active");

    await page.goto("/app");
    await settled(page);
    await expect(page).toHaveURL(/\/app/);
  });

  test("the form is not one stray click away", async ({ page }) => {
    await signUpAndVerify(page, uniqueEmail("erase-guard"));
    await page.goto("/app/profile");
    await settled(page);

    // Collapsed by default, on the same page as "Export my data" — two buttons
    // a tired person could otherwise confuse.
    await expect(page.getByLabel("Confirm your password")).toBeHidden();
    await expect(page.getByRole("button", { name: "Erase my account" })).toBeVisible();

    await page.getByRole("button", { name: "Erase my account" }).click();
    await expect(page.getByLabel("Confirm your password")).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByLabel("Confirm your password")).toBeHidden();
  });
});
