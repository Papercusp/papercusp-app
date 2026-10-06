-- 659-pot-scope-learning-tables.sql
--
-- P-001 of plan `pot-scope-all-learnings-2026-07-26`.
-- [owner:Avi 2026-07-25 interactive, verbatim] "THERE SHOULD BE NO WORKSPACE
-- SCOPED LEARNINGS. FIX THAT. ALL LEARNINGS SHOULD BE SCOPED TO A POT."
--
-- Measured state that motivated this (2026-07-25): five learning stores carried
-- NO pot attribution at all, so their rows could never be resolved by a pot's
-- Learning lens — the same class of defect that made the gym tab read empty
-- under every pot while the gym was demonstrably running (WI-5808/WI-5811).
--
--   transfer_lessons         — distilled lessons, pot-less
--   prompt_ablation_runs     — ablation verdicts, pot-less
--   code_recipes             — has no workspace_id EITHER; fully unscoped
--   learning_governor_loops  — budgets keyed by WORKSPACE (blender:<workspace>)
--   learning_spend_events    — spend keyed to those workspace-scoped loops
--
-- This migration only ADDS the column + index (nullable, no default, no
-- backfill): applying it changes no behavior. Writers begin stamping it in
-- P-002 and the backfill runs in P-003, so the deploy order is safe in either
-- direction and a rollback is a plain column drop.
--
-- D-001 (ratified by the owner's GO 2026-07-25): the key is the POT/Hive slug —
-- the tenancy boundary the directive is about — not the member harness.

-- ── transfer_lessons ────────────────────────────────────────────────────────
ALTER TABLE harness_shared.transfer_lessons
    ADD COLUMN IF NOT EXISTS pot_slug text;
CREATE INDEX IF NOT EXISTS transfer_lessons_pot_idx
    ON harness_shared.transfer_lessons (workspace_id, pot_slug);

-- ── prompt_ablation_runs ────────────────────────────────────────────────────
ALTER TABLE harness_shared.prompt_ablation_runs
    ADD COLUMN IF NOT EXISTS pot_slug text;
CREATE INDEX IF NOT EXISTS prompt_ablation_runs_pot_idx
    ON harness_shared.prompt_ablation_runs (workspace_id, pot_slug);

-- ── code_recipes ────────────────────────────────────────────────────────────
-- NOTE: this table has no workspace_id column at all, so the pot slug is its
-- ONLY scope. Index on pot_slug alone accordingly.
ALTER TABLE harness_shared.code_recipes
    ADD COLUMN IF NOT EXISTS pot_slug text;
CREATE INDEX IF NOT EXISTS code_recipes_pot_idx
    ON harness_shared.code_recipes (pot_slug);

-- ── learning_governor_loops ─────────────────────────────────────────────────
-- P-004 re-keys the loop ids themselves (blender:<pot> rather than
-- blender:<workspace>); this column is what makes a pot-owned budget queryable
-- without parsing the loop_id string.
ALTER TABLE harness_shared.learning_governor_loops
    ADD COLUMN IF NOT EXISTS pot_slug text;
CREATE INDEX IF NOT EXISTS learning_governor_loops_pot_idx
    ON harness_shared.learning_governor_loops (workspace_id, pot_slug);

-- ── learning_spend_events ───────────────────────────────────────────────────
ALTER TABLE harness_shared.learning_spend_events
    ADD COLUMN IF NOT EXISTS pot_slug text;
CREATE INDEX IF NOT EXISTS learning_spend_events_pot_idx
    ON harness_shared.learning_spend_events (workspace_id, pot_slug);
