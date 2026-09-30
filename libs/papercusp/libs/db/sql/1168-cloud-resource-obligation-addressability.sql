-- 1168-cloud-resource-obligation-addressability.sql — WI-10001673.
--
-- WHY THIS EXISTS
-- ----------------
-- Migration 1040 made the teardown obligation a ROW instead of a paragraph. It recorded
-- WHAT is owed (provider, kind, name) but not WHERE the resource lives — and GCP deletes
-- are ADDRESSED, not merely named:
--
--   delete-instance / delete-disk        -> projectId + ZONE   + resourceName + hostId
--   delete-subnetwork / delete-router    -> projectId + REGION + resourceName + hostId
--   delete-nat                           -> projectId + REGION + ROUTER NAME + resourceName + hostId
--   delete-network / delete-firewall     -> projectId +          resourceName + hostId   (global)
--
-- (the single delete member of `GcpStepInput` in
-- packages/operator-core/lib/workspace-host/gcp-provider.ts).
--
-- So from a 1040-shaped row, ONLY the two global kinds are deletable. Every metered
-- zonal/regional kind — the VM, its disks, the Cloud NAT that actually accrues charges —
-- is UNADDRESSABLE, which makes enforced teardown impossible by construction rather than
-- merely unimplemented. That is why the sweep in
-- packages/operator-core/lib/workspace-host/cloud-resource-obligations.ts could only ever
-- ESCALATE: no reclaimer could have built the delete call even with a working credential.
--
-- The information was never missing, only dropped: `WorkspaceHostResourceRef`
-- (libs/generic/deployment-driver/src/workspace-host-types.ts) already carries `region`
-- and `zone`, but `CloudResourceCreatedEventLike` declared just { kind, providerId,
-- parentProviderId }, so the observer discarded the location before the INSERT and the
-- table had nowhere to put it.
--
-- This is EXPAND-only: four nullable-by-default TEXT columns, no constraint tightened and
-- no existing column touched, so the currently-deployed release keeps writing 1040-shaped
-- rows harmlessly (they simply classify as `unaddressable`, which the reclamation planner
-- reports LOUDLY rather than skipping — a silent skip is the exact failure mode this
-- ledger has already produced twice). No FORWARD-COMPAT line is required because nothing
-- here is destructive.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file.

ALTER TABLE harness_shared.cloud_resource_obligations
  ADD COLUMN IF NOT EXISTS zone               TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS region             TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS parent_resource_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS host_id            TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN harness_shared.cloud_resource_obligations.zone IS
  'GCP zone (e.g. us-central1-a) for zonal kinds (vm, disk). Empty when not applicable or not captured; a zonal row with an empty zone is UNADDRESSABLE and cannot be reclaimed.';
COMMENT ON COLUMN harness_shared.cloud_resource_obligations.region IS
  'GCP region (e.g. us-central1) for regional kinds (subnetwork, router, nat). Empty when not applicable or not captured; a regional row with an empty region is UNADDRESSABLE.';
COMMENT ON COLUMN harness_shared.cloud_resource_obligations.parent_resource_id IS
  'Enclosing resource this one is addressed THROUGH — for kind=nat, the Cloud Router name that owns the NAT config (delete-nat takes routerName). Empty for kinds addressed directly.';
COMMENT ON COLUMN harness_shared.cloud_resource_obligations.host_id IS
  'Workspace-host id the resource was created for. Every GCP delete step carries hostId, and the provider asserts the managed-label identity of the target against it before deleting — so an empty host_id is UNADDRESSABLE by design, not a cosmetic gap.';
