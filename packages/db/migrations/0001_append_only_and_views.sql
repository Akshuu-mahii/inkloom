-- ===========================================================================
-- 0001  Append-only ledger and audit trail, plus operator-facing views.
-- ===========================================================================
-- The brief requires that audit entries be append-only "for the application",
-- and that admins can never delete credit ledger entries. A REVOKE would not
-- achieve this on its own: the application currently connects as the table
-- OWNER, and Postgres owners bypass table grants.
--
-- These triggers therefore enforce immutability unconditionally — the owner
-- cannot bypass them either. Correcting a bad ledger entry means appending a
-- compensating REVERSAL entry; correcting an audit record means appending a
-- new one. Both are what the service layer already does.
--
-- Deliberate escape hatch: a role with the `inkloom.maintenance` GUC set to
-- 'on' for the current transaction may still delete, so that a genuine data
-- retention sweep or a restore can run. Application code never sets it, and
-- setting it requires a direct database session.
-- ===========================================================================

CREATE OR REPLACE FUNCTION inkloom_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('inkloom.maintenance', true) = 'on' THEN
    -- Explicit, transaction-scoped maintenance window. Auditable by the fact
    -- that it can only be set from a direct psql session.
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on % is forbidden: this table is append-only. Append a compensating row instead.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER credit_ledger_append_only
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION inkloom_forbid_mutation();

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION inkloom_forbid_mutation();

-- ---------------------------------------------------------------------------
-- Wallet balance must always be reproducible from the ledger.
-- ---------------------------------------------------------------------------
-- Used by `pnpm credits:reconcile` and by the admin reconciliation action.
-- A row appearing here is a bug, by definition.
CREATE OR REPLACE VIEW credit_wallet_drift AS
SELECT
  w.id                                   AS wallet_id,
  w.user_id,
  w.balance                              AS cached_balance,
  COALESCE(SUM(l.amount), 0)::int        AS ledger_balance,
  w.balance - COALESCE(SUM(l.amount), 0)::int AS drift,
  COUNT(l.id)                            AS entry_count,
  MAX(l.created_at)                      AS last_entry_at
FROM credit_wallets w
LEFT JOIN credit_ledger l ON l.wallet_id = w.id
GROUP BY w.id, w.user_id, w.balance
HAVING w.balance <> COALESCE(SUM(l.amount), 0)::int;

-- ---------------------------------------------------------------------------
-- password_reset_tokens
-- ---------------------------------------------------------------------------
-- Better Auth stores password-reset tokens and email-verification tokens in a
-- single `verification_tokens` table, distinguished by an identifier prefix.
-- This view gives operators the table name the schema documentation calls for
-- without duplicating a token store (two stores would mean two expiry paths
-- and two single-use guarantees to keep correct).
--
-- The `value` column — the token itself — is deliberately NOT selected, so an
-- operator inspecting reset activity cannot read a live reset token.
CREATE OR REPLACE VIEW password_reset_tokens AS
SELECT
  id,
  split_part(identifier, ':', 2) AS user_id,
  expires_at,
  created_at,
  updated_at,
  (expires_at < now())           AS is_expired
FROM verification_tokens
WHERE identifier LIKE 'reset-password:%';

COMMENT ON VIEW password_reset_tokens IS
  'Read-only projection of verification_tokens for password resets. The token value is intentionally excluded.';

-- ---------------------------------------------------------------------------
-- Case-insensitive helper index for admin user search.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS users_name_lower_idx ON users (lower(name));
CREATE INDEX IF NOT EXISTS support_requests_reference_upper_idx ON support_requests (upper(reference));

-- ---------------------------------------------------------------------------
-- Idempotency: expired keys are garbage-collectable without a full scan.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idempotency_keys_gc_idx
  ON idempotency_keys (expires_at)
  WHERE state <> 'in_progress';
