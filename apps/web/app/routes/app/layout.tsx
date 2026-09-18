import { Link, NavLink, Outlet, redirect, useLocation } from "react-router";
import type { Route } from "./+types/layout";
import { Logo } from "../../components/logo";
import { call, type Me } from "../../lib/api";
import { formatCredits } from "../../components/ui";
import { servicesContext } from "../../lib/context";

/**
 * Dashboard shell.
 *
 * Calmer and faster than the marketing site by design: no Lenis, no GSAP, no
 * scroll-linked motion. This is a tool people open to check a balance, and
 * animation there is friction rather than delight.
 *
 * The session is resolved HERE, on the server, in a parent loader. Every child
 * route therefore renders only after the gate has passed, and a signed-out
 * visitor is redirected before a single byte of dashboard HTML is produced —
 * they never see a flash of shell.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { config } = context.get(servicesContext);
  const result = await call<Me>("/me", { request });

  if (result.status === 401 || !result.data) {
    // Round-trip the intended destination so the user lands where they meant
    // to. `safeRedirectPath` on the login side is what stops this being an
    // open-redirect vector.
    /*
     * The PAGE path, not the data path. React Router appends `.data` when it
     * fetches a route's data client-side, so without this the address bar shows
     * `?next=%2Fapp%2Fsessions.data` and sign-in lands on raw JSON.
     */
    const path = new URL(request.url).pathname;
    const next = path.endsWith(".data") ? path.slice(0, -".data".length) : path;
    throw redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }

  if (result.data.status === "suspended") {
    throw redirect("/auth/login?notice=suspended");
  }

  /*
   * The console's real mount point, for the staff link in the bar below.
   *
   * It has to come from this loader. `useAdminPath` reads the ADMIN layout's
   * data, and the dashboard is not inside that layout, so calling it here would
   * silently return its "/admin" fallback — which is exactly the bug this
   * replaces: the link was hardcoded to "/admin", and with a secret ADMIN_PATH
   * configured that is the decoy, which 404s on purpose. The one person allowed
   * into the console could not reach it by clicking the link built for them,
   * and only in a deployed environment, where the secret is actually set.
   *
   * Sent to every signed-in user, staff or not. The path is obscurity and
   * nothing more — every real control is re-checked server-side on each request
   * — but there is no reason to hand it to accounts that cannot use it, so the
   * value is only included when the role could plausibly need it.
   */
  const adminPath = result.data.role !== "user" ? config.ADMIN_PATH : null;

  return { me: result.data, adminPath };
}

const NAV = [
  { to: "/app", label: "Overview", end: true },
  { to: "/app/credits", label: "Credits" },
  { to: "/app/redeem", label: "Redeem a code" },
  { to: "/app/notifications", label: "Notifications" },
  { to: "/app/profile", label: "Profile" },
  { to: "/app/security", label: "Security" },
  { to: "/app/sessions", label: "Sessions" },
  { to: "/app/support", label: "Support" },
];

