-- 1110 — WI-7102: keep the two top-level issue-admission flags off the JSONB hot path.
--
-- `issueAdmissibleWhereSql` filters every candidate exposed by work_items:list's
-- `admissibleOnly` path. Two of its row-intrinsic floors were still written as
-- separate payload expressions:
--
--   payload ->> '_claimHold'        IS DISTINCT FROM 'true'
--   payload ->> 'needsOwnerAction'  IS DISTINCT FROM 'true'
--
-- `payload` is commonly TOASTed. Each expression can therefore fetch and decompress the
-- whole JSONB datum even though the predicate needs one boolean. Migration 721 removed the
-- same cost for payload.lane with a STORED generated column; this migration applies that
-- proven shape to the two current typed flags. The original filing called the second key
-- `needsHuman`, but migration 864 retired that ambiguous key from admission. The live writer
-- and reader contract is `needsOwnerAction`; legacy `needsHuman:true` remains admissible.
--
-- WHY GENERATED. Every writer continues to mutate payload, while Postgres maintains the
-- physical booleans. A backfill plus trigger would create a second write contract that can
-- drift. Text comparison is deliberate: it preserves the old `->> ... = 'true'` semantics
-- for both JSON boolean true and the legacy JSON string "true"; false, missing and NULL all
-- remain admitted through `IS DISTINCT FROM TRUE`.
--
-- LOCK COST / ORDER. Adding STORED columns rewrites the table under ACCESS EXCLUSIVE. As in
-- migration 721, lock the view before its base table because readers acquire them in that
-- order. Taking both locks up front prevents the view↔table inversion deadlock measured on
-- 721. The two columns share one table rewrite when added by the same ALTER TABLE.

LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS claim_hold boolean
    GENERATED ALWAYS AS ((payload ->> '_claimHold') = 'true') STORED,
  ADD COLUMN IF NOT EXISTS needs_owner_action boolean
    GENERATED ALWAYS AS ((payload ->> 'needsOwnerAction') = 'true') STORED;

COMMENT ON COLUMN harness_shared.work_items.claim_hold IS
  'WI-7102: materialised payload._claimHold for admission reads. GENERATED ALWAYS; write payload._claimHold.';
COMMENT ON COLUMN harness_shared.work_items.needs_owner_action IS
  'WI-7102: materialised payload.needsOwnerAction for admission reads. GENERATED ALWAYS; write payload.needsOwnerAction.';

-- Append whichever columns the installed view does not yet expose. Patch the LIVE view
-- definition rather than re-stating its long, migration-accumulated select list. A guarded
-- tail anchor makes a changed view shape fail loudly instead of silently reverting columns.
DO $mig1110_view$
DECLARE
  def       text;
  patched   text;
  additions text := '';
  anchor    CONSTANT text := E'\n   FROM harness_shared.work_items';
  hits      integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'engineer_issues'
       AND column_name = 'claim_hold'
  ) THEN
    additions := additions || E',\n    claim_hold';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'engineer_issues'
       AND column_name = 'needs_owner_action'
  ) THEN
    additions := additions || E',\n    needs_owner_action';
  END IF;

  IF additions = '' THEN
    RAISE NOTICE '1110: engineer_issues already exposes both generated admission flags — view no-op';
    RETURN;
  END IF;

  SELECT pg_get_viewdef(c.oid)
    INTO def
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'harness_shared'
     AND c.relname = 'engineer_issues';

  IF def IS NULL THEN
    RAISE EXCEPTION '1110: harness_shared.engineer_issues view not found';
  END IF;

  hits := (length(def) - length(replace(def, anchor, ''))) / length(anchor);
  IF hits <> 1 THEN
    RAISE EXCEPTION
      '1110: expected exactly one work_items view tail anchor, found %; re-derive the view patch instead of forcing it',
      hits;
  END IF;

  patched := replace(def, anchor, additions || anchor);
  EXECUTE format('CREATE OR REPLACE VIEW harness_shared.engineer_issues AS %s', patched);
END
$mig1110_view$;

-- Structural and semantic post-conditions. These checks make an idempotent re-run verify the
-- installed state instead of treating IF NOT EXISTS as proof that the pre-existing columns
-- have the right generation contract.
DO $mig1110_check$
DECLARE
  generated_count integer;
  base_mismatches bigint;
  view_mismatches bigint;
BEGIN
  SELECT count(*)::int
    INTO generated_count
    FROM information_schema.columns
   WHERE table_schema = 'harness_shared'
     AND table_name = 'work_items'
     AND column_name IN ('claim_hold', 'needs_owner_action')
     AND data_type = 'boolean'
     AND is_generated = 'ALWAYS';

  IF generated_count <> 2 THEN
    RAISE EXCEPTION
      '1110: expected two boolean ALWAYS-generated work_items columns, found %',
      generated_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'harness_shared'
       AND table_name = 'engineer_issues'
       AND column_name IN ('claim_hold', 'needs_owner_action')
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION
      '1110: engineer_issues does not expose both generated admission flags';
  END IF;

  SELECT count(*)
    INTO base_mismatches
    FROM harness_shared.work_items
   WHERE claim_hold IS DISTINCT FROM ((payload ->> '_claimHold') = 'true')
      OR needs_owner_action IS DISTINCT FROM ((payload ->> 'needsOwnerAction') = 'true');

  IF base_mismatches <> 0 THEN
    RAISE EXCEPTION
      '1110: % work_items rows disagree with the payload-derived admission flags',
      base_mismatches;
  END IF;

  SELECT count(*)
    INTO view_mismatches
    FROM harness_shared.engineer_issues
   WHERE claim_hold IS DISTINCT FROM ((payload ->> '_claimHold') = 'true')
      OR needs_owner_action IS DISTINCT FROM ((payload ->> 'needsOwnerAction') = 'true');

  IF view_mismatches <> 0 THEN
    RAISE EXCEPTION
      '1110: % engineer_issues rows disagree with their payload-derived admission flags',
      view_mismatches;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'harness_shared'
       AND c.relname = 'engineer_issues'
       AND t.tgname = 'engineer_issues_view_dml_trg'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION
      '1110: engineer_issues INSTEAD OF DML trigger disappeared during view replacement';
  END IF;
END
$mig1110_check$;
