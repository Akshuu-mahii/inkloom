/**
 * Erasing an account that has real history.
 *
 * Erasure is an OPERATOR action now. There is no button and no endpoint: the
 * self-service form and `DELETE /v1/me` were removed, and /privacy says what it
 * has always said — write and ask, and we will do it. So these drive
 * `anonymiseAccount` directly, which is what `pnpm account:erase` calls.
 *
 * The easy version of this test uses a fresh account that has done nothing, and
 * proves nothing: a user with no audit trail and no ledger entries can simply be
 * deleted, and the hard part never comes up. The hard part is that
 * `DELETE FROM users` cascades `SET NULL` onto `audit_events.actor_id`, which
 * the append-only trigger rejects — so an account that has actually been USED
 * cannot be removed at all. That was a live defect, found when a verification
 * script could not clean up after itself.
 *
 * So every account here first accumulates the things that make erasure hard:
 * ledger entries, audit rows, a support ticket, security events, a second
 * factor, a live session. Then it is erased, and the two halves are checked
 * separately —
 *
 *   the person is gone:      no address, no name, no credentials, no sessions,
 *                            no way to authenticate ever again
 *   the record is intact:    ledger balances, ledger rows unchanged and still
 *                            immutable, audit history complete
 *
 * Neither half is worth anything without the other. Destroying the ledger would
 * satisfy "erased" and lose the accounting record; leaving the address in place
 * would satisfy "intact" and fail the person who asked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { anonymiseAccount } from "@inkloom/core/privacy";
import { createTestApp, extractToken, type TestApp } from "../../../../../tests/helpers/app";

let app: TestApp;

beforeAll(() => {
  app = createTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.reset();
});

const ACCOUNT = {
  email: "ada@example.test",
  password: "a-perfectly-fine-passphrase-1",
  name: "Ada Lovelace",
  acceptedTerms: true as const,
};

async function signupAndVerify(email = ACCOUNT.email) {
  await app.json("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ ...ACCOUNT, email }),
  });
  const verified = await app.json("/v1/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token: extractToken(app.mail.lastTo(email)!.html) }),
  });
  return verified.cookies;
}

const userIdFor = async (email: string) => {
  const r = await app.db.db.execute<{ id: string }>(
    sql`SELECT id FROM users WHERE normalized_email = ${email.toLowerCase()}`,
  );
  return r.rows[0]?.id ?? null;
};

/**
 * Give an account the history that makes it undeletable.
 *
 * Deliberately uses the real paths — a real ledger entry through the credit
 * service, a real support ticket through the API — rather than inserting rows,
 * so the test exercises the same shapes production produces.
 */
async function buildHistory(email: string, cookies: string[]) {
  const userId = (await userIdFor(email))!;

  await app.services.credits.adminAdjust({
    userId,
    amount: 25,
    reason: "Test grant, so this account has a ledger and an audit trail",
    adminId: userId,
    idempotencyKey: `erasure-fixture-${userId}`,
  });

  const ticket = await app.json("/v1/support", {
    method: "POST",
    cookies,
    body: JSON.stringify({
      email,
      name: "Ada Lovelace",
      category: "billing",
      subject: "A question about my credits",
      message: `My name is Ada and my address is ${email}.`,
    }),
  });
  // The fixture is only useful if it actually produced a ticket: an earlier
  // version silently 400'd on a missing `email`, leaving nothing to scrub and
  // a scrub assertion that passed against a table with no rows in it.
  expect(ticket.status, "the support fixture must create a real ticket").toBe(200);

  // A profile, which is separate personal data.
  await app.json("/v1/me", {
    method: "PATCH",
    cookies,
    body: JSON.stringify({ company: "Analytical Engines Ltd", name: "Ada Lovelace" }),
  });

  return userId;
}

/** What `pnpm account:erase --apply` runs, with the same actor attribution. */
const erase = (userId: string) =>
  anonymiseAccount(app.db.db, app.services.audit, app.services.logger, {
    userId,
    actorType: "admin",
    actorId: null,
    reason: "Erasure requested by the account holder",
  });

