-- ===========================================================================
-- 0004  Correct the password_reset_tokens view.
-- ===========================================================================
-- Migration 0001 assumed Better Auth stored reset tokens as
-- `identifier = 'reset-password:<userId>'` with the token in `value`. The
-- actual layout is the OPPOSITE:
--
--   identifier = 'reset-password:<TOKEN>'
--   value      = '<userId>'
--
-- So the old view's `split_part(identifier, ':', 2) AS user_id` published the
-- LIVE RESET TOKEN under a column named `user_id`. Anyone who could read that
-- view could take over any account with a pending reset.
--
-- This replacement selects the user id from `value` and never projects the
-- identifier at all, so no part of a usable token appears in it.
-- ===========================================================================

DROP VIEW IF EXISTS password_reset_tokens;

CREATE VIEW password_reset_tokens AS
SELECT
  id,
  value            AS user_id,
  expires_at,
  created_at,
  updated_at,
  (expires_at < now()) AS is_expired
FROM verification_tokens
WHERE identifier LIKE 'reset-password:%';

COMMENT ON VIEW password_reset_tokens IS
  'Read-only projection of verification_tokens for password resets. The identifier column is deliberately excluded because it contains the reset token itself.';

-- Makes "invalidate this user''s other reset tokens" an index lookup rather
-- than a scan; that runs on every forgot-password request.
CREATE INDEX IF NOT EXISTS verification_reset_value_idx
  ON verification_tokens (value)
  WHERE identifier LIKE 'reset-password:%';
