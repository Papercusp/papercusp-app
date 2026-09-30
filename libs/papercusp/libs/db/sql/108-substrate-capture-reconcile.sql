-- 108-substrate-capture-reconcile.sql
--
-- Reconcile the substrate-outbox CDC capture into the migration set. Two gaps that
-- lived ONLY in the runtime wireDogfoodTriggers() (apps/operator/lib/ensure-schema-dogfood.ts),
-- found by the dogfood-gap-check (self-contained-migration-baseline-2026-06-02, P-008b prep):
--
--   1. P-070 federation: harness_shared.contributor_usage_events.origin (echo-guard column)
--      + its capture_substrate_outbox_trg. Neither was in 000-baseline or 107.
--
--   2. Definition drift on the two consolidated tables: migration 102 created
--      capture_substrate_outbox_trg as AFTER INSERT OR DELETE, but wireDogfoodTriggers
--      re-wires it AFTER INSERT OR UPDATE OR DELETE at every boot — so the LIVE runtime
--      trigger captures UPDATEs too (an edited feature/issue should federate), while the
--      migration set didn't. This aligns the migration set to that live reality.
--
-- All idempotent (ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE TRIGGER, PG 14+).
-- Pre-conditions (capture_substrate_outbox() fn + all 3 tables) are in 000-baseline.

ALTER TABLE harness_shared.contributor_usage_events
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'local';

CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.contributor_usage_events
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('event_id');

CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_features_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('feature_id');

CREATE OR REPLACE TRIGGER capture_substrate_outbox_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_issues_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_substrate_outbox('issue_id');
