-- 1136: selective access path for numeric adv_session_id activity-report
-- lookups used by compaction/lifecycle incident audits.
--
-- The incident query scopes by workspace and tool spelling, then ORs the
-- numeric adv_session_id branch with the native session_id/sessionId branches:
--
--   WHERE workspace_id = $workspace
--     AND tool_name IN ('activity:report', 'activity_report')
--     AND (
--       (args_json ? 'adv_session_id'
--         AND args_json->>'adv_session_id' = $adv_session_id)
--       OR (args_json ? 'session_id'
--         AND args_json->>'session_id' = $session_id)
--       OR (args_json ? 'sessionId'
--         AND args_json->>'sessionId' = $session_id)
--     )
--   ORDER BY invoked_at DESC, id DESC
--   LIMIT 20
--
-- Migration 1114 covers the native session_id/sessionId expression.  This
-- additive partial index covers the previously unindexed numeric branch so a
-- future OR/BitmapOr plan can avoid scanning the time-ordered telemetry index.
-- Keep the workspace key and newest-first ordering aligned with the audit query.

CREATE INDEX IF NOT EXISTS tool_invocations_activity_adv_session_lookup_idx
  ON harness_shared.tool_invocations USING btree (
    workspace_id,
    (args_json->>'adv_session_id'),
    invoked_at DESC,
    id DESC
  )
  WHERE tool_name IN ('activity:report', 'activity_report')
    AND (args_json ? 'adv_session_id');

COMMENT ON INDEX harness_shared.tool_invocations_activity_adv_session_lookup_idx IS
  'EI-22445064440252159: selective numeric adv_session_id activity-report lookup; keep expression, tool predicate, workspace key, and invoked_at/id order aligned with the incident audit query.';
