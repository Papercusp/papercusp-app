-- 202-watchdog-ticks.sql
--
-- watchdog-robustness-2026-06-09 (P-001 / D-002): the durable per-tick record for
-- the self-improvement collector watchdog (packages/operator-core/lib/harness/
-- improvements/watchdog.ts).
--
-- Before this, every tick's outcome vanished into a single `console.log` line in
-- the routine handler — there was no way to query "when did the watchdog last
-- run, what did it see, what did it capture, and which collectors FAILED?". A
-- collector that fails every tick (schema drift — exactly the `test_runs`
-- synthetic-row class of bug that already bit it) was invisible: a `console.warn`
-- on a host nobody tails. This table is that record, and the substrate the
-- self-escalation (P-002) reads to detect a persistently-failing collector.
--
-- Append-only, one row per tick. At the 15-min cadence that is ~96 rows/day —
-- trivial; no retention needed (a future prune is a config decision, not a
-- schema one). Control-plane state (small, durable, operator-readable), so it
-- lives in the live operator DB's harness_shared schema, scoped by workspace_id,
-- mirroring scout_routed_ideas (migration 194).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.watchdog_ticks (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id        text NOT NULL,
    -- The routine's install slug (e.g. 'papercup'); the host/target the tick ran for.
    install_slug        text,
    -- When the tick ran.
    tick_at             timestamptz NOT NULL DEFAULT now(),
    -- 'ran' (the tick swept + captured) | 'skipped' (another host held the
    -- cross-host advisory lock — P-003 / D-004; the sweep belonged to someone else).
    status              text NOT NULL DEFAULT 'ran',
    -- How many raw signals the collectors produced this tick.
    signals             integer NOT NULL DEFAULT 0,
    -- The improvement ids captured this tick (real signals).
    captured            text[] NOT NULL DEFAULT '{}',
    -- Open-duplicate captures the core declined (cross-tick dedup at work).
    declined_duplicates integer NOT NULL DEFAULT 0,
    -- Signals dropped by the per-tick anti-flood cap (still visible next tick).
    deferred            integer NOT NULL DEFAULT 0,
    -- Per-collector status: [{ name, ok, signalCount, error? }]. The read path for
    -- P-002's consecutive-failure detection — an element with ok=false is a failed
    -- collector this tick.
    collectors          jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The improvement ids the watchdog filed ABOUT ITSELF this tick (P-002 self-
    -- escalation of a persistently-failing collector). Distinct from `captured`
    -- (real external signals) so the two feeds stay separable in reports.
    self_escalations    text[] NOT NULL DEFAULT '{}'
);

-- Primary read path: the last N ticks for a workspace, newest first (P-002).
CREATE INDEX IF NOT EXISTS watchdog_ticks_ws_tick_at_idx
    ON harness_shared.watchdog_ticks (workspace_id, tick_at DESC);

-- Workspace isolation, mirroring scout_routed_ideas (194). The operator connects
-- as a superuser role (harness_admin) which bypasses RLS; the policy keeps any
-- non-superuser path workspace-scoped + consistent with the rest of harness_shared.
ALTER TABLE harness_shared.watchdog_ticks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS watchdog_ticks_workspace_isolation ON harness_shared.watchdog_ticks;
CREATE POLICY watchdog_ticks_workspace_isolation ON harness_shared.watchdog_ticks
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (the watchdog tick + any read path run under the app role).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.watchdog_ticks TO harness_app;
GRANT SELECT ON harness_shared.watchdog_ticks TO harness_zero;
