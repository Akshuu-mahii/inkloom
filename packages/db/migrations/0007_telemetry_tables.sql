-- Operational telemetry: request metrics, daily rollups, provider usage.
--
-- Three tables, one rule: a request never writes to any of them. The Worker
-- accumulates in memory and flushes an aggregate at most once per interval per
-- isolate, so measuring the system does not become the most expensive thing it
-- does. Every counter is additive because several isolates flush partial views
-- of the same hour.
--
-- Latency is a histogram rather than a stored percentile for the same reason:
-- percentiles cannot be merged. Averaging two isolates' p95 produces a number
-- that is not the p95 of anything. Bucket counts add correctly.

CREATE TABLE "daily_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"users_total" integer,
	"users_verified" integer,
	"signups" integer,
	"verifications" integer,
	"logins" integer,
	"dau" integer,
	"wau" integer,
	"mau" integer,
	"funnel_visitors" integer,
	"funnel_signup_started" integer,
	"funnel_signup_completed" integer,
	"funnel_verified" integer,
	"funnel_activated" integer,
	"credits_issued" integer,
	"credits_spent" integer,
	"redemptions" integer,
	"emails_sent" integer,
	"emails_failed" integer,
	"support_opened" integer,
	"security_events" integer,
	"rate_limit_blocks" integer,
	"database_bytes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"metric" text NOT NULL,
	"day" date NOT NULL,
	"value" text NOT NULL,
	"unit" text NOT NULL,
	"allowance" text,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"hour" integer NOT NULL,
	"route_group" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"status_2xx" integer DEFAULT 0 NOT NULL,
	"status_3xx" integer DEFAULT 0 NOT NULL,
	"status_4xx" integer DEFAULT 0 NOT NULL,
	"status_429" integer DEFAULT 0 NOT NULL,
	"status_5xx" integer DEFAULT 0 NOT NULL,
	"duration_ms_total" integer DEFAULT 0 NOT NULL,
	"duration_ms_max" integer DEFAULT 0 NOT NULL,
	"latency_buckets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_codes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_metrics_hour_range" CHECK ("request_metrics"."hour" >= 0 AND "request_metrics"."hour" <= 23),
	CONSTRAINT "request_metrics_non_negative" CHECK ("request_metrics"."requests" >= 0 AND "request_metrics"."duration_ms_total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "security_events" ALTER COLUMN "type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."security_event_type";--> statement-breakpoint
CREATE TYPE "public"."security_event_type" AS ENUM('login_failed', 'login_succeeded', 'login_blocked_suspended', 'login_new_device', 'password_reset_requested', 'password_reset_completed', 'password_changed', 'email_verification_sent', 'email_verified', 'session_revoked', 'sessions_revoked_all', 'rate_limit_exceeded', 'turnstile_failed', 'csrf_rejected', 'origin_rejected', 'access_code_failed', 'access_code_abuse_suspected', 'admin_login', 'admin_2fa_failed', 'admin_privilege_change', 'account_suspended', 'account_unsuspended', 'two_factor_enabled', 'two_factor_disabled', 'credit_adjustment_suspicious', 'unauthorized_admin_access', 'data_export_requested');--> statement-breakpoint
ALTER TABLE "security_events" ALTER COLUMN "type" SET DATA TYPE "public"."security_event_type" USING "type"::"public"."security_event_type";--> statement-breakpoint
CREATE UNIQUE INDEX "daily_metrics_day_key" ON "daily_metrics" USING btree ("day");--> statement-breakpoint
CREATE INDEX "daily_metrics_day_idx" ON "daily_metrics" USING btree ("day" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "provider_metrics_slot_key" ON "provider_metrics" USING btree ("provider","metric","day");--> statement-breakpoint
CREATE INDEX "provider_metrics_day_idx" ON "provider_metrics" USING btree ("day" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "request_metrics_slot_key" ON "request_metrics" USING btree ("day","hour","route_group");--> statement-breakpoint
CREATE INDEX "request_metrics_day_idx" ON "request_metrics" USING btree ("day" DESC NULLS LAST);