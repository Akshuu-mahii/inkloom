import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";
import type { Route } from "./+types/root";
import { Logo } from "./components/logo";
import "./app.css";

/**
 * Preload the two variable fonts.
 *
 * Both are render-blocking for the first meaningful paint, so fetching them in
 * parallel with the CSS avoids a flash of fallback text and the layout shift
 * that comes with it. `font-display: swap` covers the case where they are slow.
 */
export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: "/fonts/jost-latin.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  {
    rel: "preload",
    href: "/fonts/instrument-sans-latin.woff2",
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/icon-192.png" },
  { rel: "manifest", href: "/site.webmanifest" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#F1EDE3" />
        <Meta />
        <Links />
      </head>
      <body>
        {/* First thing in the tab order, so a keyboard user can jump the nav. */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  /**
   * Marks the document as hydrated.
   *
   * Server-rendered inputs are in the DOM long before the JavaScript that owns
   * them has run, so anything automating this app — the end-to-end suite, a
   * synthetic monitor — needs a truthful "interactive now" signal rather than
   * an arbitrary sleep. This effect fires on the hydration commit, which is
   * exactly that moment.
   */
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return <Outlet />;
}

/**
 * The error boundary.
 *
 * Shows a stack trace ONLY in development. In production a visitor gets a plain
 * apology and nothing about the internals — the detail is in the server log,
 * findable by the request id.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const isDev = import.meta.env.DEV;

  let title = "Something went wrong";
  let message = "The page could not be loaded. Try again in a moment.";
  let status = 500;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (error.status === 404) {
      title = "Page not found";
      message = "That page doesn't exist. It may have moved, or the link may be wrong.";
    } else if (error.status === 401 || error.status === 403) {
      title = "You don't have access to that";
      message = "Sign in with an account that has permission, or head back to the homepage.";
    } else {
      title = "Something went wrong";
      message = error.statusText || message;
    }
  }

  return (
    <main
      id="main"
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: "2rem 1.5rem",
      }}
    >
      <div style={{ maxWidth: "34rem", width: "100%" }}>
        <Logo size={22} />
        <p
          className="numeric"
          style={{
            marginTop: "3rem",
            fontFamily: "var(--font-display)",
            fontSize: "var(--text-h1)",
            lineHeight: 1,
            color: "var(--color-faint)",
          }}
        >
          {status}
        </p>
        <h1 style={{ fontSize: "var(--text-h2)", marginTop: "0.75rem" }}>{title}</h1>
        <p style={{ marginTop: "1rem", color: "var(--color-muted)", fontSize: "var(--text-lead)" }}>
          {message}
        </p>

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "2rem", flexWrap: "wrap" }}>
          <a href="/" className="btn btn-ink">
            Back to homepage
          </a>
          <a href="/contact" className="btn btn-quiet">
            Contact support
          </a>
        </div>

        {isDev && error instanceof Error && (
          <pre
            style={{
              marginTop: "2.5rem",
              padding: "1rem",
              background: "var(--color-panel)",
              border: "1px solid var(--color-rule)",
              overflowX: "auto",
              fontSize: "var(--text-fine)",
              lineHeight: 1.5,
            }}
          >
            {error.stack}
          </pre>
        )}
      </div>
    </main>
  );
}
