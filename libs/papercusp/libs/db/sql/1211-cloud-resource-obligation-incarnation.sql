-- 1211-cloud-resource-obligation-incarnation.sql — distinguish same-name GCP resource incarnations.
--
-- A GCE VM's provider name can be reused after teardown. Keep the provider's immutable
-- per-insert identity beside the stable address so a recreation can reopen the obligation
-- and a delayed destroy for the old incarnation cannot close the replacement's obligation.
-- Legacy and non-VM rows use the empty identity until they are observed with a provider id.
--
-- No top-level BEGIN/COMMIT: the migration runner wraps each file.

ALTER TABLE harness_shared.cloud_resource_obligations
  ADD COLUMN IF NOT EXISTS incarnation_id TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN harness_shared.cloud_resource_obligations.incarnation_id IS
  'Immutable provider identity for one allocation at resource_id (GCE numeric instance id for VMs); empty for legacy/unversioned resources.';
