-- Migration 857 — index agent_activity by workspace and recency.
--
-- WI-39548 measured activity:recent's workspace-scoped feed doing a parallel
-- sequential scan over ~465k rows because the table had indexes for owner,
-- harness, and session, but none led by workspace_id. The reader orders by id
-- after filtering workspace_id, so this composite shape serves both the default
-- newest-first feed and the since_id catch-up branch.
--
-- The reader temporarily includes the legacy '*' partition while migration 143
-- rows age out. New activity:report writes resolve a concrete workspace and do
-- not add more wildcard rows.

CREATE INDEX IF NOT EXISTS agent_activity_workspace_id_idx
    ON harness_shared.agent_activity USING btree (workspace_id, id);

COMMENT ON INDEX harness_shared.agent_activity_workspace_id_idx IS
    'Workspace-scoped activity:recent feed and numeric-id catch-up ordering (WI-39548).';
