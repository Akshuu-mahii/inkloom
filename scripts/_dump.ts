/**
 * Shared dump-file knowledge, in its own module ON PURPOSE.
 *
 * This lived in `backup.ts` and was imported from `restore-verify.ts`, which
 * meant importing the checker also ran the backup script's `main()` — taking a
 * full dump as a side effect of an import, and then calling `process.exit(0)`
 * partway through the caller's own run. The restore test appeared to pass while
 * silently skipping its last assertions.
 *
 * A module with executable top-level side effects is not importable. Keeping
 * the pure part separate is the fix.
 */
import { readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";

/**
 * Objects a valid dump of this schema must contain.
 *
 * The triggers are on this list deliberately. A dump that restores the data but
 * not the append-only protections produces a database where the ledger and the
 * audit trail can be rewritten — which is a worse outcome than a restore that
 * visibly fails, because nothing about it looks wrong.
 */
export const REQUIRED_OBJECTS = [
  "CREATE TABLE public.users",
  "CREATE TABLE public.credit_ledger",
  "CREATE TABLE public.audit_events",
  "inkloom_forbid_mutation",
  "credit_ledger_append_only",
  "audit_events_append_only",
];

export interface DumpFacts {
  bytes: number;
  tables: number;
  /** Rows in the `users` COPY block, or null if it was dumped another way. */
  userRows: number | null;
}

/**
 * Everything that must be true of a dump file on disk.
 *
 * Throws on the first problem rather than collecting them: a dump that fails
 * any one of these is not a backup, and there is nothing useful to say about
 * the rest of it.
 */
export function verifyDumpFile(file: string): DumpFacts {
  const bytes = statSync(file).size;
  if (bytes === 0) throw new Error("the dump is empty");

  const text = gunzipSync(readFileSync(file)).toString("utf8");

  const missing = REQUIRED_OBJECTS.filter((o) => !text.includes(o));
  if (missing.length) throw new Error(`the dump is missing: ${missing.join(", ")}`);

  /*
   * Truncation is the failure mode that matters, because a half-written dump
   * looks exactly like a good one until the day you need it.
   *
   * Two markers, because pg_dump's tail is version-dependent. The completion
   * comment has been there for years. Postgres 17 additionally wraps the whole
   * dump in `\restrict` / `\unrestrict`, so the comment is no longer the last
   * line — checking only for a trailing comment reported every PG17 dump as
   * truncated, a false alarm that would train someone to ignore this check. If
   * a dump opens a restrict block it must close it.
   */
  if (!text.includes("PostgreSQL database dump complete")) {
    throw new Error("the dump is truncated — no completion marker");
  }
  if (text.includes("\\restrict ") && !text.includes("\\unrestrict ")) {
    throw new Error("the dump is truncated — restrict block left open");
  }

  return {
    bytes,
    tables: (text.match(/CREATE TABLE public\./g) ?? []).length,
    userRows: countCopyRows(text, "public.users"),
  };
}

/** Count rows in a COPY block, or null if the table was dumped another way. */
export function countCopyRows(dump: string, table: string): number | null {
  const start = dump.indexOf(`COPY ${table} (`);
  if (start === -1) return null;
  const from = dump.indexOf("\n", start) + 1;

  /*
   * An EMPTY table terminates immediately: the `\.` sits on the line straight
   * after the COPY header, with no row lines between them. Searching only for a
   * newline-prefixed terminator misses that case and reports null — "this table
   * was dumped some other way" — when the truthful answer is zero rows. Those
   * two are very different when the question is whether a restore lost data.
   */
  const end = dump.startsWith("\\.", from) ? from : dump.indexOf("\n\\.", from);
  if (end === -1) return null;

  const body = dump.slice(from, end);
  return body.length === 0 ? 0 : body.split("\n").length;
}
