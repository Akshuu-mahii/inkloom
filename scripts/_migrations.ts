/**
 * Reading the migration folder, and judging what it is about to do.
 *
 * Split out from the CLI so the compatibility rules can be tested directly —
 * they are the part most likely to be wrong, and the part hardest to exercise
 * by running the command.
 */
import { readMigrationFiles } from "drizzle-orm/migrator";
import path from "node:path";
import { readFileSync } from "node:fs";
import { repoRoot } from "./_env";

export const migrationsFolder = path.join(repoRoot, "packages", "db", "migrations");

/**
 * Statements that break a database's compatibility with the version of the
 * code still running against it.
 *
 * Migrations are applied BEFORE the new Worker is deployed (docs/DEPLOYMENT.md),
 * so for a few seconds — and for as long as a rollback lasts — the OLD code is
 * talking to the NEW schema. Anything on this list makes that window fatal
 * instead of survivable, which is what expand -> migrate -> contract exists to
 * avoid: add the new thing, ship code that writes both, backfill, ship code that
 * reads the new one, and only then, in a LATER release, remove the old thing.
 *
 * A heuristic, and it says so: it reads SQL with regular expressions and will
 * occasionally flag something harmless. It refuses rather than warns because the
 * cost of a false positive is re-running with --allow-destructive after a human
 * has read the SQL, and the cost of a false negative is production down with no
 * rollback that works.
 */
export const INCOMPATIBLE: Array<{ test: (sql: string) => boolean; why: string }> = [
  {
    test: (s) => /\bdrop\s+table\b/i.test(s),
    why: "drops a table the running version may still query",
  },
  {
    test: (s) => /\bdrop\s+column\b/i.test(s),
    why: "drops a column the running version may still read",
  },
  {
    test: (s) => /\brename\s+(column\b|to\b)/i.test(s),
    why: "renames an object the running version knows by its old name",
  },
  {
    test: (s) => /\balter\s+column\b/i.test(s) && /\bset\s+not\s+null\b/i.test(s),
    why: "makes an existing column NOT NULL, which the running version may leave empty",
  },
  {
    test: (s) => /\balter\s+column\b/i.test(s) && /\b(set\s+data\s+)?type\b/i.test(s),
    why: "changes a column type under the running version",
  },
  {
    test: (s) =>
      /\badd\s+column\b/i.test(s) && /\bnot\s+null\b/i.test(s) && !/\bdefault\b/i.test(s),
    why: "adds a NOT NULL column with no default, so the running version cannot insert",
  },
  {
    test: (s) => /\bdrop\s+view\b/i.test(s),
    why: "drops a view the running version may select from",
  },
];

/**
 * Split into statements, with comments removed first.
 *
 * Order matters twice. Comments come out before the split on `;`, or a block
 * comment containing a semicolon is torn in half and its second fragment is
 * scanned as if it were code. And the Drizzle breakpoint marker is itself a
 * `--` line comment, so it has to be consumed before line comments are.
 */
export function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((chunk) => chunk.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " "))
    .flatMap((chunk) => chunk.split(";"))
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.length > 0);
}

export function incompatibilities(sql: string): string[] {
  const found = new Set<string>();
  for (const statement of statementsOf(sql)) {
    for (const rule of INCOMPATIBLE) {
      if (rule.test(statement)) found.add(rule.why);
    }
  }
  return [...found];
}

/** Journal entries, in order, paired with the hash Drizzle records for each. */
export function journal(): Array<{ tag: string; hash: string; file: string }> {
  const files = readMigrationFiles({ migrationsFolder });
  const meta = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };

  return meta.entries.map((entry, index) => ({
    tag: entry.tag,
    hash: files[index].hash,
    file: path.join(migrationsFolder, `${entry.tag}.sql`),
  }));
}
