-- 227 — attach harness_shared.emit_change_notify() to agent_chats_consolidated.
--
-- EI-324: the consolidated chat mirror backs the `agentChats.byHarness` sync
-- query (the dock ChatPanel transcript), and the bridge entry exists in
-- table-to-query-names.ts — but the table carried NO change-notify trigger,
-- so a completed chat turn never invalidated open panels: the transcript went
-- permanently stale (observed >7 min live, 2026-06-11). Chat writes also
-- happen cross-process (the SU MCP `agent_chats:chat` path runs in a
-- different operator than the desktop's), so an app-code
-- notifySyncInvalidate alone can't cover every producer — the PG trigger is
-- the reliable one (same rationale + pattern as 222 / 107 / 124).
--
-- Idempotent: CREATE OR REPLACE TRIGGER.

CREATE OR REPLACE TRIGGER emit_change_notify_trg
  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.agent_chats_consolidated
  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify();
