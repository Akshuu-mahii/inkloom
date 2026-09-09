import type { Route } from "./+types/robots";
import { servicesContext } from "../../lib/context";

/**
 * robots.txt, generated rather than static.
 *
 * Generated because the sitemap URL and the disallow list have to match the
 * real routes and the real origin, and a hand-maintained file drifts. Staging
 * gets a blanket disallow, so a preview deployment can never outrank
 * production or leak an unfinished page into search results.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { config } = context.get(servicesContext);
  const origin = config.origin;

  const body = config.isProduction
    ? [
        "User-agent: *",
        "Allow: /",
        "",
        "# Private areas. Also noindex'd at the page level and behind auth.",
        "Disallow: /app",
        "Disallow: /admin",
        "Disallow: /auth",
        "Disallow: /api",
        "",
        "# Common crawl traps",
        "Disallow: /*?cursor=",
        "",
        `Sitemap: ${origin}/sitemap.xml`,
        "",
      ].join("\n")
    : [
        "# Non-production environment: nothing here should be indexed.",
        "User-agent: *",
        "Disallow: /",
        "",
      ].join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
