-- 426-datatype-approved-global-read.sql — make APPROVED published datatypes globally readable
-- (reflexive-platform-extensibility-datatypes-2026-06-24, D-010 distribution).
--
-- The base policy `datatype_registry_workspace_isolation` (migration 421) scopes ALL access to
-- the caller's workspace. Publishing graduates a datatype to the GLOBAL/shared tier
-- (review_status='approved', migration 425); for it to be a real shared catalog, ANY workspace
-- must be able to READ an approved row (to browse + install it). This ADDS a permissive,
-- SELECT-ONLY policy for approved rows — policies are OR-combined, so a workspace sees
-- (its own rows) OR (any approved row). WRITES stay workspace-scoped: the base policy's WITH
-- CHECK is unchanged and this policy is FOR SELECT only, so no workspace can modify another's
-- rows. Idempotent (DROP POLICY IF EXISTS + CREATE).
DROP POLICY IF EXISTS datatype_registry_approved_global_read ON harness_shared.datatype_registry;
CREATE POLICY datatype_registry_approved_global_read ON harness_shared.datatype_registry
  FOR SELECT
  USING (review_status = 'approved');
