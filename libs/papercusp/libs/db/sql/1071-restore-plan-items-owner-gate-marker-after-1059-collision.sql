-- 1071-restore-plan-items-owner-gate-marker-after-1059-collision.sql
-- EI-22047964645713562
--
-- The persisted owner-gate marker writer landed in plan-index-rows.ts, and the
-- live database carries this column, but the canonical migration corpus does
-- not. The migration reservation ledger records an already-applied
-- 1059-plan-items-owner-gate-marker.sql; canonical staging later acquired a
-- different 1059-plan-assignment-claim-floor.sql. A clean empty-to-head build
-- therefore omits the column and fails the first plan write with 42703.
--
-- Repair forward instead of rewriting either applied 1059 body. IF NOT EXISTS
-- makes this a no-op on installations that received the original owner-marker
-- migration and an additive repair everywhere else.

ALTER TABLE harness_shared.plan_items
  ADD COLUMN IF NOT EXISTS owner_gate_marker text;

COMMENT ON COLUMN harness_shared.plan_items.owner_gate_marker IS
  'Derived owner-gate marker parsed from canonical harness_plans.content. Recomputed by the plan index writer; NULL means no owner gate is declared for the item.';
