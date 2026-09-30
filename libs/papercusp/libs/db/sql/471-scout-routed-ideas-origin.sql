-- 471-scout-routed-ideas-origin.sql
--
-- su-loop-capability-parity-2026-07-03 P-005 (D-009): add an ORIGIN dimension to the
-- routed-idea ledger, ORTHOGONAL to `lens`. Scout routes ideas tagged by CreativeLens;
-- SU sessions in IDEATE mode ORIGINATE feature ideas (improvements:capture kind:'feature')
-- that today get NO routed-ledger row — so no provenance, no grade slot, no outcome
-- tracking, no priming. This column lets an SU-originated idea ride the SAME ledger
-- (reusing the existing grading / outcome / priming machinery) while staying EXCLUDABLE
-- from Scout's per-lens WEIGHT learning: an origin is NOT a pseudo-lens (D-009). The
-- lens-weight readers filter origin='scout', so SU provenance never skews the lens
-- diversity floor the weighting depends on.
--
-- Additive + idempotent + fresh-migrate-safe. Existing rows default to 'scout' (they are
-- all Scout-routed), so every existing reader that now filters origin='scout' returns a
-- byte-identical result set.

ALTER TABLE harness_shared.scout_routed_ideas
    ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'scout';

-- The lens-weight / outcome / cadence readers filter by (workspace_id, origin='scout');
-- the SU-priming reader filters origin='su-ideate'. Index the dimension so both stay cheap.
CREATE INDEX IF NOT EXISTS scout_routed_ideas_ws_origin_idx
    ON harness_shared.scout_routed_ideas (workspace_id, origin);
