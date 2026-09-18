/**
 * Deploy-time refusals.
 *
 * `loadConfig` is the last thing standing between a misconfigured deploy and
 * real traffic, and every guard in it exists because the failure it prevents is
 * silent: a placeholder secret still signs sessions, an empty Turnstile sitekey
 * still renders a form, a test key still returns "valid". Nothing downstream
 * notices, so these assertions are the only thing keeping the guards honest.
 *
 * Pure — no database, no network — so this belongs to the unit project.
 */
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../index";

/** A complete, valid production environment. Each test breaks exactly one field. */
const productionEnv = () => ({
  INKLOOM_ENV: "production",
  APP_URL: "https://inkloom.art",
  DATABASE_URL: "postgresql://user:pw@host/db",
  BETTER_AUTH_SECRET: "S".repeat(48),
  ACCESS_CODE_PEPPER: "P".repeat(32),
  IP_HASH_PEPPER: "I".repeat(32),
  EMAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "re_live_abc123",
  TURNSTILE_ENABLED: "true",
  TURNSTILE_SITE_KEY: "0x4AAAAAAABcDeFgHiJkLmNo",
  TURNSTILE_SECRET_KEY: "0x4AAAAAAABsEcReTvAlUe",
});

const loadWith = (overrides: Record<string, unknown>) =>
  loadConfig({ ...productionEnv(), ...overrides });

describe("a valid production environment", () => {
  it("loads and derives its flags", () => {
    const config = loadWith({});

    expect(config.isProduction).toBe(true);
    expect(config.isStaging).toBe(false);
    expect(config.origin).toBe("https://inkloom.art");
  });

  it("is frozen, so nothing can rewrite a secret after boot", () => {
    const config = loadWith({});

    expect(() => {
      (config as { ACCESS_CODE_PEPPER: string }).ACCESS_CODE_PEPPER = "swapped";
    }).toThrow();
    expect(config.ACCESS_CODE_PEPPER).toBe("P".repeat(32));
  });
});

