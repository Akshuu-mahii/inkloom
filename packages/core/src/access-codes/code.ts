/**
 * Access-code normalisation, generation and fingerprinting.
 *
 * These are pure functions with no database or clock dependency, so the
 * security-critical part of the code system is exhaustively unit-testable.
 */
import { hmacSha256Hex } from "../util/crypto";

/**
 * Crockford base32 minus vowels, so a generated code cannot accidentally spell
 * a word, and minus the characters people mistype: I/1, O/0, L, U.
 */
const CODE_ALPHABET = "ACDEFGHJKMNPQRTVWXYZ2345679";

/**
 * Normalise a user-submitted code into its canonical form.
 *
 * Users paste codes with stray spaces, hyphens, lower case and non-breaking
 * spaces from email clients. All of that must map to one value, or a valid code
 * would be rejected and — worse — the same code could fingerprint two ways.
 *
 *   "  inkloom-hackathon " -> "INKLOOMHACKATHON"
 *   "ink loom HACK"   -> "INKLOOMHACK"
 */
export function normalizeCode(input: string): string {
  return (
    input
      .normalize("NFKC")
      .toUpperCase()
      // Strip everything that is not A-Z or 0-9: spaces, hyphens, underscores,
      // dots, zero-width characters, emoji.
      .replace(/[^A-Z0-9]/g, "")
  );
}

export const MIN_CODE_LENGTH = 6;
export const MAX_CODE_LENGTH = 64;

/** True when a normalised code is within the accepted shape. */
export function isValidCodeShape(normalized: string): boolean {
  return (
    normalized.length >= MIN_CODE_LENGTH &&
    normalized.length <= MAX_CODE_LENGTH &&
    /^[A-Z0-9]+$/.test(normalized)
  );
}

/**
 * Keyed fingerprint of a code.
 *
 * HMAC-SHA256 under a server-side pepper held in Cloudflare Secrets. Because
 * the pepper is keyed (not a plain hash), an attacker with a database dump
 * cannot brute-force short codes offline — they would need the pepper too.
 *
 * The domain separator prevents a fingerprint from ever colliding with a hash
 * computed for another purpose under the same pepper.
 */
export async function fingerprintCode(normalized: string, pepper: string): Promise<string> {
  if (!pepper || pepper.length < 16) {
    throw new Error("ACCESS_CODE_PEPPER is missing or too short (need >= 16 characters).");
  }
  return hmacSha256Hex(`access-code:v1:${normalized}`, pepper);
}

/**
 * Generate a cryptographically random code.
 *
 * `groups` x `groupSize` characters, hyphen-separated for legibility. The
 * hyphens are cosmetic — `normalizeCode` removes them, so "INKL-OOM2-6XYZ" and
 * "inkloom26xyz" are the same code.
 */
export function generateCode(groups = 3, groupSize = 4): string {
  const total = groups * groupSize;
  const bytes = new Uint8Array(total);
  crypto.getRandomValues(bytes);

  const chars: string[] = [];
  for (let i = 0; i < total; i++) {
    // Rejection sampling keeps the distribution uniform. Plain modulo would
    // bias toward the first (256 % 27) symbols of the alphabet.
    let byte = bytes[i]!;
    const limit = 256 - (256 % CODE_ALPHABET.length);
    while (byte >= limit) {
      const extra = new Uint8Array(1);
      crypto.getRandomValues(extra);
      byte = extra[0]!;
    }
    chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!);
  }

  const out: string[] = [];
  for (let i = 0; i < groups; i++)
    out.push(chars.slice(i * groupSize, (i + 1) * groupSize).join(""));
  return out.join("-");
}

/**
 * Display form stored alongside the fingerprint so an admin can recognise a
 * campaign without the code being recoverable.
 *
 *   "INKLOOMHACKATHON" -> { masked: "INKL••••••••THON", last4: "THON" }
 *
 * Short codes reveal less, never more: an 8-character code shows 2 either side.
 */
export function maskCode(normalized: string): { masked: string; last4: string } {
  const len = normalized.length;
  const reveal = len >= 12 ? 4 : len >= 8 ? 2 : 1;
  const head = normalized.slice(0, reveal);
  const tail = normalized.slice(len - reveal);
  const masked = `${head}${"•".repeat(Math.max(len - reveal * 2, 3))}${tail}`;
  return { masked, last4: tail };
}
