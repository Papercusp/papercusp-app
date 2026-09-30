-- 974: explicit psu resume reservations — a claim is not liveness.
--
-- The historical resume path cleared ended_at and bumped started_at while the
-- launcher was still doing setup. A lost HTTP response therefore recorded a
-- session as live even though no child was spawned, and every immediate retry
-- lost to the five-minute started_at claim window. These columns hold the
-- short-lived single-winner reservation separately; finalize is the only path
-- that clears terminal evidence and asserts liveness.

ALTER TABLE harness_shared.adv_sessions
  ADD COLUMN IF NOT EXISTS resume_claim_key text,
  ADD COLUMN IF NOT EXISTS resume_claimed_at timestamp with time zone;

COMMENT ON COLUMN harness_shared.adv_sessions.resume_claim_key IS
  'Opaque idempotency key holding the short-lived right to resume this exact session. A non-null value is a reservation, never proof that an agent process is live.';

COMMENT ON COLUMN harness_shared.adv_sessions.resume_claimed_at IS
  'When resume_claim_key was acquired or renewed. The launcher must finalize from concrete child/host liveness or release; expired reservations are reclaimable.';

CREATE INDEX IF NOT EXISTS adv_sessions_resume_reservation_idx
  ON harness_shared.adv_sessions (resume_claimed_at)
  WHERE resume_claim_key IS NOT NULL;

