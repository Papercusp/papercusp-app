-- 437-coord-quarantine-rate-reason.sql
-- cross-machine-coord-parity-and-trust-2026-07-01 P-015: the owner-signed
-- hive policy's `rate` caps (EN-2 — schema'd since mig 317, enforced nowhere)
-- gain their first enforcement site: per-member MESSAGE-rate limiting at the
-- coord-message projection. Rate excess QUARANTINES (attention surface only —
-- state-convergence rows are never rate-dropped: dropping LWW sync ops causes
-- permanent divergence, the forceReFold bug class). Widen the reason CHECK.

BEGIN;

ALTER TABLE harness_shared.coord_quarantine
  DROP CONSTRAINT IF EXISTS coord_quarantine_reason_check;
ALTER TABLE harness_shared.coord_quarantine
  ADD CONSTRAINT coord_quarantine_reason_check
  CHECK (reason IN ('below-message-tier', 'handoff-below-steer', 'rate-exceeded'));

COMMIT;
