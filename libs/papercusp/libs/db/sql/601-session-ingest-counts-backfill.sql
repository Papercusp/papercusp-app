-- Migration 601 — resumable EI-9970 count backfill cursor (WI-4297).
--
-- Migration 579 added prompt/response/tool-call counters to
-- session_ingest_state, but historical rows already at EOF retained zeroes.
-- A null completion marker makes those rows eligible for the bounded ingest
-- backfill; the separate byte cursor lets a restart resume without replaying
-- the indexed text turns or blocking the normal tailer.

ALTER TABLE harness_shared.session_ingest_state
  ADD COLUMN IF NOT EXISTS counts_backfill_offset BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counts_backfill_last_inference_id TEXT,
  ADD COLUMN IF NOT EXISTS counts_backfilled_at TIMESTAMPTZ;

-- Rows with already-populated counters do not need historical replay. Rows at
-- offset zero have no historical bytes yet; normal ingestion stamps them when
-- it first advances. The __hwm__ row is bookkeeping, never a transcript.
UPDATE harness_shared.session_ingest_state
   SET counts_backfilled_at = COALESCE(counts_backfilled_at, now())
 WHERE counts_backfilled_at IS NULL
   AND (
     file_path = '__hwm__'
     OR byte_offset = 0
     OR prompt_count <> 0
     OR response_count <> 0
     OR tool_call_count <> 0
   );

COMMENT ON COLUMN harness_shared.session_ingest_state.counts_backfill_offset IS
  'WI-4297: byte cursor for the resumable historical EI-9970 counter backfill; distinct from byte_offset, which owns indexed text turns.';

COMMENT ON COLUMN harness_shared.session_ingest_state.counts_backfill_last_inference_id IS
  'WI-4297: response-dedup cursor paired with counts_backfill_offset; distinct from the live tailer inference cursor.';

COMMENT ON COLUMN harness_shared.session_ingest_state.counts_backfilled_at IS
  'WI-4297: timestamp when the historical EI-9970 counters reached EOF (or the source was permanently unavailable). NULL means eligible/in progress.';
