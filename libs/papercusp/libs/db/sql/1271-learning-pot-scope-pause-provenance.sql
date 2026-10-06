-- 1271-learning-pot-scope-pause-provenance.sql
--
-- STRUCTURED DELIBERATE-PAUSE PROVENANCE for harness_shared.learning_pot_scope.
-- WI-10002099 (measured 2026-09-20, su-7f549, while working EI-23812451088589927).
--
-- ## The gap
--
-- `learning_pot_scope` (migration 1039) records only (enabled, set_by, set_at).
-- "This pot is off ON PURPOSE, by the owner's word" was encoded as a hand-typed
-- free-text suffix on `set_by` — the literal ' (owner directive)' — present on
-- every row written by the 2026-08-31 owner-directed sweep and ABSENT on the one
-- row that mattered most (the main pot). A peer read the unmarked row plus days
-- of producer silence and filed a major bug against a deliberate pause; the
-- obvious remedy (restore idea production) would have violated the directive.
-- `routines.metadata.pause` already carries structured provenance
-- ({ reason, pausedBy, pausedAtMs }); this gives the pot gate the same shape so
-- ONE predicate answers "is this off on purpose?".
--
-- ## What it adds (EXPAND only — the release still serving :3070 never names them)
--
--   pause_reason   text         WHY the pot is off. Free text, but a real citation
--                               (an owner directive id / date / work-item).
--   owner_directed boolean      the pause is a standing OWNER decision, not an
--                               agent's or an automation's. Only ever true with a
--                               pause_reason (CHECK below) so the claim always
--                               carries an inspectable citation.
--   review_by      timestamptz  when the pause should be re-examined, if ever.
--
-- A pause record only means something WHILE paused: an `enabled = true` row must
-- carry none of the three (CHECK below), so re-enabling a pot cannot leave a
-- stale "owner directive" stamped on a pot that is learning again.
--
-- ## Forward-compat
--
-- Additive columns with defaults (NULL / false) and two CHECKs that the
-- currently-deployed writer already satisfies — it never names the new columns,
-- so every row it writes carries the defaults. No DROP / RENAME / SET NOT NULL.
--
-- ## Backfill
--
-- Rows whose set_by ends in the legacy ' (owner directive)' suffix are converted
-- to the structured form and the suffix is stripped from set_by, which goes back
-- to being a bare actor identity. The original directive's text was never
-- captured, so the backfilled pause_reason says so honestly instead of
-- inventing a citation. No caller parses the suffix (grep-verified at authoring
-- time), so stripping it is safe.

ALTER TABLE harness_shared.learning_pot_scope
  ADD COLUMN IF NOT EXISTS pause_reason   text,
  ADD COLUMN IF NOT EXISTS owner_directed boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS review_by      timestamptz;

COMMENT ON COLUMN harness_shared.learning_pot_scope.pause_reason IS
  'Why learning is paused for this pot (only while enabled = false). A real citation — owner directive id/date, work-item — not a label.';
COMMENT ON COLUMN harness_shared.learning_pot_scope.owner_directed IS
  'true = the pause is a standing OWNER decision (not an agent/automation). Requires pause_reason. A detector must treat a producer silent under owner_directed = true as DELIBERATE, never as a fault.';
COMMENT ON COLUMN harness_shared.learning_pot_scope.review_by IS
  'When the pause should be re-examined, if ever. NULL = no scheduled review.';

-- Backfill the legacy free-text convention into the structured columns.
UPDATE harness_shared.learning_pot_scope
   SET owner_directed = true,
       pause_reason   = 'owner directive (legacy record: migrated from the '' (owner directive)'' suffix on set_by; the directive''s original text was not captured)',
       set_by         = regexp_replace(set_by, '\s*\(owner directive\)\s*$', '')
 WHERE enabled = false
   AND set_by ~ '\(owner directive\)\s*$';

-- Invariants. Added AFTER the backfill so the legacy rows satisfy them.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'learning_pot_scope_owner_directed_needs_reason'
       AND conrelid = 'harness_shared.learning_pot_scope'::regclass
  ) THEN
    ALTER TABLE harness_shared.learning_pot_scope
      ADD CONSTRAINT learning_pot_scope_owner_directed_needs_reason
      CHECK (NOT owner_directed OR (pause_reason IS NOT NULL AND length(btrim(pause_reason)) > 0));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'learning_pot_scope_pause_record_only_while_paused'
       AND conrelid = 'harness_shared.learning_pot_scope'::regclass
  ) THEN
    ALTER TABLE harness_shared.learning_pot_scope
      ADD CONSTRAINT learning_pot_scope_pause_record_only_while_paused
      CHECK (enabled = false
             OR (pause_reason IS NULL AND owner_directed = false AND review_by IS NULL));
  END IF;
END
$$;
