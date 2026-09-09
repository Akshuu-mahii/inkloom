/**
 * Create an access-code campaign from the command line.
 *
 *   pnpm codes:create --name "Hackathon 2026" --credits 500 --code INKLOOMHACKATHON
 *   pnpm codes:create --name "Launch wave" --credits 250 --max-total 500 --expires 2026-12-31
 *
 * Used for the initial `INKLOOMHACKATHON` campaign and for any campaign an
 * operator would rather create outside the browser. It goes through exactly the
 * same fingerprinting path as the admin API — the plaintext is never stored,
 * only `HMAC-SHA256(normalised, ACCESS_CODE_PEPPER)`.
 *
 * The full code is printed ONCE, here, and is not recoverable afterwards.
 */
import { eq } from "drizzle-orm";
import { createDb } from "@inkloom/db/client";
import { accessCodeCampaign, newId } from "@inkloom/db";
import {
  fingerprintCode,
  generateCode,
  isValidCodeShape,
  maskCode,
  normalizeCode,
} from "@inkloom/core/access-codes";
import { describeTarget, required } from "./_env";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const name = arg("name");
  const credits = Number(arg("credits"));

  if (!name || !Number.isInteger(credits) || credits <= 0) {
    console.error("\n  Usage: pnpm codes:create --name <name> --credits <n> [options]");
    console.error("\n  Options:");
    console.error("    --code <CODE>        Use a specific code (default: generate a random one)");
    console.error("    --max-total <n>      Cap total redemptions across all users");
    console.error("    --per-user <n>       Redemptions allowed per user (default 1)");
    console.error("    --expires <ISO date> Expiry, e.g. 2026-12-31");
    console.error("    --starts <ISO date>  Start time");
    console.error("    --cohort <tag>       Reporting tag");
    console.error("    --domains <a,b>      Restrict to these verified email domains\n");
    process.exit(1);
  }

  const url = required("DATABASE_URL");
  const pepper = required("ACCESS_CODE_PEPPER");
  const { db, pool } = createDb({ connectionString: url, max: 1 });

  try {
    const plaintext = arg("code")?.trim() || generateCode();
    const normalized = normalizeCode(plaintext);

    if (!isValidCodeShape(normalized)) {
      console.error(`\n  "${plaintext}" is not a usable code.`);
      console.error("  Use 6-64 letters and digits; hyphens and spaces are ignored.\n");
      process.exit(1);
    }

    const fingerprint = await fingerprintCode(normalized, pepper);
    const { masked, last4 } = maskCode(normalized);

    const existing = await db.query.accessCodeCampaign.findFirst({
      where: eq(accessCodeCampaign.codeFingerprint, fingerprint),
    });
    if (existing) {
      console.error(`\n  That code is already in use by campaign "${existing.name}".\n`);
      process.exit(1);
    }

    const domains = arg("domains")
      ?.split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    const id = newId("cmp");
    await db.insert(accessCodeCampaign).values({
      id,
      name,
      description: arg("description") ?? "Created from the command line",
      codeFingerprint: fingerprint,
      codeMasked: masked,
      codeLast4: last4,
      creditAmount: credits,
      maxTotalRedemptions: arg("max-total") ? Number(arg("max-total")) : null,
      maxRedemptionsPerUser: arg("per-user") ? Number(arg("per-user")) : 1,
      startsAt: arg("starts") ? new Date(arg("starts")!) : null,
      expiresAt: arg("expires") ? new Date(arg("expires")!) : null,
      allowedEmailDomains: domains?.length ? domains : null,
      targetCohort: arg("cohort") ?? null,
      // No `createdBy`: there is no acting admin in a CLI context, and
      // inventing one would corrupt the audit trail.
      createdBy: null,
    });

    console.log(`\n  Campaign created on ${describeTarget(url)}\n`);
    console.log(`    Name     ${name}`);
    console.log(`    Credits  ${credits} per redemption`);
    console.log(`    Masked   ${masked}`);
    console.log(`    Id       ${id}`);
    console.log(`\n    CODE     ${plaintext}\n`);
    console.log("  Save that code now. Only its keyed HMAC is stored, so this is the");
    console.log("  one and only time it can be displayed.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Failed to create campaign:", error);
  process.exit(1);
});
