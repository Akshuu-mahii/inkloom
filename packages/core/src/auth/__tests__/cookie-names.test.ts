/**
 * The session cookie must carry exactly ONE prefix, and it must be `__Host-`.
 *
 * This shipped wrong. Better Auth prepends `__Secure-` to every cookie name of
 * its own accord when `advanced.useSecureCookies` is true, so configuring
 * `__Host-inkloom_session` produced `__Secure-__Host-inkloom_session`. A
 * browser reads only the first prefix on a name, so the cookie was enforced as
 * `__Secure-` — Secure, but NOT host-only — and the sibling-subdomain
 * protection that is the entire point of `__Host-` silently did not exist. The
 * clearing header written on account erasure named the shorter cookie and
 * therefore cleared nothing.
 *
 * These assertions read the names the LIBRARY computes, not the ones this
 * repository configures, so a future Better Auth upgrade that reinstates the
 * prefix fails here rather than in a browser nobody is watching.
 */
import { describe, expect, it } from "vitest";
import { getCookies } from "better-auth/cookies";
import type { Database } from "@inkloom/db/client";
import { loadConfig } from "../../config/index";
import { silentLogger } from "../../util/logger";
import type { Mailer } from "../../notifications/mailer";
import { createAuth, SESSION_COOKIE_NAME, SESSION_COOKIE_NAME_INSECURE } from "../auth";

/**
 * Nothing here touches the database or sends mail: `betterAuth()` only stores
 * the adapter and the callbacks, and every assertion reads configuration the
 * constructor has already resolved.
 */
function cookiesFor(appUrl: string) {
  const config = loadConfig({
    INKLOOM_ENV: "test",
    APP_URL: appUrl,
    BETTER_AUTH_URL: appUrl,
    DATABASE_URL: "postgres://unused/unused",
    BETTER_AUTH_SECRET: "cookie-name-test-secret-long-enough-000",
    ACCESS_CODE_PEPPER: "cookie-name-test-access-pepper-ok",
    IP_HASH_PEPPER: "cookie-name-test-ip-pepper-okay-00",
  });

  const auth = createAuth({
    db: {} as Database,
    config,
    logger: silentLogger,
    mailer: { send: async () => {} } as unknown as Mailer,
  });

  return getCookies(auth.options);
}

const HTTPS = "https://app.inkloom.art";
const HTTP = "http://localhost:5173";

// ===========================================================================

describe("the session cookie over HTTPS", () => {
  const cookie = () => cookiesFor(HTTPS).sessionToken;

  it("is named exactly __Host-inkloom_session", () => {
    expect(cookie().name).toBe(SESSION_COOKIE_NAME);
  });

  it("carries no second prefix", () => {
    // The specific regression: "__Secure-__Host-inkloom_session".
    expect(cookie().name.startsWith("__Secure-")).toBe(false);
    expect(cookie().name.match(/__Secure-|__Host-/g)).toEqual(["__Host-"]);
  });

  it("satisfies every condition the browser imposes on a __Host- cookie", () => {
    // A browser REJECTS a __Host- cookie that breaks any of these, which would
    // log every user out rather than fail quietly.
    const { attributes } = cookie();
    expect(attributes.secure).toBe(true);
    expect(attributes.path).toBe("/");
    expect(attributes.domain).toBeUndefined();
    expect(attributes.httpOnly).toBe(true);
    expect(attributes.sameSite).toBe("lax");
  });
});

describe("the cookies Better Auth names for itself", () => {
  it("are __Secure- prefixed over HTTPS", () => {
    // OAuth state and the PKCE verifier used to ship as `better-auth.state`.
    // Suppressing useSecureCookies removed their prefix too, so cookiePrefix
    // puts it back — these are the cookies an interception attack targets.
    const cookies = cookiesFor(HTTPS);
    for (const [key, cookie] of Object.entries(cookies)) {
      if (key === "sessionToken") continue;
      expect(cookie.name, key).toMatch(/^__Secure-inkloom\./);
      expect(cookie.attributes.secure, key).toBe(true);
    }
  });
});

describe("plain-HTTP local development", () => {
  it("drops every prefix, because a browser would refuse the cookie", () => {
    const cookies = cookiesFor(HTTP);
    expect(cookies.sessionToken.name).toBe(SESSION_COOKIE_NAME_INSECURE);
    for (const cookie of Object.values(cookies)) {
      expect(cookie.name.startsWith("__")).toBe(false);
      expect(cookie.attributes.secure).toBe(false);
    }
  });
});
