-- Migration 121 — retire the last two per-harness PHYSICAL tables:
-- config_token and harness_proposals. Part of
-- harness-state-storage-unification-2026-06-01 P-004/P-005 (D-007: consolidate).
--
-- config_token: the authoritative token store is harness_shared.token_index
-- (workspace-owned: token, harness_slug, workspace_id, kind). All auth lookups
-- read token_index; the per-harness config_token was a WRITE-ONLY mirror, never
-- read for auth. Verified 2026-06-03: 0 config_token tokens are absent from
-- token_index, so dropping it loses no auth state. The writers (execute-action
-- spinup, admin/rotate-token) were updated to stop writing it.
--
-- harness_proposals: harness_shared.harness_proposals_shared is authoritative
-- (fs-watcher-fed from .harness/proposals/*.md). The per-harness harness_proposals
-- had no PG reader/writer (dead since the polling-removal arc). Verified
-- 2026-06-03: all 16 per-schema rows are present in harness_proposals_shared.
--
-- After this migration every per-harness schema contains ONLY auto-updatable
-- views over harness_shared.*_consolidated — no physical per-harness tables.
-- Idempotent.

\set ON_ERROR_STOP on
BEGIN;

DO $mig$
DECLARE s TEXT;
BEGIN
  FOR s IN
    SELECT schema_name FROM information_schema.schemata
     WHERE schema_name LIKE 'harness_%' AND schema_name <> 'harness_shared'
  LOOP
    -- Both are physical tables (never views); DROP TABLE IF EXISTS is a no-op
    -- if already gone, so this is idempotent.
    EXECUTE format('DROP TABLE IF EXISTS %I.config_token CASCADE', s);
    EXECUTE format('DROP TABLE IF EXISTS %I.harness_proposals CASCADE', s);
  END LOOP;
END $mig$;

COMMIT;
