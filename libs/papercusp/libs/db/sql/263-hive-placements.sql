-- 263-hive-placements.sql
--
-- queen-autonomous-execution-2026-06-13 B-09 (Completion guarantee — P-020 /
-- P-021): the Queen's placement-completion ledger. One row per (hive, work-item)
-- the hive placed onto a bee — the durable home for "track each Queen-placed unit
-- spawn→working→done" (P-020) and the failed-placement counter the cursed-item
-- circuit breaker keys off (P-021, which mirrors the orchestrator
-- worker-chunk-loop's `replanStrikes` exhaustion-flip: N failed attempts → stop
-- auto-re-placing → route to the owner escalation queue).
--
-- The placement watchdog (lib/hive/placement-watchdog.ts) reconciles this table
-- against live bee state on the existing 30s routinesTick (alongside the liveness
-- watchdog, mig 212). It is a BACKSTOP, not a cadence: a non-terminal placed unit
-- whose serving bee has died/stalled and is NOT re-claimed by a live bee fires one
-- targeted recovery wake to the Queen + bumps `fail_count`; once `fail_count`
-- reaches the breaker threshold the unit flips `cursed` and is escalated to the
-- owner (the D-011 Queue precursor) instead of re-placed forever.
--
-- Liveness is DERIVED every sweep from `spawned_agents` (status / heartbeat_at /
-- last_output_at) + the unit's own status + `taken_by`; this table holds ONLY the
-- durable counter, disposition, and timers — never a mirror of the live state
-- (storage policy: no PG mirror of derivable liveness). Closed rows (completed /
-- cursed / abandoned) are kept as the completion record.
--
-- Volume: a handful of open placements per started hive. No RLS (mirrors
-- 251-fleet-ekg / hive_watchdog_fires): the sweep and any resolver scope by
-- workspace_id explicitly.

CREATE TABLE IF NOT EXISTS harness_shared.hive_placements (
    workspace_id      text NOT NULL,
    install_slug      text NOT NULL,        -- the hive's home slug (one row-namespace per hive)
    work_item_id      text NOT NULL,        -- the placed unit (feature / issue / task id)
    harness_slug      text,                 -- the member harness the unit lives in
    queen_owner_id    text,                 -- coord owner woken on a stalled placement (bee.parent_spawn_id)
    bee_spawn_id      text,                 -- the current/last bee spawn serving it
    bee_owner_id      text,                 -- the current/last bee coord owner (== work-item taken_by)
    status            text NOT NULL DEFAULT 'working',
    fail_count        integer NOT NULL DEFAULT 0,   -- failed placements observed (the breaker counter)
    last_disposition  text,                 -- last watchdog action (recover / breaker / stranded / completed)
    escalation_msg_id text,                 -- the breaker/stranded escalation opened to the owner, if any
    placed_at         timestamptz NOT NULL DEFAULT now(),
    last_recovery_at  timestamptz,          -- last recovery wake fired (debounces re-wakes)
    last_seen_at      timestamptz NOT NULL DEFAULT now(),  -- last sweep that observed this placement
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT hive_placements_pkey
      PRIMARY KEY (workspace_id, install_slug, work_item_id),
    CONSTRAINT hive_placements_status_check CHECK (status IN
      ('working', 'recovering', 'cursed', 'stranded', 'completed', 'abandoned'))
);

CREATE INDEX IF NOT EXISTS hive_placements_open_idx
  ON harness_shared.hive_placements (workspace_id, install_slug, status);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.hive_placements TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.hive_placements TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
