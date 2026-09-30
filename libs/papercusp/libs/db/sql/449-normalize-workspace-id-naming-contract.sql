-- 449-normalize-workspace-id-naming-contract.sql
--
-- data-scoping-audit-2026-06-22 P-009 — CONTRACT step of the workspace/workspace_id
-- naming normalization on the three telemetry tables that diverged (agent_actions,
-- agent_queries, voice_utterances). Migration 399 (EXPAND step) added a `workspace_id
-- GENERATED ALWAYS AS (workspace) STORED` mirror column so readers could already use
-- the canonical name. This is the deferred CONTRACT step it called for: promote
-- workspace_id to a real, independently-written column (keeping every existing
-- generated value verbatim — DROP EXPRESSION preserves current data, it does not
-- recompute), then drop the now-legacy `workspace` column. A full-repo grep found
-- exactly two writers of these tables (packages/operator-core/lib/commands/
-- audit-writer.ts for agent_actions/agent_queries, packages/operator-core/lib/
-- voice-utterance-log.ts for voice_utterances) and no other reader of the `workspace`
-- column — both are switched to workspace_id in the same change as this migration, so
-- there is no undeployed-code window writing to a column that no longer exists.
--
-- Idempotent: DROP EXPRESSION IF EXISTS / DROP COLUMN IF EXISTS no-op on rerun or on a
-- fresh DB that never had the generated column (e.g. baseline already has workspace_id
-- as a plain column after this migration is folded into a future baseline regen).

ALTER TABLE harness_shared.agent_actions
  ALTER COLUMN workspace_id DROP EXPRESSION IF EXISTS;
ALTER TABLE harness_shared.agent_actions
  DROP COLUMN IF EXISTS workspace;

ALTER TABLE harness_shared.agent_queries
  ALTER COLUMN workspace_id DROP EXPRESSION IF EXISTS;
ALTER TABLE harness_shared.agent_queries
  DROP COLUMN IF EXISTS workspace;

ALTER TABLE harness_shared.voice_utterances
  ALTER COLUMN workspace_id DROP EXPRESSION IF EXISTS;
ALTER TABLE harness_shared.voice_utterances
  DROP COLUMN IF EXISTS workspace;

COMMENT ON COLUMN harness_shared.agent_actions.workspace_id IS
  'Workspace id (data-scoping-audit P-009 naming normalization, contract step — the canonical column; the legacy `workspace` name is dropped).';
COMMENT ON COLUMN harness_shared.agent_queries.workspace_id IS
  'Workspace id (data-scoping-audit P-009 naming normalization, contract step — the canonical column; the legacy `workspace` name is dropped).';
COMMENT ON COLUMN harness_shared.voice_utterances.workspace_id IS
  'Workspace id (data-scoping-audit P-009 naming normalization, contract step — the canonical column; the legacy `workspace` name is dropped).';