/**
 * Assert that a statement was refused by the append-only trigger.
 *
 * Not `rejects.toThrow(/append-only/)`: Drizzle wraps the driver error in a
 * `DrizzleQueryError` whose own message is only "Failed query: ...". The
 * database's actual complaint — and the SQLSTATE — live on `.cause`, so a
 * naive matcher passes for ANY failed query, including a typo, and would
 * happily report a missing trigger as present.
 */
async function expectAppendOnlyRefusal(run: Promise<unknown>) {
  let thrown: unknown;
  try {
    await run;
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "the statement must be refused").toBeDefined();
  const chain = [thrown, (thrown as { cause?: unknown })?.cause]
    .map((e) => (e instanceof Error ? e.message : String(e ?? "")))
    .join(" | ");
  expect(chain).toMatch(/append-only/i);
}

const scalar = async (q: ReturnType<typeof sql>) => {
  const r = await app.db.db.execute<Record<string, string>>(q);
  return r.rows[0] ?? {};
};

// ===========================================================================

describe("erasing an account that has audit and ledger history", () => {
  it("succeeds where DELETE would fail", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);

    // Establish that this account genuinely cannot be deleted the naive way —
    // otherwise the rest of this file is testing an easier problem than the
    // real one.
    const auditRows = await scalar(
      sql`SELECT COUNT(*)::text AS n FROM audit_events WHERE actor_id = ${userId}`,
    );
    expect(Number(auditRows.n), "the fixture must have audit history").toBeGreaterThan(0);

    await expectAppendOnlyRefusal(app.db.db.execute(sql`DELETE FROM users WHERE id = ${userId}`));

    const result = await erase(userId);
    expect(result.userId, "erasure must succeed where deletion cannot").toBe(userId);
    expect(result.anonymizedAt).toBeInstanceOf(Date);
  });

  it("leaves nothing that identifies the person", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await erase(userId);

    const row = await scalar(sql`
      SELECT name, email, normalized_email, status, image::text AS image,
             last_login_ip_hash, anonymized_at::text AS anonymized_at,
             email_verified::text AS email_verified
        FROM users WHERE id = ${userId}
    `);

    expect(row.email).toBe(`deleted-${userId}@deleted.invalid`);
    // lower(email), so the ULID is case-folded too — still unique, since
    // lowercasing is injective over a fixed set of ids.
    expect(row.normalized_email, "the generated column must follow").toBe(
      `deleted-${userId}@deleted.invalid`.toLowerCase(),
    );
    expect(row.name).toBe("Deleted account");
    expect(row.status).toBe("deleted");
    expect(row.image).toBeNull();
    expect(row.last_login_ip_hash).toBeNull();
    expect(row.email_verified).toBe("false");
    expect(row.anonymized_at).not.toBeNull();
  });

  it("scrubs the address out of every table that held it", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await erase(userId);

    /*
     * The address, hunted across every table that can hold one — including the
     * ones easy to forget. `rate_limit_events.subject` literally stores
     * `email:someone@example.com`, and a support ticket holds whatever the
     * person typed, which here is their own name and address.
     */
    const found = await scalar(sql`
      SELECT
        (SELECT COUNT(*) FROM users             WHERE normalized_email = ${ACCOUNT.email})      AS u,
        (SELECT COUNT(*) FROM support_requests  WHERE email = ${ACCOUNT.email}
                                                   OR message ILIKE ${"%" + ACCOUNT.email + "%"}) AS s,
        (SELECT COUNT(*) FROM security_events   WHERE target_email = ${ACCOUNT.email})          AS sec,
        (SELECT COUNT(*) FROM email_events      WHERE to_email = ${ACCOUNT.email})              AS e,
        (SELECT COUNT(*) FROM rate_limit_events WHERE subject = ${"email:" + ACCOUNT.email})    AS r,
        (SELECT COUNT(*) FROM profiles p JOIN users us ON us.id = p.user_id
                                                WHERE us.anonymized_at IS NOT NULL)             AS p
    `);

    expect(Object.entries(found).filter(([, v]) => Number(v) !== 0)).toEqual([]);
  });

  it("destroys every means of authenticating, for good", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await erase(userId);

    const left = await scalar(sql`
      SELECT
        (SELECT COUNT(*) FROM accounts            WHERE user_id = ${userId}) AS credentials,
        (SELECT COUNT(*) FROM sessions            WHERE user_id = ${userId}) AS sessions,
        (SELECT COUNT(*) FROM two_factor          WHERE user_id = ${userId}) AS two_factor,
        (SELECT COUNT(*) FROM verification_tokens WHERE value = ${userId})   AS tokens
    `);
    expect(Object.entries(left).filter(([, v]) => Number(v) !== 0)).toEqual([]);

    // The old session cookie is now a credential for nothing.
    const replayed = await app.json("/v1/me", { cookies });
    expect(replayed.status, "a live session must stop working immediately").toBe(401);

    // The original password no longer signs in.
    const login = await app.json("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ACCOUNT.email, password: ACCOUNT.password }),
    });
    expect(login.status).toBe(401);

    /*
     * And a reset cannot resurrect it.
     *
     * The mailbox is cleared first: this account was sent a verification link
     * at signup, and `lastTo` would happily return THAT message and make a
     * silent failure look like a pass.
     */
    app.mail.clear();
    const reset = await app.json("/v1/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: ACCOUNT.email }),
    });
    expect(reset.status, "still the neutral response, so nothing is enumerable").toBe(200);
    expect(app.mail.sent, "no mail at all for an erased address").toHaveLength(0);
  });

  it("frees the address for a genuinely new account", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await erase(userId);

    // Someone erasing an account and later changing their mind must not find
    // their own address permanently unusable — the tombstone holds a different
    // address precisely so the unique index no longer blocks this.
    const again = await app.json("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify(ACCOUNT),
    });
    expect(again.status, "the address must be reusable").toBe(200);

    const rows = await scalar(
      sql`SELECT COUNT(*)::text AS n FROM users WHERE normalized_email = ${ACCOUNT.email}`,
    );
    expect(Number(rows.n), "and belongs to exactly one live account").toBe(1);
  });
});

