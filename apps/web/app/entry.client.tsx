/**
 * Client hydration entry.
 *
 * Explicit rather than relying on React Router's default, because this is the
 * one place client-side error reporting can be installed once for the whole
 * application (see the Sentry note in docs/OPERATIONS.md).
 *
 * A note on the CSP nonce, since it is easy to assume it belongs here:
 * `HydratedRouter` takes no `nonce` prop. The server applies the nonce to the
 * script tags it emits, and React does not re-render those during hydration, so
 * there is nothing for the client to match. In development you will still see
 * one hydration warning about `/@react-router/critical.css` — that link is
 * injected by the Vite dev server and does not exist in a production build.
 */
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
