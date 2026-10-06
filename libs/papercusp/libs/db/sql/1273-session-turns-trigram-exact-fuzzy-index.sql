-- 1273 — session transcript exact + typo-tolerant search: storage for the trigram tiers
-- (session-transcript-exact-fuzzy-search-2026-09-14 P-002; design authority: plan D-003/D-004/D-005).
--
-- WHAT THIS ADDS (no column on session_turns, no table rewrite, no data movement):
--   * session_turn_vocab        — per-workspace term dictionary (distinct simple-dictionary tokens of
--                                 length 4-40 from session_turns.text with a doc count). The fuzzy tier
--                                 expands a mistyped query token through THIS table (trigram neighbours)
--                                 and resolves the neighbours through the exact tier. Rebuildable
--                                 projection of session_turns.text; keyed by workspace_id so a
--                                 workspace's neighbours can never surface another workspace's words.
--   * session_turn_vocab_state  — per-workspace build state + incremental watermark for that table
--                                 (absent / building / ready / failed), so the read path can degrade
--                                 instead of scanning while a build is in flight (D-005 rule 3).
--   * three INDEXES, created HERE ONLY WHEN session_turns IS SMALL (<= 10000 rows — a fresh install
--     or a test database, where the build is instant and there is no writer to block):
--       session_turns_text_trgm_idx        GIN (lower(text) gin_trgm_ops)  — exact-substring tier
--       session_turns_ts_desc_idx          btree (ts DESC NULLS LAST)      — newest-first walk for very
--                                                                          common literals
--       session_turn_vocab_word_trgm_idx   GIN (word gin_trgm_ops)         — vocabulary neighbours
--
-- WHY THE GUARD (D-004 measurements on a 1,355,857-row copy): the exact-tier GIN is 744 MB and took
-- 358.5 s to build; the btree took 0.9 s; the vocabulary's first full build took 351.9 s. A plain
-- CREATE INDEX holds a write-blocking SHARE lock on session_turns for its whole build, and the migration
-- runner wraps every file in ONE transaction, so CREATE INDEX CONCURRENTLY is illegal here. So on a
-- database that already holds a real corpus this migration creates the two small tables only and leaves
-- the indexes + the vocabulary's first build to the deferred durable job
-- (packages/operator-core/lib/session-search-index-build.ts, DBOS workflow sessionSearchIndexBuild),
-- which issues CREATE INDEX CONCURRENTLY IF NOT EXISTS outside any transaction (D-005 rules 1-2).
-- The read path reports a still-absent index/vocabulary as a skipped tier instead of falling back to a
-- sequential scan (D-005 rule 3). The index NAMES and the lower(text) expression below are byte-matched
-- by that module's spec table (and pinned by its test) — change both together.
--
-- Idempotent and replay-safe: IF NOT EXISTS everywhere, the size check re-evaluates on every apply
-- (a replay after the deferred job already built an index is a no-op), and no statement rewrites data.
-- Forward-compat: purely additive (two new tables, optional indexes); no currently-deployed reader or
-- writer of session_turns changes behaviour.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS harness_shared.session_turn_vocab (
  workspace_id text        NOT NULL,
  word         text        NOT NULL,
  -- Approximate number of turns containing the word. A full rebuild resets it to the exact count;
  -- incremental refresh adds the new rows' counts (re-ingested rows can over-count) — used only to
  -- order equally-similar neighbours, never as a correctness signal.
  ndoc         integer     NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, word)
);

COMMENT ON TABLE harness_shared.session_turn_vocab IS
  'Rebuildable term dictionary over session_turns.text for the typo-tolerant transcript search tier (plan session-transcript-exact-fuzzy-search-2026-09-14 D-004): distinct simple-dictionary tokens of length 4-40 per workspace with an approximate document count. Filled by the deferred sessionSearchIndexBuild job; safe to truncate (the next run rebuilds it).';

CREATE TABLE IF NOT EXISTS harness_shared.session_turn_vocab_state (
  workspace_id          text        PRIMARY KEY,
  status                text        NOT NULL DEFAULT 'absent'
                          CHECK (status IN ('absent', 'building', 'ready', 'failed')),
  -- max(session_turns.ingested_at) observed BEFORE the last build/refresh read the corpus; the next
  -- incremental refresh only tokenizes rows ingested after it.
  watermark_ingested_at timestamptz,
  word_count            bigint,
  build_started_at      timestamptz,
  build_finished_at     timestamptz,
  -- When the vocabulary was last rebuilt from scratch (incremental refreshes never reset ndoc
  -- drift from retention deletes; the job rebuilds fully once this is older than its max age).
  last_full_build_at    timestamptz,
  last_error            text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.session_turn_vocab_state IS
  'Per-workspace build state and incremental watermark for harness_shared.session_turn_vocab. The transcript search read path treats any status other than ready as "fuzzy tier not available yet" and reports it in its policy receipt instead of scanning.';

DO $$
DECLARE
  is_small boolean;
BEGIN
  SELECT count(*) <= 10000
    INTO is_small
    FROM (SELECT 1 FROM harness_shared.session_turns LIMIT 10001) AS probe;

  IF is_small THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS session_turns_text_trgm_idx '
         || 'ON harness_shared.session_turns USING gin (lower(text) gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS session_turns_ts_desc_idx '
         || 'ON harness_shared.session_turns (ts DESC NULLS LAST)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS session_turn_vocab_word_trgm_idx '
         || 'ON harness_shared.session_turn_vocab USING gin (word gin_trgm_ops)';
  END IF;
END $$;
