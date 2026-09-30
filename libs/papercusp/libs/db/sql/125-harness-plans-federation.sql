-- Migration 125 — federation capture triggers on harness_plans.
--
-- Plan: plans-pg-canonical-migration-2026-06-03 (Stage 2 — federation).
--
-- PG-canonical plans federate as papercup-harness content over the existing
-- peer-log machinery (D-004). capture_substrate_outbox() enqueues a local-origin
-- write into harness_shared.substrate_outbox; the drain appends it to this
-- device's own Hypercore log; peers' read-side projection
-- (projections/harness-plans.ts, tableTag 'plans-by-slug') applies it. The
-- outbox `key` is set to plan_slug (TG_ARGV[0]).
--
-- Echo-loop guard: capture_substrate_outbox() skips rows whose origin <> 'local'
-- (the projection's own remote writes), so a federated write is never re-captured.
--
-- AMPLIFICATION GUARD: the AFTER-UPDATE trigger fires ONLY when a FEDERATED
-- (document) field changes — NOT on op_status / op_priority / version /
-- updated_at bumps (those are machine-local operational state, not federated).
-- Without this, plans:start/pause/set-priority (which touch only op_*) would
-- federate the whole content blob redundantly on every operational change. (The
-- BEFORE-UPDATE updated_at trigger from migration 122 also means a plain
-- `old.* IS DISTINCT FROM new.*` WHEN would be true on every update — so the
-- field-specific WHEN is required, not just an optimization.)
--
-- This must land WITH the code that maps harness_plans outbox rows
-- (feature-issue-op-keys.ts) + registers the projection (register-all.ts) — apply
-- after restarting the operator so the drain can dispatch the new table_name.
--
-- Idempotent: CREATE OR REPLACE TRIGGER.

\set ON_ERROR_STOP on
BEGIN;

-- INSERT / DELETE: always capture (echo-guard skips remote-origin rows).
CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.harness_plans
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('plan_slug');

-- UPDATE: capture only when a federated document field actually changed.
CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_plans
  FOR EACH ROW WHEN (
       OLD.content       IS DISTINCT FROM NEW.content
    OR OLD.content_hash  IS DISTINCT FROM NEW.content_hash
    OR OLD.title         IS DISTINCT FROM NEW.title
    OR OLD.status        IS DISTINCT FROM NEW.status
    OR OLD.created       IS DISTINCT FROM NEW.created
    OR OLD.updated       IS DISTINCT FROM NEW.updated
    OR OLD.owner         IS DISTINCT FROM NEW.owner
    OR OLD.supersedes    IS DISTINCT FROM NEW.supersedes
    OR OLD.superseded_by IS DISTINCT FROM NEW.superseded_by
    OR OLD.archived      IS DISTINCT FROM NEW.archived
    OR OLD.is_legacy     IS DISTINCT FROM NEW.is_legacy
  )
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('plan_slug');

COMMIT;
