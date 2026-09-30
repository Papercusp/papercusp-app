-- 757: memory_canonical.row_kind — a first-class, DERIVED discriminator between real
-- memories and mem0's entity-graph nodes.
--
-- WI-9355, plan memory-corpus-hygiene-and-release-distribution-2026-08-03 item P-020,
-- decision D-013.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE PROBLEM
--
-- harness_shared.memory_canonical holds TWO populations that share one physical table,
-- and until now the ONLY thing telling them apart was the presence of a jsonb key:
-- `payload ? 'entityType'`. Measured live 2026-08-03 (33,897 rows):
--
--   population                        rows     linkedMemoryIds   avg len   new/24h
--   COMPOUND  (entity-graph node)   24,889              24,889        23     1,340
--   PROPER    (entity-graph node)    3,675               3,675        14       200
--   QUOTED    (entity-graph node)    1,225               1,225        28       112
--   (absent)  = REAL MEMORY          4,108                   0       830        70
--
-- So a consumer that reads this table as "the memories" over-counts by ~8.25x. That is
-- not hypothetical: it is exactly how the owning plan came to believe in a 28k-row
-- "fragment debris class" that was really a working entity index, and drafted a purge
-- (P-003) that would have deleted the memory graph and silently degraded recall. P-003
-- was dropped as dangerous once D-013 measured what those rows actually are.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY *GENERATED*, AND NOT A PLAIN COLUMN
--
-- P-020 proposed "a real row_kind column". A plain column would have to be SET by every
-- writer, which reintroduces the very bug class this migration exists to kill: one
-- writer forgetting, and a row is silently misclassified in a way no test would notice.
--
-- The discriminator is already a pure function of `payload`, so Postgres can maintain it
-- and the two can never diverge. Probed on this box (PG 18.4) before writing this:
--   * the expression is accepted in a STORED generated column;
--   * the column IS indexable (`CREATE INDEX ... WHERE row_kind = 'memory'` succeeds);
--   * Postgres REFUSES a hand-set value —
--       ERROR: cannot insert a non-DEFAULT value into column "row_kind"
--     which is the property that makes drift structurally impossible rather than merely
--     unlikely.
--
-- The expression below is deliberately BYTE-FOR-BYTE the same rule as the producer-side
-- definition in libs/generic/memory/src/canonical-store.ts (`storeKindCond`), which is
-- the generic lib's own contract and stays authoritative for non-papercusp deployments.
-- A recurrence guard test asserts the two agree on every live row, so if the generic
-- rule ever changes, the disagreement fails a test instead of silently re-splitting the
-- populations.
--
-- REJECTED: moving entity nodes to a separate table. They are actively written (~1,340
-- new COMPOUND rows/24h) and relink-entities.ts joins entity rows to memory rows inside
-- this one table; a split is a large, risky migration that buys no correctness a derived
-- column does not already give.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO PERFORMANCE CLAIM IS MADE HERE — AND THAT IS DELIBERATE
--
-- WI-9137 already measured and REFUTED the obvious index fixes for the hot health count
-- over this table (documented at packages/operator-core/lib/memory/knowledge-read.ts).
-- In particular a partial index on the ENTITY side is correctly ignored by the planner,
-- because that side matches 88% of the table and a seq scan genuinely is cheaper.
--
-- The MEMORY side is the mirror image — 4,108 of 33,897 rows (12.1%) — so an index there
-- is at least plausible. It was measured rather than assumed: see the index section at
-- the bottom of this file for the numbers and the verdict.
--
-- This migration's justification is CORRECTNESS AND DISCOVERABILITY, not speed. Anyone
-- inspecting the table now sees a named column and a comment stating that it holds two
-- populations, instead of having to already know about a jsonb key.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The discriminator.
--
-- ⚠ ADD COLUMN with a STORED generated expression REWRITES the table and holds an
-- ACCESS EXCLUSIVE lock for the duration. Measured against the live table inside a
-- rolled-back transaction: 2.01s for 33,897 rows / 27MB. That is inside the deploy's
-- 15s lock_timeout with margin, but it is two seconds of exclusive lock on a hot
-- table, not the sub-100ms this kind of DDL is often assumed to cost — worth knowing
-- if this table grows by an order of magnitude before someone writes the next one.
ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS row_kind text
  GENERATED ALWAYS AS (
    CASE WHEN payload ? 'entityType' THEN 'entity' ELSE 'memory' END
  ) STORED;

