/**
 * The backward-compatibility gate.
 *
 * Migrations run before the new code is deployed, so this scanner is the only
 * thing standing between a one-line schema change and a production outage that
 * `wrangler rollback` cannot fix. Both directions matter: a rule that never
 * fires protects nothing, and a rule that fires on ordinary additive migrations
 * gets bypassed with --allow-destructive until it means nothing either.
 */
import { describe, expect, it } from "vitest";
import { incompatibilities, journal, statementsOf } from "../_migrations";

describe("statements that break the running version", () => {
  const cases: Array<[string, string]> = [
    ["drops a table", `DROP TABLE "email_change_events";`],
    ["drops a column", `ALTER TABLE "users" DROP COLUMN "legacy_handle";`],
    ["renames a column", `ALTER TABLE "users" RENAME COLUMN "name" TO "display_name";`],
    ["renames a table", `ALTER TABLE "profile" RENAME TO "profiles";`],
    [
      "adds NOT NULL to an existing column",
      `ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL;`,
    ],
    ["narrows a type", `ALTER TABLE "users" ALTER COLUMN "name" SET DATA TYPE varchar(20);`],
    [
      "adds a NOT NULL column with no default",
      `ALTER TABLE "users" ADD COLUMN "tier" text NOT NULL;`,
    ],
    ["drops a view", `DROP VIEW "password_reset_tokens";`],
  ];

  for (const [name, sql] of cases) {
    it(`flags one that ${name}`, () => {
      expect(incompatibilities(sql)).not.toHaveLength(0);
    });
  }

  it("names every distinct reason once, not once per statement", () => {
    const sql = `ALTER TABLE "a" DROP COLUMN "x";\nALTER TABLE "b" DROP COLUMN "y";`;
    expect(incompatibilities(sql)).toHaveLength(1);
  });
});

describe("statements that are safe to run ahead of the deploy", () => {
  const cases: Array<[string, string]> = [
    ["adds a nullable column", `ALTER TABLE "users" ADD COLUMN "nickname" text;`],
    [
      "adds a NOT NULL column WITH a default",
      `ALTER TABLE "users" ADD COLUMN "tier" text DEFAULT 'free' NOT NULL;`,
    ],
    ["adds a table", `CREATE TABLE "job_runs" ("id" text PRIMARY KEY NOT NULL);`],
    ["adds an index", `CREATE INDEX "users_email_idx" ON "users" ("email");`],
    ["replaces a view in place", `CREATE OR REPLACE VIEW "credit_wallet_drift" AS SELECT 1;`],
    ["drops a constraint", `ALTER TABLE "users" DROP CONSTRAINT "users_name_check";`],
  ];

  for (const [name, sql] of cases) {
    it(`allows one that ${name}`, () => {
      expect(incompatibilities(sql)).toHaveLength(0);
    });
  }

  it("ignores a DROP COLUMN that is commented out", () => {
    expect(incompatibilities(`-- ALTER TABLE "users" DROP COLUMN "x";\nSELECT 1;`)).toHaveLength(0);
  });

  it("ignores a DROP TABLE inside a block comment", () => {
    expect(incompatibilities(`/* DROP TABLE "users"; */\nSELECT 1;`)).toHaveLength(0);
  });
});

describe("statement splitting", () => {
  it("splits on Drizzle breakpoints and semicolons alike", () => {
    const sql = `SELECT 1;\n--> statement-breakpoint\nSELECT 2;\nSELECT 3;`;
    expect(statementsOf(sql)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });
});

describe("the journal on disk", () => {
  it("pairs every entry with the file Drizzle hashes", () => {
    const entries = journal();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.file).toContain(entry.tag);
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
