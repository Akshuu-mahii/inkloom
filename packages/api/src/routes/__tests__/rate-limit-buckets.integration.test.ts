/**
 * Proof that every declared rate-limit bucket is actually enforced.
 *
 * `admin.login.account` and `api.write.user` sat in RATE_LIMIT_POLICIES for
 * months, fully specified and referenced by nothing. They read as protection in
 * code review and in the admin settings screen, where an operator could even
 * "adjust" limits that were never consulted — which is worse than having no
 * policy at all, because it stops anyone asking whether the gap exists.
 *
 * These tests assert against `rate_limit_events`, the table the limiter
 * actually writes, rather than against a call site. A bucket that stops being
 * consumed fails here even if the code still looks wired.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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

const USER = {
  email: "linus@example.test",
  password: "a-perfectly-fine-passphrase-1",
  name: "Linus Torvalds",
  acceptedTerms: true as const,
};

async function signupAndVerify(email = USER.email) {
  await app.json("/v1/auth/signup", {
    method: "POST",
    body: JSON.stringify({ ...USER, email }),
  });
  const message = app.mail.lastTo(email);
  const verified = await app.json("/v1/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token: extractToken(message!.html) }),
  });
  return verified.cookies;
}

/** Every counter recorded for a bucket, summed across windows. */
async function counted(bucket: string): Promise<number> {
  const result = await app.db.db.execute<{ total: string | null }>(
    sql`SELECT SUM(count)::text AS total FROM rate_limit_events WHERE bucket = ${bucket}`,
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function promoteToStaff(email: string) {
  await app.db.db.execute(
    sql`UPDATE users SET role = 'admin' WHERE normalized_email = ${email.toLowerCase()}`,
  );
}

/**
 * Narrow a bucket at runtime, through the same service /admin/settings uses.
 *
 * Going through the service rather than writing the row directly means these
 * tests also prove the operator control works: an override set from the console
 * has to actually reach the limiter, which it did not in an earlier version of
 * the limiter that read only its constructor options.
 */
async function overrideLimit(bucket: string, limit: number) {
  // `updated_by` is a real foreign key: settings changes are attributable to a
  // person, which is the point of the column. Any existing account will do.
  const actor = await app.db.db.execute<{ id: string }>(sql`SELECT id FROM users LIMIT 1`);

  await app.services.settings.set(
    app.db.db,
    "rate_limit_overrides",
    { [bucket]: { limit } },
    actor.rows[0]!.id,
  );
}

// ===========================================================================

describe("api.write.user — the aggregate ceiling on authenticated writes", () => {
  it("charges an authenticated write", async () => {
    const cookies = await signupAndVerify();
    expect(await counted("api.write.user")).toBe(0);

    const result = await app.json("/v1/me", {
      method: "PATCH",
      cookies,
      body: JSON.stringify({ company: "Acme" }),
    });

    expect(result.status, "the write itself must still succeed").toBeLessThan(400);
    expect(await counted("api.write.user"), "the write must be charged").toBeGreaterThan(0);
  });

  it("does not charge a read", async () => {
    const cookies = await signupAndVerify();

    await app.json("/v1/me", { cookies });
    await app.json("/v1/credits", { cookies });

    // Reads are bounded by the database, not by this bucket. Charging them
    // would burn the budget of anyone who simply left a dashboard open.
    expect(await counted("api.write.user")).toBe(0);
  });

  it("does not charge an unauthenticated write", async () => {
    // Signup has no principal to key on and carries its own per-IP budget;
    // keying this bucket on an address would punish a shared NAT twice.
    await app.json("/v1/auth/signup", {
      method: "POST",
      body: JSON.stringify({ ...USER, email: "anon@example.test" }),
    });

    expect(await counted("api.write.user")).toBe(0);
  });

  it("refuses the write once the budget is spent", async () => {
    const cookies = await signupAndVerify();
    await overrideLimit("api.write.user", 2);

    const send = () =>
      app.json("/v1/me", {
        method: "PATCH",
        cookies,
        body: JSON.stringify({ company: "Acme" }),
      });

    expect((await send()).status).toBeLessThan(400);
    expect((await send()).status).toBeLessThan(400);

    const blocked = await send();
    expect(blocked.status, "the third write must be refused").toBe(429);
    expect(blocked.error?.code).toBe("RATE_LIMITED");
  });

  it("keeps one user's budget away from another's", async () => {
    const first = await signupAndVerify("a@example.test");
    const second = await signupAndVerify("b@example.test");
    await overrideLimit("api.write.user", 1);

    const write = (cookies: string[]) =>
      app.json("/v1/me", {
        method: "PATCH",
        cookies,
        body: JSON.stringify({ company: "Acme" }),
      });

    await write(first);
    expect((await write(first)).status, "first user is out of budget").toBe(429);

    // The bucket is scoped to the user, so exhausting one must not touch the
    // other — the whole reason this is not an IP limit.
    expect((await write(second)).status, "second user is unaffected").toBeLessThan(400);
  });
});

// ===========================================================================

describe("admin.login.account — the tighter budget for staff addresses", () => {
  const wrongPassword = (email: string) =>
    app.json("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: "definitely-not-the-password" }),
    });

  it("charges a failed staff login to the staff bucket", async () => {
    await signupAndVerify();
    await promoteToStaff(USER.email);

    await wrongPassword(USER.email);

    expect(await counted("admin.login.account"), "staff failures must be charged").toBeGreaterThan(
      0,
    );
  });

  it("leaves an ordinary account's failures out of the staff bucket", async () => {
    await signupAndVerify();

    await wrongPassword(USER.email);

    expect(await counted("auth.login.account"), "the general bucket still counts").toBeGreaterThan(
      0,
    );
    expect(await counted("admin.login.account"), "but the staff bucket must not").toBe(0);
  });

  it("blocks a staff account sooner than the general budget would", async () => {
    await signupAndVerify();
    await promoteToStaff(USER.email);
    // The staff bucket allows 5; the general one allows 10. Narrow only the
    // staff bucket so a block can only have come from it.
    await overrideLimit("admin.login.account", 2);

    await wrongPassword(USER.email);
    await wrongPassword(USER.email);

    const blocked = await wrongPassword(USER.email);
    expect(blocked.status, "the staff budget must refuse the third attempt").toBe(429);
    expect(blocked.error?.code).toBe("RATE_LIMITED");
  });

  it("records the staff throttle as a critical security event", async () => {
    await signupAndVerify();
    await promoteToStaff(USER.email);
    await overrideLimit("admin.login.account", 1);

    await wrongPassword(USER.email);
    await wrongPassword(USER.email);

    const events = await app.db.db.execute<{ severity: string }>(
      sql`SELECT severity FROM security_events
          WHERE metadata->>'flow' = 'admin_login_throttled'`,
    );

    // Staff credentials under attack is not routine noise; it must be able to
    // page someone.
    expect(events.rows.length).toBeGreaterThan(0);
    expect(events.rows[0]!.severity).toBe("critical");
  });

  it("clears the staff budget once the operator signs in successfully", async () => {
    await signupAndVerify();
    await promoteToStaff(USER.email);

    await wrongPassword(USER.email);
    expect(await counted("admin.login.account")).toBeGreaterThan(0);

    await app.json("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: USER.email, password: USER.password }),
    });

    // An operator who mistypes once and then gets in must not carry that
    // failure toward a lockout for the next fifteen minutes.
    expect(await counted("admin.login.account")).toBe(0);
  });
});
