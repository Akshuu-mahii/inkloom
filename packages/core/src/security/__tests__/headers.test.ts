/**
 * The Content-Security-Policy, and the three directives Turnstile needs.
 *
 * A CSP that is too tight fails in the worst possible way: nothing errors, the
 * page renders, and one feature quietly does not work. That is exactly what
 * happened here. `script-src` and `frame-src` both allowed
 * challenges.cloudflare.com, so the script loaded and the iframe was permitted —
 * but `connect-src` was `'self'`, and Turnstile's script calls BACK to
 * Cloudflare over fetch to fetch and solve the challenge. Every one of those
 * calls was blocked.
 *
 * The visible result was a signup form that said "the human check couldn't
 * load — an ad-blocker, a VPN or a strict network can block
 * challenges.cloudflare.com", blaming the visitor's browser for the server's
 * own header. Signup, login, password reset and contact were all unusable on a
 * first visit.
 */
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "../headers";

const parse = (csp: string) =>
  Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name!, values];
      }),
  );

const base = { nonce: "test-nonce", isProduction: false, isSecureTransport: false, connectSrc: [] };
const TURNSTILE = "https://challenges.cloudflare.com";

describe("every document, not just the ones with a form", () => {
  /*
   * CSP is a property of a DOCUMENT. This application routes on the client, so
   * clicking from the home page to /auth/signup fetches no new document and the
   * page keeps the home page's CSP. Scoping these origins to "pages that render
   * the widget" therefore blocked Turnstile for anyone who navigated to signup
   * rather than landing on it — and worked on refresh, which made it look like
   * flakiness rather than a header.
   */
  const csp = parse(contentSecurityPolicy(base));

  it.each([
    ["script-src", "so the widget's script can load"],
    ["frame-src", "so its iframe can render"],
    ["connect-src", "so the script can reach Cloudflare to solve the challenge"],
  ])("allows challenges.cloudflare.com in %s — %s", (directive) => {
    expect(csp[directive], `${directive} was ${JSON.stringify(csp[directive])}`).toContain(
      TURNSTILE,
    );
  });
});

describe("a page reached by client-side navigation", () => {
  /*
   * The regression this file exists for. The home page's CSP is what a visitor
   * who clicks through to signup actually runs under, so it must already permit
   * the widget.
   */
  const home = parse(contentSecurityPolicy(base));

  it.each(["script-src", "frame-src", "connect-src"])(
    "the home page's %s already allows Turnstile",
    (directive) => {
      expect(home[directive]).toContain(TURNSTILE);
    },
  );
});

describe("the directives that must hold on every page", () => {
  {
    const csp = parse(contentSecurityPolicy(base));
    const label = "always";

    it(`${label}: frame-ancestors, object-src and base-uri stay locked`, () => {
      expect(csp["frame-ancestors"]).toEqual(["'none'"]);
      expect(csp["object-src"]).toEqual(["'none'"]);
      expect(csp["base-uri"]).toEqual(["'self'"]);
      expect(csp["form-action"]).toEqual(["'self'"]);
    });

    it(`${label}: the nonce is present and connect-src still includes 'self'`, () => {
      expect(csp["script-src"]).toContain("'nonce-test-nonce'");
      expect(csp["connect-src"]).toContain("'self'");
    });
  }

  it("keeps an extra connect-src origin, such as Sentry, alongside Turnstile's", () => {
    const csp = parse(
      contentSecurityPolicy({
        ...base,
        connectSrc: ["https://sentry.example"],
      }),
    );

    expect(csp["connect-src"]).toEqual(
      expect.arrayContaining(["'self'", TURNSTILE, "https://sentry.example"]),
    );
  });

  /*
   * `strict-dynamic` keys off the TRANSPORT, not the environment.
   *
   * It used to key off `isProduction`, which meant production was the first
   * place it ever ran. That is the opposite of what a staging environment is
   * for: under `strict-dynamic` a host allowlist and `'self'` are ignored
   * outright, so one un-nonced bundle tag takes the whole application down —
   * and staging, running a laxer policy, would have looked perfect throughout.
   */
  it("applies strict-dynamic on any HTTPS deployment, not only production", () => {
    const stagingHttps = parse(
      contentSecurityPolicy({ ...base, isProduction: false, isSecureTransport: true }),
    );
    const prod = parse(
      contentSecurityPolicy({ ...base, isProduction: true, isSecureTransport: true }),
    );
    const localHttp = parse(contentSecurityPolicy(base));

    expect(stagingHttps["script-src"], "staging must rehearse it").toContain("'strict-dynamic'");
    expect(prod["script-src"]).toContain("'strict-dynamic'");
    // Never over plain http, where it would break local development.
    expect(localHttp["script-src"]).not.toContain("'strict-dynamic'");
  });

  it("upgrades insecure requests wherever the transport is secure", () => {
    const https = contentSecurityPolicy({ ...base, isSecureTransport: true });
    expect(https).toContain("upgrade-insecure-requests");
    expect(contentSecurityPolicy(base)).not.toContain("upgrade-insecure-requests");
  });
});

describe("HSTS", () => {
  it("is never sent over plain http, where it would poison localhost", () => {
    expect(securityHeaders(base)["Strict-Transport-Security"]).toBeUndefined();
  });

  it("is sent on staging, but without the commitments that are hard to undo", () => {
    const h = securityHeaders({ ...base, isSecureTransport: true })["Strict-Transport-Security"];

    expect(h, "staging must exercise the header").toBeDefined();
    expect(h).toContain("max-age=");
    // preload is a public list that takes months to leave, and includeSubDomains
    // would bind every sibling host. Both stay deliberate production choices.
    expect(h).not.toContain("preload");
    expect(h).not.toContain("includeSubDomains");
  });

  it("commits fully in production", () => {
    const h = securityHeaders({ ...base, isProduction: true, isSecureTransport: true })[
      "Strict-Transport-Security"
    ];

    expect(h).toContain("includeSubDomains");
    expect(h).toContain("preload");
  });
});
