/**
 * Public identifiers.
 *
 * Every row that a client can ever see is addressed by a prefixed, k-sorted,
 * non-sequential id. Nothing in the API surface exposes a bigserial, so an
 * attacker cannot enumerate users by counting, and cannot infer volume from
 * the size of an id.
 *
 * Format:  <prefix>_<26-char Crockford base32 ULID>
 * Example: usr_01JQ2M8V4T0000000000000000
 *
 * ULIDs are lexicographically sortable by creation time, which lets Postgres
 * use the primary-key index for "newest first" pagination without a second
 * sort key, while still being unguessable (80 bits of randomness).
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32, no I/L/O/U
const ENCODING_LEN = 32;
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export const ID_PREFIXES = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "vrf",
  profile: "prf",
  role: "rol",
  userRole: "urol",
  campaign: "cmp",
  redemption: "rdm",
  wallet: "wal",
  ledger: "led",
  idempotency: "idem",
  consent: "cns",
  notification: "ntf",
  notificationPref: "npf",
  support: "sup",
  adminNote: "note",
  audit: "aud",
  security: "sec",
  abuse: "abu",
  rateLimit: "rl",
  featureFlag: "flag",
  systemSetting: "set",
  emailEvent: "eml",
  analytics: "evt",
  export: "exp",
  twoFactor: "tfa",
  request: "req",
  requestMetric: "rqm",
  dailyMetric: "dmx",
  providerMetric: "pvm",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

function encodeTime(now: number): string {
  let out = "";
  let n = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = n % ENCODING_LEN;
    out = ENCODING[mod] + out;
    n = (n - mod) / ENCODING_LEN;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) {
    // Rejection-free reduction is unnecessary here: 256 % 32 === 0, so the
    // modulo is uniform over the 32-symbol alphabet.
    out += ENCODING[bytes[i]! % ENCODING_LEN];
  }
  return out;
}

/** Generate a raw ULID with no prefix. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** Generate a prefixed public id, e.g. `newId("usr")` -> `usr_01JQ...`. */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  return `${prefix}_${ulid(now)}`;
}

const ID_RE = /^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{26}$/;

/** True when `value` is a syntactically valid public id, optionally of `prefix`. */
export function isValidId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) return false;
  if (prefix && !value.startsWith(`${prefix}_`)) return false;
  return true;
}
