-- 274-autonomy-policy-vocab-never-auto.sql
--
-- queen-autonomy-policy-2026-06-13 — repair migration-259 VOCAB DRIFT.
--
-- An earlier APPLIED version of migration 259 created harness_shared.autonomy_policy
-- with the never-auto level spelled `'none'` (in both CHECK constraints and the
-- seeded rows). Migration 259 on disk + ALL the code (AUTONOMY_CEILINGS /
-- isAutonomyCeiling / setAutonomyPolicy / the autonomy:policy_set tool / the B-15
-- settings UI) use `'never-auto'`. Migrations never re-run, so already-migrated DBs
-- were left on the `'none'` vocabulary while the code moved to `'never-auto'`.
--
-- SYMPTOM: setAutonomyPolicy writes `graduated_level = 'never-auto'` (its normalized
-- value), which the live `'none'`-only CHECK REJECTS → `policy_set` (and therefore the
-- owner's ENTIRE autonomy control surface: the settings ceiling sliders + the MCP
-- tool) fails with `autonomy_policy_graduated_level_check`. The owner cannot lower a
-- ceiling to go live — nor RAISE one to dial autonomy back.
--
-- FIX: align the live DB to the `'never-auto'` vocabulary (idempotent; a no-op on a
-- DB that already applied disk-259's `'never-auto'` form — DROP IF EXISTS + a guarded
-- UPDATE that only touches `'none'` rows + an ADD that re-asserts the same constraint).
-- `'none'` and `'never-auto'` are the SAME level (never auto-run), so the row UPDATE is
-- semantically behavior-neutral. Additive; fresh-migrate-safe.

ALTER TABLE harness_shared.autonomy_policy DROP CONSTRAINT IF EXISTS autonomy_policy_ceiling_check;
ALTER TABLE harness_shared.autonomy_policy DROP CONSTRAINT IF EXISTS autonomy_policy_graduated_level_check;

UPDATE harness_shared.autonomy_policy SET ceiling = 'never-auto' WHERE ceiling = 'none';
UPDATE harness_shared.autonomy_policy SET graduated_level = 'never-auto' WHERE graduated_level = 'none';

ALTER TABLE harness_shared.autonomy_policy
    ALTER COLUMN ceiling SET DEFAULT 'never-auto';
ALTER TABLE harness_shared.autonomy_policy
    ALTER COLUMN graduated_level SET DEFAULT 'never-auto';

ALTER TABLE harness_shared.autonomy_policy
    ADD CONSTRAINT autonomy_policy_ceiling_check
    CHECK (ceiling IN ('never-auto', 'trivial', 'low', 'moderate', 'high', 'critical'));
ALTER TABLE harness_shared.autonomy_policy
    ADD CONSTRAINT autonomy_policy_graduated_level_check
    CHECK (graduated_level IN ('never-auto', 'trivial', 'low', 'moderate', 'high', 'critical'));
