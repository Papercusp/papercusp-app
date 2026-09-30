-- 627-routine-pool-shed-events.sql — EI-13108 ask (2).
--
-- routinesTickImpl (routines-workflow.ts) already SHEDS its heavy sweeps on a
-- critical PG-pool-starvation probe (P-006/W4, pool-pressure.ts) and counts it
-- via recordPoolShed() — but that counter is a SAME-PROCESS-ONLY in-memory
-- global (poolShedCount()), visible only in the journal warn line. Nothing
-- durable records the ACTUAL shed event across process restarts or hosts, so
-- an instrument-staleness consumer (release-readiness panels, the
-- improvement-watchdog collectors, pot_throughput_ticks freshness checks)
-- cannot tell "paused by this guardrail" from "dead" during a shed window —
-- exactly how EI-13076's dead instrument hid for 3 weeks.
--
-- This adds a durable, appendable log of shed events: one row per critical
-- shed, inserted fire-and-forget from routinesTickImpl (never blocking the
-- tick further — the whole point is to stop piling MORE work onto an already-
-- starved pool). A staleness consumer can then check "was there a shed in
-- this window" before flagging an instrument as dead rather than shed.
--
-- Idempotent; apply via the runner (db:migrate) or psql + a schema_migrations
-- row in one txn.

\set ON_ERROR_STOP on
-- (No top-level BEGIN/COMMIT: the migration runner supplies the transaction.)

CREATE TABLE IF NOT EXISTS harness_shared.routine_pool_shed_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  shed_count  integer     NOT NULL,   -- recordPoolShed()'s cumulative same-process count at fire time
  probe_ms    integer,                -- lastPoolProbeMs() at fire time (nullable: fail-soft, never block on missing signal)
  host        text                    -- os.hostname() / process identity, best-effort attribution across restarts
);

-- Staleness-window scan: "any shed for this workspace between t0 and t1?" —
-- the query shape instrument consumers actually run.
CREATE INDEX IF NOT EXISTS routine_pool_shed_events_workspace_at_idx
  ON harness_shared.routine_pool_shed_events (workspace_id, at DESC);

COMMENT ON TABLE harness_shared.routine_pool_shed_events IS
  'EI-13108: durable log of routinesTickImpl critical PG-pool-starvation sheds (pool-pressure.ts CRITICAL band), one row per shed event, so an instrument-staleness consumer can distinguish "shed by this guardrail" from "dead" during a shed window. Appended fire-and-forget from routinesTickImpl; never read/awaited on the hot tick path.';
COMMENT ON COLUMN harness_shared.routine_pool_shed_events.shed_count IS
  'recordPoolShed()''s cumulative same-process counter value at the moment this event fired (resets to 0 on process restart — poolShedCount() semantics).';
COMMENT ON COLUMN harness_shared.routine_pool_shed_events.probe_ms IS
  'lastPoolProbeMs() at fire time — the acquire+SELECT1 probe latency that classified this tick critical. Nullable: insertion is fail-soft and must never depend on a clean signal.';
