import { Link, Outlet } from "react-router";
import { Logo } from "../../components/logo";

/**
 * Authentication chrome.
 *
 * Deliberately minimal: no navigation, no marketing, no smooth scrolling. A
 * person on these pages has exactly one job, and every extra link is a chance
 * to lose them or to distract from a security-relevant decision.
 *
 * The left column carries the mark and one honest line about where the product
 * actually is; it collapses away entirely on small screens so the form is the
 * first and only thing on the page.
 */
export default function AuthLayout() {
  return (
    <div className="auth-shell">
      <aside className="auth-aside" aria-hidden="true">
        <div>
          {/* The panel is --color-ink, so the wordmark has to be the paper
              cut: the default renders ink letters that vanish entirely and
              leave a floating orange loop. */}
          <Logo size={22} invert />
          <p className="auth-aside-copy">
            Inkloom is building specialised models for logo design. Generation is not live yet —
            early access reserves your place and your credits.
          </p>
        </div>
        <p className="auth-aside-foot">Nothing here charges you. There is no card to add.</p>
      </aside>

      <main id="main" className="auth-main">
        <div className="auth-mark">
          <Link to="/" aria-label="Inkloom home" style={{ textDecoration: "none" }}>
            <Logo size={20} />
          </Link>
        </div>
        <div className="auth-body">
          <Outlet />
        </div>
        <footer className="auth-foot">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/contact">Support</Link>
        </footer>
      </main>

      <style>{`
        .auth-shell { min-height: 100dvh; display: grid; }
        .auth-aside { display: none; }
        .auth-main {
          display: flex; flex-direction: column;
          padding: 1.5rem; min-height: 100dvh;
        }
        .auth-mark { margin-bottom: 2.5rem; }
        .auth-body { flex: 1; width: 100%; max-width: 24rem; margin-inline: auto; }
        .auth-foot {
          display: flex; gap: 1.25rem; justify-content: center;
          padding-top: 2.5rem; font-size: var(--text-micro); color: var(--color-muted);
        }
        .auth-foot a { color: inherit; text-decoration: none; }
        .auth-foot a:hover { text-decoration: underline; }

        @media (min-width: 900px) {
          .auth-shell { grid-template-columns: 24rem 1fr; }
          .auth-aside {
            display: flex; flex-direction: column; justify-content: space-between;
            background: var(--color-ink); color: var(--color-paper);
            padding: 3rem 2.5rem;
          }
          .auth-aside-copy {
            margin-top: 2.5rem; font-size: var(--text-lead);
            line-height: 1.5; color: #b8b2a4; max-width: 26ch;
          }
          /* #6f6a60 measured 3.5:1 on the ink panel and failed AA; this is 5.1:1. */
          .auth-aside-foot { font-size: var(--text-fine); color: #8a857a; max-width: 28ch; }
          .auth-main { padding: 3rem; justify-content: center; }
          .auth-mark { display: none; }
          .auth-body { max-width: 26rem; margin-inline: 0; flex: none; }
          .auth-foot { justify-content: flex-start; padding-top: 3rem; }
        }
      `}</style>
    </div>
  );
}

/** Shared heading for every auth screen. */
export function AuthHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header style={{ marginBottom: "1.75rem" }}>
      <h1 style={{ fontSize: "var(--text-h3)" }}>{title}</h1>
      {children && <p style={{ marginTop: "0.625rem", color: "var(--color-muted)" }}>{children}</p>}
    </header>
  );
}
