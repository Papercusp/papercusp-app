-- 985-p2p-foreign-workspaces-change-notify.sql — WI-42230 / P-510.
--
-- The host-local foreign-work registry was created by migration 467 before it
-- had a public sync consumer. The Settings surface now reads a path-redacted
-- lifecycle projection (`p2p.foreignWorkspaces`), so inserts and state changes
-- must invalidate an already-open page. Reuse the established sync trigger;
-- the table remains host-local and is still excluded from federation/outbox.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.p2p_foreign_workspaces
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
