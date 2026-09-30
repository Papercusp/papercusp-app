-- 1049-plan-status-awaiting-acceptance.sql
-- P-004 of deterministic-plan-state-derivation-2026-08-31.
--
-- Admit `awaiting-acceptance` into the plan lifecycle vocabulary: the state
-- between "every item is terminal" and "shipped", where implementation has
-- landed but the code-truth audit and independent acceptance grading have not
-- been done.
--
-- WHY THE VOCABULARY NEEDED A SIXTH VALUE. Nothing recomputed `status` when a
-- plan's last non-terminal item went terminal, and there was no value meaning
-- "drained but not shipped", so a finished plan kept sitting at `ready`/`active`
-- and advertising work that no longer existed. Measured over the whole corpus
-- (plan decision D-004 point 7): 227 live plans held a live status with every
-- structured item terminal. A reaction rule on `plans:set-status`
-- (plan-items/plan-drain-rule.ts) now moves them, and `plans:get` reports any
-- residual disagreement.
--
-- It is deliberately NOT terminal: `TERMINAL_PLAN_STATUSES` stays
-- ('shipped','superseded'). A plan awaiting grading is not finished, and
-- treating it as terminal would let it skip the gate this status exists to
-- route it into. Nothing auto-advances it to `shipped` — that requires the
-- audit and independent grading the ship gate demands, which no item status can
-- evidence.
--
-- FORWARD-COMPAT: this is a pure WIDENING of an existing CHECK, so the release
-- currently serving :3070 cannot be broken by it. Every row that satisfied the
-- old constraint satisfies the new one (the accepted set only grows), so no
-- existing data is invalidated; and the older release never WRITES
-- 'awaiting-acceptance', because the only writer is the new rule shipping in
-- this same change. The DROP is of the constraint this migration immediately
-- re-creates in the same transaction, not of a constraint the live code
-- depends on. Rows carrying the new value only begin to exist once the new
-- release is deployed, and the old release reads `status` as free text.

-- LOCK DISCIPLINE. `harness_plans` is one of the hottest tables in the system
-- (every agent's plan read/write touches it), and the first version of this
-- migration — a plain DROP + ADD — exhausted all five lock_timeout retries
-- without ever acquiring ACCESS EXCLUSIVE. A plain ADD CONSTRAINT also SCANS
-- the whole table to validate, holding that lock for the duration.
--
-- `NOT VALID` splits it: the DROP and the ADD are catalog-only updates that
-- hold ACCESS EXCLUSIVE for microseconds, and VALIDATE CONSTRAINT then does the
-- scan under SHARE UPDATE EXCLUSIVE, which does NOT block reads or writes.
-- `NOT VALID` never weakens the constraint for NEW rows — it only skips the
-- initial check of existing ones, and here that check cannot fail anyway: this
-- is a pure widening, so every row satisfying the old constraint satisfies the
-- new one by construction. VALIDATE is run in the same migration so the
-- constraint does not linger in the not-validated state.
ALTER TABLE harness_shared.harness_plans
  DROP CONSTRAINT IF EXISTS harness_plans_status_check;

ALTER TABLE harness_shared.harness_plans
  ADD CONSTRAINT harness_plans_status_check
  CHECK (
    (status IS NULL)
    OR (status = ANY (ARRAY[
      'draft'::text,
      'ready'::text,
      'active'::text,
      'awaiting-acceptance'::text,
      'shipped'::text,
      'superseded'::text
    ]))
  ) NOT VALID;

ALTER TABLE harness_shared.harness_plans
  VALIDATE CONSTRAINT harness_plans_status_check;

COMMENT ON CONSTRAINT harness_plans_status_check ON harness_shared.harness_plans IS
  'Plan lifecycle vocabulary. Mirrors PLAN_STATUSES in libs/generic/plan-parser/src/parser.ts — '
  'the two must be changed together. `active` is legacy (set-plan-status.ts maps it to `ready`) '
  'and survives only on existing rows. `awaiting-acceptance` (P-004) means every item is terminal '
  'but acceptance has not been concluded; it is NOT terminal, and nothing auto-advances it to '
  'shipped.';
