-- 1287-dedupe-claude-transcript-usage-copies.sql
--
-- WI-10004637: one provider request was persisted once per transcript COPY.
--
-- A carried or resumed Claude session's transcript is copied into each successor's isolated
-- config dir (~/.papercusp/session-claude/<owner>/), and the interactive-usage ingester keyed
-- every request by [file, fileGeneration, model, sourceId]. The same provider message
-- (`message:<id>`) read from N copies therefore produced N rows in agent_usage_samples, and
-- every cost/usage reader summed all of them. Measured 2026-10-01 06:25Z on the dev box:
-- 1,047,452 `message:` rows for 223,896 distinct provider messages (823,556 extra rows, up to
-- 96 copies of one request). Every copy carried the identical token vector, cost, turn count,
-- price-table version and cost source; only session_id / harness_slug / goal_id differed
-- (each copy was attributed to the session whose file it was read from).
--
-- The ingester now keys a `message:` observation by ['provider-message', model, sourceId]
-- (transcriptUsageEventKey in packages/operator-core/lib/interactive-usage/
-- ingest-claude-transcripts.ts), so a later copy max-merges into the existing row. This
-- migration repairs the rows already written:
--
--   1. Within each (workspace_id, model, sourceId) group of `message:` rows, keep the FIRST
--      INSERTED row (lowest id: the original session's read, whose attribution is the one the
--      forward fix also keeps) and delete later rows that carry the SAME token vector and cost.
--      A copy whose numbers differ is never deleted: information would be lost, so such a
--      group is left as-is and keeps its old keys (none exist today).
--   2. Rekey each group that is now a single row to the file-independent key, so a copy read
--      after this migration conflicts onto it instead of inserting a new row.
--
-- The work lives in a function so a later migration can sweep copies that an ingester still
-- running the pre-fix code writes between this migration and that code's deployment. Running
-- it again is a no-op on already-collapsed data.
--
-- Not destructive DDL: no table, column, index or constraint is dropped or renamed. The
-- pre-fix ingester stays correct against the rekeyed rows (it never re-reads an ingested byte
-- range, so it never looks the old key up again).

CREATE OR REPLACE FUNCTION harness_shared.transcript_provider_message_usage_key(p_model text, p_source_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $fn$
  -- Must equal sha256(JSON.stringify(['provider-message', model, sourceId])) in
  -- transcriptUsageEventKey. JSON.stringify emits no whitespace between elements, so the array
  -- is assembled by hand rather than with json_build_array (whose text form adds spaces).
  SELECT encode(
    sha256(convert_to('["provider-message",' || to_json(p_model)::text || ',' || to_json(p_source_id)::text || ']', 'UTF8')),
    'hex');
$fn$;

COMMENT ON FUNCTION harness_shared.transcript_provider_message_usage_key(text, text) IS
  'usage_event_key of a provider-native transcript message (WI-10004637); mirrors transcriptUsageEventKey in ingest-claude-transcripts.ts.';

-- multi_row_groups is the number of (workspace, model, message) groups still holding more than
-- one row when the call returns. Two causes, which a caller must not conflate: copies whose
-- numbers genuinely differ (never deleted), and rows an ingester committed while the DELETE
-- ran (each statement sees newly committed rows under READ COMMITTED). The second kind is
-- collapsed by calling the function again; the first kind never is.
CREATE OR REPLACE FUNCTION harness_shared.collapse_transcript_usage_copies()
RETURNS TABLE (deleted_rows bigint, rekeyed_rows bigint, multi_row_groups bigint)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_deleted bigint;
  v_rekeyed bigint;
  v_multi bigint;
BEGIN
  WITH msg AS (
    SELECT id, workspace_id, model, usage_provenance->>'sourceId' AS source_id,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           cache_creation_5m_tokens, cache_creation_1h_tokens, cost_usd
      FROM harness_shared.agent_usage_samples
     WHERE source = 'interactive'
       AND usage_event_key IS NOT NULL
       AND model IS NOT NULL
       AND usage_provenance->>'sourceId' LIKE 'message:%'
  ), ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY workspace_id, model, source_id ORDER BY id) AS rn,
           count(*) OVER (
             PARTITION BY workspace_id, model, source_id,
                          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                          cache_creation_5m_tokens, cache_creation_1h_tokens, cost_usd) AS same_vector,
           count(*) OVER (PARTITION BY workspace_id, model, source_id) AS group_size
      FROM msg
  )
  DELETE FROM harness_shared.agent_usage_samples s
   USING ranked r
   WHERE s.id = r.id
     AND r.rn > 1
     AND r.same_vector = r.group_size;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  WITH singles AS (
    SELECT workspace_id, model, usage_provenance->>'sourceId' AS source_id
      FROM harness_shared.agent_usage_samples
     WHERE source = 'interactive'
       AND usage_event_key IS NOT NULL
       AND model IS NOT NULL
       AND usage_provenance->>'sourceId' LIKE 'message:%'
     GROUP BY 1, 2, 3
    HAVING count(*) = 1
  )
  UPDATE harness_shared.agent_usage_samples s
     SET usage_event_key = harness_shared.transcript_provider_message_usage_key(s.model, g.source_id)
    FROM singles g
   WHERE s.workspace_id = g.workspace_id
     AND s.model = g.model
     AND s.usage_provenance->>'sourceId' = g.source_id
     AND s.source = 'interactive'
     AND s.usage_event_key IS NOT NULL
     AND s.usage_event_key IS DISTINCT FROM harness_shared.transcript_provider_message_usage_key(s.model, g.source_id);
  GET DIAGNOSTICS v_rekeyed = ROW_COUNT;

  SELECT count(*) INTO v_multi
    FROM (
      SELECT 1
        FROM harness_shared.agent_usage_samples
       WHERE source = 'interactive'
         AND usage_event_key IS NOT NULL
         AND model IS NOT NULL
         AND usage_provenance->>'sourceId' LIKE 'message:%'
       GROUP BY workspace_id, model, usage_provenance->>'sourceId'
      HAVING count(*) > 1
    ) d;

  RETURN QUERY SELECT v_deleted, v_rekeyed, v_multi;
END;
$fn$;

COMMENT ON FUNCTION harness_shared.collapse_transcript_usage_copies() IS
  'Collapse agent_usage_samples rows that repeat one provider message once per transcript copy, then rekey survivors to transcript_provider_message_usage_key (WI-10004637). Idempotent.';

SELECT * FROM harness_shared.collapse_transcript_usage_copies();
