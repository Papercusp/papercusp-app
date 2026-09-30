-- 1197 — index the migration-826 physical-twin survivor markers (WI-10002480).
--
-- The engineer-issues projection runs isRetiredLegacyTwinSource once per legacy
-- issue PUT on the peer-log merge hot path. It asks whether a survivor row carries
-- a mig-826 `_physicalTwinRepair` marker for (feature_id, sourceHarness) or a
-- `_physicalTwinRekey` marker for (oldId, sourceHarness). Neither branch had a
-- usable index: `feature_id` is only a non-leading column of
-- work_items_scoped_identity / work_items_pkey without `harness_slug`, and the
-- rekey marker is unindexed JSON. So every call was a parallel sequential scan of
-- the workspace's whole work_items table. Measured on the P-203 rig VM
-- (2026-09-22): 709.9ms per call over 177,720 rows (656,959 shared buffer hits),
-- active in 39 of 40 pg_stat_activity samples. It alone bounded the fold to
-- ~33-107 ops/s, i.e. ~16-20h for a new peer to join a 7.7M-op log.
--
-- The marked population is tiny and bounded (mig 826 wrote it once; the rig VM
-- holds 58 repaired, 0 rekeyed), so both indexes are PARTIAL on the marker's own
-- `migration = '826'` predicate and cost almost nothing to keep. The projection's
-- queries repeat these WHERE clauses verbatim so the planner can prove each
-- partial index applies — reword one side and the scan comes back. The
-- index-served test in engineer-issues.integration.test.ts EXPLAINs the
-- production SQL against this file to pin that.
--
-- The migration runner supplies the transaction; no BEGIN/COMMIT here.

CREATE INDEX IF NOT EXISTS work_items_twin_repair_marker_idx
  ON harness_shared.work_items (workspace_id, feature_id)
  WHERE (payload->'_physicalTwinRepair'->>'migration') = '826';

CREATE INDEX IF NOT EXISTS work_items_twin_rekey_marker_idx
  ON harness_shared.work_items (workspace_id, ((payload->'_physicalTwinRekey'->>'oldId')))
  WHERE (payload->'_physicalTwinRekey'->>'migration') = '826';
