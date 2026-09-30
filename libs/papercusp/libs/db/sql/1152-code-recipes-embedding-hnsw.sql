-- 1152-code-recipes-embedding-hnsw.sql
--
-- Add the missing ANN index on `harness_shared.code_recipes.embedding`.
--
-- THE GAP. A survey of every live pgvector column in this database (2026-09-12)
-- found 22 vector columns, of which 21 carry an HNSW index and exactly ONE does
-- not: `code_recipes.embedding`, at 20,425 rows -- larger than seven of the
-- columns that DO have one (doc_sections at 14.2k, carry_notes at 19.6k, and
-- every harness_plans / harness_docs / consult_state / harness_decisions column
-- at <=1.9k). Nothing distinguishes it; it is an omission, not a decision.
--
-- WHAT IT COSTS. Both readers ORDER BY cosine distance over the whole table:
-- `code-recipes-search.ts:95` (the recipes:search vector leg, one call per
-- multi-step code:run authoring decision) and
-- `harness/routines/loop-wake-recipe.ts:120,125` (fired per loop wake). With no
-- index each is an exact k-NN scan: 20,425 rows x 768 dims read and distanced
-- per query. `recipes:search` sits directly in front of code:run, so this is on
-- an agent-interactive path, not a batch one.
--
-- WHY vector_cosine_ops. Both call sites use the cosine-distance operator `<=>`
-- and report `1 - (embedding <=> qVec)` as similarity. An HNSW index is only
-- usable by a query whose operator matches its ops class, so an l2 or ip index
-- here would build, occupy disk, and never be chosen -- the failure mode that
-- looks exactly like "the index did not help". Cosine also matches every other
-- ANN index in this database: all 21 are `USING hnsw (... vector_cosine_ops)`,
-- with no IVFFlat anywhere.
--
-- WHY NOT PARTIAL. Measured at write time: 20,425 of 20,425 rows have a
-- non-NULL embedding. There is no unembedded minority to exclude, so a partial
-- index (the shape migration 1093 needed for memory_vec_*) would buy nothing and
-- would only add a predicate the planner must match.
--
-- NO `CONCURRENTLY`. The migration runner wraps each file in a transaction and
-- `CREATE INDEX CONCURRENTLY` cannot run inside one. This build therefore holds a
-- write lock on code_recipes for its duration -- acceptable at this size (the
-- comparable 19.6k-row carry_notes index is a few seconds), and code_recipes is
-- written by recipe authoring, not a hot write path.
--
-- FORWARD-COMPAT: not required -- this migration is purely additive (one CREATE
-- INDEX, no DROP / RENAME / SET NOT NULL / partial UNIQUE), so the older release
-- still serving :3070 is unaffected: its existing queries simply gain a usable
-- index, and nothing it reads or writes changes shape.
--
-- Idempotent. No BEGIN/COMMIT -- the runner wraps each migration in its own
-- transaction (lint-migrations.test.ts fails the release gate on explicit
-- transaction control).

\set ON_ERROR_STOP on

CREATE INDEX IF NOT EXISTS code_recipes_embedding_hnsw_idx
  ON harness_shared.code_recipes USING hnsw (embedding public.vector_cosine_ops);

COMMENT ON INDEX harness_shared.code_recipes_embedding_hnsw_idx IS
  'Cosine ANN index for the recipes:search vector leg (code-recipes-search.ts) and the loop-wake recipe lookup (harness/routines/loop-wake-recipe.ts), both of which ORDER BY `embedding <=> qVec`. Added by migration 1152: code_recipes was the only vector column in the database without an ANN index, at 20,425 rows, so every recipe search was an exact k-NN scan.';
