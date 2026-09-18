/**
 * Concurrency and crash-resistance harness. LOCAL ONLY.
 *
 * SUPERSEDED FOR CAPACITY MEASUREMENT by `scripts/capacity-test.ts`, and the
 * reason matters. This runs from the machine you type on, and at any real
 * concurrency that machine becomes the bottleneck: measured here,
 * `/api/health` — which touches no database — went from 135ms to 12,239ms at 25
 * concurrent while the server's own telemetry reported a 372ms maximum and zero
 * errors for the same traffic. Numbers from this harness describe the client,
 * not Inkloom, and must never be quoted as capacity.
 *
 * What it is still good for, and why it is kept: CORRECTNESS under contention.
 * It drives a full journey per bot against a real Worker and a real Postgres,
 * which is how the redemption serialisation and ledger-integrity guarantees
 * were established. Contention is reproducible from one machine; throughput is
 * not.
 *
 * Concurrency and crash-resistance harness.
 *
 * Drives the REAL Worker (workerd, production build) against a REAL Postgres
 * with a full user journey per bot:
 *
 *   signup -> login -> enable 2FA -> confirm a genuine TOTP -> redeem a code
 *           -> browse the dashboard
 *
 * Mail is off entirely (EMAIL_TRANSPORT=console): nothing is sent, nothing is
 * queued, no SMTP or HTTP call leaves the process. Every address is
 * `@example.test`, which is reserved by RFC 2606 and can never belong to anyone.
 *
 * Usage: node loadtest.mjs <bots> <concurrency>
 */
import pg from "pg";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";

const BASE = process.env.LOAD_BASE ?? "http://127.0.0.1:8788";
/*
 * The API enforces a strict same-origin check on every write, comparing the
 * Origin header against APP_URL — not against the address it was reached on. So
 * the harness must present the configured origin, exactly as a browser would.
 * Getting this wrong produces ORIGIN_REJECTED, which is the control working.
 */
const ORIGIN = process.env.LOAD_ORIGIN ?? "http://localhost:5173";
const BOTS = Number(process.argv[2] ?? 1000);
const CONCURRENCY = Number(process.argv[3] ?? 50);
const PASSWORD = "load-test-passphrase-9!";
const CODE = process.env.LOAD_CODE ?? "LOADTEST";
/** Unique per run, so repeat runs do not collide on an existing address. */
const RUN = process.env.LOAD_RUN ?? Date.now().toString(36).slice(-5);
/*
 * Against a DEPLOYED target the signup endpoint requires a Turnstile token that
 * a bot cannot produce, and bot protection must not be switched off on an
 * internet-facing host. So accounts are created out of band by
 * scripts/seed-load-users.ts and this harness exercises everything after
 * signup — which is where concurrency, contention and data-crossing actually
 * live. Signup itself is load-tested locally, where the always-passing test key
 * is legitimate.
 */
const SKIP_SIGNUP = process.env.LOAD_SKIP_SIGNUP === "1";
const PREFIX = process.env.LOAD_PREFIX ?? null;

const stats = new Map(); // step -> {ok, fail, codes:Map, times:[]}
const record = (step, code, ms) => {
  let s = stats.get(step);
  if (!s) stats.set(step, (s = { ok: 0, fail: 0, codes: new Map(), times: [] }));
  if (code >= 200 && code < 400) s.ok += 1;
  else s.fail += 1;
  s.codes.set(code, (s.codes.get(code) ?? 0) + 1);
  s.times.push(ms);
};

async function hit(step, path, { method = "GET", body, cookies } = {}) {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        accept: "application/json",
        origin: ORIGIN,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookies ? { cookie: cookies } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const ms = performance.now() - started;
    record(step, res.status, ms);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON is itself a finding; status already recorded */
    }
    return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] };
  } catch (error) {
    record(step, 0, performance.now() - started);
    return { status: 0, json: null, setCookie: [], error: String(error) };
  }
}

const jar = (cookies) => cookies.map((c) => c.split(";")[0]).join("; ");
const botEmail = (i) =>
  PREFIX
    ? `${PREFIX}-${String(i).padStart(5, "0")}@example.test`
    : `bot-${RUN}-${String(i).padStart(5, "0")}@example.test`;

async function signupBot(i) {
  const email = botEmail(i);
  await hit("1_signup", "/api/v1/auth/signup", {
    method: "POST",
    body: {
      email,
      password: PASSWORD,
      name: `Bot ${i}`,
      acceptedTerms: true,
      marketingOptIn: false,
      // Cloudflare's always-passing TEST secret accepts any non-empty token.
      turnstileToken: "load-test-token",
      utm: {},
    },
  });
}

