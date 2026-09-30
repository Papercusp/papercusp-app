-- 1178-sync-trigger-coverage-dream-and-identity.sql — WI-10001749.
--
-- `TABLE_TO_QUERY_NAMES` maps these four relations into the sync-invalidation
-- bridge, but no producer trigger emitted their `.changed` events. Raw-SQL and
-- federated writes could therefore leave open clients serving stale query data
-- until an unrelated mapped-table write caused an invalidation.
--
-- Attach the established generic producer trigger. The migrated-database
-- cache-tag trigger-coverage integration test derives its required set from the
-- map and prevents this class of omission from recurring.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.dream_runs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.experiment_runs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.session_briefs
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.session_identity_activation_events
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
