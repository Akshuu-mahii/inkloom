/**
 * How `call()` reaches the API, and why it must not use the network on Workers.
 *
 * The bug these tests exist for: a server action ran
 * `fetch("https://staging.inkloom.art/api/v1/auth/signup")` from inside the
 * Worker that serves that very hostname. Cloudflare does not route a Worker's
 * subrequest back into the same Worker — it lands on the asset handler, misses,
 * and with `not_found_handling: "none"` returns a 404 with an empty body.
 * `response.json()` throws, and every caller reports "the server sent an
 * unreadable response".
 *
 * Vite's dev server loops a same-origin fetch back to itself, so signup, login,
 * the /app area and the whole admin console worked locally and were broken on
 * every deployed environment. 271 tests passed throughout, because nothing here
 * was covered by a test project at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { call } from "../api";
import { runWithApiDispatch } from "../api-dispatch.server";

const ok = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const envelope = (data: unknown) => ({ data, error: null, requestId: "req_test" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("in-process dispatch", () => {
  it("uses the dispatcher instead of the network when one is in scope", async () => {
    const networkFetch = vi.fn();
    vi.stubGlobal("fetch", networkFetch);
    const dispatch = vi.fn(async () => ok(envelope({ id: "u_1" })));

    const result = await runWithApiDispatch(dispatch, () =>
      call<{ id: string }>("/me", { request: new Request("https://app.test/app") }),
    );

    expect(result.data).toEqual({ id: "u_1" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    // The whole point: no socket, no edge round trip.
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it("passes a request the API app can route, with method, body and headers intact", async () => {
    let seen: Request | undefined;
    const dispatch = vi.fn(async (request: Request) => {
      seen = request;
      return ok(envelope({ ok: true }));
    });

    await runWithApiDispatch(dispatch, () =>
      call("/auth/signup", {
        method: "POST",
        body: { email: "a@b.test" },
        request: new Request("https://app.test/auth/signup", {
          headers: { cookie: "__Host-inkloom_session=abc" },
        }),
      }),
    );

    expect(seen).toBeDefined();
    expect(seen!.method).toBe("POST");
    expect(new URL(seen!.url).pathname).toBe("/api/v1/auth/signup");
    // Cookie forwarding is what makes the API see the same principal as the
    // browser; without it every server-side call is anonymous.
    expect(seen!.headers.get("cookie")).toBe("__Host-inkloom_session=abc");
    expect(await seen!.json()).toEqual({ email: "a@b.test" });
  });

  it("falls back to fetch when no dispatcher is in scope, so dev and tests are unchanged", async () => {
    const networkFetch = vi.fn(async () => ok(envelope({ id: "u_2" })));
    vi.stubGlobal("fetch", networkFetch);

    const result = await call<{ id: string }>("/me", {
      request: new Request("https://app.test/app"),
    });

    expect(result.data).toEqual({ id: "u_2" });
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });

  /*
   * The reason this is AsyncLocalStorage and not a module-level variable.
   *
   * One isolate serves many requests at once. A mutable module binding would
   * hand request A the services built for request B — a cross-request data
   * leak, and the kind that appears only under concurrency.
   */
  it("keeps dispatchers separate across concurrent requests", async () => {
    const a = vi.fn(async () => ok(envelope({ who: "a" })));
    const b = vi.fn(async () => ok(envelope({ who: "b" })));

    const [ra, rb] = await Promise.all([
      runWithApiDispatch(a, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return call<{ who: string }>("/me", { request: new Request("https://app.test/a") });
      }),
      runWithApiDispatch(b, () =>
        call<{ who: string }>("/me", { request: new Request("https://app.test/b") }),
      ),
    ]);

    expect(ra.data).toEqual({ who: "a" });
    expect(rb.data).toEqual({ who: "b" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not leak the dispatcher outside its run scope", async () => {
    const networkFetch = vi.fn(async () => ok(envelope(null)));
    vi.stubGlobal("fetch", networkFetch);
    const dispatch = vi.fn(async () => ok(envelope(null)));

    await runWithApiDispatch(dispatch, async () => {
      await call("/me", { request: new Request("https://app.test/a") });
    });
    await call("/me", { request: new Request("https://app.test/a") });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });
});

describe("the failure that started this", () => {
  /*
   * An empty 404 is precisely what an unrouted self-subrequest produces. The
   * envelope `call()` synthesises is what the user actually saw on the signup
   * form, so this asserts the observable symptom rather than the cause.
   */
  it("reports an unreadable response rather than throwing, when the body is empty", async () => {
    const dispatch = vi.fn(async () => new Response(null, { status: 404 }));

    const result = await runWithApiDispatch(dispatch, () =>
      call("/auth/signup", { method: "POST", request: new Request("https://app.test/x") }),
    );

    expect(result.error?.code).toBe("INTERNAL_ERROR");
    expect(result.status).toBe(404);
  });

  it("surfaces a real API error envelope untouched", async () => {
    const dispatch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: null,
          error: { code: "TURNSTILE_FAILED", message: "We couldn't verify that you're human." },
          requestId: "req_1",
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runWithApiDispatch(dispatch, () =>
      call("/auth/signup", { method: "POST", request: new Request("https://app.test/x") }),
    );

    expect(result.error?.code).toBe("TURNSTILE_FAILED");
    expect(result.status).toBe(403);
  });
});