async function journeyBot(i) {
  const email = botEmail(i);

  const login = await hit("3_login", "/api/v1/auth/login", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  if (login.status !== 200) return;
  let cookies = jar(login.setCookie);
  if (!cookies) return;

  const enable = await hit("4_2fa_enable", "/api/v1/auth/two-factor/enable", {
    method: "POST",
    body: { currentPassword: PASSWORD },
    cookies,
  });
  const uri = enable.json?.data?.totpURI;
  if (enable.status === 200 && uri) {
    const encoded = new URL(uri).searchParams.get("secret");
    const secret = new TextDecoder().decode(base32.decode(encoded));
    const code = await createOTP(secret).totp();
    /*
     * Enrolling in 2FA ROTATES the session: Better Auth mints a new one from the
     * pre-enrolment session and deletes the old, so the claim carries the
     * upgraded privilege. A client that keeps using the cookie it arrived with
     * is holding a deleted session and gets 401 on everything afterwards — which
     * is correct behaviour, and worth a harness knowing about.
     */
    const confirmed = await hit("5_2fa_confirm", "/api/v1/auth/two-factor/confirm", {
      method: "POST",
      body: { code },
      cookies,
    });
    const rotated = jar(confirmed.setCookie);
    if (rotated) cookies = rotated;
  }

  await hit("6_redeem", "/api/v1/access-codes/redeem", {
    method: "POST",
    body: { code: CODE },
    cookies,
  });

  await hit("7_me", "/api/v1/me", { cookies });
  await hit("8_credits", "/api/v1/credits/history?limit=10", { cookies });
  await hit("9_sessions", "/api/v1/me/sessions", { cookies });
}

// --- verification step runs in bulk against the database -------------------
async function verifyAll(client) {
  await client.query(
    `UPDATE users SET email_verified = true WHERE email LIKE 'bot-${RUN}-%@example.test'`,
  );
}

const pct = (v, q) => {
  const a = [...v].sort((x, y) => x - y);
  return a.length ? a[Math.min(Math.floor(a.length * q), a.length - 1)] : 0;
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

console.log(`\n  ${BOTS} bots, ${CONCURRENCY} concurrent, target ${BASE}`);
console.log("  mail: OFF (console transport, nothing sent)\n");

const before = await client.query(
  "SELECT (SELECT COUNT(*) FROM users)::int u, (SELECT COALESCE(SUM(amount),0) FROM credit_ledger)::int l",
);

const pool = async (n, fn) => {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, n) }, async () => {
      while (cursor < n) await fn(cursor++);
    }),
  );
};

const started = Date.now();
if (!SKIP_SIGNUP) {
  // Phase 1: everybody registers at once.
  await pool(BOTS, signupBot);
  // Phase 2: verification, in bulk — the link itself is a stateless JWT check
  // with no database write, so it is not what a crowd stresses.
  await verifyAll(client);
}
// Phase 3: everybody signs in, enrols in 2FA and uses the product at once.
await pool(BOTS, journeyBot);
const elapsed = (Date.now() - started) / 1000;

console.log("  step             n      ok    fail   p50     p95     max    status codes");
console.log("  " + "-".repeat(78));
let totalReq = 0,
  totalFail = 0;
for (const [step, s] of [...stats.entries()].sort()) {
  const n = s.times.length;
  totalReq += n;
  totalFail += s.fail;
  const codes = [...s.codes.entries()].sort((a, b) => b[1] - a[1]).map(([c, k]) => `${c}:${k}`).join(" ");
  console.log(
    `  ${step.padEnd(16)} ${String(n).padStart(5)} ${String(s.ok).padStart(7)} ${String(s.fail).padStart(6)} ` +
      `${pct(s.times, 0.5).toFixed(0).padStart(6)}ms ${pct(s.times, 0.95).toFixed(0).padStart(6)}ms ` +
      `${Math.max(...s.times).toFixed(0).padStart(6)}ms   ${codes}`,
  );
}

const after = await client.query(`
  SELECT (SELECT COUNT(*) FROM users)::int u,
         (SELECT COALESCE(SUM(amount),0) FROM credit_ledger)::int l,
         (SELECT COALESCE(SUM(balance),0) FROM credit_wallets)::int w,
         (SELECT COUNT(*) FROM credit_wallets cw
            WHERE cw.balance <> (SELECT COALESCE(SUM(cl.amount),0) FROM credit_ledger cl
                                  WHERE cl.wallet_id = cw.id))::int drift,
         (SELECT COUNT(*) FROM access_code_redemptions)::int red,
         (SELECT COUNT(*) FROM users WHERE two_factor_enabled)::int tfa,
         (SELECT COUNT(*) FROM two_factor)::int tfarows,
         (SELECT COUNT(*) FROM email_events)::int mail
`);
const a = after.rows[0];

console.log("  " + "-".repeat(78));
console.log(`  requests ${totalReq}   failures ${totalFail}   ${elapsed.toFixed(1)}s   ` +
            `${(totalReq / elapsed).toFixed(1)} req/s`);
console.log(`\n  users        ${before.rows[0].u} -> ${a.u}`);
console.log(`  2FA enabled  ${a.tfa}   (two_factor rows: ${a.tfarows})`);
console.log(`  redemptions  ${a.red}`);
console.log(`  ledger sum   ${a.l}     wallet sum ${a.w}`);
console.log(`  LEDGER DRIFT ${a.drift}   <- must be 0`);
console.log(`  email_events ${a.mail}  (nothing delivered: console transport)`);

await client.end();
