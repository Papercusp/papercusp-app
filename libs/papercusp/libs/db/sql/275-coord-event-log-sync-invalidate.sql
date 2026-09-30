-- Migration 275 — live-push the coordination activity feed (dev.coordFeed).
--
-- coord_event_log is the union of every coordination surface (messages,
-- handoffs, escalations, plan-events). The sync resolver query `dev.coordFeed`
-- reads it for the PresenceRail "Activity" tab + the /adv Conversations Feed,
-- but the table had NO emit_change_notify trigger — so a new coord event never
-- fired an SSE `sync_invalidate` and the feed only refreshed on a manual
-- refetch. shared-hive-collaboration-2026-06-14 P-006 needs live updates
-- WITHOUT polling, so attach the standard producer.
--
-- FILTERED to ORIGINAL rows (body->>'notify_kind' IS NULL): coord_event_log is
-- the busiest coord table and the subscribe→inject fan-out writes one delivery
-- COPY per subscriber (mig 126), each carrying a notify_kind. Firing per-copy
-- would be a notify storm; the original message/handoff/escalation/plan-event
-- row is the one the feed shows. (Same WHEN discriminator mig 150's federation
-- capture uses.) The client-side (name,args) dedupe in @papercusp/sync bounds
-- burst refetches.
--
-- INSERT covers new events; UPDATE covers the escalation/handoff ON CONFLICT
-- upserts. DELETE is intentionally NOT pushed (a GC'd event vanishing isn't
-- time-critical; the feed reconciles on the next event), which also keeps the
-- WHEN clause referencing NEW only.
--
-- The bridge entry  harness_shared.coord_event_log -> ['dev.coordFeed']  lives
-- in packages/operator-core/lib/sync-resolver/table-to-query-names.ts.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; — an inner COMMIT would end the runner's
-- wrapper txn early and break apply+ledger atomicity (migration-runner.js
-- contract; lint:migrations).

DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.coord_event_log;
CREATE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE ON harness_shared.coord_event_log
  FOR EACH ROW
  WHEN ((NEW.body->>'notify_kind') IS NULL)
  EXECUTE FUNCTION harness_shared.emit_change_notify();
