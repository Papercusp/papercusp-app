-- 244-learning-governor.sql
--
-- self-learning-frontier-2026-06-12 (P-003 / FB-01, D-004): the LEARNING
-- GOVERNOR — one shared learning-spend ledger with per-loop registration,
-- sub-budgets, and priorities, generalizing the gym autoloop budget pattern
-- (migration 110's gym_autoloop_config: an unattended loop with no explicit
-- budget REFUSES to run).
--
--   learning_governor_loops — the REGISTRY: one row per learning loop.
--     loop_id examples: 'gym:<harness>', 'scout:<harness>',
--     'frontier:negative-space-miner'. Vocabulary OWNED by
--     packages/operator-core/lib/learning-governor/core.ts (columns stay plain
--     text so the seam can evolve it, mirroring improvement_dispatches):
--       budget_kind: 'lifetime' = accumulating cap the governor enforces
--                    (gym pattern) | 'per-cycle' = each run capped by the loop
--                    itself (scout pattern; spend still ledgers here so total
--                    learning spend stays one visible number).
--       budget_usd:  NULL = unbudgeted ⇒ learningGovernorPreflight REFUSES the
--                    unattended path (the gym null-budget precedent, D-004).
--       enforcement: 'governor' = the preflight is the gate (every frontier
--                    loop) | 'native' = the loop's existing self-gate stays
--                    authoritative (the gym/scout mirrors — zero behavior
--                    change; their rows here are observability + sub-budget
--                    visibility, synced from their own sources of truth).
--
--   learning_spend_events — append-only spend ledger, one row per costed
--     run/cycle. signal_origin matches migration 241's provenance vocabulary
--     (P-002/D-002: organic | drill | replay | shadow) so drill/replay/shadow
--     spend stays distinguishable from organic spend on the same ledger.
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.learning_governor_loops (
    workspace_id  text NOT NULL,
    loop_id       text NOT NULL,
    display_name  text NOT NULL,
    -- 'lifetime' | 'per-cycle' (see header).
    budget_kind   text NOT NULL DEFAULT 'lifetime',
    -- NULL = unbudgeted ⇒ the governor refuses the unattended path.
    budget_usd    numeric,
    spent_usd     numeric NOT NULL DEFAULT 0,
    -- Lower = more important when budgets contend (gym mirrors seed 50,
    -- scout 60, frontier loops default 100).
    priority      integer NOT NULL DEFAULT 100,
    enabled       boolean NOT NULL DEFAULT true,
    -- 'governor' | 'native' (see header).
    enforcement   text NOT NULL DEFAULT 'governor',
    meta          jsonb,
    registered_at timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, loop_id)
);

CREATE TABLE IF NOT EXISTS harness_shared.learning_spend_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  text NOT NULL,
    loop_id       text NOT NULL,
    cost_usd      numeric NOT NULL,
    -- Provenance vocabulary shared with migration 241 (P-002/D-002).
    signal_origin text NOT NULL DEFAULT 'organic'
                  CHECK (signal_origin IN ('organic', 'drill', 'replay', 'shadow')),
    -- Correlation to the costed run (gym cycle, scout cycleId, replay run id).
    run_ref       text,
    note          text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Primary read path: the workspace ledger, newest first (the "one visible
-- number" rollup + recent-events drill-down).
CREATE INDEX IF NOT EXISTS learning_spend_events_ws_created_idx
    ON harness_shared.learning_spend_events (workspace_id, created_at DESC);

-- Per-loop drill-down.
CREATE INDEX IF NOT EXISTS learning_spend_events_ws_loop_created_idx
    ON harness_shared.learning_spend_events (workspace_id, loop_id, created_at DESC);

-- Workspace isolation, mirroring improvement_dispatches (238). The operator
-- connects as harness_admin (superuser, bypasses RLS); the policy keeps any
-- non-superuser path workspace-scoped + consistent with harness_shared.
ALTER TABLE harness_shared.learning_governor_loops ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_governor_loops_workspace_isolation ON harness_shared.learning_governor_loops;
CREATE POLICY learning_governor_loops_workspace_isolation ON harness_shared.learning_governor_loops
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.learning_spend_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS learning_spend_events_workspace_isolation ON harness_shared.learning_spend_events;
CREATE POLICY learning_spend_events_workspace_isolation ON harness_shared.learning_spend_events
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (registration/spend writes run under the app role from
-- the routine actions; zero-sync reads stay read-only).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.learning_governor_loops TO harness_app;
GRANT SELECT ON harness_shared.learning_governor_loops TO harness_zero;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.learning_spend_events TO harness_app;
GRANT SELECT ON harness_shared.learning_spend_events TO harness_zero;
