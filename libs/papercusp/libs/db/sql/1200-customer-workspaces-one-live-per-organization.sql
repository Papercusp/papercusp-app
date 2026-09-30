-- Migration 1200 — at most ONE live customer workspace per hosted organization.
-- (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22 P-319 / WI-10002240; decision D-397.)
--
-- WHY. Each sign-up creates exactly one organization, and the owner requires that a
-- sign-up can run only a single instance. A customer workspace is bound to exactly one
-- workspace host (customer_workspaces_host_identity_uq), so capping live workspaces per
-- organization caps hosts per sign-up. The first-workspace route already refuses an
-- organization that holds a live workspace, but that is a read-then-write: two concurrent
-- attempts with different attempt keys both read "none" and both admit. Only the database
-- can make the cap race-proof.
--
-- WHAT. A partial unique index over the live rows. A soft-deleted workspace ('deleted')
-- frees the slot, so an organization can replace a workspace it has deleted. The
-- admission writer maps a violation of this index to organization_has_live_workspace.
--
-- Measured before arming (2026-09-23): harness_shared.customer_workspaces holds one row
-- (one organization, state 'active'), so the index builds without conflict.
--
-- FORWARD-COMPAT: the currently-deployed release already refuses a second live workspace for an organization before writing, so the only write this index newly rejects is the concurrent double-admission that release wrongly lets through; there it surfaces as a failed admission instead of a second host, and the writer that maps it to a clean refusal ships with this index.
CREATE UNIQUE INDEX IF NOT EXISTS customer_workspaces_one_live_per_organization_uq
  ON harness_shared.customer_workspaces (workspace_id, organization_id)
  WHERE state <> 'deleted';
