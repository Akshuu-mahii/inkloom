-- Reconciles Drizzle's snapshot with reality.
--
-- `0008_job_runs.sql` was hand-written, and its journal entry was added by
-- hand too — but no `meta/0008_snapshot.json` was ever generated. Drizzle's
-- model of the schema therefore stopped at 0007, so every `db:generate` wanted
-- to create `job_runs` again and CI's drift check failed permanently.
--
-- This migration carries the snapshot that was missing. It is written
-- IDEMPOTENTLY because `job_runs` already exists everywhere 0008 was applied:
-- on those databases this is a no-op, and on a fresh one it is the table's
-- definition. Either way Drizzle's snapshot is correct from here on.
--
-- The lesson, for the next hand-written migration: `db:generate` produces the
-- SQL, the journal entry AND the snapshot. Writing only the first two leaves
-- the tool blind to the change.

CREATE TABLE IF NOT EXISTS "job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"steps" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_status_check" CHECK ("job_runs"."status" IN ('ok', 'partial', 'failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_runs_job_finished_idx" ON "job_runs" USING btree ("job","finished_at" DESC NULLS LAST);
