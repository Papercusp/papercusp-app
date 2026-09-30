-- Migration 050 — also auto-compute needs_design when writers INSERT
-- directly into harness_features_consolidated (instead of going through
-- the per-harness table + sync trigger).
--
-- Migration 049 wired the heuristic into sync_features_consolidated(),
-- but per-harness tables are mostly views post-migration 032 and most
-- writers now target consolidated directly. So 049 alone misses the
-- common case.
--
-- This BEFORE INSERT trigger on consolidated fills needs_design when
-- the writer left it false/NULL. Writers that compute their own value
-- (e.g. via apps/operator/lib/design-phase.ts) keep theirs intact.
--
-- Idempotent.

\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION harness_shared.fill_needs_design()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.needs_design IS NULL OR NEW.needs_design = FALSE THEN
    NEW.needs_design := harness_shared.compute_needs_design(NEW.title, NEW.summary);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fill_needs_design_trg
  ON harness_shared.harness_features_consolidated;

CREATE TRIGGER fill_needs_design_trg
  BEFORE INSERT ON harness_shared.harness_features_consolidated
  FOR EACH ROW
  EXECUTE FUNCTION harness_shared.fill_needs_design();

COMMIT;
