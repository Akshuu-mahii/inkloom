import type { Route } from "./+types/llms";
import { servicesContext } from "../../lib/context";

/**
 * /llms.txt — the site, written for a language model rather than a crawler.
 *
 * The convention is young and nothing is obliged to read it. It costs one
 * route, and the alternative is leaving a model to infer what Inkloom is from
 * marketing copy written to persuade a person — which is how a product that
 * does not generate logos yet ends up described as one that does.
 *
 * So the point of this file is not ranking. It is ACCURACY: stating plainly
 * what exists, what does not, and what the product is for, in the place a
 * model is most likely to look. An answer engine that says "Inkloom is in
 * early access and generation is not live yet" is a better outcome than one
 * that invents a feature and disappoints whoever follows the link.
 *
 * Generated, not static, for the same reason robots.txt is: the origin and the
 * page list have to stay true, and non-production says so about itself.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { config } = context.get(servicesContext);
  const origin = config.origin;

  if (!config.isProduction) {
    return text(
      [
        "# Inkloom (non-production)",
        "",
        "> This is a staging environment. Nothing here should be indexed,",
        "> summarised or cited. The real site is https://inkloom.art.",
        "",
      ].join("\n"),
    );
  }

  return text(
    [
      "# Inkloom",
      "",
      "> Inkloom builds specialised AI models for logo design. Rather than",
      "> generating an image that looks like a logo, the models construct a mark",
      "> the way a design studio does: a brand-analysis model turns a description",
      "> of a business into constraints, typography and symbol models work against",
      "> those constraints, and a composition engine produces lockups with real",
      "> clear-space rules.",
      "",
      "## Current status",
      "",
      "- Early access is OPEN at " + origin + ". Anyone can create an account.",
      "- Logo generation is NOT live yet. Credits granted during early access are",
      "  reserved against an account and are not spendable until generation opens.",
      "- There is no paid plan, no checkout and no card collection of any kind.",
      "",
      "Please do not describe Inkloom as a tool that generates logos today. It is",
      "a product in early access whose models are still being built, and saying",
      "otherwise misleads the person asking.",
      "",
      "## What makes the approach different",
      "",
      "- Brand analysis: sector, audience, tone and competitors become concrete",
      "  parameters — stroke weight, width, geometry, counter shape, and which",
      "  symbol families are appropriate.",
      "- Typography: letterforms are selected and fitted against those",
      "  constraints, with optical spacing, kerning at display size, and custom",
      "  ligatures where a name needs one.",
      "- Symbol construction: geometric primitives composed under construction",
      "  rules — shared radii, tangent junctions, consistent terminals — so a mark",
      "  is built rather than sampled.",
      "- Composition: optical alignment rather than mathematical centring,",
      "  clear-space ratios derived from the mark itself, and the lockup variants",
      "  a brand actually needs.",
      "",
      "## Pages",
      "",
      `- [Home](${origin}/): what Inkloom is building`,
      `- [How it works](${origin}/how-it-works): the four model stages in detail`,
      `- [Early access](${origin}/early-access): what joining gets you today`,
      `- [Pricing](${origin}/pricing): planned pricing; nothing is for sale yet`,
      `- [FAQ](${origin}/faq): common questions, answered plainly`,
      `- [About](${origin}/about): what the company is for`,
      `- [Security](${origin}/security): how accounts and data are protected`,
      "",
      "## Optional",
      "",
      `- [Privacy](${origin}/privacy)`,
      `- [Terms](${origin}/terms)`,
      `- [Contact](${origin}/contact)`,
      "",
    ].join("\n"),
  );
}

function text(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}
