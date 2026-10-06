-- WI-10005969: exact submicro amounts on the existing receipt and roll-up rail.
-- Unconstrained NUMERIC is intentional: NUMERIC(p,s) rounds on assignment.
-- These are lossless widenings; journal cents remain integers and the existing
-- tenant FK, source/null, append-only, permissions and roll-up identity survive.
ALTER TABLE papercusp_auth.hosted_usage_receipts
  ALTER COLUMN cost_micros TYPE numeric USING cost_micros::numeric;
ALTER TABLE harness_shared.money_journal_rollups
  ALTER COLUMN total_micros TYPE numeric USING total_micros::numeric,
  ALTER COLUMN rounding_micros TYPE numeric USING rounding_micros::numeric;
ALTER TABLE harness_shared.money_journal_micro_accruals
  ALTER COLUMN micros TYPE numeric USING micros::numeric;
DO $guard$
BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_usage_receipts_decimal_precision'
               AND conrelid = 'papercusp_auth.hosted_usage_receipts'::regclass) THEN
  ALTER TABLE papercusp_auth.hosted_usage_receipts
  ADD CONSTRAINT hosted_usage_receipts_decimal_precision
  CHECK (cost_micros IS NULL OR (cost_micros >= 0 AND cost_micros <= 9007199254740991 AND scale(cost_micros) <= 324));
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_journal_rollups_decimal_precision'
               AND conrelid = 'harness_shared.money_journal_rollups'::regclass) THEN
  ALTER TABLE harness_shared.money_journal_rollups
  ADD CONSTRAINT money_journal_rollups_decimal_precision
  CHECK (total_micros BETWEEN 0 AND 9007199254740991 AND scale(total_micros) <= 324
     AND rounding_micros BETWEEN 0 AND 9007199254740991 AND scale(rounding_micros) <= 324);
END IF;
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'money_journal_micro_accruals_decimal_precision'
               AND conrelid = 'harness_shared.money_journal_micro_accruals'::regclass) THEN
  ALTER TABLE harness_shared.money_journal_micro_accruals
  ADD CONSTRAINT money_journal_micro_accruals_decimal_precision
  CHECK (micros > 0 AND micros <= 9007199254740991 AND scale(micros) <= 324);
END IF;
END;
$guard$;
