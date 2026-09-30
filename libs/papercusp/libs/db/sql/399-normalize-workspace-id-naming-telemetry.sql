-- 399-normalize-workspace-id-naming-telemetry.sql
--
-- data-scoping-audit-2026-06-22 P-009 — normalize the `workspace` column name to the
-- canonical `workspace_id` on the three telemetry tables that diverged (agent_actions,
-- agent_queries, voice_utterances all carry `workspace`, not `workspace_id`; D-002 nit).
--
-- EXPAND step of a zero-downtime rename (NOT a destructive RENAME): add a
-- `workspace_id` GENERATED ALWAYS AS (workspace) STORED column that mirrors the legacy
-- `workspace` column. The running (pre-deploy) code keeps writing `workspace` unaffected;
-- workspace_id auto-populates for every existing + future row and gives readers the
-- canonical name immediately. The CONTRACT step (switch the few writers/readers to
-- workspace_id, then DROP COLUMN workspace) is a deferred follow-up that lands with the
-- code change once the deploy gate is green — doing the rename as expand/contract avoids
-- breaking the old code's `workspace` writes during the undeployed window.
--
-- `workspace` is the source of truth (a plain nullable column); workspace_id is a derived
-- projection. Behavior-neutral, idempotent, non-destructive. NO DEFAULT (derived, never
-- defaulted) so lint:no-workspace-default stays clean. These are low-volume telemetry
-- tables → the ADD ... STORED rewrite is cheap.

ALTER TABLE harness_shared.agent_actions
  ADD COLUMN IF NOT EXISTS workspace_id text GENERATED ALWAYS AS (workspace) STORED;

ALTER TABLE harness_shared.agent_queries
  ADD COLUMN IF NOT EXISTS workspace_id text GENERATED ALWAYS AS (workspace) STORED;

ALTER TABLE harness_shared.voice_utterances
  ADD COLUMN IF NOT EXISTS workspace_id text GENERATED ALWAYS AS (workspace) STORED;

COMMENT ON COLUMN harness_shared.agent_actions.workspace_id IS
  'GENERATED mirror of the legacy `workspace` column (data-scoping-audit P-009 naming normalization, expand step). `workspace` stays the source of truth until the contract step drops it.';
COMMENT ON COLUMN harness_shared.agent_queries.workspace_id IS
  'GENERATED mirror of the legacy `workspace` column (data-scoping-audit P-009 naming normalization, expand step). `workspace` stays the source of truth until the contract step drops it.';
COMMENT ON COLUMN harness_shared.voice_utterances.workspace_id IS
  'GENERATED mirror of the legacy `workspace` column (data-scoping-audit P-009 naming normalization, expand step). `workspace` stays the source of truth until the contract step drops it.';
