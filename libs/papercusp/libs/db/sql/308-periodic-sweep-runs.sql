-- Migration 308 — periodic_sweep_runs: a liveness heartbeat for periodic sweeps
--
-- work-queue-stuck-item-recovery-2026-06-17 (P-009). The stale-claim reaper is the
-- only actor freeing/requeuing dead-held work-item claims, and it runs as ONE DBOS
-- scheduled workflow. If that scheduler wedges (the FB-24 / EI-455 shape — a DBOS
-- workflow stuck PENDING on a dead executor), reaping silently stops and stuck items
-- accumulate with no alarm. This table records each sweep's last successful run so the
-- system-health reader can detect a wedged scheduler (last_run_at older than N
-- minutes) and raise it — the detection MUST be external to the (possibly wedged)
-- sweep itself.
--
-- One row per sweep name, GLOBAL (the stale-claim sweep is workspace-agnostic — it
-- runs one pass over harness_shared via the admin connection). last_released is the
-- count freed on the most recent run (cheap operational signal).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE IF NOT EXISTS harness_shared.periodic_sweep_runs (
  sweep_name    text PRIMARY KEY,
  last_run_at   timestamptz NOT NULL DEFAULT now(),
  last_released integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMIT;
