-- 530 — record WHICH embedder produced each stored vector (the embedding "space").
--
-- WI-3616. The five prose surfaces walked by lib/search/embed-backfill.ts each
-- keep their vectors in ONE column with no record of which embedder produced
-- them. The embedder is chosen at runtime from the `memoryEmbedderMode` pref
-- (openai | local), and the SAME pref drives the QUERY-side vector
-- (agent-tools/search/embedder.ts buildQueryEmbedder).
--
-- So flipping that pref silently desynchronises stored vectors from query
-- vectors. Both are 384-D, so nothing errors — but OpenAI-384 and BGE-384 are
-- different spaces, and cosine similarity across them is meaningless. Measured
-- 2026-07-09 after switching to 'local': searching operator_turns for a row by
-- its OWN EXACT TEXT ranked that row #6574 of 8383. Search silently returned noise.
--
-- Worse, embed-backfill only ever filled rows `WHERE embedding IS NULL`, so a
-- column that went mixed could never self-heal: the old-space rows were never
-- revisited. (Observed live: 4 of 40 sampled operator_turns rows were already
-- BGE while 36 were still OpenAI, and the ratio climbed every 5-minute sweep.)
--
-- The fix is to give these columns the same per-mode discipline mem0's memory
-- vectors already have (separate memory_vec_openai / memory_vec_local tables):
-- tag every stored vector with its space, so the backfill can re-embed exactly
-- the rows whose space no longer matches the active embedder.
--
--   NULL  = space unknown (pre-migration rows) -> treat as stale, re-embed.
--   'openai' | 'local' = the embedder that produced the vector in that row.
--
-- Deliberately NOT backfilled to 'openai' here, even though the rows were in
-- fact OpenAI-embedded at the time of writing: by 530 the live column had
-- already begun mixing, so a blanket stamp would assert a falsehood for the
-- rows the sweep had just re-filled with BGE. NULL ("unknown") is the honest
-- value, and the backfill re-embeds it — correct by construction, at the cost
-- of one re-embed pass.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout; re-runnable.
-- Each ALTER is guarded on the embedding column existing, because the vector
-- columns themselves are only added when pgvector is installed (see 501).

DO $space$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT * FROM (VALUES
      ('harness_escalations', 'body_embedding'),
      ('harness_brainstorm',  'content_embedding'),
      ('operator_turns',      'text_embedding'),
      ('harness_decisions',   'body_embedding'),
      ('session_turns',       'text_embedding')
    ) AS v(tbl, col)
  LOOP
    -- Only tables that actually carry the vector column (pgvector present).
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'harness_shared'
         AND table_name   = t.tbl
         AND column_name  = t.col
    ) THEN
      EXECUTE format(
        'ALTER TABLE harness_shared.%I ADD COLUMN IF NOT EXISTS %I text',
        t.tbl, t.col || '_mode'
      );

      -- Partial index: the backfill's hot predicate is "rows not in the active
      -- space", i.e. mode IS DISTINCT FROM $active. Indexing the non-null modes
      -- keeps that scan cheap once the bulk of a large table (session_turns is
      -- ~287k rows) has been stamped.
      EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON harness_shared.%I (%I) WHERE %I IS NOT NULL',
        t.tbl || '_' || t.col || '_mode_idx', t.tbl, t.col || '_mode', t.col || '_mode'
      );
    END IF;
  END LOOP;
END
$space$;
