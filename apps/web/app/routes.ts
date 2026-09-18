import { type RouteConfig, index, layout, prefix, route } from "@react-router/dev/routes";
import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Route manifest.
 *
 * Three layouts, because the three areas have genuinely different jobs:
 *
 *   marketing  animated, public, indexed
 *   auth       minimal chrome, no navigation to distract from the one task
 *   app        calm, dense, signed-in, noindex
 *   admin      densest, staff only, gated server-side in every loader
 *
 * The admin routes are declared here but every one of them re-checks
 * permission on the SERVER. Route configuration is not access control.
 */
/**
 * Where the admin console is mounted.
 *
 * Read at BUILD time from `ADMIN_PATH`, so React Router's own route table
 * carries the secret segment. That matters: every `<Link>` and redirect the
 * console generates is then correct by construction. Rewriting the path inside
 * the Worker instead would leave the router believing it lived at /admin, and
 * every link it rendered would point at a URL that no longer resolves.
 *
 * The cost is that rotating the path is a redeploy rather than a secret change.
 * That is the right trade for something that is an obscurity layer and never
 * the authorization: it is rotated rarely, and authorization is re-checked
 * server-side on every request regardless of which path got there.
 *
 * WHY THIS LOADS .env ITSELF, AND WHY IT REFUSES TO GUESS
 * ------------------------------------------------------
 * `ADMIN_PATH` is a Cloudflare SECRET, which exists only at runtime. A deploy
 * that does not also put it in the BUILD environment produces a route table
 * mounted at `/admin` while the Worker believes the console lives somewhere
 * else — and the Worker then 404s `/admin` as a decoy. Both doors end up
 * locked and the console becomes unreachable, with the API still working
 * perfectly so nothing else looks wrong.
 *
 * That shipped. It survived a full security pass because the live suite
 * asserted `/admin` returns 404, which is exactly what a correctly-hidden
 * console AND a completely broken one both do.
 *
 * So: load `.env` for local builds, and REFUSE to build a deployed environment
 * without the value rather than silently falling back to `/admin`.
 */
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"), quiet: true });

const DEPLOYED = ["staging", "production"];
const targetEnv = process.env.CLOUDFLARE_ENV ?? "";

if (DEPLOYED.includes(targetEnv) && !process.env.ADMIN_PATH) {
  throw new Error(
    `ADMIN_PATH is required to build for "${targetEnv}".\n\n` +
      "Without it the admin console is built at /admin, which the Worker then\n" +
      "404s as a decoy — leaving the console unreachable at every path.\n\n" +
      "Set it in .env for a local deploy, or as a build-step secret in CI. It\n" +
      "must match the ADMIN_PATH secret configured on the Worker.",
  );
}

const ADMIN_PREFIX = (process.env.ADMIN_PATH ?? "/admin").replace(/^\//, "") || "admin";

export default [
  // --- Marketing ---------------------------------------------------------
  layout("routes/marketing/layout.tsx", [
    index("routes/marketing/home.tsx"),
    route("how-it-works", "routes/marketing/how-it-works.tsx"),
    route("early-access", "routes/marketing/early-access.tsx"),
    route("pricing", "routes/marketing/pricing.tsx"),
    route("faq", "routes/marketing/faq.tsx"),
    route("about", "routes/marketing/about.tsx"),
    route("contact", "routes/marketing/contact.tsx"),
    route("security", "routes/marketing/security.tsx"),
    route("privacy", "routes/marketing/legal.privacy.tsx"),
    route("terms", "routes/marketing/legal.terms.tsx"),
    route("cookies", "routes/marketing/legal.cookies.tsx"),
    route("acceptable-use", "routes/marketing/legal.acceptable-use.tsx"),
  ]),

  // --- Authentication ----------------------------------------------------
  layout("routes/auth/layout.tsx", [
    ...prefix("auth", [
      route("signup", "routes/auth/signup.tsx"),
      route("login", "routes/auth/login.tsx"),
      route("verify-email", "routes/auth/verify-email.tsx"),
      route("check-email", "routes/auth/check-email.tsx"),
      route("forgot-password", "routes/auth/forgot-password.tsx"),
      route("reset-password", "routes/auth/reset-password.tsx"),
      route("two-factor", "routes/auth/two-factor.tsx"),
      route("error", "routes/auth/error.tsx"),
    ]),
  ]),

  /*
   * Sign-out sits OUTSIDE the auth layout: it renders nothing, it only acts.
   * Putting it in the layout would load that layout's chrome for a request
   * whose entire job is to answer with a redirect.
   */
  ...prefix("auth", [
    route("sign-out", "routes/auth/sign-out.tsx"),
    route("google", "routes/auth/google.tsx"),
  ]),

  // --- Signed-in dashboard ------------------------------------------------
  layout("routes/app/layout.tsx", [
    ...prefix("app", [
      index("routes/app/home.tsx"),
      route("profile", "routes/app/profile.tsx"),
      route("security", "routes/app/security.tsx"),
      route("sessions", "routes/app/sessions.tsx"),
      route("credits", "routes/app/credits.tsx"),
      route("redeem", "routes/app/redeem.tsx"),
      route("notifications", "routes/app/notifications.tsx"),
      route("support", "routes/app/support.tsx"),
    ]),
  ]),

  // --- Admin --------------------------------------------------------------
  layout("routes/admin/layout.tsx", [
    ...prefix(ADMIN_PREFIX, [
      index("routes/admin/overview.tsx"),
      route("users", "routes/admin/users.tsx"),
      route("users/:id", "routes/admin/user-detail.tsx"),
      route("access-codes", "routes/admin/campaigns.tsx"),
      route("access-codes/new", "routes/admin/campaign-new.tsx"),
      route("access-codes/:id", "routes/admin/campaign-detail.tsx"),
      route("credits", "routes/admin/credits.tsx"),
      route("activity", "routes/admin/activity.tsx"),
      route("emails", "routes/admin/emails.tsx"),
      route("performance", "routes/admin/performance.tsx"),
      route("infrastructure", "routes/admin/infrastructure.tsx"),
      route("audit", "routes/admin/audit.tsx"),
      route("security", "routes/admin/security.tsx"),
      route("support", "routes/admin/support.tsx"),
      route("settings", "routes/admin/settings.tsx"),
      route("system", "routes/admin/system.tsx"),
      route("recovery", "routes/admin/recovery.tsx"),
    ]),
  ]),

  // --- Machine-readable, served from the app so they stay in step with it --
  route("robots.txt", "routes/well-known/robots.ts"),
  route("sitemap.xml", "routes/well-known/sitemap.ts"),

  // --- 404 ----------------------------------------------------------------
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;