// ===========================================================================

describe("the record survives the person", () => {
  it("keeps the ledger balanced, unchanged and still immutable", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);

    const before = await scalar(sql`
      SELECT COUNT(*)::text AS rows, COALESCE(SUM(amount),0)::text AS total
        FROM credit_ledger WHERE user_id = ${userId}
    `);
    expect(Number(before.rows)).toBeGreaterThan(0);

    await erase(userId);

    const after = await scalar(sql`
      SELECT COUNT(*)::text AS rows, COALESCE(SUM(amount),0)::text AS total
        FROM credit_ledger WHERE user_id = ${userId}
    `);
    expect(after.rows, "no ledger row may be removed").toBe(before.rows);
    expect(after.total, "no ledger amount may change").toBe(before.total);

    // The wallet is the running total of the ledger. Zeroing it on erasure
    // would manufacture exactly the drift the reconciliation job hunts for.
    const drift = await scalar(sql`
      SELECT COUNT(*)::text AS n FROM credit_wallets w
       WHERE w.balance <> COALESCE(
         (SELECT SUM(amount) FROM credit_ledger l WHERE l.user_id = w.user_id), 0)
    `);
    expect(Number(drift.n), "erasure must not create ledger drift").toBe(0);

    // And the protection is still armed afterwards — erasure must not have
    // disabled a trigger to get its work done.
    await expectAppendOnlyRefusal(
      app.db.db.execute(sql`UPDATE credit_ledger SET amount = 0 WHERE user_id = ${userId}`),
    );
  });

  it("keeps the audit trail complete and still immutable", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);

    const before = await scalar(
      sql`SELECT COUNT(*)::text AS n FROM audit_events WHERE actor_id = ${userId}`,
    );

    await erase(userId);

    const after = await scalar(
      sql`SELECT COUNT(*)::text AS n FROM audit_events WHERE actor_id = ${userId}`,
    );
    expect(Number(after.n), "history may only grow").toBeGreaterThanOrEqual(Number(before.n));

    await expectAppendOnlyRefusal(
      app.db.db.execute(sql`UPDATE audit_events SET reason = 'x' WHERE actor_id = ${userId}`),
    );
  });

  it("records the erasure itself, without writing the address into it", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await erase(userId);

    const entry = await scalar(sql`
      SELECT action, target_id, reason, metadata::text AS metadata
        FROM audit_events
       WHERE action = 'user.account.erased' AND target_id = ${userId}
    `);

    expect(entry.action).toBe("user.account.erased");
    expect(entry.target_id).toBe(userId);

    /*
     * The audit row names the opaque id and NOT the address. Writing the old
     * email here would put the identity straight back into the one table that
     * can never be rewritten — an erasure that defeats itself.
     */
    expect(`${entry.reason} ${entry.metadata}`).not.toContain(ACCOUNT.email);
    expect(`${entry.reason} ${entry.metadata}`).not.toContain("Ada Lovelace");
  });

  it("leaves the history of OTHER users completely alone", async () => {
    const mine = await signupAndVerify();
    const mineId = await buildHistory(ACCOUNT.email, mine);

    const theirs = await signupAndVerify("grace@example.test");
    const otherId = await buildHistory("grace@example.test", theirs);

    const before = await scalar(sql`
      SELECT (SELECT COUNT(*) FROM credit_ledger WHERE user_id = ${otherId}) AS ledger,
             (SELECT COUNT(*) FROM audit_events  WHERE actor_id = ${otherId}) AS audit,
             (SELECT COUNT(*) FROM users WHERE id = ${otherId} AND status = 'active') AS live
    `);

    await erase(mineId);

    const after = await scalar(sql`
      SELECT (SELECT COUNT(*) FROM credit_ledger WHERE user_id = ${otherId}) AS ledger,
             (SELECT COUNT(*) FROM audit_events  WHERE actor_id = ${otherId}) AS audit,
             (SELECT COUNT(*) FROM users WHERE id = ${otherId} AND status = 'active') AS live
    `);

    expect(after).toEqual(before);
    expect((await app.json("/v1/me", { cookies: theirs })).status).toBe(200);
  });
});

