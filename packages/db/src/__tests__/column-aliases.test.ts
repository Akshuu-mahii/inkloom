/**
 * Columns that do not exist, and the raw SQL that keeps reaching for them.
 *
 * Several tables name a timestamp for what it MEANS rather than for when the row
 * appeared: a redemption has `redeemedAt`, a data export has `requestedAt`, a
 * role grant has `grantedAt`. All three are the same physical column —
 * `created_at` — aliased in the Drizzle schema via the shared `createdAt()`
 * helper. Through the query builder that is invisible and correct.
 *
 * Raw SQL does not go through the query builder. Writing `ORDER BY
 * r.redeemed_at` reads as obviously right, matches the TypeScript property, and
 * fails at runtime with SQLSTATE 42703 — undefined column.
 *
 * That is not hypothetical. The redemption replay path — the query that answers
 * "you have already redeemed this code" — contained exactly that, and returned a
 * 500 every time it ran. It survived for a long time because a lock upstream
 * made the path nearly unreachable; the moment that lock was removed for
 * performance, it fired immediately.
 *
 * So this test derives the phantom names FROM THE SCHEMA rather than listing
 * them. Alias a fourth column tomorrow and the guard covers it without anyone
 * remembering to update a list.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const SCHEMA_DIR = join(REPO, "packages/db/src/schema");

const snake = (s: string) => s.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase();

/**
 * Property names that resolve to a different physical column, and the name a
 * reader would wrongly expect the column to have.
 */
function aliasedColumns(): Array<{
  file: string;
  property: string;
  phantom: string;
  real: string;
}> {
  const found: Array<{ file: string; property: string; phantom: string; real: string }> = [];

  for (const entry of readdirSync(SCHEMA_DIR)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(join(SCHEMA_DIR, entry), "utf8");

    for (const m of source.matchAll(/(\w+)\s*:\s*(createdAt|updatedAt)\(\)/g)) {
      const property = m[1]!;
      const real = m[2] === "createdAt" ? "created_at" : "updated_at";
      const phantom = snake(property);
      if (phantom !== real) found.push({ file: entry, property, phantom, real });
    }
  }
  return found;
}

/** Every .ts/.sql file that could contain hand-written SQL. */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "build", "dist", "__tests__", ".wrangler"].includes(entry))
      continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFiles(full, found);
    else if (/\.(ts|tsx|sql)$/.test(entry)) found.push(full);
  }
  return found;
}

describe("aliased timestamp columns", () => {
  it("finds the aliases, so the guard below cannot pass by checking nothing", () => {
    const aliases = aliasedColumns();

    expect(aliases.length, "expected at least the three known aliases").toBeGreaterThanOrEqual(3);
    expect(aliases.map((a) => a.property)).toEqual(
      expect.arrayContaining(["redeemedAt", "requestedAt", "grantedAt"]),
    );
    for (const a of aliases) expect(a.real).toBe("created_at");
  });

  it("no file references a column name that does not exist", () => {
    const aliases = aliasedColumns();
    const offenders: string[] = [];

    for (const file of sourceFiles(join(REPO, "packages")).concat(
      sourceFiles(join(REPO, "apps")),
      sourceFiles(join(REPO, "scripts")),
    )) {
      /*
       * Comments are blanked, not skipped, so reported line numbers still point
       * at the real line. Prose ABOUT the phantom column — including the
       * paragraph in redemption.ts explaining this exact bug, and the header of
       * this file — is documentation, not SQL. A guard that fails on its own
       * explanation gets deleted rather than fixed.
       */
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

      source.split("\n").forEach((line, index) => {
        for (const alias of aliases) {
          /*
           * Word-bounded, and only the snake_case spelling. The camelCase
           * property is the correct thing to write in TypeScript; it is the
           * SQL-shaped spelling that is always wrong, because no such column was
           * ever created.
           */
          if (new RegExp(`\\b${alias.phantom}\\b`).test(line)) {
            offenders.push(
              `${relative(REPO, file)}:${index + 1}  "${alias.phantom}" does not exist ` +
                `(${alias.property} maps to ${alias.real})\n      ${line.trim().slice(0, 100)}`,
            );
          }
        }
      });
    }

    expect(
      offenders,
      "Raw SQL referencing a column that was never created. These fail at " +
        "runtime with SQLSTATE 42703, not at build time:\n\n" +
        offenders.join("\n") +
        "\n",
    ).toEqual([]);
  });
});
