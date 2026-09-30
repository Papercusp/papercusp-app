-- 650-harness-gym-durable-run-analytics.sql
--
-- Durable gym RUN-ANALYTICS in the LIVE operator DB (plan
-- gym-repoint-live-coding-and-visible-runs-2026-07-20, Phase 2 / P-010–P-013).
--
-- Why this exists: the gym cycle writes its run analytics (cycles / variants / runs /
-- scores / tasks) into a per-cycle EPHEMERAL testcontainer PG (autoloop-cycle.ts) that is
-- TORN DOWN when the cycle finishes — so the gym UI's Cycles / Variants / Frontier tabs
-- (read via /api/gym/:slug/{cycles,variants,compare,frontier}) had NO durable database to
-- read and always rendered "no gym run database configured" / empty.
--
-- This mirrors D-020 exactly. D-020 already moved the small, user-facing gym CONTROL PLANE
-- (proposals / autoloop config) into the live operator DB (harness_shared, migration 110)
-- while the heavy EXECUTION data (transcripts, DBOS, full per-run vectors) stays in the
-- ephemeral gym PG (D-018 intact). This migration extends that principle to the *lightweight
-- analytics rows the UI reads*: a cycle-end copy step (store.ts copyRunAnalyticsToDurable,
-- the run-analytics analogue of makeLoopProposalRecorder) upserts them here after each cycle,
-- so they survive the ephemeral-PG teardown and the tabs populate. Heavy blobs
-- (deterministic_signals, trace/distilled refs, run params) are deliberately NOT copied.
--
-- SEPARATE SCHEMA (harness_gym_durable), NOT harness_gym — DELIBERATE. A gym cycle boots a
-- full operator against its ephemeral gym PG, which applies BOTH this live sql-NNN sequence
-- AND the gym-PG-resident gym schema (packages/operator-core/lib/gym/sql/001-harness-gym.sql,
-- via applyGymSchema). That gym schema owns `harness_gym` with a DIFFERENT shape (run_id is a
-- bare PK, FKs reference it). If this migration also created `harness_gym`, the `CREATE TABLE
-- IF NOT EXISTS` no-op would leave whichever ran first, and the loser's FK / NOT NULL columns
-- would break the other — which broke every gym cycle ("no unique constraint matching given
-- keys for referenced table gym_runs"). A distinct schema name keeps the durable read-cache
-- and the ephemeral run store completely independent in every database that hosts both.
--
-- Scoping: this is ONE shared schema across every gym harness + workspace, and the gym's
-- fixed task / variant / cycle ids ('gym-loop-health', 'baseline', 'cyc-0', …) are IDENTICAL
-- across harnesses. So every table is keyed by (workspace_id, harness_slug, <original id>) and
-- every read/join is scoped by (workspace_id, harness_slug). No cross-table FOREIGN KEYS: a
-- denormalized read-cache populated by a best-effort copy must never fail a partial copy on
-- referential integrity — the readers tolerate a missing join row.
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe. RLS + the runtime-role
-- grants mirror harness_shared.gym_proposals (migration 110): harness_admin (the operator's
-- admin pool + the copy step) owns + bypasses RLS; harness_app reads via routeWithWorkspace
-- under the app.workspace_id GUC policy.

CREATE SCHEMA IF NOT EXISTS harness_gym_durable;
GRANT USAGE ON SCHEMA harness_gym_durable TO harness_app;
GRANT USAGE ON SCHEMA harness_gym_durable TO harness_zero;

-- Synthetic feature tasks, by pool (mirrors the ephemeral gym_tasks columns the read joins
-- need: task_id + pool; the descriptive columns ride along for future UI use).
CREATE TABLE IF NOT EXISTS harness_gym_durable.gym_tasks (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    task_id      text NOT NULL,
    pool         text NOT NULL,
    spec         text,
    intent       text,
    repo_url     text,
    repo_commit  text,
    generated_by text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, task_id)
);

-- Prompt-overlay variants + lineage.
CREATE TABLE IF NOT EXISTS harness_gym_durable.gym_variants (
    workspace_id       text NOT NULL,
    harness_slug       text NOT NULL,
    variant_id         text NOT NULL,
    parent_id          text,
    label              text NOT NULL,
    prompt_overrides   jsonb NOT NULL DEFAULT '{}'::jsonb,
    diff_from_parent   text,
    proposer_rationale text,
    status             text NOT NULL DEFAULT 'candidate',
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, variant_id)
);

