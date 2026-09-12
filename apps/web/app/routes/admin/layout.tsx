import { Link, NavLink, Outlet, redirect } from "react-router";
import type { Route } from "./+types/layout";
import { Logo } from "../../components/logo";
import { Notice } from "../../components/ui";
import { call, type Me } from "../../lib/api";
import { hasPermission, isAdminRole, toRole, type Permission } from "@inkloom/core/rbac";

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
export async function loader({ request }: Route.LoaderArgs) {
  const result = await call<Me>("/me", { request });

  if (result.status === 401 || !result.data) {
    /*
     * The PAGE path, not the data path. React Router appends `.data` when it
     * fetches a route's data client-side, so without this the address bar shows
     * `?next=%2Fapp%2Fsessions.data` and sign-in lands on raw JSON.
     */
    const path = new URL(request.url).pathname;
    const next = path.endsWith(".data") ? path.slice(0, -".data".length) : path;
    throw redirect(`/auth/login?next=${encodeURIComponent(next)}`);
  }

  const me = result.data;
  const role = toRole(me.role);

  /**
   * A non-admin is sent to the ordinary dashboard rather than shown a 403.
   *
   * The admin area's existence is not a secret — it is at a guessable URL — but
   * there is no reason to confirm to a prober that they found something real.
   */
  if (!isAdminRole(role)) {
    throw redirect("/app");
  }

  return { me, role, twoFactorReady: me.twoFactorEnabled };
}

interface NavItem {
  to: string;
  label: string;
  permission: Permission;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/admin", label: "Overview", permission: "admin.access", end: true },
  { to: "/admin/users", label: "Users", permission: "users.read" },
  { to: "/admin/access-codes", label: "Access codes", permission: "codes.read" },
  { to: "/admin/credits", label: "Credits", permission: "credits.read" },
  { to: "/admin/support", label: "Support", permission: "support.read" },
  { to: "/admin/audit", label: "Audit log", permission: "audit.read" },
  { to: "/admin/security", label: "Security", permission: "security.read" },
  { to: "/admin/settings", label: "Settings", permission: "settings.read" },
  { to: "/admin/system", label: "System", permission: "settings.read" },
];

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { me, role, twoFactorReady } = loaderData;

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
            <Link to="/admin" style={{ textDecoration: "none" }} aria-label="Inkloom admin">
              <Logo size={18} monochrome />
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
                <NavLink to={item.to} end={item.end} className="admin-nav-link">
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
