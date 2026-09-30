-- 914-goal-budget-window.sql
-- work-on-everything-goal-2026-08-23 P-004 — the rolling budget window.
--
-- WHY THIS EXISTS. `goals.budget_cents` is enforced, not merely reported:
-- `enforceGoalBreaches` (operator-core/lib/goals/spend-rollup.ts) compares it
-- against the goal's LIFETIME spend and, on reach, sets status='killed' and
-- fans the stop out through the shared goal-stop seam. That is right for an
-- outcome goal — it bounds a bet. It is fatal for a STANDING goal (P-001): a
-- goal pursuing an ongoing duty accrues spend forever, so lifetime spend
-- crosses ANY finite ceiling by construction. A standing goal under today's
-- rule is therefore not "budgeted" but scheduled for auto-kill, at a date set
-- by how expensive it happens to be.
--
-- WHAT IT DOES. Makes the ceiling's DENOMINATOR explicit. NULL (the default,
-- and every existing row) means "per goal lifetime" — exactly today's
-- behaviour, so this migration changes no live goal. A positive value means
-- the ceiling is spend-per-that-many-seconds, measured over a trailing window.
--
-- WHY SECONDS AND NOT DAYS. The spend legs already take a `sinceMs` bound
-- (`goalSpend`, `sessionSpendForGoal`), so a duration in seconds converts with
-- no unit table and no rounding decision; "weekly" is 604800 and reads as a
-- duration rather than a calendar concept. It is deliberately NOT a calendar
-- month/week boundary: a trailing window cannot be gamed by spending hard just
-- before a reset, and needs no timezone.
--
-- WHY NOT STANDING-ONLY. The column is independent of `standing` on purpose
-- (D-001: no bespoke rails). A window is a general property of a ceiling; a
-- standing goal is simply the case that REQUIRES one. Coupling them would mean
-- an ordinary long-running goal could not have a rolling budget, and that
-- `standing` would silently change what an unrelated column means.
--
-- NOT DESTRUCTIVE: adds a nullable column with no default backfill and no
-- constraint on existing rows, so the currently-deployed release — which never
-- reads it — keeps working unchanged. No FORWARD-COMPAT line is required.

ALTER TABLE harness_shared.goals
  ADD COLUMN IF NOT EXISTS budget_window_sec INTEGER;

COMMENT ON COLUMN harness_shared.goals.budget_window_sec IS
  'Denominator for budget_cents. NULL = the ceiling is per goal LIFETIME (default; '
  'the pre-P-004 behaviour). A positive value = the ceiling is spend per that many '
  'seconds, measured over a TRAILING window — required for standing goals, whose '
  'lifetime spend crosses any finite ceiling by construction. See '
  'work-on-everything-goal-2026-08-23 P-004.';

-- A zero or negative window is not a stricter budget, it is an undefined one:
-- a trailing window of length <= 0 selects no samples at all, so the ceiling
-- could never be reached and the control would silently stop existing. Refuse
-- it at the column rather than discovering it as a goal that never dies.
-- NOT VALID: the check applies to new writes immediately, and no existing row
-- can violate it (every one is NULL), so a full-table validation scan on a hot
-- table buys nothing. Validated in a later migration if that ever changes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'goals_budget_window_sec_positive'
       AND conrelid = 'harness_shared.goals'::regclass
  ) THEN
    ALTER TABLE harness_shared.goals
      ADD CONSTRAINT goals_budget_window_sec_positive
      CHECK (budget_window_sec IS NULL OR budget_window_sec > 0) NOT VALID;
  END IF;
END $$;
