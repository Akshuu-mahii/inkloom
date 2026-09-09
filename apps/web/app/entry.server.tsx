/**
 * Server rendering entry, for the Workers runtime.
 *
 * React Router's default server entry uses `renderToPipeableStream`, which is
 * Node-only — workerd has no Node streams. This entry uses
 * `renderToReadableStream`, the Web Streams renderer, so SSR works in the same
 * runtime that serves production.
 *
 * It is also where the per-request CSP nonce is applied. React Router injects
 * a small inline hydration script; giving it the nonce is what lets the policy
 * forbid inline script entirely rather than falling back to `unsafe-inline`.
 */
import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext, type RouterContextProvider } from "react-router";
import { isbot } from "isbot";
import { nonceContext } from "./lib/context";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
): Promise<Response> {
  const nonce = safeNonce(loadContext);

  let didError = false;

  const stream = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} nonce={nonce} />,
    {
      nonce,
      signal: request.signal,
      onError(error: unknown) {
        // Streaming has already begun by the time most render errors surface,
        // so the status can only be corrected for errors thrown in the shell.
        didError = true;
        // The one sanctioned console call on the client build: this runs before
        // any request-scoped logger exists.
        // eslint-disable-next-line no-restricted-syntax
        console.error(
          JSON.stringify({
            level: "error",
            msg: "ssr_render_error",
            url: request.url,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      },
    },
  );

  /**
   * Bots get the fully-buffered document.
   *
   * A crawler that receives a streamed shell may index it before the content
   * arrives, which would leave the marketing pages looking empty in search
   * results. Real visitors get the stream and a faster first paint.
   */
  if (isbot(request.headers.get("user-agent") ?? "")) {
    await stream.allReady;
  }

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");

  return new Response(stream, {
    status: didError ? 500 : responseStatusCode,
    headers: responseHeaders,
  });
}

/**
 * The nonce is set by the Worker on every document request. Tests and tooling
 * can render without one, so a missing value is not an error.
 */
function safeNonce(loadContext: RouterContextProvider): string | undefined {
  try {
    return loadContext.get(nonceContext);
  } catch {
    return undefined;
  }
}
