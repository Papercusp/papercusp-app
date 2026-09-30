-- Migration 199 — drop harness_shared.snapshot_index (retire the export-state
-- snapshot system).
--
-- Plan: retire-snapshots-instance-spec-2026-06-09 (P-008).
--
-- The harness-snapshot system (FS `.tar.gz` tarballs + this PG discovery index +
-- the `snapshots:*` tools + the Cupboard `kind=snapshot` path) is retired: its
-- three jobs are re-homed — distribution → blueprints (the Cupboard distributes
-- recipes), backup → git + PG, and the one remaining job, the reproducible clone,
-- → the lightweight `InstanceSpec` (blueprintRef + repoSha + deploymentConfig +
-- genome; capture/boot/vary). With `snapshot-discovery` / `snapshot-index` and the
-- `@papercusp/export-state` lib moved to `_retired/`, this index has no remaining
-- reader, so the table goes too. Dropping the table cascades its index
-- (snapshot_index_recent_idx), RLS policy (snapshot_index_workspace_isolation), and
-- grants.
--
-- NOT DROPPED — the legacy `harness_shared.harness_snapshots` /
-- `harness_snapshots_consolidated` tables are a SEPARATE, still-LIVE "iteration
-- snapshot" concept (features_json / validation_md / iter_num), trigger-fed +
-- git-exported (harness-state/git-export/serialize.ts, the `/harness/snapshots`
-- route, scaffold-harness-schema). Migration 134 explicitly warned not to conflate
-- the two; they stay. (The plan's P-008 mislabeled `harness_snapshots_consolidated`
-- as "orphaned" — it is not; only `snapshot_index` is retired here.)
--
-- Idempotent: DROP TABLE IF EXISTS. Composes onto 000-baseline.sql + 134 for
-- fresh/embedded-pg boots and applies cleanly on the native :5432 dev box.

\set ON_ERROR_STOP on
BEGIN;

DROP TABLE IF EXISTS harness_shared.snapshot_index;

COMMIT;
