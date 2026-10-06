-- Identity lessons use the existing queue, but are private to their proposing
-- workspace and require an explicit decision. Fleet candidates remain global.
ALTER TABLE harness_shared.knowledge_pack_candidates
  ADD COLUMN IF NOT EXISTS workspace_id text,
  ADD COLUMN IF NOT EXISTS target_identity_id text,
  ADD COLUMN IF NOT EXISTS target_pack_id text,
  ADD COLUMN IF NOT EXISTS source_memory_id uuid;

ALTER TABLE harness_shared.knowledge_pack_candidates
  ADD CONSTRAINT knowledge_pack_candidates_identity_target_check CHECK (
    (workspace_id IS NULL AND target_identity_id IS NULL AND target_pack_id IS NULL AND source_memory_id IS NULL)
    OR (num_nonnulls(workspace_id, target_identity_id, target_pack_id, source_memory_id) = 4
      AND workspace_id <> '' AND target_identity_id <> '' AND target_pack_id <> '')
  );

CREATE INDEX IF NOT EXISTS knowledge_pack_candidates_identity_listing_idx
  ON harness_shared.knowledge_pack_candidates (workspace_id, target_identity_id, target_pack_id, status, created_at DESC);
