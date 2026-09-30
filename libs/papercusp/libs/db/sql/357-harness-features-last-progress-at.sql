-- 357-harness-features-last-progress-at.sql
-- agent-activity-liveness-truth-2026-06-21 · P-001 (D-001/D-004).
--
-- THE MISSING THIRD SIGNAL. "Who's doing what" was answered from a claim
-- (taken_by — a RESERVATION) + the holder's presence heartbeat (proves the
-- PROCESS is alive) — neither proves the WORK is advancing. A claim or a
-- "bee spawned for X" broadcast was treated as proof of work; it is not. On
-- 2026-06-21 a green-gate-fix bee DIED seconds after being spawned, yet every
-- reader (the Queen's placement, idle su agents, the coordinator) read the
-- stale "bee is on it" signal as "actively worked" for ~1 hour, so the gate sat
-- RED + unowned and blocked all deploys.
--
-- last_progress_at is bumped ONLY on REAL item-scoped work (a state transition
-- via setWorkItemState, or a checkpoint write) — NEVER on a bare presence
-- heartbeat or a lease keepalive (the existing work_item_claims.last_activity_ts
-- is a keepalive, bumped on every heartbeat, so it is NOT a clean progress
-- signal — exactly D-001's point). The classifier classifyItemActivity()
-- (packages/operator-core/lib/item-activity.ts) derives
-- free|reserved|alive|progressing|stalled|dead from (taken_by, taken_at,
-- last_progress_at, holderAlive); "actively worked" ≡ holder alive AND
-- progressing within the STALE_MS (10-min) liveness window.
--
-- Additive + nullable: a NULL last_progress_at on an existing claimed row means
-- "no item-scoped progress recorded yet" — the classifier falls back to
-- taken_at for the grace window, so old rows are not spuriously read as stalled
-- before they get a chance to progress.

ALTER TABLE harness_shared.harness_features_consolidated
  ADD COLUMN IF NOT EXISTS last_progress_at timestamptz;

-- Partial index for the reconciler / fleet_assignment `stalled` leg (P-002/P-003):
-- the only rows that query last_progress_at are CLAIMED ones ("is this held item
-- progressing or stalled?"). Keeping it partial (taken_by IS NOT NULL) keeps it
-- tiny — the vast majority of the 667-row table is unclaimed/terminal.
CREATE INDEX IF NOT EXISTS harness_features_consolidated_claimed_progress_idx
  ON harness_shared.harness_features_consolidated (harness_slug, last_progress_at)
  WHERE taken_by IS NOT NULL AND taken_by <> '';