describe("Turnstile", () => {
  /*
   * The regression this file was written for.
   *
   * Wrangler REPLACES the top-level `vars` block with `env.<name>.vars` rather
   * than merging them, so a sitekey set once at the top silently resolves to
   * the schema default of "" in every deployed environment. The widget then
   * renders with an empty sitekey and issues no token, the server keeps
   * demanding one, and signup, login, password reset and contact all fail at
   * once with nothing in the logs but "captcha failed".
   */
  it("refuses an empty site key while enabled", () => {
    expect(() => loadWith({ TURNSTILE_SITE_KEY: "" })).toThrow(ConfigError);
    expect(() => loadWith({ TURNSTILE_SITE_KEY: "" })).toThrow(/TURNSTILE_SITE_KEY is required/);
  });

  it("refuses a site key that was never set at all", () => {
    const { TURNSTILE_SITE_KEY: _omitted, ...withoutSiteKey } = productionEnv();

    expect(() => loadConfig(withoutSiteKey)).toThrow(/TURNSTILE_SITE_KEY is required/);
  });

  it("refuses Cloudflare's always-passing test site key", () => {
    expect(() => loadWith({ TURNSTILE_SITE_KEY: "1x00000000000000000000AA" })).toThrow(
      /always-passing test key/,
    );
  });

  it("refuses the always-passing test secret key", () => {
    expect(() => loadWith({ TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" })).toThrow(
      /always-passing test key/,
    );
  });

  it("allows both to be absent when Turnstile is switched off", () => {
    const config = loadWith({
      TURNSTILE_ENABLED: "false",
      TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
    });

    expect(config.TURNSTILE_ENABLED).toBe(false);
  });
});

describe("placeholder secrets", () => {
  it.each([
    ["BETTER_AUTH_SECRET", "dev-only-insecure-secret-replace-me-0000000000"],
    ["ACCESS_CODE_PEPPER", "dev-only-insecure-pepper-replace-me-000000"],
    ["IP_HASH_PEPPER", "dev-only-insecure-ip-pepper-replace-me-00"],
  ])("refuses to boot production on the %s placeholder", (key, placeholder) => {
    expect(() => loadWith({ [key]: placeholder })).toThrow(/is still the development placeholder/);
  });

  it("refuses any secret merely prefixed dev-only-", () => {
    expect(() => loadWith({ BETTER_AUTH_SECRET: `dev-only-${"x".repeat(40)}` })).toThrow(
      /is still the development placeholder/,
    );
  });

  it("rejects a secret shorter than the minimum length", () => {
    expect(() => loadWith({ BETTER_AUTH_SECRET: "short" })).toThrow(ConfigError);
  });
});

describe("transport and URL guards", () => {
  it("refuses plaintext http in production", () => {
    expect(() => loadWith({ APP_URL: "http://inkloom.art" })).toThrow(/must be https/);
  });

  it("refuses a trailing slash, which would double up every built URL", () => {
    expect(() => loadWith({ APP_URL: "https://inkloom.art/" })).toThrow(ConfigError);
  });

  it("refuses Mailpit outside development", () => {
    expect(() => loadWith({ EMAIL_TRANSPORT: "mailpit" })).toThrow(/Mailpit is local-only/);
  });

  it("refuses a missing Resend key", () => {
    const { RESEND_API_KEY: _omitted, ...withoutKey } = productionEnv();

    expect(() => loadConfig(withoutKey)).toThrow(/RESEND_API_KEY is required/);
  });
});

describe("staging is held to the same standard as production", () => {
  const stagingEnv = () => ({
    ...productionEnv(),
    INKLOOM_ENV: "staging",
    APP_URL: "https://staging.inkloom.art",
  });

  it("loads when fully configured", () => {
    expect(loadConfig(stagingEnv()).isStaging).toBe(true);
  });

  it.each([
    ["an empty site key", { TURNSTILE_SITE_KEY: "" }],
    [
      "a placeholder secret",
      { BETTER_AUTH_SECRET: "dev-only-insecure-secret-replace-me-0000000000" },
    ],
    ["plaintext http", { APP_URL: "http://staging.inkloom.art" }],
    ["Mailpit", { EMAIL_TRANSPORT: "mailpit" }],
  ])("refuses %s", (_label, override) => {
    expect(() => loadConfig({ ...stagingEnv(), ...override })).toThrow(ConfigError);
  });
});

describe("development stays permissive", () => {
  it("accepts placeholders and http, so local setup needs no ceremony", () => {
    const config = loadConfig({
      INKLOOM_ENV: "development",
      APP_URL: "http://localhost:5173",
      DATABASE_URL: "postgresql://inkloom:inkloom@127.0.0.1:5433/inkloom",
      BETTER_AUTH_SECRET: "dev-only-insecure-secret-replace-me-0000000000",
      ACCESS_CODE_PEPPER: "dev-only-insecure-pepper-replace-me-000000",
      IP_HASH_PEPPER: "dev-only-insecure-ip-pepper-replace-me-00",
      EMAIL_TRANSPORT: "mailpit",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    });

    expect(config.isDevelopment).toBe(true);
  });
});

describe("ADMIN_PATH", () => {
  it("defaults to /admin", () => {
    expect(loadWith({}).ADMIN_PATH).toBe("/admin");
  });

  it.each(["/api", "/app", "/auth", "/assets", "/API"])(
    "refuses %s, which would shadow a real prefix",
    (path) => {
      expect(() => loadWith({ ADMIN_PATH: path })).toThrow(ConfigError);
    },
  );

  it.each(["admin", "/admin/deeper", "/../etc", "/with space", "/-leading-dash", ""])(
    "refuses the malformed path %j",
    (path) => {
      expect(() => loadWith({ ADMIN_PATH: path })).toThrow(ConfigError);
    },
  );

  it("accepts a single obscure segment", () => {
    expect(loadWith({ ADMIN_PATH: "/internal-admin-7f3a91" }).ADMIN_PATH).toBe(
      "/internal-admin-7f3a91",
    );
  });
});

describe("Google OAuth is only enabled when both halves are present", () => {
  it.each([
    ["neither", {}, false],
    ["id only", { GOOGLE_CLIENT_ID: "id" }, false],
    ["secret only", { GOOGLE_CLIENT_SECRET: "secret" }, false],
    ["both", { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }, true],
  ])("%s", (_label, override, expected) => {
    expect(loadWith(override).googleOAuthEnabled).toBe(expected);
  });
});