// ===========================================================================

describe("erasure refuses when it should", () => {
  // The product used to carry this as a form on /app/profile. It was removed,
  // and this is what stops it coming back by accident: an endpoint that is
  // merely unlinked is still an endpoint.
  it("has no self-service endpoint left", async () => {
    const cookies = await signupAndVerify();
    const result = await app.json("/v1/me", {
      method: "DELETE",
      cookies,
      body: JSON.stringify({ currentPassword: ACCOUNT.password, understood: true }),
    });

    expect([404, 405], `unexpected status ${result.status}`).toContain(result.status);
    expect((await app.json("/v1/me", { cookies })).status).toBe(200);
  });

  it("refuses to erase the last remaining owner", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await app.db.db.execute(sql`UPDATE users SET role = 'super_admin' WHERE id = ${userId}`);

    // Otherwise the organisation locks itself out of its own console, and
    // bootstrapping a replacement owner needs an existing verified account.
    await expect(erase(userId)).rejects.toThrow(/only owner/i);

    const row = await scalar(
      sql`SELECT status, anonymized_at::text AS anonymized_at FROM users WHERE id = ${userId}`,
    );
    expect(row.status).toBe("active");
    expect(row.anonymized_at).toBeNull();
  });

  it("erases an owner once another one exists", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await signupAndVerify("grace@example.test");
    const otherId = await userIdFor("grace@example.test");
    await app.db.db.execute(
      sql`UPDATE users SET role = 'super_admin' WHERE id IN (${userId}, ${otherId})`,
    );

    await expect(erase(userId)).resolves.toMatchObject({ userId });
  });

  it("refuses an account that does not exist", async () => {
    await expect(erase("usr_nope")).rejects.toThrow(/No such account/i);
  });

  it("cannot be run twice", async () => {
    const cookies = await signupAndVerify();
    const userId = await buildHistory(ACCOUNT.email, cookies);
    await erase(userId);

    const anonymizedAt = (
      await scalar(sql`SELECT anonymized_at::text AS a FROM users WHERE id = ${userId}`)
    ).a;

    // The first erasure's timestamp must not be overwritten by a second run.
    await expect(erase(userId)).rejects.toThrow(/already erased/i);
    const after = (
      await scalar(sql`SELECT anonymized_at::text AS a FROM users WHERE id = ${userId}`)
    ).a;
    expect(after).toBe(anonymizedAt);
  });
});
