-- 107-dogfood-reactivity-triggers.sql
--
-- Attach harness_shared.emit_change_notify() (the SSE `sync_invalidate` producer)
-- to the 18 reactive tables. This DDL used to live ONLY in the runtime helper
-- wireDogfoodTriggers() in apps/operator/lib/ensure-schema-dogfood.ts — it was never
-- in any migration, so the squashed 000-baseline.sql (which is a dump of a reference
-- build that invoked the dogfood TABLE ensures but not the TRIGGER wiring) does not
-- contain these triggers. Without them a fresh DB built from migrations alone has no
-- reactivity, and the schema-diff gate doesn't diff triggers so it didn't catch the gap.
--
-- Moving them into a migration makes the migration set the single complete source
-- (self-contained-migration-baseline-2026-06-02, P-008 follow-up). The runtime
-- wireDogfoodTriggers() remains for now as an idempotent no-op and can be retired in a
-- later pass. Idempotent via CREATE OR REPLACE TRIGGER (PG 14+).
--
-- Pre-conditions guaranteed by ordering: emit_change_notify() (the function) + all 18
-- tables are created by 000-baseline.sql, which applies before this file (000 < 107).

-- New dogfood tables (DOGFOOD_REACTIVE_TABLES).
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.feature_queue              FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.feature_working_set        FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.contributors              FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.feature_claims            FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.pr_reviewer_settings      FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.pr_check_status_cache     FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.known_schema_versions     FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.auto_review_audit         FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.claim_audit               FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.webhook_audit             FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.trusted_authors           FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.contributor_usage_events  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.insights_first_visit      FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.shared_repo_binding_cache FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

-- Existing HYPERBEE consolidated tables (EXISTING_HYPERBEE_REACTIVE_TABLES).
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_features_consolidated FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_issues_consolidated   FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.coord_presence               FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_feature_prs          FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
