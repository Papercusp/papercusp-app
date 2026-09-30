-- Migration 485 — per-bee release-cooldown provenance on work items.
--
-- Plan: fleet-scheduler-hardening-2026-07-03 P-005 (EI-6956 ping-pong).
--
-- A bee that voluntarily releases a work-item could immediately re-claim the SAME
-- item on its very next scheduler:get_next / work_items:claim_next pull (release
-- resets the row to `todo`, and under a stable rank the released row often sorts
-- right back to the top for the releasing bee) — the observed claim/release
-- ping-pong that burned member turns during the 2026-07-03 backlog-clearance run.
--
-- The claim lease row (work_item_claims) is DELETEd on release, so no durable
-- "recently released by X" record existed. These two columns capture release
-- provenance ON the row itself, in the same UPDATE that frees it
-- (releaseWorkItem: `last_released_by = taken_by` reads the OLD row value); the
-- shared claim floors (claimFloorsWhereSql) then exclude the row FOR THE RELEASING
-- BEE ONLY for a short cooldown window (PAPERCUSP_RELEASE_COOLDOWN_SEC, default
-- 300s) — every other bee can claim it instantly.
--
-- Base table + view re-expansion mirror mig 432 (work_items is the true base;
-- harness_features_consolidated is its feature-family SELECT * view).
--
-- The migration runner wraps each file in its own txn — NO top-level
-- BEGIN;/COMMIT; (lint:migrations, files >= 215).

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS last_released_by text,
  ADD COLUMN IF NOT EXISTS last_released_at timestamptz;

COMMENT ON COLUMN harness_shared.work_items.last_released_by IS
  'ownerId of the agent whose voluntary release last freed this row (release-cooldown floor, mig 485 / EI-6956). NULL until first released.';
COMMENT ON COLUMN harness_shared.work_items.last_released_at IS
  'when that voluntary release happened — the claim floors exclude the row for last_released_by only, for a short cooldown window.';

-- Re-expand `SELECT *` to pick up the two new trailing columns (additive; the
-- view's existing column list/order for everything else is preserved).
CREATE OR REPLACE VIEW harness_shared.harness_features_consolidated AS
  SELECT * FROM harness_shared.work_items
  WHERE item_kind NOT IN ('bug', 'change', 'task')
  WITH CASCADED CHECK OPTION;
