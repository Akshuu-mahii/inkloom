import { Link } from "react-router";
import type { Route } from "./+types/not-found";
import { Logo } from "../components/logo";
import { buildMeta } from "../lib/seo";

export function meta({ location }: Route.MetaArgs) {
  return buildMeta({
    title: "Page not found",
    description: "That page doesn't exist.",
    path: location.pathname,
    noindex: true,
  });
}

/**
 * The 404.
 *
 * Returns a real 404 status, not a 200 with 404-looking content — a soft 404
 * gets indexed and pollutes search results.
 */
export async function loader() {
  throw new Response("Not Found", { status: 404 });
}

export default function NotFound() {
  return null;
}

/**
 * Rendered for the thrown 404 above, and for any unmatched route.
 * An empty screen is an invitation to act, so it offers the likely destinations.
 */
export function ErrorBoundary() {
  return (
    <main
      id="main"
      style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "2rem 1.5rem" }}
    >
      <div style={{ maxWidth: "34rem", width: "100%" }}>
        <Link to="/" style={{ textDecoration: "none" }} aria-label="Inkloom home">
          <Logo size={22} />
        </Link>

        <p
          className="numeric"
          style={{
            marginTop: "3rem",
            fontFamily: "var(--font-display)",
            fontSize: "var(--text-hero)",
            lineHeight: 1,
            letterSpacing: "-0.04em",
            color: "var(--color-faint)",
          }}
        >
          404
        </p>

        <h1 style={{ fontSize: "var(--text-h2)", marginTop: "0.5rem" }}>
          That page isn&rsquo;t here
        </h1>
        <p style={{ marginTop: "1rem", color: "var(--color-muted)", fontSize: "var(--text-lead)" }}>
          It may have moved, or the link may be wrong. Here is where most people are heading:
        </p>

        <nav
          aria-label="Suggested pages"
          style={{ marginTop: "2rem", borderTop: "1px solid var(--color-rule)" }}
        >
          {(
            [
              ["/", "Homepage"],
              ["/how-it-works", "How Inkloom will work"],
              ["/auth/login", "Sign in"],
              ["/contact", "Contact support"],
            ] as const
          ).map(([to, label]) => (
            <Link
              key={to}
              to={to}
              style={{
                display: "block",
                padding: "0.875rem 0",
                borderBottom: "1px solid var(--color-rule-soft)",
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
