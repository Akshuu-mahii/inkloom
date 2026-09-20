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
        /*
         * The AI crawlers, named explicitly.
         *
         * `User-agent: *` already permits them, so this changes no behaviour —
         * it states an intention. Several of these bots are blocked by default
         * in the boilerplate robots.txt that ships with hosting platforms and
         * CMS templates, so an operator reading this file should be able to see
         * at a glance that the omission was a decision rather than an oversight.
         *
         * Inkloom is a new product with nothing to hide and everything to gain
         * from being readable: a model that has never read the site cannot
         * describe it, and being absent from an answer is worse than being
         * summarised imperfectly.
         */
        "# Answer engines and AI crawlers are welcome. See /llms.txt.",
        "User-agent: GPTBot",
        "Allow: /",
        "",
        "User-agent: OAI-SearchBot",
        "Allow: /",
        "",
        "User-agent: ChatGPT-User",
        "Allow: /",
        "",
        "User-agent: ClaudeBot",
        "Allow: /",
        "",
        "User-agent: Claude-Web",
        "Allow: /",
        "",
        "User-agent: PerplexityBot",
        "Allow: /",
        "",
        "User-agent: Google-Extended",
        "Allow: /",
        "",
        "User-agent: Applebot-Extended",
        "Allow: /",
        "",
        "User-agent: CCBot",
        "Allow: /",
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
