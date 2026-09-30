-- 114-substrate-capture-restore-update-guard.sql
--
-- Restore the IS-DISTINCT-FROM guard on substrate-outbox UPDATE capture that
-- migration 108-substrate-capture-reconcile dropped.
--
-- 000-baseline + the (squashed) 091/102 era used a SPLIT design per capture
-- table: capture_substrate_outbox_trg AFTER INSERT OR DELETE (unconditional) +
-- capture_substrate_outbox_upd_trg AFTER UPDATE ... WHEN (OLD.* IS DISTINCT FROM
-- NEW.*) — the WHEN guard is load-bearing: it stops a no-op re-upsert (an
-- identical row merged back during federation) from re-emitting an outbox row,
-- which is what terminates the cross-peer echo loop.
--
-- Migration 108 collapsed capture into a SINGLE
-- `capture_substrate_outbox_trg AFTER INSERT OR UPDATE OR DELETE` with NO WHEN
-- clause, so every UPDATE — including identical re-upserts — is captured →
-- unbounded intra-peer self-amplification (the outbox never reaches a fixed
-- point). This restores the split, guarded design on all three capture tables.
--
-- Idempotent (CREATE OR REPLACE TRIGGER, PG 14+). The capture function +
-- tables are pre-conditions from 000-baseline.

-- contributor_usage_events (event_id) — had only the unguarded main trg; this
-- also ADDS the guarded UPDATE trg it was missing.
CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.contributor_usage_events
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('event_id');
CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.contributor_usage_events
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('event_id');

-- harness_features_consolidated (feature_id)
CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.harness_features_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');
CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_features_consolidated
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');

-- harness_issues_consolidated (issue_id)
CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.harness_issues_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
CREATE OR REPLACE TRIGGER capture_substrate_outbox_upd_trg
  AFTER UPDATE ON harness_shared.harness_issues_consolidated
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
  EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
