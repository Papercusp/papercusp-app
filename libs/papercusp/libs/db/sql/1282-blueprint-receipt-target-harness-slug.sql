-- 1282 — blueprint operation receipts record the work-item STORAGE slug (WI-10004562,
-- plan blueprint-backed-work-item-execution-2026-09-23 D-045).
--
-- createWorkItem re-homes an item written for a pot MEMBER harness to the pot's home
-- slug (pot_membership_check_* on work_items). A receipt is keyed by the OPERATION
-- harness, so every receipt-to-item read that joined work_items on
-- receipt.harness_slug missed a pot member's item. The set-based program launch scan
-- (coord-program-workflow.ts findUnstartedAcceptedCoordPrograms) never found the root,
-- so a pot member's program operation stayed `accepted` forever.
--
-- Admission resolves the storage slug with the same resolver as the write path
-- (workItemStorageSlug) and records it here; readers address the item with
-- COALESCE(target_harness_slug, harness_slug). Expand-only: the column is nullable, so
-- a release that does not write it keeps working (its readers fall back to
-- harness_slug, today's behaviour).

ALTER TABLE harness_shared.blueprint_operation_invocations
  ADD COLUMN IF NOT EXISTS target_harness_slug text;

COMMENT ON COLUMN harness_shared.blueprint_operation_invocations.target_harness_slug IS
  'For target_kind=''work-item'': the harness_slug the target work item is STORED under '
  '(the pot home slug for a pot-member harness). NULL = stored under harness_slug.';

-- Backfill from the item each receipt already points at. Direct admission pins the
-- operation and specification revision on the item; scheduled admission pins the
-- receipt id. A receipt whose item cannot be matched stays NULL (today's behaviour).
UPDATE harness_shared.blueprint_operation_invocations AS i
   SET target_harness_slug = wi.harness_slug
  FROM harness_shared.work_items AS wi
 WHERE i.target_kind = 'work-item'
   AND i.target_harness_slug IS NULL
   AND i.target_ref IS NOT NULL
   AND wi.workspace_id = i.workspace_id
   AND wi.feature_id = i.target_ref
   AND (
         (wi.payload->'blueprintOperation'->>'operationId' = i.operation_id
          AND wi.payload->'blueprintOperation'->>'specificationRevision' = i.specification_revision)
      OR wi.payload->'_blueprintScheduled'->>'receiptId' = i.id::text
   );
