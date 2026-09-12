/**
 * End-to-end global teardown.
 *
 * Puts `rate_limit_overrides` back exactly as the run found it.
 *
 * `global-setup.ts` raises every abuse limit roughly a hundredfold so a suite
 * that signs up a dozen accounts from one address is not throttled by the
 * limiter it shares with production. That is reasonable for the duration of a
 * run and dangerous for a second longer: without this file the raised values
 * simply stayed in the database, and a developer machine was found still
 * allowing 500 signups per hour per IP instead of 5 long after the run that
 * raised it. Anyone testing anti-abuse behaviour by hand after that was testing
 * a system with its alarms switched off.
 *
 * Two properties matter more than tidiness here:
 *
 *   - It restores the PREVIOUS value, not a hardcoded default. If an operator
 *     had legitimately widened a bucket before the run, that choice survives.
 *   - It runs even when tests fail. Playwright calls a global teardown after a
 *     failing run as well as a passing one, which is the case that matters:
 *     a suite that breaks halfway is exactly when limits would otherwise be
 *     left wide open.
 */
import { config } from "dotenv";
import pg from "pg";
import fs from "node:fs";
import { LOCAL_HOSTS, OVERRIDE_BACKUP } from "./global-setup";

config({ path: ".env", quiet: true });

export default async function globalTeardown() {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  // Same guard as setup. A teardown that wrote to production would be worse
  // than one that did nothing.
  const parsed = new URL(url);
  if (!LOCAL_HOSTS.has(parsed.hostname)) return;

  if (!fs.existsSync(OVERRIDE_BACKUP)) {
    console.warn(
      "  e2e: no rate-limit backup found — leaving overrides alone.\n" +
        "       Check them by hand: SELECT value FROM system_settings WHERE key = 'rate_limit_overrides';",
    );
    return;
  }

  const backup = JSON.parse(fs.readFileSync(OVERRIDE_BACKUP, "utf8")) as {
    existed: boolean;
    value: unknown;
  };

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    if (backup.existed) {
      await client.query(
        `UPDATE system_settings SET value = $1::jsonb, updated_at = now()
          WHERE key = 'rate_limit_overrides'`,
        [JSON.stringify(backup.value)],
      );
      console.log("  e2e: rate-limit overrides restored to their pre-run value");
    } else {
      // There was nothing before, so leaving an empty row behind would still be
      // a change. Remove it and let the code defaults be the policy again.
      await client.query("DELETE FROM system_settings WHERE key = 'rate_limit_overrides'");
      console.log("  e2e: rate-limit overrides removed — code defaults are in force again");
    }
    fs.rmSync(OVERRIDE_BACKUP, { force: true });
  } finally {
    await client.end();
  }
}
