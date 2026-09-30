-- Migration 763 — live-push a MODE CHANGE.
-- session-chat-popup-timestamps-and-modes-2026-08-09 P-003.
--
-- [owner 2026-08-09] "I changed drain mode from off to on, but the display
-- still showed off afterward."
--
-- The mode pill in the session-chat control band reads its current value from
-- the `advRoster.list` sync query. `mode:set` writes harness_shared.agent_modes
-- (packages/operator-core/lib/modes/store.ts) — and that table had NO triggers
-- AT ALL, so a mode write emitted no `sync_invalidate` and nothing refetched the
-- roster. The pill therefore kept rendering its PRE-CHANGE value until some
-- unrelated coord_presence write happened to refresh the roster for its own
-- reasons, which is why the staleness looked intermittent rather than total.
--
-- WHY A TRIGGER RATHER THAN notifySyncInvalidate AT THE WRITE SITE:
-- `setMode` is today's only writer, so an app-code push would work today. It
-- would also silently stop covering the surface the moment a second writer
-- appears — federation replay, a backfill, a direct admin fix — and the symptom
-- of that regression is precisely the one being fixed here: a display that
-- disagrees with the database and looks like a UI bug. Attaching the standard
-- producer to the TABLE makes the push a property of the data, so it holds for
-- every writer including ones not yet written.
--
-- DELETE is included, and it is not an afterthought: disabling a mode is
-- implemented as a DELETE of the axis row (store.ts), so an INSERT/UPDATE-only
-- trigger would push mode-ON and stay silent on mode-OFF — leaving exactly half
-- the reported bug in place, in the harder direction to notice.
-- harness_shared.emit_change_notify() already handles DELETE (it reads
-- COALESCE(NEW, OLD) and returns OLD), so no special-casing is needed here.
--
-- No WHEN filter: agent_modes is low-write (one row per agent per axis, moved by
-- a human or an agent decision, not by telemetry), so there is no notify-storm
-- risk of the kind that made migration 275 filter coord_event_log. The
-- client-side (name,args) dedupe in @papercusp/sync bounds any burst anyway.
--
-- The bridge entry  harness_shared.agent_modes -> ['advRoster.list', …]  lives
-- in packages/operator-core/lib/sync-resolver/table-to-query-names.ts. BOTH
-- halves are required: this trigger emits `harness_shared.agent_modes.changed`
-- and that map is what turns it into the query names to refetch. Neither does
-- anything alone.
--
-- The migration runner wraps each file in its own transaction, so this file
-- carries NO top-level BEGIN;/COMMIT; — an inner COMMIT would end the runner's
-- wrapper txn early and break apply+ledger atomicity (migration-runner.js
-- contract; lint:migrations).

DROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.agent_modes;
CREATE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.agent_modes
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.emit_change_notify();
