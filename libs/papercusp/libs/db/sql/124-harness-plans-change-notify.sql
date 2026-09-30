-- Migration 124 — attach emit_change_notify() to harness_plans.
--
-- Plan: plans-pg-canonical-migration-2026-06-03 (Stage 1).
--
-- Plans are now PG-canonical, so the admin Plans tab's live sync queries
-- (plans.list / plans.get / plans.items / plans.attention / plans.search,
-- registered in sync-resolver/index.ts) must refetch when a plan row changes.
-- emit_change_notify() is the SSE `sync_invalidate` producer attached to every
-- reactive table in migration 107; the sync-sse LISTEN handler bridges the
-- `harness_shared.harness_plans.changed` event to those camelCase query names
-- via TABLE_TO_QUERY_NAMES. Without this trigger an agent's plan write would not
-- refresh another client's open Plans tab.
--
-- The federation capture trigger (capture_substrate_outbox) is a SEPARATE
-- concern attached in the Stage-2 federation migration, once the plans
-- projection is registered on the outbox drain.
--
-- Idempotent: CREATE OR REPLACE TRIGGER.

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_plans
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

COMMIT;
