-- Converts users.normalized_email from an application-maintained column into a
-- Postgres GENERATED column derived from `email`, so it can never drift and no
-- code path can forget to write it.
--
-- Dropping the column also drops the unique index that depends on it, so the
-- index is recreated explicitly below. Losing the old values is safe: every one
-- of them is reproducible from `email`, which is exactly the point.
ALTER TABLE "users" DROP CONSTRAINT "users_normalized_email_is_folded";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "normalized_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" drop column "normalized_email";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "normalized_email" text GENERATED ALWAYS AS (lower(email)) STORED;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "locked_until" timestamp with time zone;
--> statement-breakpoint
-- Recreated: DROP COLUMN above removed it along with the column. This index is
-- the actual enforcement of case-insensitive email uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS "users_normalized_email_key" ON "users" ("normalized_email");
