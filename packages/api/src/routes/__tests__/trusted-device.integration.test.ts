/**
 * "Trust this device" has to actually skip the second factor next time.
 *
 * It had never been tested, and it broke silently. The trust is stored in two
 * halves — a signed cookie in the browser and a verification row in the
 * database — and only the row is visible to anyone looking at the system from
 * the inside. Staging had a perfectly good row, unexpired, while every sign-in
 * kept asking for a code, because a change to the cookie PREFIX renamed the
 * half the browser holds. Nothing logged an error: to the server, a request
 * with no trust cookie is simply an untrusted device.
 *
 * That is the shape these tests pin. Not "does the endpoint accept a
 * trustDevice flag", which it always did, but: after trusting, does a fresh
 * sign-in with the cookies the browser kept produce a SESSION rather than a
 * challenge — and does an untrusted browser still get challenged.
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

const ACCOUNT = {
  email: "ada@example.test",
  password: "a-perfectly-fine-passphrase-1",
  name: "Ada Lovelace",
  acceptedTerms: true as const,
};

async function signupAndVerify(): Promise<string[]> {
  await app.json("/v1/auth/signup", { method: "POST", body: JSON.stringify(ACCOUNT) });
  const message = app.mail.lastTo(ACCOUNT.email);
  const verified = await app.json("/v1/auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token: extractToken(message!.html) }),
  });
  return verified.cookies;
}

/** Real TOTP enrolment, so the codes below are the ones an app would show. */
async function enrolTwoFactor(cookies: string[]): Promise<string> {
  const { createOTP } = await import("@better-auth/utils/otp");
  const { base32 } = await import("@better-auth/utils/base32");

  const started = await app.json("/v1/auth/two-factor/enable", {
    method: "POST",
    cookies,
    body: JSON.stringify({ currentPassword: ACCOUNT.password }),
  });

  const uri = (started.data as { totpURI?: string } | undefined)?.totpURI;
  expect(uri, "enrolment must return a TOTP URI").toBeDefined();
  const secret = new TextDecoder().decode(base32.decode(new URL(uri!).searchParams.get("secret")!));

  const confirmed = await app.json("/v1/auth/two-factor/confirm", {
    method: "POST",
    cookies,
    body: JSON.stringify({ code: await createOTP(secret).totp() }),
  });
  expect(confirmed.status, "enrolment must complete").toBe(200);
  return secret;
}

/** Password sign-in. Returns the challenge cookies and whether 2FA was asked. */
async function signIn(cookies: string[] = []) {
  const result = await app.json<{ twoFactorRequired?: boolean }>("/v1/auth/login", {
    method: "POST",
    cookies,
    body: JSON.stringify({ email: ACCOUNT.email, password: ACCOUNT.password }),
  });
  expect(result.status).toBe(200);
  return { challenged: result.data?.twoFactorRequired === true, cookies: result.cookies };
}

async function verify(challengeCookies: string[], secret: string, trustDevice: boolean) {
  const { createOTP } = await import("@better-auth/utils/otp");
  const result = await app.json("/v1/auth/two-factor/verify", {
    method: "POST",
    cookies: challengeCookies,
    body: JSON.stringify({ code: await createOTP(secret).totp(), trustDevice }),
  });
  expect(result.status, "a correct code must be accepted").toBe(200);
  return result.cookies;
}

// ===========================================================================

describe("trusting a device", () => {
  it("skips the second factor on the next sign-in from that browser", async () => {
    const session = await signupAndVerify();
    const secret = await enrolTwoFactor(session);

    const first = await signIn();
    expect(first.challenged, "an enrolled account is challenged the first time").toBe(true);

    // The browser keeps every cookie the trusted verification handed back.
    const trusted = await verify(first.cookies, secret, true);

    const second = await signIn(trusted);
    expect(second.challenged, "a trusted browser must not be challenged again").toBe(false);
  });

  it("still challenges a browser that did not ask to be trusted", async () => {
    const session = await signupAndVerify();
    const secret = await enrolTwoFactor(session);

    const first = await signIn();
    const notTrusted = await verify(first.cookies, secret, false);

    const second = await signIn(notTrusted);
    expect(second.challenged, "declining to trust must keep the second factor").toBe(true);
  });

  it("still challenges a DIFFERENT browser", async () => {
    // The trust belongs to the device that asked for it, not to the account —
    // otherwise one convenient login would disarm the second factor everywhere.
    const session = await signupAndVerify();
    const secret = await enrolTwoFactor(session);

    const first = await signIn();
    await verify(first.cookies, secret, true);

    const elsewhere = await signIn([]);
    expect(elsewhere.challenged, "another browser has no trust cookie").toBe(true);
  });

  it("records the trust with an expiry, so it cannot last forever", async () => {
    const session = await signupAndVerify();
    const secret = await enrolTwoFactor(session);
    const first = await signIn();
    await verify(first.cookies, secret, true);

    const rows = await app.db.db.execute<{ identifier: string; expires_at: Date }>(sql`
      SELECT identifier, expires_at FROM verification_tokens
       WHERE identifier LIKE 'trust-device-%'
    `);

    expect(rows.rows, "trusting a device must leave a record").toHaveLength(1);
    expect(new Date(rows.rows[0]!.expires_at).getTime()).toBeGreaterThan(Date.now());
  });
});
