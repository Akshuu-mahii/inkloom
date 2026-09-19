/**
 * The www redirect.
 *
 * `www.inkloom.art` is a proxied CNAME to the apex, so Cloudflare terminates
 * the connection and then looks for an origin. Until the hostname was attached
 * to the Worker there was none, and it answered 522 — an outage page for what
 * is only a slightly wrong address.
 */
import { describe, expect, it } from "vitest";
import { redirectToCanonicalHost } from "../../../workers/app";

const env = { APP_URL: "https://inkloom.art" } as never;
const request = (url: string) => new Request(url, { method: "GET" });

describe("www", () => {
  it("redirects to the bare domain", () => {
    const response = redirectToCanonicalHost(request("https://www.inkloom.art/pricing"), env);
    expect(response?.headers.get("location")).toBe("https://inkloom.art/pricing");
  });

  it("keeps the path and the query string", () => {
    const response = redirectToCanonicalHost(
      request("https://www.inkloom.art/auth/login?next=%2Fapp"),
      env,
    );
    expect(response?.headers.get("location")).toBe("https://inkloom.art/auth/login?next=%2Fapp");
  });

  // A 301 lets an intermediary turn a POST into a GET, which would quietly
  // discard a submitted form rather than deliver it to the canonical host.
  it("uses 308, so a POST stays a POST", () => {
    expect(redirectToCanonicalHost(request("https://www.inkloom.art/"), env)?.status).toBe(308);
  });
});

describe("everything else is left alone", () => {
  it("passes the canonical host through", () => {
    expect(redirectToCanonicalHost(request("https://inkloom.art/"), env)).toBeNull();
  });

  it("does not match a host that merely starts with www", () => {
    expect(redirectToCanonicalHost(request("https://wwwinkloom.art/"), env)).toBeNull();
  });

  it("does not match a www subdomain of something else", () => {
    expect(redirectToCanonicalHost(request("https://www.example.com/"), env)).toBeNull();
  });

  it("follows APP_URL rather than a hardcoded domain", () => {
    const staging = { APP_URL: "https://staging.inkloom.art" } as never;
    expect(
      redirectToCanonicalHost(request("https://www.staging.inkloom.art/"), staging)?.headers.get(
        "location",
      ),
    ).toBe("https://staging.inkloom.art/");
    expect(redirectToCanonicalHost(request("https://www.inkloom.art/"), staging)).toBeNull();
  });

  it("does nothing without APP_URL, rather than guessing", () => {
    expect(redirectToCanonicalHost(request("https://www.inkloom.art/"), {} as never)).toBeNull();
  });
});
