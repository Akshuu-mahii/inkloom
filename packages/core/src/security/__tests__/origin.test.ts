import { describe, expect, it } from "vitest";
import { checkOrigin, isAcceptableContentType, isSafeMethod } from "../origin";

const APP = "https://inkloom.art";

describe("checkOrigin", () => {
  it("allows safe methods without an Origin header", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(checkOrigin({ method, origin: null, referer: null, allowedOrigin: APP })).toEqual({
        ok: true,
      });
    }
  });

  it("allows a same-origin write", () => {
    expect(checkOrigin({ method: "POST", origin: APP, referer: null, allowedOrigin: APP })).toEqual(
      { ok: true },
    );
  });

  it("rejects a cross-origin write", () => {
    expect(
      checkOrigin({
        method: "POST",
        origin: "https://evil.example",
        referer: null,
        allowedOrigin: APP,
      }),
    ).toEqual({ ok: false, reason: "origin_mismatch" });
  });

  it("rejects lookalike origins", () => {
    // Suffix tricks, scheme downgrade, an extra subdomain and a port change are
    // all distinct origins and must all be refused.
    for (const hostile of [
      "https://inkloom.art.evil.example",
      "http://inkloom.art",
      "https://www.inkloom.art",
      "https://inkloom.art:8443",
      "null",
    ]) {
      expect(
        checkOrigin({ method: "POST", origin: hostile, referer: null, allowedOrigin: APP }).ok,
        hostile,
      ).toBe(false);
    }
  });

  it("rejects a write with no Origin and no Referer", () => {
    expect(
      checkOrigin({ method: "DELETE", origin: null, referer: null, allowedOrigin: APP }),
    ).toEqual({ ok: false, reason: "missing_origin" });
  });

  it("falls back to Referer when Origin is stripped by a privacy tool", () => {
    expect(
      checkOrigin({
        method: "POST",
        origin: null,
        referer: `${APP}/app/redeem`,
        allowedOrigin: APP,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a hostile Referer", () => {
    expect(
      checkOrigin({
        method: "POST",
        origin: null,
        referer: "https://evil.example/attack",
        allowedOrigin: APP,
      }).ok,
    ).toBe(false);
  });

  it("prefers Origin over Referer when both are present", () => {
    // A hostile page can control Referer more easily than Origin.
    expect(
      checkOrigin({
        method: "POST",
        origin: "https://evil.example",
        referer: `${APP}/app`,
        allowedOrigin: APP,
      }).ok,
    ).toBe(false);
  });

  it("permits an explicitly allowlisted extra origin (staging preview)", () => {
    expect(
      checkOrigin({
        method: "POST",
        origin: "https://staging.inkloom.art",
        referer: null,
        allowedOrigin: APP,
        additionalOrigins: ["https://staging.inkloom.art"],
      }),
    ).toEqual({ ok: true });
  });
});

describe("isAcceptableContentType", () => {
  it("accepts JSON, with or without a charset", () => {
    expect(isAcceptableContentType("application/json")).toBe(true);
    expect(isAcceptableContentType("application/json; charset=utf-8")).toBe(true);
    expect(isAcceptableContentType("APPLICATION/JSON")).toBe(true);
  });

  it("rejects the content types a cross-origin HTML form can send", () => {
    // These three are the entire simple-request CSRF surface.
    for (const type of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/plain",
      "text/plain;charset=UTF-8",
    ]) {
      expect(isAcceptableContentType(type), type).toBe(false);
    }
  });

  it("rejects a missing content type", () => {
    expect(isAcceptableContentType(null)).toBe(false);
    expect(isAcceptableContentType("")).toBe(false);
  });
});

describe("isSafeMethod", () => {
  it("classifies only read methods as safe", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("HEAD")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isSafeMethod(method), method).toBe(false);
    }
  });
});
