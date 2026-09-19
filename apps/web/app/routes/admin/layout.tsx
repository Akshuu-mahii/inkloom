import { data, Link, NavLink, Outlet } from "react-router";
import type { Route } from "./+types/layout";
import { Logo } from "../../components/logo";
import { Notice } from "../../components/ui";
import { call, type Me } from "../../lib/api";
import { servicesContext } from "../../lib/context";
import { hasPermission, toRole, type Permission } from "@inkloom/core/rbac";

/**
 * Admin shell.
 *
 * THREE independent gates, because this is the part of the system where a
 * mistake is most expensive:
 *
 *   1. This loader refuses anyone without an admin role, so no admin HTML is
 *      ever produced for an ordinary user.
 *   2. Every admin API endpoint re-checks the permission server-side. The UI
 *      gate is a courtesy; the API gate is the control.
 *   3. Mandatory 2FA — an admin who has not enrolled gets a wall, not a
 *      dashboard, because `requirePermission` will reject their API calls
 *      anyway and a half-working admin panel is worse than an honest block.
 *
 * The navigation is filtered by permission, so a `support` user is not shown
 * links to pages that would refuse them. That is UX, not security.
 */
/**
 * One response for every way of not being allowed in.
 *
 * Signed out, signed in as an ordinary user, holding a staff role but not the
 * owner, or staff who have not enrolled a second factor — all four get this,
 * byte for byte, with a 403 and no loader data. Distinguishing them would hand
 * a prober a free oracle: "wrong password" versus "not an admin" versus "not
 * the owner" maps out both the gate and who sits behind it.
 *
 * It carries no navigation, no account details and no hint of what is behind
 * it. `restricted: true` is the ONLY thing the network response contains, so
 * there is nothing to read out of the payload either.
 */
