/**
 * Cloudflare Access, verified AT THE ORIGIN rather than trusted from the edge.
 *
 * Staging is a full copy of the product — same code, same mail provider, same
 * verified sending domain — with signup open and seeded data inside. It exists
 * for one person. Putting a Cloudflare Access policy in front of it is the
 * right control, but a policy attached to a hostname protects THAT HOSTNAME and
 * nothing else: anything that reaches the Worker by another path — a
 * workers.dev subdomain, a preview URL, a route added later, a misconfigured
 * DNS record — arrives with no Access in front of it at all. That is the
 * classic way an Access-protected environment turns out not to be protected,
 * and it is invisible until someone goes looking.
 *
 * So the Worker checks for itself. Access signs a JWT for every request it
 * lets through, and this verifies that signature against the team's published
 * keys, then checks the audience, the issuer, the expiry and — the part that
 * makes "only me" true rather than "only people in my Cloudflare account" — the
 * email inside it.
 *
 * FAILS CLOSED when configured and OPEN when not, which is the only pairing
 * that works in practice: a developer running `wrangler dev` has no Access in
 * front of them and must not be locked out, while a staging deploy that sets
 * the two variables can never quietly stop enforcing them. `loadConfig`
 * decides which environments must configure it.
 */

export interface AccessGateConfig {
  /** e.g. "inkloom.cloudflareaccess.com" — the team domain, no scheme. */
  teamDomain: string;
  /** The Application Audience (AUD) tag of the Access application. */
  aud: string;
  /** Addresses permitted through, matched case-insensitively. Empty = nobody. */
  allowedEmails: readonly string[];
  /**
   * Service tokens permitted through, by Client ID.
   *
   * Access issues a JWT for a service token exactly as it does for a person,
   * but with `common_name` — the token's Client ID — in place of `email`. This
   * is how anything non-interactive gets in, and without it turning Access on
   * breaks the deploy pipeline: the post-deploy smoke test drives a real
   * browser against the deployed site and would meet a login page.
   *
   * Separate from `allowedEmails` on purpose. A service token is a credential
   * held by CI, not a person, and the two should be revocable independently.
   */
  allowedServiceTokens?: readonly string[];
}

export interface AccessIdentity {
  /** The person's address, or `service:<client id>` for a service token. */
  email: string;
  /** Access's own subject id, useful in an audit line. */
  sub: string;
  expiresAt: Date;
}

export type AccessResult =
  { ok: true; identity: AccessIdentity } | { ok: false; reason: AccessRefusal };

export type AccessRefusal =
  | "no_token"
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "no_email"
  | "email_not_allowed"
  | "service_token_not_allowed"
  | "keys_unavailable";

/** Header Access sets on the request; the cookie is the browser-side copy. */
const ACCESS_HEADER = "cf-access-jwt-assertion";
const ACCESS_COOKIE = "CF_Authorization";

export function accessTokenFrom(request: Request): string | null {
  const header = request.headers.get(ACCESS_HEADER);
  if (header) return header.trim();

  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === ACCESS_COOKIE && rest.length) return rest.join("=").trim();
  }
  return null;
}

/*
 * The signing keys, cached per isolate.
 *
 * Fetching them on every request would put a round trip in front of every page
 * load, and Cloudflare rotates them on the order of weeks rather than minutes.
 * An hour is short enough that a rotation heals itself without a deploy, and an
 * unknown `kid` refetches immediately regardless — which is what actually makes
 * a rotation invisible.
 */
/**
 * `CryptoKey` is not a global TYPE in every runtime's type set (it is present
 * at runtime in all of them), so the key type is taken from the function that
 * produces it rather than named directly.
 */
type ImportedKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

interface KeyCache {
  keys: Map<string, ImportedKey>;
  fetchedAt: number;
}
const keyCaches = new Map<string, KeyCache>();
const KEY_TTL_MS = 60 * 60 * 1000;

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

