import { Link, NavLink, Outlet, useLoaderData, useLocation } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/layout";
import { Logo } from "../../components/logo";
import { call, type Me } from "../../lib/api";

/**
 * Marketing chrome.
 *
 * Lenis smooth scroll is loaded HERE and nowhere else — the signed-in
 * dashboard keeps native scrolling, because smoothing hurts a tool people use
 * every day and interferes with assistive technology.
 *
 * It is also imported dynamically, so the library is not in the bundle that a
 * signed-in user downloads.
 */
/**
 * Is anyone signed in?
 *
 * The marketing pages had no loader at all, so the header always offered
 * "Sign in" and "Join early access" — to people who were already signed in and
 * one click from their dashboard. The session cookie is Path=/ and has been
 * sent with these requests all along; nothing was reading it.
 *
 * Deliberately tolerant: an anonymous visitor gets a 401 here, which is the
 * normal case and not an error. The marketing site must render for someone with
 * no account at all, so a failure to resolve a session is simply "signed out".
 */
export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<Me>("/me", { request });
  return {
    signedIn: Boolean(result.data?.email),
    displayName: result.data?.profile.displayName ?? result.data?.name ?? null,
  };
}

export default function MarketingLayout() {
  const { signedIn, displayName } = useLoaderData<typeof loader>();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    // Never smooth-scroll for someone who asked for reduced motion.
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) return;

    let lenis: { raf: (t: number) => void; destroy: () => void } | null = null;
    let frame = 0;
    let cancelled = false;

    void import("lenis").then(({ default: Lenis }) => {
      if (cancelled) return;
      lenis = new Lenis({
        duration: 1.05,
        // Never intercept touch: native momentum on mobile is better than
        // anything a library reproduces, and hijacking it breaks scroll-to-top
        // gestures.
        syncTouch: false,
        touchMultiplier: 1,
      });
      const raf = (time: number) => {
        lenis?.raf(time);
        frame = requestAnimationFrame(raf);
      };
      frame = requestAnimationFrame(raf);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      lenis?.destroy();
    };
  }, []);

  return (
    <>
      <SiteHeader
        menuOpen={menuOpen}
        onToggleMenu={() => setMenuOpen((open) => !open)}
        signedIn={signedIn}
        displayName={displayName}
      />
      <main id="main">
        <Outlet />
      </main>
      <SiteFooter />
    </>
  );
}

const NAV = [
  { to: "/examples", label: "Examples" },
  { to: "/how-it-works", label: "How it works" },
  { to: "/pricing", label: "Pricing" },
  { to: "/faq", label: "FAQ" },
];

function SiteHeader({
  menuOpen,
  onToggleMenu,
  signedIn,
  displayName,
}: {
  menuOpen: boolean;
  onToggleMenu: () => void;
  signedIn: boolean;
  displayName: string | null;
}) {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 40,
        background: "color-mix(in srgb, var(--color-paper) 88%, transparent)",
        backdropFilter: "blur(8px)",
        borderBottom: "1px solid var(--color-rule-soft)",
      }}
    >
      <div
        className="measure"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: "4rem",
          gap: "1rem",
        }}
      >
        <Link to="/" aria-label="Inkloom home" style={{ textDecoration: "none" }}>
          <Logo size={22} />
        </Link>

        <nav aria-label="Main" className="site-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              style={({ isActive }) => ({
                fontSize: "var(--text-fine)",
                fontWeight: 500,
                color: isActive ? "var(--color-ink)" : "var(--color-muted)",
                textDecoration: "none",
                paddingBottom: "0.125rem",
                borderBottom: `1px solid ${isActive ? "var(--color-ink)" : "transparent"}`,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="site-actions">
          {signedIn ? (
            <Link
              to="/app"
              className="btn btn-ink"
              style={{ minHeight: "2.25rem", padding: "0.375rem 1rem" }}
            >
              {displayName ? `Go to dashboard` : "Dashboard"}
            </Link>
          ) : (
            <>
              <Link
                to="/auth/login"
                style={{
                  fontSize: "var(--text-fine)",
                  fontWeight: 500,
                  color: "var(--color-ink)",
                  textDecoration: "none",
                }}
              >
                Sign in
              </Link>
              <Link
                to="/auth/signup"
                className="btn btn-ink"
                style={{ minHeight: "2.25rem", padding: "0.375rem 1rem" }}
              >
                Join early access
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          className="menu-toggle btn btn-quiet"
          onClick={onToggleMenu}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          /* 44px minimum: the WCAG 2.1 target-size guidance, and the smallest
             thing a thumb reliably hits. The inherited `.btn` height was
             overridden down to 40px here, which the mobile test caught. */
          style={{ minHeight: "2.75rem", padding: "0.5rem 0.875rem" }}
        >
          {menuOpen ? "Close" : "Menu"}
        </button>
      </div>

      {menuOpen && (
        <nav
          id="mobile-nav"
          aria-label="Main"
          style={{
            borderTop: "1px solid var(--color-rule-soft)",
            padding: "1rem 1.5rem 1.5rem",
            display: "grid",
            gap: "0.25rem",
            background: "var(--color-paper)",
          }}
        >
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              style={{
                padding: "0.75rem 0",
                fontSize: "var(--text-lead)",
                textDecoration: "none",
                borderBottom: "1px solid var(--color-rule-soft)",
              }}
            >
              {item.label}
            </Link>
          ))}
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            {signedIn ? (
              <Link to="/app" className="btn btn-ink" style={{ flex: 1 }}>
                Go to dashboard
              </Link>
            ) : (
              <>
                <Link to="/auth/login" className="btn btn-quiet" style={{ flex: 1 }}>
                  Sign in
                </Link>
                <Link to="/auth/signup" className="btn btn-ink" style={{ flex: 1 }}>
                  Join early access
                </Link>
              </>
            )}
          </div>
        </nav>
      )}

      <style>{`
        .site-nav { display: none; gap: 1.75rem; }
        .site-actions { display: none; gap: 1.25rem; align-items: center; }
        .menu-toggle { display: inline-flex; }
        @media (min-width: 860px) {
          .site-nav { display: flex; }
          .site-actions { display: flex; }
          .menu-toggle { display: none; }
        }
      `}</style>
    </header>
  );
}

