-- EI-12108: retain the beginning of an uninterrupted placement-recovery episode.
-- last_recovery_at and updated_at move on every retry/sweep, so neither can bound
-- a recovery that keeps getting touched without ever acquiring a new live cup.

ALTER TABLE harness_shared.pot_placements
  ADD COLUMN IF NOT EXISTS recovery_started_at timestamp with time zone;

UPDATE harness_shared.pot_placements
   SET recovery_started_at = COALESCE(last_recovery_at, updated_at, placed_at, now())
 WHERE status = 'recovering'
   AND recovery_started_at IS NULL;

CREATE INDEX IF NOT EXISTS pot_placements_recovering_age_idx
  ON harness_shared.pot_placements (workspace_id, install_slug, recovery_started_at)
  WHERE status = 'recovering';
