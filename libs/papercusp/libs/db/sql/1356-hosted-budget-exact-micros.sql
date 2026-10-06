-- EI-24963575607470324: extend the existing reservation receipt rail.
-- Lossless BIGINT -> unconstrained NUMERIC widening; a fixed scale rounds on
-- assignment. Integer admissions/provider maxima, scope FK, immutable history,
-- source/finality and service-only permissions retain their original contract.
ALTER TABLE papercusp_auth.hosted_budget_receipts
  ALTER COLUMN cost_micros TYPE numeric USING cost_micros::numeric;
DO $guard$
BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hosted_budget_receipts_decimal_precision'
               AND conrelid = 'papercusp_auth.hosted_budget_receipts'::regclass) THEN
  ALTER TABLE papercusp_auth.hosted_budget_receipts
  ADD CONSTRAINT hosted_budget_receipts_decimal_precision
  CHECK (cost_micros IS NULL OR (cost_micros >= 0 AND cost_micros <= 9007199254740991 AND scale(cost_micros) <= 324));
END IF;
END;
$guard$;
