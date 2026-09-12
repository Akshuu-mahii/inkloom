/**
 * End-to-end global setup.
 *
 * A full run signs up a dozen accounts from one address, which is exactly what
 * the `auth.signup.ip` limit (5 per hour) exists to stop — so without this the
 * suite spends most of its time proving its own rate limiter works.
 *
 * The limits are NOT disabled. They are raised through the product's own
 * `rate_limit_overrides` system setting, which means:
 *
 *   - the limiter still runs on every request, so a regression that removed it
 *     would still be caught elsewhere;
 *   - the override mechanism itself gets exercised on every CI run;
 *   - `rate-limit.spec.ts` can set a deliberately tiny override and assert that
 *     blocking still happens.
 *
 * It also refuses to touch anything that is not obviously a local database.
 *
 * WHAT IT PUTS BACK
 * -----------------
 * Whatever `rate_limit_overrides` held before the run is written to
 * `OVERRIDE_BACKUP` and restored by `global-teardown.ts`, including the case
 * where it held nothing — then the row is removed again rather than left at the
 * test values.
 *
 * That teardown was missing for a long time and the consequence was not
 * theoretical: a developer database was found sitting at 500 signups per hour
 * per IP instead of 5, weeks after the run that raised it, because the suite
 * loosened the limiter and nothing ever tightened it again. Manual testing
 * after any run was therefore happening against abuse controls that were
 * effectively off. The limits are a security control; a test must hand them
 * back exactly as it found them.
 */
import { config } from "dotenv";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

config({ path: ".env", quiet: true });

export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

/**
 * Where the pre-run value of `rate_limit_overrides` is parked.
 *
 * A file rather than another settings row: the teardown has to be able to tell
 * "there was no override before" from "the override was empty", and a row that
 * itself needs cleaning up is the problem this is meant to solve.
 */
export const OVERRIDE_BACKUP = path.join(os.tmpdir(), "inkloom-e2e-rate-limit-backup.json");

/** Generous enough for a whole suite; still finite. */
const E2E_OVERRIDES = {
  "auth.signup.ip": { limit: 500 },
  "auth.login.ip": { limit: 500 },
  "auth.login.account": { limit: 200 },
  "auth.forgot_password.email": { limit: 100 },
  "auth.forgot_password.ip": { limit: 200 },
  "auth.resend_verification.account": { limit: 100 },
  "code.redeem.user": { limit: 200 },
  "code.redeem.ip": { limit: 500 },
  "support.submit.user": { limit: 100 },
  "support.submit.ip": { limit: 200 },
};

export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set; cannot prepare the e2e environment.");

  const parsed = new URL(url);
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing to prepare e2e against a non-local database (${parsed.hostname}). ` +
        "These tests create accounts and rewrite settings.",
    );
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    // Start from a clean slate so a previous run's counters do not carry over.
    await client.query("DELETE FROM rate_limit_events");

    /*
     * Save whatever is there before touching it. `rows[0]` being undefined is a
     * meaningful state, not an error: it means no override existed, and the
     * teardown must then delete the row rather than restore an empty object.
     */
    const existing = await client.query(
      "SELECT value FROM system_settings WHERE key = 'rate_limit_overrides'",
    );
    fs.writeFileSync(
      OVERRIDE_BACKUP,
      JSON.stringify({ existed: existing.rowCount > 0, value: existing.rows[0]?.value ?? null }),
    );

    await client.query(
      `INSERT INTO system_settings (id, key, value, description, high_risk)
       VALUES ($1, 'rate_limit_overrides', $2::jsonb,
               'Per-bucket overrides for the rate limiter', true)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [`set_e2e_${Date.now()}`, JSON.stringify(E2E_OVERRIDES)],
    );

    // Every feature flag at its declared default, so one test flipping a flag
    // cannot leave the next run in a surprising state.
    await client.query(`
      UPDATE feature_flags SET enabled = true
      WHERE key IN ('signup_enabled','code_redemption_enabled','promotional_grants_enabled',
                    'support_form_enabled','analytics_enabled','early_access_open')
    `);
    await client.query(`
      UPDATE feature_flags SET enabled = false
      WHERE key IN ('generation_enabled','payments_enabled','maintenance_banner_enabled')
    `);

    // The suite redeems this repeatedly; make sure it exists and is open.
    const campaign = await client.query(
      "SELECT id, status FROM access_code_campaigns WHERE code_last4 = 'THON' LIMIT 1",
    );
    if (campaign.rowCount === 0) {
      throw new Error(
        "The INKLOOMHACKATHON campaign is missing. Run `pnpm db:seed` before the e2e suite.",
      );
    }
    await client.query(
      "UPDATE access_code_campaigns SET status = 'enabled', paused_at = NULL WHERE id = $1",
      [campaign.rows[0].id],
    );

    console.log(`  e2e: rate-limit overrides applied to ${parsed.pathname.slice(1)}`);
  } finally {
    await client.end();
  }
}
