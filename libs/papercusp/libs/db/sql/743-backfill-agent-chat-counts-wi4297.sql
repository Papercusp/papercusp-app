-- Migration 743 — un-exempt agent_chat rows migration 601 wrongly marked
-- "backfilled" (WI-4297 completion gap).
--
-- Migration 601 exempted rows from the resumable EI-9970 counter backfill
-- when `byte_offset = 0`, reasoning "no historical bytes yet; normal
-- ingestion stamps them when it first advances" (true for the file-based
-- claude/omp/codex adapters, where byte_offset is a real, advancing byte
-- cursor). That reasoning does not hold for source_kind='agent_chat':
-- syncAgentChats() ALWAYS writes byte_offset=0 for chats (see
-- packages/operator-core/lib/search/session-ingest.ts, syncAgentChats,
-- writeState calls) — a chat transcript has no byte cursor at all, so
-- byte_offset=0 is agent_chat's PERMANENT steady state, not a "not yet
-- touched" signal.
--
-- Net effect: every pre-migration-579 agent_chat row that already had
-- turn_count > 0 (fully tailed under the old turn-only counter) but had
-- never had its prompt/response counts computed satisfied migration 601's
-- `byte_offset = 0` exemption and was permanently marked
-- counts_backfilled_at = now() with prompt_count/response_count/
-- tool_call_count left at their zero defaults — never actually counted,
-- and (because counts_backfilled_at is the ONLY eligibility gate
-- backfillHistoricalCounts's WHERE clause checks) never eligible to be
-- picked up by the resumable backfill loop again.
--
-- Fix: reset counts_backfilled_at back to NULL for exactly the affected
-- rows (agent_chat, turn_count > 0, all three counts still 0, not the
-- __hwm__ bookkeeping row) so backfillHistoricalCounts's agent_chat block
-- (session-ingest.ts, the `chats` query + loop) recomputes them for real on
-- its next tick — it derives fresh prompt/response counts directly from
-- agent_chats_consolidated.transcript, which is unaffected by this reset.
--
-- A chat whose transcript has since been deleted/expired
-- (agent_chats_consolidated has no matching row, or transcript IS NULL) is
-- NOT reset here: there is no source left to recount from, exactly the
-- 'counts_backfill_source_missing' case the file-adapter path already
-- handles terminally. Those rows stay counts_backfilled_at-set (their
-- prompt/response counts are permanently unknowable, not "still to do").

UPDATE harness_shared.session_ingest_state AS st
   SET counts_backfilled_at = NULL,
       counts_backfill_offset = 0,
       counts_backfill_last_inference_id = NULL
  FROM harness_shared.agent_chats_consolidated AS c
 WHERE st.source_kind = 'agent_chat'
   AND st.file_path <> '__hwm__'
   AND st.turn_count > 0
   AND st.prompt_count = 0
   AND st.response_count = 0
   AND st.tool_call_count = 0
   AND st.counts_backfilled_at IS NOT NULL
   AND st.file_path = ('chat:' || c.workspace_id || ':' || c.harness_slug || ':' || c.id)
   AND c.transcript IS NOT NULL;