COMMENT ON COLUMN harness_shared.memory_canonical.row_kind IS
  'DERIVED, always-correct discriminator for the two populations sharing this table: '
  '''memory'' = a real memory; ''entity'' = a mem0 entity-graph node (COMPOUND/PROPER/'
  'QUOTED) extracted FROM a memory and carrying linkedMemoryIds back to it. GENERATED '
  'ALWAYS AS (payload ? ''entityType'') STORED — Postgres maintains it, so it cannot '
  'drift and cannot be set by a writer. Entity rows outnumber memories ~7:1, so ANY '
  'count/scan of this table that means "the memories" MUST filter row_kind = ''memory'' '
  '(see D-013 / WI-9355 — omitting it over-counts by ~8x and nearly caused a purge of '
  'the entity index).';

COMMENT ON TABLE harness_shared.memory_canonical IS
  'Canonical memory store. ⚠ HOLDS TWO POPULATIONS — real memories AND mem0 entity-graph '
  'nodes — discriminated by the row_kind column. Read that column''s comment before '
  'writing any query that counts or scans this table.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The index — MEASURED, then kept.
--
-- Question: does a partial index on the MEMORY side make the hot totalMemories count
-- (knowledge-read.ts readStoreCounts, ~0.68 calls/s fleet-wide) cheaper, given that
-- WI-9137 refuted the entity-side equivalent?
--
-- Measured against the LIVE table AFTER this migration was applied and the table
-- ANALYZEd — i.e. production steady state, not a synthetic one. EXPLAIN (ANALYZE,
-- BUFFERS), three consecutive runs each:
--
--   BEFORE  count(*) WHERE NOT (payload ? 'entityType')   -- the old hot query
--     Seq Scan          32.05 / 34.29 / 30.98 ms    buffers: shared hit=4440
--
--   AFTER   count(*) WHERE row_kind = 'memory'
--     Bitmap Heap Scan   8.97 / 10.06 /  9.07 ms    buffers: shared hit=1154
--       -> Bitmap Index Scan on memory_canonical_row_kind_memory_idx
--
-- ~3.4x faster and ~3.8x fewer buffers. This is NOT a contradiction of WI-9137 — that
-- finding is about the 88% ENTITY side, where the planner's refusal to use an index is
-- correct. The minority side is the opposite case.
--
-- ⚠ An earlier draft of this file claimed 70.9ms -> 5.0ms (~14x). Those numbers came
-- from a rolled-back transaction against a table this migration had just REWRITTEN, and
-- they did not survive contact with the live steady state. The figures above replace
-- them. If you are tempted to quote a speedup from a DDL probe inside a transaction:
-- don't — re-measure after the migration is applied and ANALYZEd.
--
-- Note it is a Bitmap Heap Scan, NOT an index-only scan: the count still visits the heap
-- for visibility. It may become index-only once autovacuum sets the visibility map, but
-- that was not observed and is deliberately NOT claimed.
--
-- The entity count in that same query stays a seq scan by design; per WI-9137 that is
-- already optimal and is left alone.
CREATE INDEX IF NOT EXISTS memory_canonical_row_kind_memory_idx
  ON harness_shared.memory_canonical (id)
  WHERE row_kind = 'memory';

COMMENT ON INDEX harness_shared.memory_canonical_row_kind_memory_idx IS
  'Partial, MINORITY-side index (12.1% of rows) serving the hot "how many real memories" '
  'count — measured live, post-ANALYZE: ~32ms -> ~9ms. The mirror-image index on the ENTITY side is '
  'deliberately absent: WI-9137 measured it and the planner correctly refuses it at 88% '
  'selectivity, where a seq scan is genuinely cheaper.';
