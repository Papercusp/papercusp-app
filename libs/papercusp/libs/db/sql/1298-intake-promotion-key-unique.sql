-- 1298 — at most one work item per intake promotion key
-- (observation-candidate-acceptance-promotion-2026-09-30 P-006, WI-10004569).
--
-- Executing an intake promote/investigate decision stamps the receipt
-- payload.intakePromotion = { key: 'intake-exec:<sourceId>:<sourceRevision>', ... }
-- on exactly one row: the candidate itself (promoted in place) or the one
-- distinct item created for it. This index makes that "exactly one" a database
-- guarantee instead of a property of the executor's advisory lock: a double
-- accept, an overlapping run or a retry racing a slow first attempt gets a
-- unique violation, and the executor converges on the row that already carries
-- the key (intake-promotion.ts). A second writer that never takes the lock
-- cannot create duplicate work either.
--
-- Partial (only rows that carry a receipt), so it costs nothing for the rest of
-- work_items and never constrains a row written by any other path.

-- FORWARD-COMPAT: the currently deployed release never writes payload.intakePromotion (it is introduced by P-006 in this same change), so no live writer can violate this partial unique index; it only constrains rows written by the new executor.
CREATE UNIQUE INDEX IF NOT EXISTS work_items_intake_promotion_key_uniq
  ON harness_shared.work_items ((payload -> 'intakePromotion' ->> 'key'))
  WHERE payload ? 'intakePromotion';

COMMENT ON INDEX harness_shared.work_items_intake_promotion_key_uniq IS
  'P-006: one row per intake promotion key (intake-exec:<sourceId>:<sourceRevision>). '
  'The executor converges on the existing row on a unique violation.';
