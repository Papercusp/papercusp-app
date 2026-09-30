-- 222 — attach harness_shared.emit_change_notify() to harness_registry.
--
-- The harness registry (single JSONB row per workspace, migration 025) backs
-- the `harnessProjects.lite` sync query (EI-206). App-code notifySyncInvalidate
-- from the registry write seam is source-deduped for 90s per (name, args), so
-- the second registry change inside the window (e.g. a create followed by a
-- delete) was silently swallowed and open harness lists went stale. PG-trigger
-- events bypass the source-side dedupe and also cover raw-SQL writes, so the
-- table trigger is the reliable producer (same pattern as 107 / 124).
--
-- Idempotent: CREATE OR REPLACE TRIGGER.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_registry
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
