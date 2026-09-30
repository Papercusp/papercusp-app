-- 555-cup-lexicon-db-rename-phase2-bee-claim-specs-beekeeper.sql
--
-- P-009 Phase 2 (cup-lexicon-full-rename-2026-07-09, Slice H): rename bee_claim_specs and
-- all beekeeper_* tables to their cup_*/cup_keeper_* equivalents, following the expand-contract
-- pattern established in Phase 1 (migration 554). This phase is safe to run concurrently with
-- live traffic and deferred until accessor files are updated in the same change (to avoid
-- ON CONFLICT issues with views + raw SQL literals).
--
-- SCOPE:
--   bee_claim_specs → cup_claim_specs
--   beekeeper_instances → cup_keeper_instances
--   beekeeper_runs → cup_keeper_runs
--   beekeeper_scores → cup_keeper_scores
--
-- beekeeper_sessions is DELIBERATELY NOT renamed here: migration 200 already
-- DROPPED it (created speculatively by mig 180, never wired — no live writer,
-- see 200's own comment; confirmed zero code references to beekeeper_sessions
-- or cup_keeper_sessions repo-wide). An earlier version of this migration
-- unconditionally `CREATE OR REPLACE VIEW`'d a beekeeper_sessions compat view
-- regardless of whether the rename's IF-guard actually ran, which 42P01'd on
-- ANY DB (fresh or live) where 200 had already applied — i.e. every DB, since
-- 200 predates this migration and this migration therefore could never
-- successfully apply anywhere (also fixed here: a `DO $ ... END $;` missing
-- the second `$` of the dollar-quote, and a RENAME CONSTRAINT on a constraint
-- migration 217 had already dropped — see below).
--
-- IDEMPOTENT: each table/index/constraint rename is guarded (skips if already renamed),
-- so a partial prior apply or re-run converges safely.
-- 
-- NOTE: Busy tables (bee_claim_specs, beekeeper_runs during active eval) may need
-- SET LOCAL lock_timeout='60s' on manual apply per Phase 1 experience.

\set ON_ERROR_STOP on

-- ── bee_claim_specs -> cup_claim_specs ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.bee_claim_specs') IS NOT NULL AND to_regclass('harness_shared.cup_claim_specs') IS NULL THEN
    ALTER TABLE harness_shared.bee_claim_specs RENAME TO cup_claim_specs;
    ALTER TABLE harness_shared.cup_claim_specs RENAME CONSTRAINT bee_claim_specs_bee_nonempty TO cup_claim_specs_bee_nonempty;
    ALTER TABLE harness_shared.cup_claim_specs RENAME CONSTRAINT bee_claim_specs_ws_nonempty TO cup_claim_specs_ws_nonempty;
    ALTER TABLE harness_shared.cup_claim_specs RENAME CONSTRAINT bee_claim_specs_pkey TO cup_claim_specs_pkey;
  END IF;
END $$;

-- Create backward-compatibility view for bee_claim_specs
CREATE OR REPLACE VIEW harness_shared.bee_claim_specs AS SELECT * FROM harness_shared.cup_claim_specs;

-- ── beekeeper_instances -> cup_keeper_instances ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.beekeeper_instances') IS NOT NULL AND to_regclass('harness_shared.cup_keeper_instances') IS NULL THEN
    ALTER TABLE harness_shared.beekeeper_instances RENAME TO cup_keeper_instances;
    ALTER TABLE harness_shared.cup_keeper_instances RENAME CONSTRAINT beekeeper_instances_pkey TO cup_keeper_instances_pkey;
    ALTER TABLE harness_shared.cup_keeper_instances RENAME CONSTRAINT beekeeper_instances_workspace_id_code_sha_genome_id_key TO cup_keeper_instances_workspace_id_code_sha_genome_id_key;
  END IF;
END $$;

-- Create backward-compatibility view for beekeeper_instances
CREATE OR REPLACE VIEW harness_shared.beekeeper_instances AS SELECT * FROM harness_shared.cup_keeper_instances;

-- ── beekeeper_runs -> cup_keeper_runs ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.beekeeper_runs') IS NOT NULL AND to_regclass('harness_shared.cup_keeper_runs') IS NULL THEN
    ALTER TABLE harness_shared.beekeeper_runs RENAME TO cup_keeper_runs;
    ALTER TABLE harness_shared.cup_keeper_runs RENAME CONSTRAINT beekeeper_runs_pkey TO cup_keeper_runs_pkey;
    ALTER TABLE harness_shared.cup_keeper_runs RENAME CONSTRAINT beekeeper_runs_instance_id_fkey TO cup_keeper_runs_instance_id_fkey;
    -- NOTE: migration 217 DROPPED the UNIQUE(instance_id, case_id) constraint
    -- (beekeeper_runs_instance_id_case_id_key — it silently broke --repeats>1)
    -- and replaced it with a plain composite index; rename THAT, not the
    -- long-gone constraint (a RENAME CONSTRAINT on a dropped name 42704s).
    ALTER INDEX IF EXISTS harness_shared.beekeeper_runs_instance_case_idx RENAME TO cup_keeper_runs_instance_case_idx;
    ALTER INDEX IF EXISTS harness_shared.beekeeper_runs_instance_idx RENAME TO cup_keeper_runs_instance_idx;
    ALTER INDEX IF EXISTS harness_shared.beekeeper_runs_case_idx RENAME TO cup_keeper_runs_case_idx;
  END IF;
END $$;

-- Create backward-compatibility view for beekeeper_runs
CREATE OR REPLACE VIEW harness_shared.beekeeper_runs AS SELECT * FROM harness_shared.cup_keeper_runs;

-- ── beekeeper_scores -> cup_keeper_scores ──────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('harness_shared.beekeeper_scores') IS NOT NULL AND to_regclass('harness_shared.cup_keeper_scores') IS NULL THEN
    ALTER TABLE harness_shared.beekeeper_scores RENAME TO cup_keeper_scores;
    ALTER TABLE harness_shared.cup_keeper_scores RENAME CONSTRAINT beekeeper_scores_pkey TO cup_keeper_scores_pkey;
    ALTER TABLE harness_shared.cup_keeper_scores RENAME CONSTRAINT beekeeper_scores_run_id_fkey TO cup_keeper_scores_run_id_fkey;
    ALTER INDEX IF EXISTS harness_shared.beekeeper_scores_run_idx RENAME TO cup_keeper_scores_run_idx;
  END IF;
END $$;

-- Create backward-compatibility view for beekeeper_scores
CREATE OR REPLACE VIEW harness_shared.beekeeper_scores AS SELECT * FROM harness_shared.cup_keeper_scores;

-- beekeeper_sessions: intentionally skipped — see the SCOPE note above (mig
-- 200 already dropped it; nothing to rename, no compat view to create).

