/**
 * The Access gate, tested against real signatures rather than a stub.
 *
 * This is the control that makes a staging environment private. Every check in
 * it fails silently if it is skipped — a gate that verifies nothing and a gate
 * that verifies everything both return "allowed" for the one person who tests
 * it by hand — so each is asserted here with a genuinely signed token, an RSA
 * keypair generated per run, and a stubbed key endpoint that serves the real
 * public half.
 *
 * The negative cases are the point. Dropping the audience check would let a
 * token minted for any other application in the same Cloudflare account through
 * this door; dropping the issuer check would accept a token from any Access
 * team at all; dropping the email check would open staging to everyone in the
 * account rather than to one person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessTokenFrom,
  isUngatedPath,
  resetAccessKeyCache,
  verifyAccessToken,
  type AccessGateConfig,
} from "../access-gate";

/*
 * `CryptoKey` and `CryptoKeyPair` are values at runtime in every runtime this
 * targets, but not global TYPES in the Node type set this package compiles
 * against, so both are taken from the functions that produce them.
 */
type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
type KeyPair = { privateKey: Key; publicKey: Key };

const TEAM = "inkloom.cloudflareaccess.com";
const AUD = "aud-of-this-application";
const OWNER = "owner@example.com";

const gate: AccessGateConfig = { teamDomain: TEAM, aud: AUD, allowedEmails: [OWNER] };
const SERVICE_TOKEN = "abc123.access";

let keyPair: KeyPair;
let jwks: { keys: unknown[] };
const KID = "test-key-1";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const encodeJson = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