-- One (variant x task x cycle x repeat) run. Only the columns the read joins need are copied
-- (variant_id / task_id / cycle) + a few observability fields; the heavy JSONB signals and
-- trace refs stay in the ephemeral gym PG.
CREATE TABLE IF NOT EXISTS harness_gym_durable.gym_runs (
    workspace_id   text NOT NULL,
    harness_slug   text NOT NULL,
    run_id         text NOT NULL,
    variant_id     text NOT NULL,
    task_id        text NOT NULL,
    cycle          integer NOT NULL DEFAULT 0,
    repeat         integer NOT NULL DEFAULT 0,
    terminal_state text,
    started_at     timestamptz,
    finished_at    timestamptz,
    elapsed_ms     bigint,
    PRIMARY KEY (workspace_id, harness_slug, run_id)
);

-- Frozen judge output; the composite the frontier/compare views read, keyed on rubric_hash.
CREATE TABLE IF NOT EXISTS harness_gym_durable.gym_scores (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    run_id       text NOT NULL,
    judge_model  text NOT NULL,
    rubric_hash  text NOT NULL,
    judge_temp   real,
    weights      jsonb NOT NULL DEFAULT '{}'::jsonb,
    d1           real NOT NULL DEFAULT 0,
    d2           real NOT NULL DEFAULT 0,
    d3           real NOT NULL DEFAULT 0,
    composite    real NOT NULL DEFAULT 0,
    rationale    text,
    scored_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, run_id, rubric_hash)
);

-- Loop audit trail — the Cycles tab.
CREATE TABLE IF NOT EXISTS harness_gym_durable.gym_cycles (
    workspace_id     text NOT NULL,
    harness_slug     text NOT NULL,
    cycle_id         text NOT NULL,
    cycle            integer NOT NULL,
    parent_id        text,
    candidate_id     text,
    decision         text,
    gate_results     jsonb,
    budget_spent_usd numeric,
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, harness_slug, cycle_id)
);

CREATE INDEX IF NOT EXISTS gym_durable_runs_ws_harness_task_idx
    ON harness_gym_durable.gym_runs (workspace_id, harness_slug, task_id);
CREATE INDEX IF NOT EXISTS gym_durable_runs_ws_harness_variant_idx
    ON harness_gym_durable.gym_runs (workspace_id, harness_slug, variant_id);
CREATE INDEX IF NOT EXISTS gym_durable_tasks_ws_harness_pool_idx
    ON harness_gym_durable.gym_tasks (workspace_id, harness_slug, pool);
CREATE INDEX IF NOT EXISTS gym_durable_cycles_ws_harness_cycle_idx
    ON harness_gym_durable.gym_cycles (workspace_id, harness_slug, cycle);

-- Workspace isolation, mirroring harness_shared.gym_proposals (migration 110). harness_admin
-- (the operator admin pool + the copy step) is a superuser role that bypasses RLS; the policy
-- keeps the harness_app read path (routeWithWorkspace) workspace-scoped.
ALTER TABLE harness_gym_durable.gym_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_tasks_workspace_isolation ON harness_gym_durable.gym_tasks;
CREATE POLICY gym_tasks_workspace_isolation ON harness_gym_durable.gym_tasks
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_gym_durable.gym_variants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_variants_workspace_isolation ON harness_gym_durable.gym_variants;
CREATE POLICY gym_variants_workspace_isolation ON harness_gym_durable.gym_variants
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_gym_durable.gym_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_runs_workspace_isolation ON harness_gym_durable.gym_runs;
CREATE POLICY gym_runs_workspace_isolation ON harness_gym_durable.gym_runs
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_gym_durable.gym_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_scores_workspace_isolation ON harness_gym_durable.gym_scores;
CREATE POLICY gym_scores_workspace_isolation ON harness_gym_durable.gym_scores
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_gym_durable.gym_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_cycles_workspace_isolation ON harness_gym_durable.gym_cycles;
CREATE POLICY gym_cycles_workspace_isolation ON harness_gym_durable.gym_cycles
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (harness_app reads via routeWithWorkspace; harness_zero read-only).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_gym_durable.gym_tasks TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_gym_durable.gym_variants TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_gym_durable.gym_runs TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_gym_durable.gym_scores TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_gym_durable.gym_cycles TO harness_app;
GRANT SELECT ON harness_gym_durable.gym_tasks TO harness_zero;
GRANT SELECT ON harness_gym_durable.gym_variants TO harness_zero;
GRANT SELECT ON harness_gym_durable.gym_runs TO harness_zero;
GRANT SELECT ON harness_gym_durable.gym_scores TO harness_zero;
GRANT SELECT ON harness_gym_durable.gym_cycles TO harness_zero;
