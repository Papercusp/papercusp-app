-- 238-improvement-dispatches-ledger.sql
--
-- self-improvement-consume-edges-2026-06-12 (P-010 / B-04, core of EI-365): the
-- DURABLE dispatch ledger for the auto-implement lane.
--
-- Before this, dispatch bookkeeping lived only on the issue payload
-- (implementAttempts / lastDispatchAt, written BEFORE the fire) — a fire that
-- failed, a worker that died, and a worker still running were all
-- indistinguishable, and the lane ran armed for two days without a single
-- resolve while looking "in progress" the whole time. One row per dispatch:
-- written at fire time by the improvement-implement routine
-- (packages/operator-core/lib/harness/routines/improvement-actions.ts via
-- packages/operator-core/lib/harness/improvements/dispatch-ledger.ts), driven
-- to a terminal state by the fire result (fire failure), the worker's
-- improvements:resolve back-edge (fixed / could-not-fix / needs-human), or the
-- orphaned-dispatch collector (P-011, worker death).
--
-- State model (vocabulary OWNED by dispatch-ledger.ts — columns stay plain
-- text so the seam can evolve it, mirroring scout_routed_ideas.graded_by):
--   fire_result: 'pending' (inserted, fire not yet returned — a row stuck here
--                means the dispatcher itself died mid-fire) | 'ok' | 'error'.
--   outcome (terminal; NULL = still open): 'fixed' | 'could-not-fix' |
--                'needs-human' (the resolve back-edge) | 'fire-failed' |
--                'orphaned' (P-011's collector — worker death).
--   A row with fire_result='ok' AND outcome IS NULL is IN PROGRESS; past the
--   overdue threshold it is presumed dead until something closes it.
--
-- Append-only-ish (rows update only to reach their terminal state); one row per
-- dispatch at maxPerRun ~1/tick — trivial volume, no retention needed yet.
-- Control-plane state in the live operator DB's harness_shared schema, scoped
-- by workspace_id, mirroring watchdog_ticks (migration 202).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.improvement_dispatches (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    text NOT NULL,
    -- The improvement item dispatched (harness_shared.engineer_issues id, e.g. 'EI-365').
    item_id         text NOT NULL,
    -- payload.implementAttempts as stamped for THIS dispatch (1-based).
    attempt         integer NOT NULL DEFAULT 1,
    -- The dedicated runner harness the implement blueprint was fired at (D-006).
    runner_harness  text,
    fired_at        timestamptz NOT NULL DEFAULT now(),
    -- 'pending' → 'ok' | 'error' (see state model above).
    fire_result     text NOT NULL DEFAULT 'pending',
    -- The fire failure, when fire_result='error'.
    fire_error      text,
    -- Correlation to the spawned worker: the fallback fire path's spawned_agents
    -- run_id, or the DBOS durable-spawn idempotency key. NULL when the fire
    -- path could not surface one.
    spawned_run_id  text,
    -- Terminal outcome (NULL = dispatch still open). Set by improvements:resolve,
    -- a fire failure, or the orphaned-dispatch collector.
    outcome         text,
    resolved_at     timestamptz,
    -- Who drove the row terminal (the resolving worker's identity, 'system' for
    -- a fire failure, the collector's name for an orphan).
    resolved_by     text
);

-- Primary read path: recent dispatches for a workspace, newest first (the
-- watchdog-status / flow-strip rollup).
CREATE INDEX IF NOT EXISTS improvement_dispatches_ws_fired_at_idx
    ON harness_shared.improvement_dispatches (workspace_id, fired_at DESC);

-- The close path (improvements:resolve → close open rows for one item) and
-- P-011's orphan scan both want open rows cheaply.
CREATE INDEX IF NOT EXISTS improvement_dispatches_open_item_idx
    ON harness_shared.improvement_dispatches (item_id)
    WHERE outcome IS NULL;

-- Workspace isolation, mirroring watchdog_ticks (202). The operator connects as
-- harness_admin (superuser, bypasses RLS); the policy keeps any non-superuser
-- path workspace-scoped + consistent with the rest of harness_shared.
ALTER TABLE harness_shared.improvement_dispatches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS improvement_dispatches_workspace_isolation ON harness_shared.improvement_dispatches;
CREATE POLICY improvement_dispatches_workspace_isolation ON harness_shared.improvement_dispatches
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (the implement routine + resolve back-edge + read paths
-- run under the app role).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.improvement_dispatches TO harness_app;
GRANT SELECT ON harness_shared.improvement_dispatches TO harness_zero;
