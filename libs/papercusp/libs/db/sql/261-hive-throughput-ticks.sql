-- 261-hive-throughput-ticks.sql
--
-- queen-autonomous-execution-2026-06-13 (B-11 / P-050): hive THROUGHPUT
-- observability — the durable per-tick snapshot of how the Queen hive loop is
-- *operating*, surfaced on the Learning tab's "Throughput" sub-view.
--
-- The Queen loop (blueprint kind:'hive', spine.decider:queen) places ranked
-- work onto bees; until now there was no queryable record of how WELL it runs:
-- how deep the frontier is, how many bees are placed per wake, busy-vs-cap
-- utilization, how many placements are stuck, mean-time-to-complete, and the
-- question-rung split (how many bee questions self-resolved vs reached the
-- owner). This table is the durable per-tick record, mirroring `scout_ticks`
-- (migration 208) and `watchdog_ticks` (202): append-only, one row per tick,
-- trivial volume at the routinesTick cadence (30s, only while a hive is started
-- with demand). The collector (packages/operator-core/lib/hive/throughput.ts)
-- also files an FB-21 audit-as-sensors breach signal through captureImprovement
-- when utilization pegs at cap with a growing frontier (starvation) or stuck
-- placements appear — observability that *escalates itself*, not just a chart.
--
-- NOTE: deliberately NOT harness_shared.hive_watchdog_fires (mig 212) — that is
-- the LIVENESS dead-man's-switch ledger (was a wake armed?); THIS is the
-- THROUGHPUT ledger (how is the running loop doing?). Different question,
-- different schema; kept separate rather than overloading either.
--
-- question_rungs is the surface for a signal the question-ladder (B-10/B-17)
-- will feed later — today it is an empty map ({}), present so the chart exists
-- and lights up the moment rung data starts flowing. Recording an empty map is
-- the honest "no questions / ladder not armed yet" state, not a gap.
--
-- Control-plane state (small, durable, operator-readable) → harness_shared in
-- the live operator DB, workspace-scoped, mirroring scout_ticks (208).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.hive_throughput_ticks (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id    text NOT NULL,
    -- The hive's home-harness slug (e.g. 'papercup'); the hive the tick is for.
    hive_slug       text NOT NULL,
    -- When the tick was taken.
    tick_at         timestamptz NOT NULL DEFAULT now(),
    -- Ready work waiting for placement (todo feature-family items) — the queue depth.
    frontier_depth  integer NOT NULL DEFAULT 0,
    -- Bees newly placed since the previous tick (placements-per-wake proxy).
    placements      integer NOT NULL DEFAULT 0,
    -- Live placed bees right now (running spawned_agents) and the fleet ceiling.
    bees_busy       integer NOT NULL DEFAULT 0,
    bees_cap        integer NOT NULL DEFAULT 0,
    -- Running bees whose heartbeat went stale past the stuck threshold (10 min).
    stuck_count     integer NOT NULL DEFAULT 0,
    -- Bees that finished (status='done') in the tick window.
    completed       integer NOT NULL DEFAULT 0,
    -- Mean-time-to-complete (ms) over bees that finished in the window; NULL when none.
    mttc_ms         bigint,
    -- Question-rung distribution {rung -> count}: how many bee questions resolved
    -- at each rung (bee-self / peer-vote / Queen / owner). Empty until B-10/B-17.
    question_rungs  jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Free-form extras: { utilization, stuckThresholdMs, breach, ... }.
    detail          jsonb
);

-- Primary read path: the last N ticks for a workspace/hive, newest first.
CREATE INDEX IF NOT EXISTS hive_throughput_ticks_ws_hive_tick_idx
    ON harness_shared.hive_throughput_ticks (workspace_id, hive_slug, tick_at DESC);

-- Workspace isolation, mirroring scout_ticks (208) / watchdog_ticks (202).
-- Existence-guarded so a RE-RUN on an already-applied DB takes ZERO table locks
-- (ALTER/CREATE POLICY/GRANT all want ACCESS EXCLUSIVE; the 2026-06-09 deploy
-- died on a lock timeout re-applying an unguarded RLS block).
DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.hive_throughput_ticks'::regclass) THEN
    ALTER TABLE harness_shared.hive_throughput_ticks ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'harness_shared'
                  AND tablename = 'hive_throughput_ticks'
                  AND policyname = 'hive_throughput_ticks_workspace_isolation') THEN
    CREATE POLICY hive_throughput_ticks_workspace_isolation ON harness_shared.hive_throughput_ticks
        USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
        WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.hive_throughput_ticks', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.hive_throughput_ticks TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.hive_throughput_ticks', 'SELECT') THEN
    GRANT SELECT ON harness_shared.hive_throughput_ticks TO harness_zero;
  END IF;
END $$;
