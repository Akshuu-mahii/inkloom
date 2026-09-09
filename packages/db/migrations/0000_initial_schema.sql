CREATE TYPE "public"."campaign_status" AS ENUM('enabled', 'paused', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('terms', 'privacy', 'marketing_email', 'product_analytics');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed');--> statement-breakpoint
CREATE TYPE "public"."export_status" AS ENUM('requested', 'processing', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."ledger_actor_type" AS ENUM('user', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."ledger_ref_type" AS ENUM('access_code_redemption', 'admin_adjustment', 'reversal', 'expiry_sweep', 'system_bootstrap', 'payment', 'generation');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('EARLY_ACCESS_GRANT', 'PROMOTIONAL_GRANT', 'ADMIN_GRANT', 'ADMIN_DEDUCTION', 'EXPIRY', 'REVERSAL', 'PURCHASE', 'GENERATION_RESERVE', 'GENERATION_CAPTURE', 'GENERATION_RELEASE', 'PAYMENT_REFUND');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('announcement', 'security', 'credits', 'support', 'account');--> statement-breakpoint
CREATE TYPE "public"."redemption_outcome" AS ENUM('granted', 'duplicate', 'limit_reached', 'expired', 'not_started', 'paused', 'revoked', 'unknown_code', 'domain_not_allowed', 'email_unverified', 'user_suspended', 'rate_limited', 'redemption_disabled');--> statement-breakpoint
CREATE TYPE "public"."role_name" AS ENUM('user', 'support', 'operations', 'admin', 'super_admin');--> statement-breakpoint
CREATE TYPE "public"."security_event_type" AS ENUM('login_failed', 'login_succeeded', 'login_blocked_suspended', 'login_new_device', 'password_reset_requested', 'password_reset_completed', 'password_changed', 'email_change_requested', 'email_changed', 'email_verification_sent', 'email_verified', 'session_revoked', 'sessions_revoked_all', 'rate_limit_exceeded', 'turnstile_failed', 'csrf_rejected', 'origin_rejected', 'access_code_failed', 'access_code_abuse_suspected', 'admin_login', 'admin_2fa_failed', 'admin_privilege_change', 'account_suspended', 'account_unsuspended', 'account_deleted', 'credit_adjustment_suspicious', 'unauthorized_admin_access', 'data_export_requested');--> statement-breakpoint
CREATE TYPE "public"."support_category" AS ENUM('account', 'billing', 'access_code', 'bug', 'feedback', 'security', 'other');--> statement-breakpoint
CREATE TYPE "public"."support_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."support_status" AS ENUM('open', 'in_progress', 'waiting_on_user', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'pending_deletion', 'deleted');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text,
	"company" text,
	"timezone" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" text,
	"absolute_expires_at" timestamp with time zone,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"normalized_email" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"deletion_requested_at" timestamp with time zone,
	"anonymized_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_login_ip_hash" text,
	"early_access_joined_at" timestamp with time zone,
	"signup_utm" jsonb,
	CONSTRAINT "users_normalized_email_is_folded" CHECK ("users"."normalized_email" = lower("users"."normalized_email")),
	CONSTRAINT "users_suspension_consistent" CHECK (
      ("users"."status" <> 'suspended') OR ("users"."suspended_at" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" "role_name" NOT NULL,
	"rank" integer NOT NULL,
	"description" text NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text
);
--> statement-breakpoint
CREATE TABLE "access_code_campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"code_fingerprint" text NOT NULL,
	"code_masked" text NOT NULL,
	"code_last4" text NOT NULL,
	"credit_amount" integer NOT NULL,
	"max_total_redemptions" integer,
	"max_redemptions_per_user" integer DEFAULT 1 NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"status" "campaign_status" DEFAULT 'enabled' NOT NULL,
	"allowed_email_domains" jsonb,
	"target_cohort" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paused_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"revoked_reason" text,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"last_redeemed_at" timestamp with time zone,
	CONSTRAINT "campaigns_credit_amount_positive" CHECK ("access_code_campaigns"."credit_amount" > 0),
	CONSTRAINT "campaigns_max_total_positive" CHECK ("access_code_campaigns"."max_total_redemptions" IS NULL OR "access_code_campaigns"."max_total_redemptions" > 0),
	CONSTRAINT "campaigns_per_user_positive" CHECK ("access_code_campaigns"."max_redemptions_per_user" > 0),
	CONSTRAINT "campaigns_count_non_negative" CHECK ("access_code_campaigns"."redemption_count" >= 0),
	CONSTRAINT "campaigns_window_ordered" CHECK ("access_code_campaigns"."starts_at" IS NULL OR "access_code_campaigns"."expires_at" IS NULL OR "access_code_campaigns"."starts_at" < "access_code_campaigns"."expires_at"),
	CONSTRAINT "campaigns_within_total_cap" CHECK ("access_code_campaigns"."max_total_redemptions" IS NULL OR "access_code_campaigns"."redemption_count" <= "access_code_campaigns"."max_total_redemptions")
);
--> statement-breakpoint
CREATE TABLE "access_code_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"user_id" text NOT NULL,
	"slot" integer DEFAULT 1 NOT NULL,
	"credits_granted" integer NOT NULL,
	"ledger_entry_id" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redemptions_credits_positive" CHECK ("access_code_redemptions"."credits_granted" > 0),
	CONSTRAINT "redemptions_slot_positive" CHECK ("access_code_redemptions"."slot" >= 1)
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"amount" integer NOT NULL,
	"type" "ledger_type" NOT NULL,
	"balance_after" integer NOT NULL,
	"reference_type" "ledger_ref_type" NOT NULL,
	"reference_id" text,
	"idempotency_key" text NOT NULL,
	"actor_type" "ledger_actor_type" NOT NULL,
	"actor_id" text,
	"reason" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_amount_non_zero" CHECK ("credit_ledger"."amount" <> 0),
	CONSTRAINT "credit_ledger_balance_non_negative" CHECK ("credit_ledger"."balance_after" >= 0),
	CONSTRAINT "credit_ledger_reason_not_blank" CHECK (length(btrim("credit_ledger"."reason")) > 0),
	CONSTRAINT "credit_ledger_v1_types_only" CHECK ("credit_ledger"."type" IN ('EARLY_ACCESS_GRANT','PROMOTIONAL_GRANT','ADMIN_GRANT','ADMIN_DEDUCTION','EXPIRY','REVERSAL')),
	CONSTRAINT "credit_ledger_sign_matches_type" CHECK (
        ("credit_ledger"."type" IN ('EARLY_ACCESS_GRANT','PROMOTIONAL_GRANT','ADMIN_GRANT') AND "credit_ledger"."amount" > 0)
        OR ("credit_ledger"."type" IN ('ADMIN_DEDUCTION','EXPIRY') AND "credit_ledger"."amount" < 0)
        OR ("credit_ledger"."type" = 'REVERSAL')
        OR ("credit_ledger"."type" IN ('PURCHASE','GENERATION_RESERVE','GENERATION_CAPTURE','GENERATION_RELEASE','PAYMENT_REFUND'))
      )
);
--> statement-breakpoint
CREATE TABLE "credit_wallets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"last_entry_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_wallets_balance_non_negative" CHECK ("credit_wallets"."balance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"request_hash" text NOT NULL,
	"response_body" jsonb,
	"response_status" integer,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_state_valid" CHECK ("idempotency_keys"."state" IN ('in_progress','completed','failed'))
);
--> statement-breakpoint
CREATE TABLE "data_export_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" "export_status" DEFAULT 'requested' NOT NULL,
	"payload" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"to_email" text NOT NULL,
	"template" text NOT NULL,
	"subject" text NOT NULL,
	"status" "email_status" DEFAULT 'queued' NOT NULL,
	"provider_message_id" text,
	"error" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"action_path" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"security_email" boolean DEFAULT true NOT NULL,
	"product_updates_email" boolean DEFAULT true NOT NULL,
	"marketing_email" boolean DEFAULT false NOT NULL,
	"credits_email" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_prefs_security_always_on" CHECK ("notification_preferences"."security_email" = true)
);
--> statement-breakpoint
CREATE TABLE "user_consents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"type" "consent_type" NOT NULL,
	"granted" boolean NOT NULL,
	"document_version" text,
	"ip_hash" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"user_id" text,
	"email" text NOT NULL,
	"name" text,
	"category" "support_category" DEFAULT 'other' NOT NULL,
	"priority" "support_priority" DEFAULT 'normal' NOT NULL,
	"status" "support_status" DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"request_id" text,
	"assigned_to" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "abuse_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_key" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"hit_count" integer DEFAULT 1 NOT NULL,
	"active_until" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	CONSTRAINT "abuse_subject_type_valid" CHECK ("abuse_flags"."subject_type" IN ('user','ip','email_domain'))
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"anonymous_id" text,
	"user_id" text,
	"device_category" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"referrer" text,
	"landing_path" text,
	"path" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_role" text,
	"target_type" text,
	"target_id" text,
	"reason" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_actor_type_valid" CHECK ("audit_events"."actor_type" IN ('user','admin','system'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"subject" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_seconds" integer NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_count_positive" CHECK ("rate_limit_events"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "security_event_type" NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"user_id" text,
	"target_email" text,
	"ip_hash" text,
	"user_agent" text,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_severity_valid" CHECK ("security_events"."severity" IN ('info','warning','critical'))
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"description" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"high_risk" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"description" text NOT NULL,
	"high_risk" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_code_campaigns" ADD CONSTRAINT "access_code_campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_code_campaigns" ADD CONSTRAINT "access_code_campaigns_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_code_redemptions" ADD CONSTRAINT "access_code_redemptions_campaign_id_access_code_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."access_code_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_code_redemptions" ADD CONSTRAINT "access_code_redemptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_requests" ADD CONSTRAINT "data_export_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_notes" ADD CONSTRAINT "admin_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_flags" ADD CONSTRAINT "abuse_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_flags" ADD CONSTRAINT "feature_flags_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_key" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_user_key" ON "profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_expires_idx" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_last_active_idx" ON "sessions" USING btree ("user_id","last_active_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "two_factor_user_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users" USING btree ("normalized_email");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_email_verified_idx" ON "users" USING btree ("email_verified");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification_tokens" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expires_at_idx" ON "verification_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_key" ON "roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_rank_key" ON "roles" USING btree ("rank");--> statement-breakpoint
CREATE UNIQUE INDEX "user_roles_active_key" ON "user_roles" USING btree ("user_id","role_id") WHERE "user_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_fingerprint_key" ON "access_code_campaigns" USING btree ("code_fingerprint");--> statement-breakpoint
CREATE INDEX "campaigns_status_expires_idx" ON "access_code_campaigns" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "campaigns_created_at_idx" ON "access_code_campaigns" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "campaigns_cohort_idx" ON "access_code_campaigns" USING btree ("target_cohort");--> statement-breakpoint
CREATE UNIQUE INDEX "redemptions_campaign_user_slot_key" ON "access_code_redemptions" USING btree ("campaign_id","user_id","slot");--> statement-breakpoint
CREATE INDEX "redemptions_campaign_idx" ON "access_code_redemptions" USING btree ("campaign_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "redemptions_user_idx" ON "access_code_redemptions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_key" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_created_idx" ON "credit_ledger" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_ledger_type_created_idx" ON "credit_ledger" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_ledger_reference_idx" ON "credit_ledger" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_actor_idx" ON "credit_ledger" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "credit_wallets_user_key" ON "credit_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_key" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_user_idx" ON "idempotency_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "exports_user_idx" ON "data_export_requests" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "exports_status_idx" ON "data_export_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_events_status_created_idx" ON "email_events" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_events_user_idx" ON "email_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_events_template_idx" ON "email_events" USING btree ("template","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "email_events_to_idx" ON "email_events" USING btree ("to_email");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_prefs_user_key" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consents_user_type_idx" ON "user_consents" USING btree ("user_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "consents_created_idx" ON "user_consents" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_notes_subject_idx" ON "admin_notes" USING btree ("subject_type","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "admin_notes_author_idx" ON "admin_notes" USING btree ("author_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_reference_key" ON "support_requests" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "support_status_created_idx" ON "support_requests" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_user_idx" ON "support_requests" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_email_idx" ON "support_requests" USING btree ("email");--> statement-breakpoint
CREATE INDEX "support_priority_idx" ON "support_requests" USING btree ("priority","status");--> statement-breakpoint
CREATE INDEX "abuse_subject_idx" ON "abuse_flags" USING btree ("subject_type","subject_key");--> statement-breakpoint
CREATE INDEX "abuse_active_idx" ON "abuse_flags" USING btree ("active_until");--> statement-breakpoint
CREATE INDEX "abuse_created_idx" ON "abuse_flags" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "analytics_name_created_idx" ON "analytics_events" USING btree ("name","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "analytics_user_idx" ON "analytics_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "analytics_anon_idx" ON "analytics_events" USING btree ("anonymous_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "analytics_created_idx" ON "analytics_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_actor_created_idx" ON "audit_events" USING btree ("actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_action_created_idx" ON "audit_events" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_events" USING btree ("target_type","target_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "rate_limit_lookup_idx" ON "rate_limit_events" USING btree ("bucket","subject","window_start");--> statement-breakpoint
CREATE INDEX "rate_limit_window_idx" ON "rate_limit_events" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "rate_limit_blocked_idx" ON "rate_limit_events" USING btree ("blocked","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_type_created_idx" ON "security_events" USING btree ("type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_user_created_idx" ON "security_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_ip_created_idx" ON "security_events" USING btree ("ip_hash","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_created_idx" ON "security_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags" USING btree ("key");--> statement-breakpoint
CREATE INDEX "feature_flags_enabled_idx" ON "feature_flags" USING btree ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings" USING btree ("key");