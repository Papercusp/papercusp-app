-- 987-bulk-review-owner-dismissed-outcome.sql
-- Distinguish a resolver's `skipped` verdict from the owner's deliberate
-- dismissal. A skipped row remains unresolved/retryable; only `dismissed`
-- records that the owner reviewed it and chose to close it.

ALTER TABLE harness_shared.attention_bulk_run_items
  DROP CONSTRAINT IF EXISTS attention_bulk_run_items_outcome_check;

ALTER TABLE harness_shared.attention_bulk_run_items
  ADD CONSTRAINT attention_bulk_run_items_outcome_check
  CHECK (outcome IN ('pending', 'auto_resolved', 'recommended', 'skipped', 'failed', 'dismissed'));
