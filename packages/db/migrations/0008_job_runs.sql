-- A durable record of scheduled job runs.
--
-- The retention sweep enforced the periods published at /privacy and left no
-- evidence that it had: it logged to Workers Logs, and only when it removed
-- something, so "ran and deleted nothing" and "never ran at all" looked
-- identical. This table makes the question answerable in SQL, months later,
-- and makes the ABSENCE of a row the alert — a run that dies halfway writes
-- nothing, so staleness is detected by age rather than by an error someone has
-- to remember to raise.

CREATE TABLE "job_runs" (
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
CREATE INDEX "job_runs_job_finished_idx" ON "job_runs" USING btree ("job","finished_at" DESC);
