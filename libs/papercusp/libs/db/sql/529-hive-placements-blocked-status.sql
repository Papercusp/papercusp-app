-- 529 — allow status 'blocked' on hive_placements.
--
-- The placement-watchdog's 'parked' decision (WI-1439 recovery-churn fix, EI-6563)
-- writes status 'blocked' for a deliberately-parked unit (blocked / needs-human),
-- but 263's check constraint was never extended, so EVERY parked unit aborted its
-- hive's ENTIRE reconcile sweep with a constraint violation — reclaimed items were
-- never re-placed (observed live 2026-07-09 19:31 EDT, spam:
-- "[hive-placement-watchdog] hive papercusp failed: new row ... violates check
-- constraint hive_placements_status_check"; WI-3388/WI-3464/WI-3465 stranded with
-- no placement rows after an operator restart reclaim).
-- Plan pot-auto-loop-working-2026-07-09 P-002.

ALTER TABLE harness_shared.hive_placements
  DROP CONSTRAINT IF EXISTS hive_placements_status_check;

ALTER TABLE harness_shared.hive_placements
  ADD CONSTRAINT hive_placements_status_check CHECK (status IN
    ('working', 'recovering', 'cursed', 'stranded', 'completed', 'abandoned', 'blocked'));
