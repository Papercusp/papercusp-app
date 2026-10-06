-- 1312-memory-canonical-hot-surfaced-bump.sql
--
-- Plan papercusp-log-performance-remediation-2026-09-23, P-015(d), WI-10005005.
-- Make the memory_canonical.last_surfaced_at bump a HOT update.
--
-- Measured 2026-10-01 (pg_stat_statements since the 2026-09-29 reset): the bump
--   UPDATE harness_shared.memory_canonical SET last_surfaced_at = now() WHERE id = ANY($1::uuid[])
-- ran 99,892 times and wrote 5.68 GB of WAL, about 29 kB per row for rows that
-- average 409 bytes. Only 53 of the table's 200,437 updates were HOT.
--
-- Cause: the bumped column is covered by memory_canonical_recently_surfaced_idx
-- (archive/085-memory-audit-columns.sql). PostgreSQL never does a HOT update when
-- an indexed column changes, so every bump wrote a new heap tuple plus a fresh
-- entry in all 8 indexes on the table, including the trigram GIN index over
-- payload->>'data'.
--
-- The index serves no query. Nothing orders or range-scans by last_surfaced_at.
-- The only filter on it is recentlySurfacedIds()
-- (packages/operator-core/lib/memory/bump-last-surfaced.ts), which looks rows up
-- by id = ANY(...) and is served by the primary key. The "Layer 3 picker" the
-- index was created for was never built.
--
-- fillfactor 90 leaves free space on each heap page, so a bumped row's new
-- version can stay on the same page (a HOT update needs that). It applies to
-- pages written from now on; existing pages gain room as old versions are pruned.
--
-- Recurrence guard: packages/operator-core/lib/memory/bump-last-surfaced-hot.integration.test.ts
-- fails if any index on memory_canonical covers last_surfaced_at again, or if the
-- real bump statement stops being a HOT update.
--
-- FORWARD-COMPAT: the release still serving on :3070 never relies on this index for correctness, because none of its queries orders or range-scans by last_surfaced_at and its one filter on the column (recentlySurfacedIds) is answered through the primary key, so dropping the index changes only the planner's choice of path.

DROP INDEX IF EXISTS harness_shared.memory_canonical_recently_surfaced_idx;

ALTER TABLE harness_shared.memory_canonical SET (fillfactor = 90);
