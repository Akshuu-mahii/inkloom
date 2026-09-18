/**
 * The backup file checks.
 *
 * These matter more than most unit tests because of when they run: unattended,
 * nightly, against a file nobody will look at until the day it is the only copy
 * of the data left. A corrupt archive that passes verification is indistinguish-
 * able from a good one right up until the restore fails.
 *
 * So every case here is a way a dump can be broken while still looking
 * plausible — the right size, valid gzip, real SQL inside — rather than the
 * obviously-empty case that any check would catch.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countCopyRows, verifyDumpFile } from "../_dump";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "inkloom-dump-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A dump with everything a real one has, so tests can remove one thing at a time. */
function validDump(): string {
  return [
    "--",
    "-- PostgreSQL database dump",
    "--",
    "",
    "\\restrict AbCdEf123",
    "",
    "CREATE TABLE public.users (id text NOT NULL, email text NOT NULL);",
    "CREATE TABLE public.credit_ledger (id text NOT NULL, amount integer NOT NULL);",
    "CREATE TABLE public.audit_events (id text NOT NULL, action text NOT NULL);",
    "",
    "COPY public.users (id, email) FROM stdin;",
    "usr_1\tada@example.test",
    "usr_2\tgrace@example.test",
    "\\.",
    "",
    "CREATE FUNCTION public.inkloom_forbid_mutation() RETURNS trigger AS $$ $$;",
    "CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE ON public.credit_ledger",
    "CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON public.audit_events",
    "",
    "--",
    "-- PostgreSQL database dump complete",
    "--",
    "",
    "\\unrestrict AbCdEf123",
    "",
  ].join("\n");
}

function write(name: string, contents: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === "string" ? gzipSync(contents) : contents);
  return path;
}

describe("a dump that is actually usable", () => {
  it("accepts a complete one", () => {
    const facts = verifyDumpFile(write("good.sql.gz", validDump()));

    expect(facts.tables).toBe(3);
    expect(facts.userRows).toBe(2);
    expect(facts.bytes).toBeGreaterThan(0);
  });

  it("reads the row count out of the COPY block", () => {
    // The dump's own record of what it contains, which is what makes a
    // "restored but half the users are missing" failure detectable.
    expect(countCopyRows(validDump(), "public.users")).toBe(2);
    expect(countCopyRows(validDump(), "public.nonexistent")).toBeNull();
  });

  it("counts an empty table as zero rows, not as missing", () => {
    const empty = validDump().replace("usr_1\tada@example.test\nusr_2\tgrace@example.test\n", "");
    expect(countCopyRows(empty, "public.users")).toBe(0);
  });
});

describe("the ways a dump can be broken while still looking fine", () => {
  it("rejects an empty file", () => {
    expect(() => verifyDumpFile(write("empty.sql.gz", Buffer.alloc(0)))).toThrow(/empty/i);
  });

  /*
   * The important one. A dump cut off partway through is valid gzip, contains
   * real SQL, and is roughly the right size — it fails only at restore time.
   */
  it("rejects one truncated partway through", () => {
    const full = validDump();
    const cut = full.slice(0, full.indexOf("CREATE FUNCTION"));
    expect(() => verifyDumpFile(write("cut.sql.gz", cut))).toThrow(/missing/i);
  });

  it("rejects one missing the completion marker", () => {
    const noMarker = validDump().replace(
      "-- PostgreSQL database dump complete",
      "-- something else",
    );
    expect(() => verifyDumpFile(write("nomarker.sql.gz", noMarker))).toThrow(/truncated/i);
  });

  /*
   * Postgres 17 wraps a dump in \restrict / \unrestrict. An unclosed block
   * means the file ended early even when the completion comment is present,
   * because the comment is no longer the last thing written.
   */
  it("rejects one whose restrict block was never closed", () => {
    const unclosed = validDump().replace("\\unrestrict AbCdEf123", "");
    expect(() => verifyDumpFile(write("unclosed.sql.gz", unclosed))).toThrow(/restrict block/i);
  });

  it("accepts a dump from an older pg_dump with no restrict block at all", () => {
    // The wrapper is version-specific; its absence is not a defect.
    const older = validDump()
      .replace("\\restrict AbCdEf123", "")
      .replace("\\unrestrict AbCdEf123", "");
    expect(() => verifyDumpFile(write("older.sql.gz", older))).not.toThrow();
  });

  /*
   * The subtlest failure: everything restores, but the append-only triggers do
   * not come back. The result is a database where the ledger and the audit
   * trail can be silently rewritten, and nothing about it looks wrong.
   */
  it("rejects a dump that would restore the data without its protections", () => {
    const noTriggers = validDump()
      .replace("CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE ON public.credit_ledger", "")
      .replace("CREATE TRIGGER audit_events_append_only BEFORE UPDATE ON public.audit_events", "");

    expect(() => verifyDumpFile(write("notriggers.sql.gz", noTriggers))).toThrow(
      /credit_ledger_append_only/,
    );
  });

  it("rejects a dump missing a table that must exist", () => {
    const noLedger = validDump().replace(
      "CREATE TABLE public.credit_ledger (id text NOT NULL, amount integer NOT NULL);",
      "",
    );
    expect(() => verifyDumpFile(write("noledger.sql.gz", noLedger))).toThrow(/credit_ledger/);
  });

  it("rejects valid gzip that is not a dump at all", () => {
    expect(() => verifyDumpFile(write("wrong.sql.gz", "SELECT 1;"))).toThrow(/missing/i);
  });
});
