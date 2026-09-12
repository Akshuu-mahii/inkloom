-- Two-factor enable/disable as recordable security events.
--
-- Turning a second factor off is exactly the kind of thing an operator needs to
-- see in the security trail — it is a common first move after an account
-- takeover. `security_events.type` is a Postgres enum with a CHECK behind it,
-- so the value has to exist before the application can write it; without this
-- the insert fails and the disable request 500s.
--
-- ADD VALUE IF NOT EXISTS is idempotent, so re-running this migration is safe.

ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'two_factor_enabled';
ALTER TYPE security_event_type ADD VALUE IF NOT EXISTS 'two_factor_disabled';
