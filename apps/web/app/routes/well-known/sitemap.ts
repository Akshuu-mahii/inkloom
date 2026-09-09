import type { Route } from "./+types/sitemap";
import { servicesContext } from "../../lib/context";

/**
 * XML sitemap.
 *
 * Lists ONLY public, indexable pages. Authenticated and auth-flow routes are
 * deliberately absent: they carry `noindex`, and listing them in a sitemap
 * while asking robots not to index them is a contradiction search engines
 * report as an error.
 */
const PUBLIC_ROUTES: Array<{ path: string; changefreq: string; priority: string }> = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/examples", changefreq: "weekly", priority: "0.9" },
  { path: "/how-it-works", changefreq: "monthly", priority: "0.9" },
  { path: "/early-access", changefreq: "weekly", priority: "0.9" },
  { path: "/pricing", changefreq: "monthly", priority: "0.8" },
  { path: "/faq", changefreq: "monthly", priority: "0.7" },
  { path: "/about", changefreq: "monthly", priority: "0.6" },
  { path: "/security", changefreq: "monthly", priority: "0.6" },
  { path: "/contact", changefreq: "yearly", priority: "0.5" },
  { path: "/terms", changefreq: "yearly", priority: "0.3" },
  { path: "/privacy", changefreq: "yearly", priority: "0.3" },
  { path: "/cookies", changefreq: "yearly", priority: "0.3" },
  { path: "/acceptable-use", changefreq: "yearly", priority: "0.3" },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { config } = context.get(servicesContext);
  const origin = config.origin;
  const lastmod = new Date().toISOString().slice(0, 10);

  const urls = PUBLIC_ROUTES.map(
    (route) =>
      `  <url>\n` +
      `    <loc>${origin}${route.path === "/" ? "/" : route.path}</loc>\n` +
      `    <lastmod>${lastmod}</lastmod>\n` +
      `    <changefreq>${route.changefreq}</changefreq>\n` +
      `    <priority>${route.priority}</priority>\n` +
      `  </url>`,
  ).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
