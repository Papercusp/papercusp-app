-- Migration 501 — session_turns: the episodic verbatim transcript index
-- (session-search-scope-2026-07-05 P-003 / D-003, owner-ratified 2026-07-05).
--
-- ONE turns table fed by an ADAPTER REGISTRY (operator-core
-- lib/search/session-ingest.ts): claude / omp / codex JSONL tailers +
-- agent_chats_consolidated transcript sync. Searched via the `session_turn`
-- SearchSource (search:fulltext / search:semantic) and the fused
-- `sessions:search` tool; windows read by `sessions:read`.
--
-- Design notes:
--   * workspace_id defaults 'default' — local transcript files carry no
--     workspace identity (same convention as agent_chats_consolidated,
--     migration 116). The SearchSource matches (workspace_id = $ws OR
--     workspace_id = 'default') so host-global transcripts are visible
--     from any workspace-scoped search on this box.
--   * text is TRUNCATED AT INGEST (~8k chars) — the index is for recall,
--     the full turn lives in the source JSONL (sessions:read re-reads it).
--   * text_tsv is a GENERATED column (no trigger to forget).
--   * text_embedding vector(384) is added ONLY when pgvector is installed —
--     hybrid search degrades to BM25-only without it (the @papercusp/search
--     per-source try/catch contract). Filled by the embed-backfill sweep
--     (bench lane, admission-governed), NEVER at ingest time.
--   * Retention: the ingest tick prunes rows past the retention window
--     (code-side, session-ingest.ts) — this table is a bounded INDEX, not
--     an archive; the JSONL files remain the archive.
--
-- Idempotent: IF NOT EXISTS everywhere; re-runnable. No top-level
-- BEGIN/COMMIT — the migration runner wraps each file in its own
-- transaction (lint-migrations enforced-era contract).

CREATE TABLE IF NOT EXISTS harness_shared.session_turns (
  workspace_id  TEXT        NOT NULL DEFAULT 'default',
  source_kind   TEXT        NOT NULL,  -- 'claude' | 'omp' | 'codex' | 'agent_chat'
  session_id    TEXT        NOT NULL,  -- client session id (jsonl basename / chat id)
  turn_idx      INTEGER     NOT NULL,  -- 0-based indexed-turn position within the session
  ts            TIMESTAMPTZ,           -- the turn's own timestamp when the source carries one
  owner         TEXT,                  -- agent ownerId when resolvable (su-…, role-…)
  harness_slug  TEXT,
  cwd           TEXT,
  speaker       TEXT        NOT NULL,  -- 'user' | 'assistant' (v1 indexes text turns only)
  text          TEXT        NOT NULL,
  text_tsv      tsvector GENERATED ALWAYS AS (to_tsvector('english', left(text, 20000))) STORED,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
);

CREATE INDEX IF NOT EXISTS session_turns_tsv_idx
  ON harness_shared.session_turns USING gin (text_tsv);
-- Owner + time: the fleet/owner-filtered searches and sessions:timeline.
CREATE INDEX IF NOT EXISTS session_turns_owner_ts_idx
  ON harness_shared.session_turns (owner, ts);
-- Session window reads (sessions:read): PK already orders by
-- (workspace_id, source_kind, session_id, turn_idx); this covers
-- session_id lookups that don't know the source_kind.
CREATE INDEX IF NOT EXISTS session_turns_session_idx
  ON harness_shared.session_turns (session_id);
-- Retention prune scans.
CREATE INDEX IF NOT EXISTS session_turns_ingested_idx
  ON harness_shared.session_turns (ingested_at);

-- pgvector leg — only when the extension is installed (embedded-PG ships it;
-- a bare dev PG may not). The embedding column + HNSW index are optional:
-- absent, search:semantic degrades to BM25-only for this source.
DO $vec$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    EXECUTE 'ALTER TABLE harness_shared.session_turns ADD COLUMN IF NOT EXISTS text_embedding vector(384)';
    -- HNSW needs pgvector >= 0.5; guard so an older extension just skips it
    -- (cosine scans still work, only slower).
    BEGIN
      EXECUTE 'CREATE INDEX IF NOT EXISTS session_turns_embedding_idx
                 ON harness_shared.session_turns
              USING hnsw (text_embedding vector_cosine_ops)';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'session_turns: hnsw index skipped (%)', SQLERRM;
    END;
  END IF;
END
$vec$;

-- coord_message search leg (P-009): an expression GIN index over the coord
-- message stream so the coord_message SearchSource's BM25 is index-backed on
-- the 120k+-row coord_event_log. The WHERE + expression MUST match the
-- source's SQL (sources.ts coordMessage) exactly or the planner won't use it.
CREATE INDEX IF NOT EXISTS coord_event_log_msg_tsv_idx
  ON harness_shared.coord_event_log
  USING gin (to_tsvector('english', left(coalesce(body->>'summary','') || ' ' || coalesce(body->>'body',''), 20000)))
  WHERE surface = 'messages';

-- The tailer's incremental bookkeeping: one row per source file (JSONL path)
-- or per agent_chat id. byte_offset = end of the last fully-ingested line;
-- turn_count = the next turn_idx to assign (monotonic per session).
CREATE TABLE IF NOT EXISTS harness_shared.session_ingest_state (
  source_kind  TEXT   NOT NULL,
  file_path    TEXT   NOT NULL,  -- absolute JSONL path, or 'chat:<id>' for agent_chat
  byte_offset  BIGINT NOT NULL DEFAULT 0,
  turn_count   INTEGER NOT NULL DEFAULT 0,
  session_id   TEXT,
  mtime_ms     BIGINT,
  last_error   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_kind, file_path)
);
