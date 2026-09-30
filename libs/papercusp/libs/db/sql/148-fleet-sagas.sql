-- Migration 148 — sagas + tombstones for cross-machine destructive ops.
--
-- Plan: fleet-as-supervised-blackboard-2026-06-04 (P4, D-006). Cross-machine
-- destructive actions (delete/revoke/prune/force-push/spend) get an ORCHESTRATED SAGA
-- (intent → fenced execute → compensations) — NOT last-write-wins (it silently drops
-- the safety-check loser) and NOT 2PC (its blocking is acute when the coordinators are
-- flaky autonomous agents). The saga log is durable so a crashed coordinator's
-- in-flight saga can be compensated on recovery.
--
-- And we make destructive effects LOGICALLY REVERSIBLE — soft-delete + TOMBSTONE +
-- DEFERRED physical GC — so a compensation is cheap (un-tombstone), which demotes most
-- "deletes" out of the dangerous class: only the deferred physical GC is truly
-- irreversible, and it runs after a grace window (and behind the fenced lease for the
-- one correctness-class case).
--
-- Composes onto 000-baseline.sql for fresh/embedded-pg. Idempotent. Runs as harness_admin.

\set ON_ERROR_STOP on
BEGIN;

-- ── Saga log ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.fleet_sagas (
  workspace_id text        NOT NULL,
  saga_id      text        NOT NULL,
  name         text        NOT NULL,
  -- 'running' | 'completed' | 'compensated' | 'failed'
  status       text        NOT NULL DEFAULT 'running',
  -- Per-step log: [{ name, status: pending|done|failed|compensated, error? }]
  steps        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, saga_id)
);
CREATE INDEX IF NOT EXISTS fleet_sagas_open_idx
  ON harness_shared.fleet_sagas (workspace_id, updated_at)
  WHERE status = 'running';

-- ── Tombstones (soft-delete + deferred physical GC) ──────────────────────────────
CREATE TABLE IF NOT EXISTS harness_shared.fleet_tombstones (
  workspace_id text        NOT NULL,
  ref_kind     text        NOT NULL,            -- what was deleted (e.g. 'snapshot', 'work_item')
  ref_id       text        NOT NULL,
  reason       text        NOT NULL DEFAULT '',
  deleted_by   text,
  deleted_at   timestamptz NOT NULL DEFAULT now(),
  -- Physical GC may run only after this instant (the grace window — a compensation can
  -- un-tombstone before then for free).
  gc_after     timestamptz NOT NULL,
  -- Set when a compensation restores the object (un-tombstone). NULL = still tombstoned.
  restored_at  timestamptz,
  PRIMARY KEY (workspace_id, ref_kind, ref_id)
);
CREATE INDEX IF NOT EXISTS fleet_tombstones_gc_idx
  ON harness_shared.fleet_tombstones (workspace_id, gc_after)
  WHERE restored_at IS NULL;

COMMENT ON TABLE harness_shared.fleet_sagas IS
  'Durable saga log (plan fleet-as-supervised-blackboard D-006): intent → fenced execute → compensations for cross-machine destructive ops. Engine: operator-core/lib/fleet/saga.ts.';
COMMENT ON TABLE harness_shared.fleet_tombstones IS
  'Soft-delete tombstones with deferred physical GC (D-006): a destructive op tombstones first (cheap to compensate via restore); physical GC runs only after gc_after.';

COMMIT;
