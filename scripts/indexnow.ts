/**
 * Tell the search engines a page changed, instead of waiting to be found.
 *
 *   pnpm seo:ping
 *
 * A new domain is not crawled because nobody has linked to it yet, and a
 * sitemap only helps once something arrives to read it. IndexNow inverts that:
 * one request names the URLs, and Bing, Yandex and the other participants fetch
 * them rather than waiting for a crawl cycle. It is free, needs no account, and
 * the whole protocol is a key file served from the site root proving the
 * submitter controls the domain.
 *
 * Google does not participate. Google is reached by verifying the property in
 * Search Console and submitting the sitemap once — a one-off human step no API
 * key can replace.
 *
 * Worth knowing: Bing's index is what several answer engines search against, so
 * this reaches further than Bing's own traffic would suggest.
 */
import { required, optional } from "./_env";

const ENDPOINT = "https://api.indexnow.org/IndexNow";

/** Every page a stranger should be able to find. Mirrors the sitemap. */
const PATHS = [
  "/",
  "/how-it-works",
  "/early-access",
  "/pricing",
  "/faq",
  "/about",
  "/security",
  "/contact",
  "/privacy",
  "/terms",
  "/cookies",
  "/acceptable-use",
];

async function main() {
  const origin = optional("APP_URL", "https://inkloom.art").replace(/\/$/, "");
  const key = required("INDEXNOW_KEY");
  const host = new URL(origin).hostname;

  // The proof: the key must be readable at the root before anything is accepted.
  const proof = await fetch(`${origin}/${key}.txt`);
  const served = (await proof.text()).trim();
  if (!proof.ok || served !== key) {
    console.error(
      `\n  The key file is not being served correctly.\n` +
        `  Expected ${origin}/${key}.txt to return exactly the key.\n` +
        `  Got HTTP ${proof.status}: ${served.slice(0, 60)}\n`,
    );
    process.exit(1);
  }

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host,
      key,
      keyLocation: `${origin}/${key}.txt`,
      urlList: PATHS.map((p) => `${origin}${p}`),
    }),
  });

  /*
   * 200 and 202 both mean accepted; 202 means the key is still being verified.
   * Anything else is reported with its body, because a silent failure here
   * looks exactly like a success — nothing happens either way.
   */
  if (response.status === 200 || response.status === 202) {
    console.log(`\n  Submitted ${PATHS.length} URLs for ${host} (HTTP ${response.status}).`);
    console.log("  Indexing is not instant; this removes the waiting-to-be-found part.\n");
    return;
  }

  console.error(`\n  IndexNow refused: HTTP ${response.status}`);
  console.error(`  ${(await response.text()).slice(0, 300)}\n`);
  process.exit(1);
}

main().catch((error) => {
  console.error("IndexNow submission failed:", error);
  process.exit(1);
});