export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const { me, adminPath } = loaderData;
  const location = useLocation();

  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-bar-inner">
          {/*
            The mark goes HOME, not to the dashboard.
            
            It used to link to /app — the page you are already on — so from
            inside the dashboard there was no way back to the public site at
            all. A wordmark is the one control everyone expects to return them
            to the front door.
          */}
          <Link to="/" aria-label="Inkloom home" style={{ textDecoration: "none" }}>
            <Logo size={20} />
          </Link>

          <div className="app-bar-right">
            <span className="app-balance numeric" title="Your credit balance">
              {formatCredits(me.credits.balance)}
            </span>
            {/* Staff only. The link is hidden from ordinary users as a courtesy;
                the server refuses them regardless, which is the real control. */}
            {me.role !== "user" && adminPath && (
              <Link to={adminPath} className="app-admin-link">
                Admin
              </Link>
            )}
            {/* Posts to a route, not to the API: a native form post navigates
                to whatever it hits, and the API answers with JSON. */}
            <form method="post" action="/auth/sign-out">
              <button type="submit" className="btn btn-quiet app-signout">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      {!me.emailVerified && (
        <div className="app-banner" role="status">
          <span>
            Confirm your email address to redeem codes and receive credits.{" "}
            <Link to={`/auth/check-email?to=${encodeURIComponent(me.email)}`}>Resend the link</Link>
          </span>
        </div>
      )}

      <div className="app-body">
        <nav className="app-nav" aria-label="Dashboard">
          <ul>
              {/*
                Fetch on hover or keyboard focus, not on click.

                A dashboard tab is a client-side navigation that fetches the
                route's data before it can render, so the whole cost lands
                AFTER the click: measured on staging at ~840ms of server time
                plus ~135ms of network, which is exactly the "clicking a tab
                takes two seconds" complaint.

                `prefetch="intent"` starts that fetch when the pointer enters
                the link or it receives focus — typically a few hundred
                milliseconds of warning — so by the time the click lands the
                data is usually already there. It does not make the server
                faster; it moves the waiting to a moment when nobody is
                watching for it.

                The cost is some speculative requests for links people hover
                and never click. On a nav of eight items behind a login that is
                a good trade; it would not be on a public page with a hundred.
              */}
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  prefetch="intent"
                  className="app-nav-link"
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main id="main" className="app-main" key={location.pathname}>
          <Outlet context={{ me }} />
        </main>
      </div>

      {/*
        A quiet footer, mostly so there is a second way back to the public
        site. The dashboard had none: no footer, and a wordmark that linked to
        the page you were already on.
      */}
      <footer className="app-foot">
        <Link to="/">Back to inkloom.art</Link>
        <span aria-hidden="true">·</span>
        <Link to="/terms">Terms</Link>
        <span aria-hidden="true">·</span>
        <Link to="/privacy">Privacy</Link>
        <span aria-hidden="true">·</span>
        <Link to="/cookies">Cookies</Link>
        <span aria-hidden="true">·</span>
        <Link to="/contact">Support</Link>
      </footer>

      <style>{`
        .app-shell { min-height: 100dvh; display: flex; flex-direction: column; background: var(--color-paper); }
        .app-foot {
          border-top: 1px solid var(--color-rule); margin-top: auto;
          max-width: 78rem; width: 100%; margin-inline: auto;
          padding: 1.25rem 1.5rem; display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem;
          font-size: var(--text-fine); color: var(--color-muted);
        }
        .app-foot a { color: var(--color-muted); }
        .app-foot a:hover { color: var(--color-ink); }
        .app-bar { border-bottom: 1px solid var(--color-rule); background: var(--color-panel); }
        .app-bar-inner {
          max-width: 78rem; margin-inline: auto; padding: 0 1.5rem;
          min-height: 3.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem;
        }
        .app-bar-right { display: flex; align-items: center; gap: 1rem; }
        .app-balance {
          font-size: var(--text-fine); font-weight: 600;
          padding: 0.25rem 0.625rem; border: 1px solid var(--color-rule);
        }
        .app-admin-link {
          font-size: var(--text-fine); font-weight: 600; text-decoration: none;
          /* Type, so the readable orange — not the brand fill. */
          color: var(--color-loop-text);
        }
        .app-signout { min-height: 2rem; padding: 0.25rem 0.75rem; font-size: var(--text-fine); }
        .app-banner {
          background: var(--color-caution-wash); border-bottom: 1px solid var(--color-caution);
          color: var(--color-caution); font-size: var(--text-fine);
          padding: 0.625rem 1.5rem; text-align: center;
        }
        .app-body { flex: 1; max-width: 78rem; width: 100%; margin-inline: auto; padding: 0 1.5rem; }
        .app-nav { padding: 1rem 0; border-bottom: 1px solid var(--color-rule-soft); }
        .app-nav ul {
          list-style: none; margin: 0; padding: 0;
          display: flex; gap: 1.25rem; overflow-x: auto; -webkit-overflow-scrolling: touch;
        }
        .app-nav-link {
          display: block; white-space: nowrap; text-decoration: none;
          font-size: var(--text-fine); color: var(--color-muted);
          padding-bottom: 0.375rem; border-bottom: 2px solid transparent;
        }
        .app-nav-link.active { color: var(--color-ink); font-weight: 600; border-bottom-color: var(--color-loop); }
        .app-main { padding: 2rem 0 4rem; }

        @media (min-width: 900px) {
          .app-body { display: grid; grid-template-columns: 12rem 1fr; gap: 3rem; padding: 0 3rem; }
          .app-nav { border-bottom: none; border-right: 1px solid var(--color-rule-soft); padding: 2rem 0; }
          .app-nav ul { flex-direction: column; gap: 0.125rem; overflow: visible; }
          .app-nav-link { padding: 0.375rem 0; border-bottom: none; border-left: 2px solid transparent; padding-left: 0.75rem; margin-left: -0.75rem; }
          .app-nav-link.active { border-bottom-color: transparent; border-left-color: var(--color-loop); }
        }
      `}</style>
    </div>
  );
}
