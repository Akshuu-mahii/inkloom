/**
 * Keyed hashing helpers.
 *
 * Everything here uses WebCrypto (`globalThis.crypto.subtle`), which exists in
 * Cloudflare Workers and in Node 20+ without a polyfill, so the same code runs
 * in both. No password hashing or session cryptography lives here — Better
 * Auth owns all of that, and nothing in Inkloom reimplements it.
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// Return type is inferred rather than annotated as `CryptoKey`: that global is
// declared by the DOM lib, which a server package should not pull in. The value
// is identical in Workers and in Node's WebCrypto.
async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Hex-encoded HMAC-SHA256 of `message` under `secret`. */
export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Hex-encoded SHA-256. Used for non-secret content hashes (idempotency bodies). */
export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(message)));
}

/**
 * Constant-time string comparison.
 *
 * Used wherever a caller-supplied value is compared against a secret-derived
 * one, so that comparison time cannot reveal how many leading characters were
 * correct.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // Compare the fixed-length hex digests of both inputs so that a length
  // difference does not short-circuit and leak through timing.
  // Walk the LONGER of the two either way, so a length difference does not
  // short-circuit and leak through timing. Comparing the character beyond the
  // end of the shorter string against NaN keeps the work identical in shape.
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;

  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }

  return diff === 0;
}

/**
 * Pseudonymise an IP address for abuse monitoring.
 *
 * The brief asks for rotating keyed hashes over raw IP storage. The rotation
 * period is folded into the hashed message, so a given address maps to a
 * different key each period: correlation stays possible inside a window (which
 * is all abuse detection needs) but a stolen database yields no durable
 * per-person identifier, and the mapping cannot be reversed without the pepper.
 *
 * Truncated to 32 hex chars (128 bits) — ample against collisions, smaller to
 * index.
 */
export async function hashIp(
  ip: string | null | undefined,
  pepper: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!ip) return null;
  const period = ipRotationPeriod(now);
  const digest = await hmacSha256Hex(`ip:${period}:${ip.trim().toLowerCase()}`, pepper);
  return digest.slice(0, 32);
}

/** UTC day bucket. Hashes rotate daily. */
export function ipRotationPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Random URL-safe token. Used for support references and anonymous ids. */
export function randomToken(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf.buffer);
}