function restricted(): never {
  throw data({ restricted: true } as const, {
    status: 403,
    headers: { "cache-control": "no-store" },
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { config, logger } = context.get(servicesContext);
  const result = await call<Me>("/me", { request });

  if (result.status === 401 || !result.data) restricted();

  const me = result.data;

  /*
   * One flag, computed server-side, covering role + owner + 2FA together.
   *
   * This is the page-level courtesy gate; the API re-checks every part of it
   * and is the actual control. It matters anyway: without it the console's
   * shell would render for anyone signed in, and a shell whose every data call
   * then fails is both a worse experience and a much louder signal that
   * something real is here.
   */
  if (!me.canAccessAdmin) restricted();

  /*
   * The console's own mount point, handed to the component.
   *
   * Every link below is built from this rather than a literal "/admin". With a
   * secret ADMIN_PATH configured, a hardcoded link would point at the decoy
   * that now returns 404 — so the navigation would break for the one person
   * allowed to use it, and only in production, where the secret is set.
   */
  /*
   * Two sources for one prefix, and they are allowed to disagree quietly.
   *
   * `routes.ts` reads `.env` at BUILD time to decide where these pages are
   * mounted; this loader reads the Worker's RUNTIME environment to decide what
   * to link to. A deploy feeds both from one secret. Locally they are separate
   * files — `.env` and `apps/web/.dev.vars` — so setting only the first serves
   * the console from a secret path while every link inside it points at
   * `/admin`, the decoy that returns 404.
   *
   * The symptom is maddening precisely because the console looks fine: it
   * renders, it loads data, and only navigation is broken. So say so, once,
   * with the fix in the message. Development only — in a deployed environment
   * the two cannot diverge, and a log line naming the real prefix would be a
   * gift to anyone reading logs.
   */
  const builtAt = typeof __ADMIN_PREFIX_AT_BUILD__ === "string" ? __ADMIN_PREFIX_AT_BUILD__ : null;
  if (config.isDevelopment && builtAt && builtAt !== config.ADMIN_PATH) {
    logger.warn("admin_path_mismatch", {
      mountedAt: builtAt,
      workerThinks: config.ADMIN_PATH,
      fix:
        "Set ADMIN_PATH to the same value in BOTH .env (read by routes.ts at build time) " +
        "and apps/web/.dev.vars (read by the Worker), then restart the dev server.",
    });
  }

  return {
    me,
    role: toRole(me.role),
    twoFactorReady: me.twoFactorEnabled,
    /*
     * The BUILD-time prefix in development, the runtime one everywhere else.
     *
     * Links have to match where the routes actually are, and in development
     * that is whatever `routes.ts` read from `.env`. Using the runtime value
     * there would produce links to a prefix that has no routes behind it.
     */
    adminPath: config.isDevelopment && builtAt ? builtAt : config.ADMIN_PATH,
  };
}

/**
 * What an unauthorized visitor sees.
 *
 * Deliberately empty of information: no product name beyond the mark, no
 * navigation, no mention of an admin area, no way to tell whether the address
 * is real. Someone who arrived by guessing learns nothing; the owner, who knows
 * where they are, will recognise it as a session that needs re-establishing.
 */
export function ErrorBoundary() {
  return (
    <main className="restricted-shell">
      <div className="restricted-card">
        <Logo size={34} />
        <h1>Restricted</h1>
        <p>
          This area requires authorisation. If you believe you should have access, sign in and try
          again.
        </p>
        <Link to="/" className="btn btn-outline">
          Return to Inkloom
        </Link>
      </div>
      <style>{`
        .restricted-shell {
          min-height: 70vh; display: grid; place-items: center; padding: 3rem 1.5rem;
        }
        .restricted-card {
          max-width: 26rem; text-align: center;
          display: flex; flex-direction: column; align-items: center; gap: 1rem;
        }
        .restricted-card h1 {
          font-size: 1.5rem; margin: 0; letter-spacing: -0.01em;
        }
        .restricted-card p { margin: 0; color: var(--color-muted); }
      `}</style>
    </main>
  );
}

interface NavItem {
  to: string;
  label: string;
  permission: Permission;
  end?: boolean;
}

/** Paths are relative to the console's mount point, never absolute. */
const NAV: NavItem[] = [
  { to: "", label: "Overview", permission: "admin.access", end: true },
  { to: "users", label: "Users", permission: "users.read" },
  { to: "access-codes", label: "Access codes", permission: "codes.read" },
  { to: "credits", label: "Credits", permission: "credits.read" },
  { to: "activity", label: "Activity", permission: "admin.overview.read" },
  { to: "emails", label: "Emails", permission: "admin.overview.read" },
  { to: "performance", label: "Performance", permission: "admin.overview.read" },
  { to: "infrastructure", label: "Infrastructure", permission: "admin.overview.read" },
  { to: "support", label: "Support", permission: "support.read" },
  { to: "audit", label: "Audit log", permission: "audit.read" },
  { to: "security", label: "Security", permission: "security.read" },
  { to: "settings", label: "Settings", permission: "settings.read" },
  { to: "system", label: "System", permission: "settings.read" },
  { to: "recovery", label: "Recovery", permission: "settings.read" },
];

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { me, role, twoFactorReady, adminPath } = loaderData;

  if (!twoFactorReady) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "2rem" }}>
        <div style={{ maxWidth: "32rem" }}>
          <Logo size={22} />
          <h1 style={{ fontSize: "var(--text-h2)", marginTop: "2.5rem" }}>
            Two-factor authentication required
          </h1>
          <p
            style={{ marginTop: "1rem", color: "var(--color-muted)", fontSize: "var(--text-lead)" }}
          >
            Staff accounts must use a second factor. Until you enrol, every admin request will be
            refused — that check lives in the API, so there is nothing to work around here.
          </p>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "2rem", flexWrap: "wrap" }}>
            <Link to="/app/security" className="btn btn-primary">
              Set up two-factor now
            </Link>
            <Link to="/app" className="btn btn-quiet">
              Back to my dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const visible = NAV.filter((item) => hasPermission(role, item.permission));

  return (
    <div className="admin-shell">
      <header className="admin-bar">
        <div className="admin-bar-inner">
          <div style={{ display: "flex", alignItems: "center", gap: "0.875rem" }}>
            <Link to={adminPath} style={{ textDecoration: "none" }} aria-label="Inkloom admin">
              {/* Paper letters: the admin bar is ink, and the mono wordmark
                  is ink too — it was invisible against it. */}
              <Logo size={18} invert />
            </Link>
            <span className="admin-tag">Admin</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <span className="admin-role" title="Your role determines what you can do">
              {role.replace("_", " ")}
            </span>
            <Link to="/app" className="admin-exit">
              Exit admin
            </Link>
          </div>
        </div>
      </header>

      <div className="admin-body">
        <nav className="admin-nav" aria-label="Admin">
          <ul>
            {visible.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to ? `${adminPath}/${item.to}` : adminPath}
                  end={item.end}
                  /*
                   * Same reasoning as the dashboard nav: the console's pages are
                   * its slowest (measured at ~1,050ms server time), and every
                   * millisecond of that lands after the click. Hovering a tab
                   * starts the fetch early.
                   */
                  prefetch="intent"
                  className="admin-nav-link"
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <main id="main" className="admin-main">
          {role !== "super_admin" && (
            <div style={{ marginBottom: "1.5rem" }}>
              <Notice tone="info">
                You are signed in as <strong>{role.replace("_", " ")}</strong>. Creating campaigns,
                adjusting credits, changing roles and system settings are reserved to a super admin.
              </Notice>
            </div>
          )}
          <Outlet context={{ me, role }} />
        </main>
      </div>

      <style>{`
        .admin-shell { min-height: 100dvh; background: var(--color-paper); }
        .admin-bar { background: var(--color-ink); color: var(--color-paper); }
        .admin-bar-inner {
          max-width: 96rem; margin-inline: auto; padding: 0 1.5rem;
          min-height: 3rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem;
        }
        .admin-tag {
          font-size: var(--text-micro); font-weight: 600; letter-spacing: 0.02em;
          border: 1px solid #3a3630; padding: 0.125rem 0.5rem; color: var(--color-loop);
        }
        .admin-role { font-size: var(--text-micro); color: #b8b2a4; text-transform: capitalize; }
        .admin-exit { font-size: var(--text-fine); color: var(--color-paper); text-decoration: none; }
        .admin-exit:hover { text-decoration: underline; }
        .admin-body { max-width: 96rem; margin-inline: auto; padding: 0 1.5rem; }
        .admin-nav { padding: 0.875rem 0; border-bottom: 1px solid var(--color-rule); }
        .admin-nav ul {
          list-style: none; margin: 0; padding: 0; display: flex; gap: 1.125rem;
          overflow-x: auto; -webkit-overflow-scrolling: touch;
        }
        .admin-nav-link {
          white-space: nowrap; text-decoration: none; font-size: var(--text-fine);
          color: var(--color-muted); padding-bottom: 0.25rem; border-bottom: 2px solid transparent;
        }
        .admin-nav-link.active { color: var(--color-ink); font-weight: 600; border-bottom-color: var(--color-loop); }
        .admin-main { padding: 2rem 0 4rem; }
        @media (min-width: 1000px) { .admin-body { padding: 0 2.5rem; } }
      `}</style>
    </div>
  );
}
