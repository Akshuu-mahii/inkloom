/**
 * SEO metadata.
 *
 * Every public page gets a unique title and description, a canonical URL and
 * Open Graph tags. Authenticated pages get `noindex` instead — a dashboard in
 * search results is a privacy problem, not a traffic win.
 */

export const SITE = {
  name: "Inkloom",
  /** Overridden per-environment at render time from config. */
  url: "https://inkloom.art",
  twitter: "@inkloom",
  description:
    "Inkloom is building specialised AI models for logo design. Join early access and reserve your free credits.",
} as const;

export interface MetaInput {
  title: string;
  description: string;
  /** Path only, e.g. "/pricing". Combined with the site origin. */
  path: string;
  origin?: string;
  /** Keep authenticated and transactional pages out of search results. */
  noindex?: boolean;
  /** Absolute or root-relative image path for social previews. */
  image?: string;
  type?: "website" | "article";
}

type MetaDescriptor = Record<string, string> & { title?: string };

export function buildMeta(input: MetaInput): MetaDescriptor[] {
  const origin = input.origin ?? SITE.url;
  const canonical = `${origin}${input.path === "/" ? "" : input.path}`;
  const image = input.image
    ? input.image.startsWith("http")
      ? input.image
      : `${origin}${input.image}`
    : `${origin}/og-default.png`;

  // The site name trails the page title, so a browser tab truncating from the
  // right still shows the part that identifies the page.
  const fullTitle = input.path === "/" ? input.title : `${input.title} — ${SITE.name}`;

  const tags: MetaDescriptor[] = [
    { title: fullTitle },
    { name: "description", content: input.description },
    { property: "og:title", content: fullTitle },
    { property: "og:description", content: input.description },
    { property: "og:type", content: input.type ?? "website" },
    { property: "og:url", content: canonical },
    { property: "og:image", content: image },
    { property: "og:site_name", content: SITE.name },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: fullTitle },
    { name: "twitter:description", content: input.description },
    { name: "twitter:image", content: image },
    { tagName: "link", rel: "canonical", href: canonical },
  ];

  if (input.noindex) {
    tags.push({ name: "robots", content: "noindex, nofollow" });
  } else {
    tags.push({ name: "robots", content: "index, follow, max-image-preview:large" });
  }

  return tags;
}

/**
 * Organization structured data.
 *
 * Only claims that are true today. There is deliberately no `SoftwareApplication`
 * block with an `offers` price: Inkloom is not selling anything yet, and
 * publishing a price to a search engine before checkout exists would be a lie
 * with a rich-result attached to it.
 */
export function organizationJsonLd(origin: string = SITE.url) {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE.name,
    url: origin,
    logo: `${origin}/icon-512.png`,
    description: SITE.description,
    email: "support@inkloom.art",
    foundingDate: "2026",
    /*
     * The other places this same organisation exists.
     *
     * `sameAs` is how a search engine decides that two presences are one
     * entity rather than two. It was an empty array, which says nothing — and
     * "Inkloom" is a contested name: a textile brand, a design studio, an Etsy
     * shop and a docs tool all answer to it, and every one of them has years of
     * history and a social footprint this domain does not.
     *
     * A verifiable link to a repository under an organisation of the same name
     * is a weak signal on its own and the only one currently true. Add the
     * social profiles here as they exist; an entity with one link is easier to
     * confuse with another than one with four.
     */
    sameAs: ["https://github.com/Inkloom-art"],
  };
}

/**
 * WebSite structured data with a description of what the product will do.
 *
 * Typed as `WebSite` rather than `SoftwareApplication` for the same reason:
 * the software does not generate logos yet, and structured data that says it
 * does would be inaccurate.
 */
export function websiteJsonLd(origin: string = SITE.url) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE.name,
    url: origin,
    description: SITE.description,
    publisher: { "@type": "Organization", name: SITE.name },
  };
}

export function faqJsonLd(faqs: Array<{ q: string; a: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.q,
      acceptedAnswer: { "@type": "Answer", text: faq.a },
    })),
  };
}
