/**
 * How a loader or action reaches the API when it is already inside the Worker.
 *
 * The obvious implementation — `fetch("https://this-app/api/v1/...")` from a
 * server action — does not work on Cloudflare Workers, and fails in a way that
 * gives almost nothing away. A Worker's subrequest to its OWN hostname is not
 * routed back into the Worker: it goes to the asset handler instead, which has
 * no such file, and with `not_found_handling: "none"` answers with an empty
 * 404. `response.json()` then throws and every call site reports "the server
 * sent an unreadable response". No exception, no log line, nothing in the tail
 * output but a 200 on the document itself.
 *
 * It survived every local check because Vite's dev server DOES loop a
 * same-origin fetch back to itself, so signup, login, the whole /app area and
 * the entire admin console worked perfectly in development and were broken the
 * moment they were deployed.
 *
 * So: when we are inside the Worker, dispatch straight to the Hono app in the
 * same isolate. No socket, no edge round trip, and the API's own middleware —
 * origin check, rate limit, auth — still runs, because this calls the real
 * app's `fetch`, not past it.
 *
 * AsyncLocalStorage rather than a module-level variable: one isolate serves
 * many requests concurrently, and a mutable module binding would hand request A
 * the services built for request B — a cross-request data leak. The store is
 * scoped to one `run()` and cannot escape it.
 *
 * `.server.ts` is load-bearing. `call()` runs on the server today, but nothing
 * structurally stops someone importing it into a component, and `node:async_hooks`
 * in the browser bundle would be the 144KB-server-code-in-the-client bug again.
 * The suffix makes Vite fail the build instead.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Hands a Request to the API app and returns its Response, in-process. */
export type ApiDispatch = (request: Request) => Promise<Response>;

const storage = new AsyncLocalStorage<ApiDispatch>();

/** Run `fn` with an in-process API dispatcher available to everything it calls. */
export function runWithApiDispatch<T>(dispatch: ApiDispatch, fn: () => T): T {
  return storage.run(dispatch, fn);
}

/**
 * The dispatcher for the request in flight, if there is one.
 *
 * `undefined` outside a Worker request — the Vite dev server, unit tests, the
 * cron handler — and callers fall back to a network fetch, which is correct in
 * every one of those places.
 */
export function currentApiDispatch(): ApiDispatch | undefined {
  return storage.getStore();
}
