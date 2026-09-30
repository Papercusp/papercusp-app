-- 070: Auth rate-limit + audit-log tables.
--
-- Step E (Tier-2 follow-up arc).
--
-- Two-bucket rate limiter for /api/auth/login:
--   - soft per-IP: 10 / 60s, refund on success; loopback exempt
--   - hard per-(IP, username): 5 / 15min, no refund, 5-min lockout
--
-- Audit log captures login_ok / login_bad_password / login_unknown_user /
-- login_rate_limited / change_password_* / logout. session_hmac is an
-- HMAC-SHA256 of the issued session token (truncated to 16 hex chars)
-- using the superuser-token-derived key — not enough to hijack, but
-- enough to correlate audit rows across services.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS). Named dollar-quoted block per
-- `feedback_named_dollar_quote_in_sql` memory rule.

CREATE TABLE IF NOT EXISTS harness_shared.auth_rate_limit (
  key         text     PRIMARY KEY,
  payload     jsonb    NOT NULL DEFAULT '{}'::jsonb,
  updated_at  bigint   NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS auth_rate_limit_updated_at_idx
  ON harness_shared.auth_rate_limit (updated_at);

CREATE TABLE IF NOT EXISTS harness_shared.auth_audit_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            timestamptz NOT NULL DEFAULT now(),
  kind          text        NOT NULL,
  username      text,
  ip            text,
  user_agent    text,
  ok            boolean     NOT NULL,
  error_code    text,
  session_hmac  text,
  metadata      jsonb
);

CREATE INDEX IF NOT EXISTS auth_audit_log_ts_idx
  ON harness_shared.auth_audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS auth_audit_log_username_idx
  ON harness_shared.auth_audit_log (username, ts DESC);

-- Replica identity for both tables — same pattern as migration 065.
DO $body$
BEGIN
  EXECUTE 'ALTER TABLE harness_shared.auth_rate_limit REPLICA IDENTITY FULL';
  EXECUTE 'ALTER TABLE harness_shared.auth_audit_log REPLICA IDENTITY FULL';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'replica identity already set or unavailable: %', SQLERRM;
END
$body$;
