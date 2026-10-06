-- WI-10006171: these existing mapped tables lacked a raw-SQL/federation
-- producer. Reuse the generic notifier, including its bulk-fold coalescing.
CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.report_library
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.work_item_occurrences
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