/** Mint a token the way Access does, signed with the run's private key. */
async function mint(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key: Key = keyPair.privateKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = encodeJson({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const body = encodeJson({
    iss: `https://${TEAM}`,
    aud: AUD,
    email: OWNER,
    sub: "sub_123",
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

beforeEach(async () => {
  resetAccessKeyCache();

  keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as KeyPair;

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(String(url)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify(jwks), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================

describe("a token Access really signed", () => {
  it("is accepted, and reports who it belongs to", async () => {
    const result = await verifyAccessToken(await mint(), gate);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.email).toBe(OWNER);
      expect(result.identity.sub).toBe("sub_123");
      expect(result.identity.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("matches the allowed address case-insensitively", async () => {
    const result = await verifyAccessToken(await mint({ email: "Owner@Example.COM" }), gate);
    expect(result.ok).toBe(true);
  });

  it("accepts an audience array that contains ours", async () => {
    const result = await verifyAccessToken(await mint({ aud: ["something-else", AUD] }), gate);
    expect(result.ok).toBe(true);
  });
});

describe("tokens that must be refused", () => {
  it("refuses one signed by a different key", async () => {
    const attacker = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as KeyPair;

    const result = await verifyAccessToken(await mint({}, {}, attacker.privateKey), gate);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses one minted for another application in the same account", async () => {
    // The check that separates THIS environment from every other Access app.
    const result = await verifyAccessToken(await mint({ aud: "some-other-app" }), gate);
    expect(result).toEqual({ ok: false, reason: "wrong_audience" });
  });

  it("refuses one from another Access team", async () => {
    const result = await verifyAccessToken(
      await mint({ iss: "https://evil.cloudflareaccess.com" }),
      gate,
    );
    expect(result).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  it("refuses an expired token", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const result = await verifyAccessToken(await mint({ exp: past }), gate);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses a valid Access login by somebody else", async () => {
    // Everything about this token is genuine. It is simply not our person —
    // the difference between "only my account" and "only me".
    const result = await verifyAccessToken(await mint({ email: "colleague@example.com" }), gate);
    expect(result).toEqual({ ok: false, reason: "email_not_allowed" });
  });

  it("refuses a token with no email claim at all", async () => {
    const result = await verifyAccessToken(await mint({ email: undefined }), gate);
    expect(result).toEqual({ ok: false, reason: "no_email" });
  });

  it("refuses an unsigned token, whatever it claims", async () => {
    // "alg": "none" is the oldest JWT attack there is.
    const now = Math.floor(Date.now() / 1000);
    const token = `${encodeJson({ alg: "none", kid: KID })}.${encodeJson({
      iss: `https://${TEAM}`,
      aud: AUD,
      email: OWNER,
      exp: now + 3600,
    })}.`;

    expect(await verifyAccessToken(token, gate)).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses rubbish without throwing", async () => {
    for (const junk of ["", "a.b", "....", "not-a-jwt", "a.b.c"]) {
      const result = await verifyAccessToken(junk, gate);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses everything when the allowlist is empty", async () => {
    const result = await verifyAccessToken(await mint(), { ...gate, allowedEmails: [] });
    expect(result).toEqual({ ok: false, reason: "email_not_allowed" });
  });
});

describe("service tokens, which are how CI gets in", () => {
  /*
   * Without these, turning Access on breaks the deploy pipeline: the
   * post-deploy smoke test drives a real browser at the deployed site and meets
   * a login page. Access signs a token for a service token exactly as it does
   * for a person, with `common_name` — the Client ID — instead of `email`.
   */
  const withToken = { ...gate, allowedServiceTokens: [SERVICE_TOKEN] };

  it("accepts a listed service token", async () => {
    const token = await mint({ email: undefined, common_name: SERVICE_TOKEN });
    const result = await verifyAccessToken(token, withToken);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.email).toBe(`service:${SERVICE_TOKEN}`);
  });

  it("refuses a service token that is not listed", async () => {
    const token = await mint({ email: undefined, common_name: "someone-elses.access" });

    expect(await verifyAccessToken(token, withToken)).toEqual({
      ok: false,
      reason: "service_token_not_allowed",
    });
  });

  it("refuses every service token when none are configured", async () => {
    // The default. A human allowlist must not silently admit machines.
    const token = await mint({ email: undefined, common_name: SERVICE_TOKEN });

    expect(await verifyAccessToken(token, gate)).toEqual({
      ok: false,
      reason: "service_token_not_allowed",
    });
  });

  it("does not let a service token borrow the human allowlist", async () => {
    // A token naming itself after the owner's address must not inherit access.
    const token = await mint({ email: undefined, common_name: OWNER });

    expect(await verifyAccessToken(token, withToken)).toEqual({
      ok: false,
      reason: "service_token_not_allowed",
    });
  });

  it("still requires a valid signature", async () => {
    const attacker = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as KeyPair;

    const token = await mint(
      { email: undefined, common_name: SERVICE_TOKEN },
      {},
      attacker.privateKey,
    );

    expect(await verifyAccessToken(token, withToken)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });
});

describe("key handling", () => {
  it("fetches the keys once and reuses them", async () => {
    await verifyAccessToken(await mint(), gate);
    await verifyAccessToken(await mint(), gate);

    // A round trip to the identity provider on every page load would be a
    // latency cost on every single request.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("refetches once for an unknown key id, so a rotation heals itself", async () => {
    await verifyAccessToken(await mint(), gate);
    vi.mocked(fetch).mockClear();

    const result = await verifyAccessToken(await mint({}, { kid: "rotated-key" }), gate);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("refuses rather than allows when the key endpoint is down", async () => {
    // FAILS CLOSED. An identity provider that cannot be reached must not become
    // an open door.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const result = await verifyAccessToken(await mint(), gate);
    expect(result).toEqual({ ok: false, reason: "keys_unavailable" });
  });
});

describe("reading the token off a request", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://staging.inkloom.art/", { headers });

  it("prefers the header Access sets", () => {
    expect(accessTokenFrom(request({ "cf-access-jwt-assertion": "tok" }))).toBe("tok");
  });

  it("falls back to the cookie a browser carries", () => {
    expect(accessTokenFrom(request({ cookie: "other=1; CF_Authorization=tok; more=2" }))).toBe(
      "tok",
    );
  });

  it("is null when there is nothing to read", () => {
    expect(accessTokenFrom(request({}))).toBeNull();
    expect(accessTokenFrom(request({ cookie: "unrelated=1" }))).toBeNull();
  });
});

describe("what stays reachable", () => {
  it("lets the two probes through, and nothing else", () => {
    // A deploy has to be able to confirm it succeeded, and an uptime check has
    // to work without an identity. Neither exposes data.
    expect(isUngatedPath("/api/health")).toBe(true);
    expect(isUngatedPath("/api/ready")).toBe(true);

    for (const path of ["/", "/app", "/api/v1/me", "/api/v1/admin/users", "/api/health/../me"]) {
      expect(isUngatedPath(path), path).toBe(false);
    }
  });
});
