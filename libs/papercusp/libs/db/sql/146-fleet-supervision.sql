-- Migration 146 — fleet supervision + structured concurrency over the spawn tree.
--
-- Plan: fleet-as-supervised-blackboard-2026-06-04 (P0 nursery + D-003 transitive
-- cancellation; P1 supervision + D-002 restart strategies).
--
-- harness_shared.spawned_agents is the durable parent→child spawn tree (the
-- orchestrator-spawn plugin's lineage record). The plan reframes that one tree as
-- FOUR things at once: a supervision tree (failure flows up), a structured-
-- concurrency nursery (cancellation flows down), a blackboard the curator steers,
-- and a backpressure-governed spend boundary. This migration adds the columns those
-- mechanisms need — without changing what a spawn IS:
--
--   • session_owner / coordination_domain — the spawned agent's coordination
--     identity (PAPERCUSP_SID, same id baked into its MCP ?client=) + lock
--     partition. This is the MISSING LINK that lets transitive cancellation
--     "release its locks NOW": locks live in papercusp_su keyed by (domain, owner),
--     so to release a cancelled descendant's locks we must know its owner. Today
--     spawned_agents had no owner column, so a cancel could only wait for N leases
--     to independently expire. (D-003.)
--   • plan_slug / item_id — the plan-item nursery this spawn serves (the unit of
--     work in the project-centric model), alongside the existing feature_id/chunk_id.
--   • restart_strategy / restart_count / restart_window_start — supervision: how a
--     crash is handled (one_for_one | one_for_all | rest_for_one) and the
--     restart-intensity bookkeeping that bounds a crash-loop (D-002).
--   • cancel_reason / cancelled_at — why/when a node was cancelled (audit + the
--     coord cancellation notice).
--
-- Composes onto 000-baseline.sql for fresh/embedded-pg. Idempotent: ADD COLUMN IF
-- NOT EXISTS + a guarded CHECK constraint + CREATE INDEX IF NOT EXISTS. Runs as
-- harness_admin.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.spawned_agents
  ADD COLUMN IF NOT EXISTS session_owner        text,
  ADD COLUMN IF NOT EXISTS coordination_domain  text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS plan_slug            text,
  ADD COLUMN IF NOT EXISTS item_id              text,
  ADD COLUMN IF NOT EXISTS restart_strategy     text NOT NULL DEFAULT 'one_for_one',
  ADD COLUMN IF NOT EXISTS restart_count        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS restart_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason        text,
  ADD COLUMN IF NOT EXISTS cancelled_at         timestamptz;

-- restart_strategy is a small closed enum; add the CHECK idempotently (PG has no
-- ADD CONSTRAINT IF NOT EXISTS, so guard on pg_constraint).
DO $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'spawned_agents_restart_strategy_chk'
       AND conrelid = 'harness_shared.spawned_agents'::regclass
  ) THEN
    ALTER TABLE harness_shared.spawned_agents
      ADD CONSTRAINT spawned_agents_restart_strategy_chk
      CHECK (restart_strategy IN ('one_for_one', 'one_for_all', 'rest_for_one'));
  END IF;
END
$body$;

-- Transitive cancellation collects descendants' owners to release their locks;
-- index the owner lookup. Partial — most rows never carry an owner.
CREATE INDEX IF NOT EXISTS spawned_agents_session_owner_idx
  ON harness_shared.spawned_agents (workspace_id, session_owner)
  WHERE session_owner IS NOT NULL;

-- The nursery completion gate ("cannot complete while a child lives") and the
-- subtree walk both query running descendants by parent; the existing
-- spawned_agents_parent_idx (workspace_id, parent_spawn_id) already serves it.

COMMENT ON COLUMN harness_shared.spawned_agents.session_owner IS
  'Coordination identity (PAPERCUSP_SID/ownerId) of the spawned agent. The key transitive cancellation uses to release this node''s file/resource locks (papercusp_su, keyed by (coordination_domain, owner)) and work-item/plan-item claims immediately. Plan fleet-as-supervised-blackboard D-003.';
COMMENT ON COLUMN harness_shared.spawned_agents.restart_strategy IS
  'Supervision restart strategy: one_for_one (independent) | one_for_all (sibling-set shares an invariant; restart all) | rest_for_one (restart it + later siblings). Plan D-002.';

COMMIT;
