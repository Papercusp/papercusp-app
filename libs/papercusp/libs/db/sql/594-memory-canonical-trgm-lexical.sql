-- 594 — pg_trgm GIN indexes for the memory lexical leg (EI-10931).
--
-- The `hybrid-pg` lexical leg (libs/generic/memory canonical-store.lexicalSearch) is an
-- embed-free, field-weighted ILIKE match over memory_canonical. Measured on the live
-- store it costs ~776ms per search and grows LINEARLY with the store:
--
--     Seq Scan on memory_canonical (actual time=1.368..774.428 rows=1287 loops=1)
--     Execution Time: 775.674 ms          -- 13,594 active rows, a 12-token query
--
-- The scan was unavoidable because every ILIKE lived in the SELECT list (the score
-- expression) and the only WHERE predicate was `invalid_at IS NULL` — so Postgres had to
-- read and SCORE every row, and no index could be used. canonical-store.ts now also emits
-- an equivalent, INDEXABLE OR pre-filter in the inner WHERE; these indexes are what that
-- pre-filter is served from.
--
-- gin_trgm_ops (NOT tsvector — deliberately): trigram matching accelerates ILIKE '%x%'
-- with IDENTICAL semantics — no stemming, no stop-word removal, no tokenization change.
-- A weighted `tsvector` looks like a natural fit for the 3/2/1 field weights, but
-- `to_tsvector('english', …)` stems and drops stop-words, which MANGLES IDENTIFIERS
-- (PAPERCUSP_MEMORY_TIMEOUT, WI-4522, camelCase tool names). Exact-identifier recall
-- (MRR 1.00 vs the cosine leg's 0.87) is the entire reason this leg exists, so a tsvector
-- migration would silently destroy its purpose while looking like a clean optimization.
--
-- Caveat retained for whoever tunes this next: pg_trgm cannot serve a pattern shorter than
-- 3 chars, and the lexical tokenizer emits min-2-char tokens. A 2-char token in the OR
-- pre-filter is therefore not indexable and can push the planner back to a seq scan. That
-- is a correctness-preserving fallback (the pre-filter is logically equivalent to the score
-- filter either way) — never a wrong answer, only a slow one.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Field-weighted lexical match reads exactly these three payload fields (name ×3 >
-- description ×2 > data ×1), so index exactly these three expressions.
CREATE INDEX IF NOT EXISTS memory_canonical_payload_name_trgm
  ON harness_shared.memory_canonical
  USING gin ((payload ->> 'name') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS memory_canonical_payload_description_trgm
  ON harness_shared.memory_canonical
  USING gin ((payload ->> 'description') gin_trgm_ops);

CREATE INDEX IF NOT EXISTS memory_canonical_payload_data_trgm
  ON harness_shared.memory_canonical
  USING gin ((payload ->> 'data') gin_trgm_ops);
