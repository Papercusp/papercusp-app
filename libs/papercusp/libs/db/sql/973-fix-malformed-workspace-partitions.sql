-- EI-21412168682953521 — remap work_items rows that were partitioned under
-- workspace ids that were never real identities. Attributed (2026-08-26,
-- su-17b86): all eight rows are local su improvement-captures whose calling
-- session resolved an ambient workspace from a raw environment string:
--   '${PAPERCUSP_WORKSPACE}'                      unexpanded env template
--   '"papercusp-workspace"'                       JSON-double-quoted id
--   '/home/builduser/papercupai-workspace/…'   filesystem path used as tenant
-- The writer-side chokepoint guard (workspace-registry.ts
-- isMalformedWorkspaceId, same EI) prevents new rows; this migration re-homes
-- the existing residue onto the canonical tenant so the filings are visible to
-- every concrete-workspace read again. Idempotent: the second run updates 0 rows.
UPDATE harness_shared.work_items
   SET workspace_id = 'papercusp-workspace'
 WHERE harness_slug = 'papercusp'
   AND workspace_id IN (
     '${PAPERCUSP_WORKSPACE}',
     '"papercusp-workspace"',
     '/home/builduser/papercupai-workspace/papercusp'
   );