async function loadKeys(teamDomain: string, force: boolean): Promise<Map<string, ImportedKey>> {
  const cached = keyCaches.get(teamDomain);
  if (!force && cached && Date.now() - cached.fetchedAt < KEY_TTL_MS) return cached.keys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    // A slow identity provider must not hold a request open indefinitely.
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Access certs returned ${response.status}`);

  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = new Map<string, ImportedKey>();

  for (const jwk of body.keys ?? []) {
    // RS256 only. Accepting whatever the document offers is how "alg: none"
    // and HMAC-confusion attacks get in.
    if (!jwk.kid || jwk.kty !== "RSA" || (jwk.alg && jwk.alg !== "RS256")) continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    } catch {
      // A key we cannot import is a key we cannot trust; skip it rather than
      // failing the whole document, so one bad entry cannot lock everyone out.
    }
  }

  keyCaches.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

/** Test seam: drops cached keys so a suite is not order-dependent. */
export function resetAccessKeyCache(): void {
  keyCaches.clear();
}

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Returns an ArrayBuffer rather than a Uint8Array: under the Workers type set a
 * `Uint8Array<ArrayBufferLike>` is not assignable to `BufferSource`, and the
 * buffer is what `crypto.subtle.verify` wants anyway.
 */
function decodeSignature(segment: string): ArrayBuffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Verify one Access token.
 *
 * Every check here has a failure mode that is silent if it is skipped, which is
 * why each returns a distinct reason rather than a bare false: an environment
 * that is refusing everyone because of a stale AUD looks exactly like one that
 * is correctly refusing a stranger, unless something says which.
 */
export async function verifyAccessToken(
  token: string,
  config: AccessGateConfig,
  now: Date = new Date(),
): Promise<AccessResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  let header: { alg?: string; kid?: string };
  let claims: {
    aud?: string | string[];
    iss?: string;
    exp?: number;
    nbf?: number;
    sub?: string;
    email?: string;
    /** Present instead of `email` when the caller is a service token. */
    common_name?: string;
  };
  try {
    header = decodeSegment(parts[0]!) as typeof header;
    claims = decodeSegment(parts[1]!) as typeof claims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (header.alg !== "RS256" || !header.kid) return { ok: false, reason: "malformed" };

  let keys: Map<string, ImportedKey>;
  try {
    keys = await loadKeys(config.teamDomain, false);
    // A key we have never seen almost always means a rotation rather than an
    // attack, so refetch once before refusing. Without this, every rotation
    // would lock the environment out for up to an hour.
    if (!keys.has(header.kid)) keys = await loadKeys(config.teamDomain, true);
  } catch {
    return { ok: false, reason: "keys_unavailable" };
  }

  const key = keys.get(header.kid);
  if (!key) return { ok: false, reason: "unknown_key" };

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`).buffer;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeSignature(parts[2]!),
    signed,
  );
  if (!valid) return { ok: false, reason: "bad_signature" };

  // Claims are only worth reading once the signature says they are Access's.
  if (claims.iss !== `https://${config.teamDomain}`) return { ok: false, reason: "wrong_issuer" };

  const audience = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  // Without this, a token minted for ANY other application in the same
  // Cloudflare account would open this one.
  if (!audience.includes(config.aud)) return { ok: false, reason: "wrong_audience" };

  const seconds = Math.floor(now.getTime() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= seconds) {
    return { ok: false, reason: "expired" };
  }
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) {
    return { ok: false, reason: "not_yet_valid" };
  }

  /*
   * The last gate, and the one that means "me" rather than "anyone in the
   * account". An Access policy can be edited in a dashboard; this list is in
   * the deployment's own configuration, and both must agree.
   */
  const email = claims.email?.trim().toLowerCase();
  const commonName = claims.common_name?.trim();

  if (!email) {
    // No email means a service token — CI, a monitor, something automated.
    if (!commonName) return { ok: false, reason: "no_email" };

    const tokens = (config.allowedServiceTokens ?? []).map((t) => t.trim()).filter(Boolean);
    if (!tokens.includes(commonName)) return { ok: false, reason: "service_token_not_allowed" };

    return {
      ok: true,
      identity: {
        email: `service:${commonName}`,
        sub: claims.sub ?? "",
        expiresAt: new Date(claims.exp * 1000),
      },
    };
  }

  const allowed = config.allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(email)) return { ok: false, reason: "email_not_allowed" };

  return {
    ok: true,
    identity: { email, sub: claims.sub ?? "", expiresAt: new Date(claims.exp * 1000) },
  };
}

/**
 * Paths that answer before the gate.
 *
 * Only the two probes a deploy and an uptime check need. They expose no data —
 * readiness reports a boolean and health reports that the Worker is running —
 * and gating them would mean a deploy could never confirm it had succeeded.
 */
const UNGATED = new Set(["/api/health", "/api/ready"]);

export function isUngatedPath(pathname: string): boolean {
  return UNGATED.has(pathname);
}
