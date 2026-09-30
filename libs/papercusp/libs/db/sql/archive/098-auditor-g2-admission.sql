-- 098: G2 Admission state — auditor verdict columns on harness_features_consolidated.
--
-- Plan: papercusp-user-protection-gate-2026-05-31 P-005.
--
-- Every remote-authored feature (origin='remote', added in migration 097)
-- must be screened by the auditor role before the orchestrator pick loop
-- can auto-pick it. These three columns carry that verdict:
--
--   audit_verdict  TEXT NULL   — 'pending' | 'admit' | 'reject'
--                               NULL and 'pending' both mean "not yet admitted".
--                               A local feature (origin='local') never needs a
--                               verdict — the pick gate bypasses the check.
--   audit_reasons  TEXT NULL   — free-text rationale from the auditor, stored
--                               for the human-escalation surface (P-007).
--   audited_at     TIMESTAMPTZ NULL — when the auditor last set a verdict.
--
-- Pick-gate predicate (P-008, enforced in readFeaturesPg / state-pg.ts):
--   A feature is auto-pickable iff
--     (origin = 'local') OR (audit_verdict = 'admit').
--   Remote features with NULL / 'pending' / 'reject' verdict are NOT returned
--   to the orchestrator pick loop.
--
-- D-006: local features bypass the gate entirely (no audit needed).
-- D-005: rejected features auto-escalate to human (implemented in P-007).
--
-- Existing rows: columns added as NULL (no default) so:
--   - Local rows: origin='local', audit_verdict=NULL → pickable via local bypass.
--   - Remote rows that pre-date this migration: audit_verdict=NULL → NOT pickable
--     until admitted (correct: they must be screened).
--   We deliberately do NOT default remote rows to 'admit'.
--
-- Idempotent (IF NOT EXISTS, idempotent ALTER). No dollar-quoted blocks.

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS audit_verdict TEXT;

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS audit_reasons TEXT;

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ;

-- Partial index for the dispatch query (P-007): efficiently finds remote features
-- that are still pending a verdict. The set is expected to be small (most features
-- are local) so a partial index is cheap and fast.
CREATE INDEX IF NOT EXISTS hfc_audit_pending_idx
  ON harness_shared.harness_features_consolidated (harness_slug)
  WHERE origin = 'remote' AND (audit_verdict IS NULL OR audit_verdict = 'pending');