const FOOTER_GROUPS = [
  {
    heading: "Product",
    links: [
      { to: "/examples", label: "Examples" },
      { to: "/how-it-works", label: "How it works" },
      { to: "/pricing", label: "Pricing" },
      { to: "/early-access", label: "Early access" },
    ],
  },
  {
    heading: "Company",
    links: [
      { to: "/about", label: "About" },
      { to: "/contact", label: "Contact" },
      { to: "/faq", label: "FAQ" },
      { to: "/security", label: "Security" },
    ],
  },
  {
    heading: "Legal",
    links: [
      { to: "/terms", label: "Terms" },
      { to: "/privacy", label: "Privacy" },
      { to: "/cookies", label: "Cookies" },
      { to: "/acceptable-use", label: "Acceptable use" },
    ],
  },
];

function SiteFooter() {
  return (
    <footer style={{ borderTop: "1px solid var(--color-rule)", marginTop: "6rem" }}>
      <div className="measure" style={{ paddingBlock: "3.5rem 2rem" }}>
        <div
          style={{
            display: "grid",
            gap: "2.5rem",
            gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
          }}
        >
          <div>
            <Logo size={20} />
            <p
              style={{
                marginTop: "1rem",
                fontSize: "var(--text-fine)",
                color: "var(--color-muted)",
                maxWidth: "18rem",
              }}
            >
              Specialised AI models for logo design. In development — join early access to be among
              the first to use them.
            </p>
          </div>

          {FOOTER_GROUPS.map((group) => (
            <nav key={group.heading} aria-labelledby={`footer-${group.heading}`}>
              <h2
                id={`footer-${group.heading}`}
                style={{
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--text-fine)",
                  fontWeight: 600,
                  letterSpacing: 0,
                  marginBottom: "0.75rem",
                }}
              >
                {group.heading}
              </h2>
              <ul
                style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "0.5rem" }}
              >
                {group.links.map((link) => (
                  <li key={link.to}>
                    <Link
                      to={link.to}
                      style={{
                        fontSize: "var(--text-fine)",
                        color: "var(--color-muted)",
                        textDecoration: "none",
                      }}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <hr className="rule" style={{ marginTop: "3rem" }} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "1rem",
            flexWrap: "wrap",
            paddingTop: "1.5rem",
            fontSize: "var(--text-micro)",
            color: "var(--color-muted)",
          }}
        >
          <p style={{ maxWidth: "none" }}>© {new Date().getFullYear()} Inkloom</p>
          <p style={{ maxWidth: "none" }}>
            Logo generation is not live yet. Early-access credits are promotional.
          </p>
        </div>
      </div>
    </footer>
  );
}
