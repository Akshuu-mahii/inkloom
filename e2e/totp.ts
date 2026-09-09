/**
 * A minimal TOTP generator, for tests only.
 *
 * The admin flow requires a real second factor, so the end-to-end suite has to
 * behave like a real authenticator app: enrol, read the shared secret out of
 * the `otpauth://` URI, and produce the same six digits the server expects.
 *
 * This is RFC 6238 (TOTP) over RFC 4226 (HOTP) with SHA-1 and a 30-second step,
 * which is what Better Auth issues by default. It exists so the tests can
 * exercise 2FA honestly rather than by writing `two_factor_enabled = true`
 * straight into the database — a fixture like that produces an account that
 * claims to have a second factor and has no secret behind it, so sign-in
 * correctly becomes impossible and the test learns nothing.
 *
 * Nothing here is used by the application.
 */
import { createHmac } from "node:crypto";

/** Decode a Crockford-free, standard RFC 4648 base32 string. */
export function base32Decode(input: string): Buffer {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

/** Generate the TOTP code for a secret at a point in time. */
export function totp(
  secret: string,
  atMs: number = Date.now(),
  stepSeconds = 30,
  digits = 6,
): string {
  const counter = Math.floor(atMs / 1000 / stepSeconds);

  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Pull the shared secret out of an `otpauth://totp/...?secret=...` URI. */
export function secretFromUri(uri: string): string {
  const match = /[?&]secret=([A-Z2-7=]+)/i.exec(uri);
  if (!match?.[1]) throw new Error(`No secret in TOTP URI: ${uri.slice(0, 60)}`);
  return match[1];
}
