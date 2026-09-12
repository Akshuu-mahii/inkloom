-- Remove the security-event types belonging to two withdrawn features.
--
-- Self-service account deletion and self-service email change were removed from
-- the product. Their endpoints, schemas, templates and feature flag are gone, so
-- nothing can ever write these three values again and leaving them in the enum
-- would advertise capabilities that no longer exist.
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`, so the type has to be rebuilt and
-- the column re-pointed at it. `security_events.type` is the only column using
-- this type and no view depends on it, which is what makes that safe here.
--
-- The guard below matters: if any row still carries one of these values, the
-- rebuild would fail partway through with Postgres's own opaque "invalid input
-- value for enum" error. Failing first, with a message naming the problem, keeps
-- a deploy diagnosable. It is deliberately a hard failure rather than a silent
-- delete — these are security-audit rows and dropping them quietly to make a
-- migration pass would be the wrong trade.

DO $$
DECLARE
  stale bigint;
BEGIN
  SELECT count(*) INTO stale
  FROM security_events
  WHERE type IN ('email_change_requested', 'email_changed', 'account_deleted');

  IF stale > 0 THEN
    RAISE EXCEPTION
      'Cannot drop these security_event_type values: % existing row(s) still use them. Re-map or archive those rows first; this migration will not delete security-audit history.', stale;
  END IF;
END $$;
--> statement-breakpoint

ALTER TYPE security_event_type RENAME TO security_event_type_old;
--> statement-breakpoint

CREATE TYPE security_event_type AS ENUM (
  'login_failed',
  'login_succeeded',
  'login_blocked_suspended',
  'login_new_device',
  'password_reset_requested',
  'password_reset_completed',
  'password_changed',
  'email_verification_sent',
  'email_verified',
  'session_revoked',
  'sessions_revoked_all',
  'rate_limit_exceeded',
  'turnstile_failed',
  'csrf_rejected',
  'origin_rejected',
  'access_code_failed',
  'access_code_abuse_suspected',
  'admin_login',
  'admin_2fa_failed',
  'admin_privilege_change',
  'account_suspended',
  'account_unsuspended',
  'credit_adjustment_suspicious',
  'unauthorized_admin_access',
  'data_export_requested',
  'two_factor_enabled',
  'two_factor_disabled'
);
--> statement-breakpoint

ALTER TABLE security_events
  ALTER COLUMN type TYPE security_event_type
  USING type::text::security_event_type;
--> statement-breakpoint

DROP TYPE security_event_type_old;
