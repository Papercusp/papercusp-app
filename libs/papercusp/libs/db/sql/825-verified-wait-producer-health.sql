-- Verified waits: persist the producer-health certificate beside an await so
-- the timeout sweeper can diagnose the producer before spending a wake turn.
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS producer_health jsonb,
  ADD COLUMN IF NOT EXISTS timeout_verification jsonb,
  ADD COLUMN IF NOT EXISTS verification_claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS event_awaits_verified_timeout_due
  ON harness_shared.event_awaits (expires_ts)
  WHERE producer_health IS NOT NULL
    AND fired_at IS NULL
    AND cancelled_at IS NULL;
