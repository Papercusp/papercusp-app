-- 1173-plan-items-parts-change-notify.sql — WI-10001643 / P-009.
--
-- `projectHistoryEvents.byHarness` (the live History timeline) reads three
-- backing tables: work_items, plan_items and harness_plan_parts. The
-- `table-to-query-names` bridge maps all three to that query, but a bridge
-- entry is only reachable when the table actually EMITS
-- `harness_shared.<table>.changed` — that event is produced solely by the
-- `emit_change_notify` trigger, which pg_notify's the `sync_invalidate`
-- channel that sync-sse.ts then feeds to `queryNamesForTriggerEvent`.
--
-- Measured 2026-09-17 against the live DB: work_items carries
-- emit_change_notify_trg, while plan_items had NO non-internal triggers at all
-- and harness_plan_parts carried only the outbox/canonicalize ones. So both
-- bridge entries were dead code — a plan-item status change or a plan-part
-- edit never invalidated an open History tab, and the timeline silently served
-- stale plan rows until an unrelated work_items write happened to bust it.
--
-- The trigger (rather than enumerated notifySyncInvalidate call sites) is the
-- right layer here for the reason the bridge comment already gives: these two
-- tables are written from many app paths AND from raw SQL, MCP-tool writes and
-- migrations that never run app code. A trigger catches every writer; an
-- enumerated call-site list silently misses most of them.
--
-- Non-destructive: adds two triggers, changes no column, constraint or data,
-- so the currently-deployed release keeps serving unchanged.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.plan_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.harness_plan_parts
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
