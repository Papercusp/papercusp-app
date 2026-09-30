-- Migration 1055 — durable per-agent release-cooldown provenance.
--
-- The legacy last_released_by/last_released_at columns on work_items can store only
-- one release. When two agents release the same row, the second release overwrites
-- the first agent's cooldown and the first agent can immediately re-claim the row.
-- Keep those columns for compatibility, but make the caller-relative floor read this
-- keyed sidecar as well. One row per (workspace, harness, item, releasing agent) means
-- peer releases no longer erase one another.

CREATE TABLE IF NOT EXISTS harness_shared.work_item_release_cooldowns (
  workspace_id text NOT NULL,
  harness_slug text NOT NULL,
  feature_id text NOT NULL,
  agent_id text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, harness_slug, feature_id, agent_id)
);

CREATE INDEX IF NOT EXISTS work_item_release_cooldowns_expiry_idx
  ON harness_shared.work_item_release_cooldowns
    (workspace_id, harness_slug, feature_id, released_at);

COMMENT ON TABLE harness_shared.work_item_release_cooldowns IS
  'Per-agent release cooldowns; keyed rows prevent peer releases from overwriting one another (migration 1055 / EI-21986146237645643).';
COMMENT ON COLUMN harness_shared.work_item_release_cooldowns.released_at IS
  'When this agent released this work item; caller-relative claim floors apply the configured cooldown window.';

-- Preserve cooldowns written by older runtimes before the sidecar existed. The
-- legacy columns remain the read fallback, so this copy is additive and idempotent.
INSERT INTO harness_shared.work_item_release_cooldowns
  (workspace_id, harness_slug, feature_id, agent_id, released_at)
SELECT workspace_id, harness_slug, feature_id, btrim(last_released_by), last_released_at
  FROM harness_shared.work_items
 WHERE btrim(COALESCE(last_released_by, '')) <> ''
   AND btrim(COALESCE(harness_slug, '')) <> ''
   AND last_released_at IS NOT NULL
ON CONFLICT (workspace_id, harness_slug, feature_id, agent_id) DO UPDATE
  SET released_at = GREATEST(
    harness_shared.work_item_release_cooldowns.released_at,
    EXCLUDED.released_at
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.work_item_release_cooldowns TO harness_app;
DO $grant$
BEGIN
  GRANT SELECT ON harness_shared.work_item_release_cooldowns TO harness_zero;
EXCEPTION
  WHEN undefined_object THEN NULL;
END
$grant$;

ALTER TABLE harness_shared.work_item_release_cooldowns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_item_release_cooldowns_workspace_isolation
  ON harness_shared.work_item_release_cooldowns;
CREATE POLICY work_item_release_cooldowns_workspace_isolation
  ON harness_shared.work_item_release_cooldowns
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
