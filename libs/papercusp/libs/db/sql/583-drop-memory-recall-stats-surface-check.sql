-- 583-drop-memory-recall-stats-surface-check.sql
--
-- memory-delivery-unification-2026-07-12 P-005 (D-006) FIX.
--
-- The `surface` column of harness_shared.memory_recall_stats is FREE-TEXT by
-- design: each per-entry-point injection PORT records under its own label
-- (initialize / compact / turn-start / brief / orient / claim / create), and
-- the RecallSurface union in recall-stats.ts is DOCUMENTATION, not a DB
-- constraint — "adding a port needs no migration, just a member there".
--
-- But the original table (migration 240) shipped a CHECK constraint pinning
-- surface to ('search','injection'). P-005 added the new port labels in code
-- but never dropped that CHECK, so EVERY new-port write silently violated
-- `memory_recall_stats_surface_check` and was swallowed by recordRecallStats'
-- fire-and-forget catch — per-port telemetry recorded nothing. (The P-005 unit
-- test mocks `sql`, so it never exercised the real constraint; a real-DB
-- integration test now guards this class — recall-stats-surface.integration.test.ts.)
--
-- Fix: drop the CHECK so the column is genuinely free-text, matching the
-- documented design. Instant (no table rewrite), reversible, and no existing
-- row violates anything. Idempotent.

ALTER TABLE harness_shared.memory_recall_stats
  DROP CONSTRAINT IF EXISTS memory_recall_stats_surface_check;
