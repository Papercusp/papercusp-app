-- 425-datatype-review-status.sql — the PUBLISHED/shared-tier moderation state for datatypes
-- (reflexive-platform-extensibility-datatypes-2026-06-24, D-010 shared leg).
--
-- A datatype's LOCAL `status` stays 'active' (usable in its own workspace regardless of any
-- publish state). `review_status` is the SEPARATE gate for the GLOBAL/shared tier:
--   'none'     = local only (the default; never offered globally)
--   'pending'  = published, awaiting operator moderation
--   'approved' = published + globally visible
--   'rejected' = publish declined
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS) so it is fresh-migrate-safe and cannot
-- wedge operator boot; the table's grants/RLS (migration 421) already cover the new column.
ALTER TABLE harness_shared.datatype_registry
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'none';

-- The moderation queue read (published + pending), cross-workspace (operator-moderated).
CREATE INDEX IF NOT EXISTS datatype_registry_review_pending_idx
  ON harness_shared.datatype_registry (review_status)
  WHERE review_status = 'pending';
