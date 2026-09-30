-- 063-decisions-search.sql
--
-- Add BM25 + semantic search columns to harness_decisions. Plan 2A.1
-- listed this as an indexed surface but migrations 059/061 only covered
-- escalations/brainstorm/operator_turns. Surfacing decisions makes the
-- "remember when we decided X" use case actually answerable.
--
-- Source text shape: verb || ' ' || args (decisions are like git log
-- entries — short, dense). No setweight needed since the columns are
-- of equal importance.

-- harness_decisions is in publication "zero_harness"; required for
-- UPDATE during backfill.
ALTER TABLE harness_shared.harness_decisions REPLICA IDENTITY FULL;

-- ── BM25 (tsvector) ────────────────────────────────────────────────

ALTER TABLE harness_shared.harness_decisions
  ADD COLUMN IF NOT EXISTS body_tsv tsvector;

CREATE OR REPLACE FUNCTION harness_shared.harness_decisions_tsv_update()
RETURNS trigger AS $$
BEGIN
  NEW.body_tsv := to_tsvector('english',
    coalesce(NEW.verb, '') || ' ' || coalesce(NEW.args, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS harness_decisions_tsv_trigger ON harness_shared.harness_decisions;
CREATE TRIGGER harness_decisions_tsv_trigger
  BEFORE INSERT OR UPDATE OF verb, args
  ON harness_shared.harness_decisions
  FOR EACH ROW EXECUTE FUNCTION harness_shared.harness_decisions_tsv_update();

UPDATE harness_shared.harness_decisions
   SET body_tsv = to_tsvector('english',
     coalesce(verb, '') || ' ' || coalesce(args, ''))
 WHERE body_tsv IS NULL;

CREATE INDEX IF NOT EXISTS harness_decisions_body_tsv_idx
  ON harness_shared.harness_decisions USING GIN (body_tsv);

-- ── Semantic (vector) ──────────────────────────────────────────────
-- Wrapped in DO/EXCEPTION so missing pgvector doesn't break boot
-- (matches the pattern from 060).

DO $$
BEGIN
  EXECUTE 'ALTER TABLE harness_shared.harness_decisions ADD COLUMN IF NOT EXISTS body_embedding vector(384)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS harness_decisions_body_embedding_hnsw ON harness_shared.harness_decisions USING hnsw (body_embedding vector_cosine_ops)';
EXCEPTION
  WHEN undefined_object OR feature_not_supported THEN
    RAISE NOTICE 'pgvector not installed — skipping embedding column on harness_decisions';
END $$;
