-- Migration 145 — federation capture triggers on plan_item_assignments.
--
-- Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 0 federation, D-002).
--
-- Stage 2 of the ASSIGNMENT surface: it federates as CONTENT over the peer-log, the
-- same way features/issues/plans/conversations do. capture_substrate_outbox()
-- enqueues local writes into harness_shared.substrate_outbox keyed by the single
-- TG_ARGV[0] column — here the generated `fed_key` = '<plan_slug>:<item_id>' (the
-- composite primary key folded to one scalar, since the trigger fn reads ONE key
-- column). The Stage-3 drain (feature-issue-op-keys.ts toAssignmentValue + the
-- 'plan_item_assignments' → 'item-assignments' tag) maps the outbox row to the
-- projection (projections/plan-item-assignments.ts), which peers apply.
--
-- This trigger is applied TOGETHER with that code (op-key tag + projection +
-- register-all) at the same operator restart, so the drain never sees a captured
-- row for an unmapped table.
--
-- Echo-loop guard: capture_substrate_outbox skips rows where origin <> 'local' (the
-- projection's own remote-apply writes), so the CDC round-trip reaches a fixed point.
-- Amplification guard: UPDATE captures ONLY when a federated document field changes
-- (assignee_name / assigned_by_user / assigned_ts / released_ts / strategy / note),
-- not the updated_at bump or the local origin/author_pubkey stamp.
--
-- The CLAIM table (plan_item_claims) is authority-mediated and is DELIBERATELY NOT
-- federated — it gets no capture trigger.
--
-- Idempotent (CREATE OR REPLACE TRIGGER, PG14+); composes onto 000-baseline.sql.

\set ON_ERROR_STOP on
BEGIN;

-- INSERT / DELETE: always capture (echo-guard skips remote-origin rows).
CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.plan_item_assignments
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('fed_key');

-- UPDATE: capture only when a FEDERATED document field actually changed.
CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.plan_item_assignments
  FOR EACH ROW WHEN (
       OLD.assignee_name    IS DISTINCT FROM NEW.assignee_name
    OR OLD.assigned_by_user IS DISTINCT FROM NEW.assigned_by_user
    OR OLD.assigned_ts      IS DISTINCT FROM NEW.assigned_ts
    OR OLD.released_ts      IS DISTINCT FROM NEW.released_ts
    OR OLD.strategy         IS DISTINCT FROM NEW.strategy
    OR OLD.note             IS DISTINCT FROM NEW.note
  )
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('fed_key');

COMMIT;
