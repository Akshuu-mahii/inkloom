/**
 * Proves that DATABASE_URL is the database a given environment actually runs
 * against — BEFORE anything is applied to it.
 *
 *   pnpm db:verify-target production
 *
 * The check is not "does this look like production". It resolves the Hyperdrive
 * binding that the deployed Worker uses for that environment, asks Cloudflare
 * for its origin, and requires DATABASE_URL to match it exactly. That makes the
 * running deployment the source of truth rather than a constant in this repo
 * that nobody would notice going stale: if the database is ever moved, this
 * check follows it, and if someone hands the migrator the wrong URL it stops
 * before the first statement.
 *
 * It also refuses a URL matching ANY OTHER environment's binding. Pointing the
 * production migrator at staging is the mistake with the worst blast radius and
 * the one most easily made by pasting the wrong secret, so it gets its own
 * error rather than being caught by the general mismatch.
 *
 * Exits non-zero on any disagreement. Nothing here writes to the database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { repoRoot, required } from "./_env";

interface Origin {
  host: string;
  port: number;
  database: string;
  user: string;
}

/**
 * Strip comments and trailing commas from JSONC.
 *
 * String-aware on purpose: wrangler.jsonc is full of `"https://..."` values,
 * and a naive `//` strip truncates the config at the first URL — producing a
 * parse error that reads like a corrupt file rather than a bad stripper.
 */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[++i] ?? "";
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }

  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface WranglerConfig {
  hyperdrive?: Array<{ binding: string; id: string }>;
  env?: Record<string, { hyperdrive?: Array<{ binding: string; id: string }> }>;
}

/** Every deployed environment's Hyperdrive id, keyed by environment name. */
function hyperdriveIdsByEnv(): Map<string, string> {
  const file = path.join(repoRoot, "apps", "web", "wrangler.jsonc");
  const config = parseJsonc(readFileSync(file, "utf8")) as WranglerConfig;
  const ids = new Map<string, string>();

  for (const [name, env] of Object.entries(config.env ?? {})) {
    const id = env.hyperdrive?.find((h) => h.binding === "HYPERDRIVE")?.id;
    if (id) ids.set(name, id);
  }

  if (ids.size === 0) {
    console.error(`No environment Hyperdrive bindings found in ${file}.`);
    process.exit(1);
  }
  return ids;
}

async function fetchOrigin(id: string): Promise<Origin> {
  const accountId = required("CLOUDFLARE_ACCOUNT_ID");
  const token = required("CLOUDFLARE_API_TOKEN");

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/hyperdrive/configs/${id}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await response.json()) as {
    success: boolean;
    result?: { origin: Origin };
    errors?: Array<{ code: number; message: string }>;
  };

  if (!response.ok || !body.success || !body.result) {
    const detail =
      body.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? response.statusText;
    console.error(`\n  Could not read Hyperdrive config ${id}: ${detail}`);
    // Fail closed, loudly, with the fix: a token that cannot read the binding
    // cannot confirm the target, and an unconfirmed target must not be migrated.
    console.error("  The API token needs Account -> Hyperdrive -> Read.\n");
    process.exit(1);
  }
  return body.result.origin;
}

function originOf(connectionString: string): Origin {
  const url = new URL(connectionString);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
  };
}

function sameOrigin(a: Origin, b: Origin): boolean {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    a.database === b.database &&
    a.user === b.user
  );
}

function describe(origin: Origin): string {
  return `${origin.user}@${origin.host}:${origin.port}/${origin.database}`;
}

async function main() {
  const targetEnv = process.argv[2];
  if (!targetEnv) {
    console.error("Usage: pnpm db:verify-target <environment>");
    process.exit(1);
  }

  const ids = hyperdriveIdsByEnv();
  const targetId = ids.get(targetEnv);
  if (!targetId) {
    console.error(
      `Unknown environment "${targetEnv}". Known: ${[...ids.keys()].sort().join(", ")}`,
    );
    process.exit(1);
  }

  const actual = originOf(required("DATABASE_URL"));
  const expected = await fetchOrigin(targetId);

  console.log(`Target environment : ${targetEnv}`);
  console.log(`Hyperdrive binding : ${targetId}`);
  console.log(`Expected origin    : ${describe(expected)}`);
  console.log(`DATABASE_URL       : ${describe(actual)}`);

  // The wrong-environment case first: a generic mismatch message would leave
  // the operator wondering which database they nearly migrated.
  for (const [name, id] of ids) {
    if (name === targetEnv) continue;
    const other = await fetchOrigin(id);
    if (sameOrigin(actual, other)) {
      console.error(
        `\n  REFUSED: DATABASE_URL is the ${name.toUpperCase()} database, not ${targetEnv}.`,
      );
      console.error(`  Nothing was applied. Check which secret the job is reading.\n`);
      process.exit(1);
    }
  }

  if (!sameOrigin(actual, expected)) {
    console.error(`\n  REFUSED: DATABASE_URL does not match the ${targetEnv} Hyperdrive origin.`);
    console.error("  Nothing was applied.\n");
    process.exit(1);
  }

  // Connect, so a URL that matches on paper but cannot be reached fails here
  // rather than halfway through the migration.
  const pool = new pg.Pool({
    connectionString: required("DATABASE_URL"),
    max: 1,
    connectionTimeoutMillis: 15_000,
  });
  pool.on("error", () => {});
  try {
    const { rows } = await pool.query<{
      database: string;
      user: string;
      version: string;
    }>("select current_database() as database, current_user as user, version() as version");
    const identity = rows[0];
    if (identity.database !== expected.database) {
      console.error(
        `\n  REFUSED: connected to "${identity.database}" but expected "${expected.database}".\n`,
      );
      process.exit(1);
    }
    console.log(`Connected          : ${identity.user}@${identity.database}`);
    console.log(`Server             : ${identity.version.split(" on ")[0]}`);
  } finally {
    await pool.end();
  }

  console.log(`\nConfirmed: this is the ${targetEnv} database.`);
}

main().catch((error) => {
  console.error("Target verification failed:", error);
  process.exit(1);
});
