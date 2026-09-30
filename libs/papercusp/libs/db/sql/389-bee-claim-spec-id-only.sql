-- 389: bee_claim_specs.id_only — the id-pin observability tripwire (claim-spec id-filter, 2026).
--
-- WHY: the claim-spec vocabulary now allows `view.filter: { field:'id', op:'in', value:[...] }` —
-- a STATIC pin of a fixed work-item set, the intended exception for a hotfix / cutover / re-drive
-- wave (it forfeits auto-inflow + work-stealing, so it is the wrong tool for a standing lane). A
-- Queen who pins by id for ONGOING work has quietly fallen back to hand-listing items (the old
-- `tasks` habit). This column denormalizes `isIdOnlySelector(spec)` per stored spec so over-reliance
-- is a one-line COUNT (`SELECT count(*) FROM bee_claim_specs WHERE id_only`) rather than a jsonb
-- scan — keeping the describe-by-property discipline visible. setClaimSpec writes it on every upsert.
--
-- Idempotent across BOTH schema eras:
--   * fresh/pre-555 databases still have the bee_claim_specs base table;
--   * a database that skipped this migration but already applied migration 555 has
--     cup_claim_specs as the base table and bee_claim_specs as a compatibility view.
--
-- The second shape is not theoretical. The r22 workspace-host package accidentally
-- pruned migration filenames containing "spec", then r24 restored the complete set.
-- On that persisted database, blindly altering the compatibility view fails with
-- SQLSTATE 42809 before the host can serve. Add the column to whichever BASE table
-- exists and refresh the compatibility view so its frozen SELECT * column list also
-- exposes id_only.

DO $$
DECLARE
  bee_kind "char";
  cup_kind "char";
BEGIN
  SELECT c.relkind
    INTO bee_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'harness_shared' AND c.relname = 'bee_claim_specs';

  SELECT c.relkind
    INTO cup_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'harness_shared' AND c.relname = 'cup_claim_specs';

  IF bee_kind IN ('r', 'p') THEN
    ALTER TABLE harness_shared.bee_claim_specs
      ADD COLUMN IF NOT EXISTS id_only boolean NOT NULL DEFAULT false;
  ELSIF cup_kind IN ('r', 'p') THEN
    ALTER TABLE harness_shared.cup_claim_specs
      ADD COLUMN IF NOT EXISTS id_only boolean NOT NULL DEFAULT false;

    IF bee_kind = 'v' THEN
      CREATE OR REPLACE VIEW harness_shared.bee_claim_specs AS
        SELECT * FROM harness_shared.cup_claim_specs;
    END IF;
  ELSE
    RAISE EXCEPTION
      'migration 389 requires bee_claim_specs or cup_claim_specs to be a base table (bee relkind %, cup relkind %)',
      bee_kind,
      cup_kind;
  END IF;
END $$;
