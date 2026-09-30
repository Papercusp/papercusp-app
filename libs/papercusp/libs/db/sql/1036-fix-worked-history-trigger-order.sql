-- EI-20223969389884116: re-apply the 806 trigger-order fix.
--
-- Migration 806 (libs/papercusp/libs/db/sql/806-work-item-worked-history.sql) was
-- edited ON DISK after it had already applied, to rename the history trigger from
-- work_items_worked_by_history_trg to record_work_item_worked_by_history_trg (so it
-- runs alphabetically BEFORE stamp_local_federated_write_trg — trigger firing order
-- for same-kind PostgreSQL triggers is alphabetical by name, and the history
-- trigger's fed_ts guard only works correctly if it sees fed_ts BEFORE the stamp
-- trigger changes it). That disk edit never re-ran: db:check_drift confirms 806's
-- recorded applied sha256 does not match the current file content, and the live
-- database still has the OLD trigger name (verified via pg_trigger). This migration
-- re-applies the rename directly so the fix is actually live.

DROP TRIGGER IF EXISTS work_items_worked_by_history_trg ON harness_shared.work_items;
DROP TRIGGER IF EXISTS record_work_item_worked_by_history_trg ON harness_shared.work_items;
CREATE TRIGGER record_work_item_worked_by_history_trg
  BEFORE UPDATE OF taken_by ON harness_shared.work_items
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.record_work_item_worked_by_history();
