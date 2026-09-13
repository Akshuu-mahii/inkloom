/**
 * Where the console is mounted, for building links inside it.
 *
 * The admin prefix is a deployment secret (`ADMIN_PATH`), so no page may write
 * "/admin/users" literally: with a secret path configured that string points at
 * the decoy, which deliberately returns 404. Every in-console link is built
 * through `adminUrl` instead.
 *
 * The value is read from the admin layout's loader data rather than threaded
 * through every page's own loader. That keeps pages unchanged when the prefix
 * changes, and there is exactly one place the real value comes from.
 *
 * IMPORTANT — this is for PAGE links only. API calls stay `/admin/...`: those
 * are `/api/v1/admin/...` on the server and have nothing to do with where the
 * browser-facing console happens to be mounted. Rewriting those too was the
 * obvious mistake here, and it would have broken every data call in the console.
 */
import { useRouteLoaderData } from "react-router";

const LAYOUT_ROUTE_ID = "routes/admin/layout";

/** The console's mount point, e.g. "/admin" or "/internal-admin-7f3a91". */
export function useAdminPath(): string {
  const data = useRouteLoaderData(LAYOUT_ROUTE_ID) as { adminPath?: string } | undefined;
  /*
   * Falls back to "/admin" rather than throwing.
   *
   * A missing layout loader means this is being rendered outside the console —
   * a story, a test, an error boundary — and a broken link there is a far
   * smaller problem than a crash. When the layout is present, which is every
   * real case, the configured value is always used.
   */
  return data?.adminPath ?? "/admin";
}

/** Join the console's mount point with a path inside it. */
export function adminUrl(adminPath: string, within = ""): string {
  if (!within) return adminPath;
  return `${adminPath}/${within.replace(/^\//, "")}`;
}
