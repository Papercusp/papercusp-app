-- 1114: selective access path for conversation-context-projection's foreign-session
-- activity-report lookup (application-performance-implementation-2026-09-04 P-003).
--
-- The reader in packages/operator-core/lib/conversation-context-projection.ts needs
-- the newest bounded activity rows for one CLI session.  Its compatibility query
-- accepts both producer spellings (`session_id` and `sessionId`) and reads rows from
-- the requested workspace plus the legacy `default` workspace:
--
--   WHERE (workspace_id = $workspace OR workspace_id = 'default')
--     AND tool_name IN ('activity:report', 'activity_report')
--     AND (args_json ? 'session_id' OR args_json ? 'sessionId')
--     AND COALESCE(args_json->>'session_id', args_json->>'sessionId') = $session
--   ORDER BY invoked_at DESC, id DESC
--   LIMIT 200
--
-- Before this index, PostgreSQL chose tool_invocations_invoked_at_cov_idx and
-- applied the session expression as a post-scan filter.  A live absent-session
-- probe on 2026-09-04 read 6,687,492 shared blocks and took 8,737.87 ms while
-- removing 902,266 rows per worker.  The expression below is intentionally
-- byte-for-byte the same COALESCE as the reader; PostgreSQL cannot use a nearby
-- expression index when the tree differs.
--
-- The first key is workspace_id so the requested and legacy scopes can be served
-- as two ordered index branches.  The normalized session expression is next, so
-- each branch reaches one session directly; invoked_at/id then satisfy the newest
-- first order without a second sort.  The partial predicate excludes unrelated
-- telemetry and rows with neither supported session-key spelling.  The reader
-- states that predicate explicitly; the key-presence clauses are logically
-- redundant with the equality but load-bearing for partial-index eligibility.
--
-- This is deliberately a normal CREATE INDEX: the migration runner wraps each
-- file in one transaction, so CREATE INDEX CONCURRENTLY is not legal here.  The
-- runner applies migrations before the serving process accepts traffic.  The
-- index is additive and idempotent; no existing access path is dropped.

CREATE INDEX IF NOT EXISTS tool_invocations_activity_session_lookup_idx
  ON harness_shared.tool_invocations USING btree (
    workspace_id,
    (COALESCE(args_json->>'session_id', args_json->>'sessionId')),
    invoked_at DESC,
    id DESC
  )
  WHERE tool_name IN ('activity:report', 'activity_report')
    AND (args_json ? 'session_id' OR args_json ? 'sessionId');

COMMENT ON INDEX harness_shared.tool_invocations_activity_session_lookup_idx IS
  'P-003: bounded foreign-session conversation-context projection lookup; expression must stay byte-identical to COALESCE(args_json->>''session_id'', args_json->>''sessionId'') and the reader must retain both partial-index key-presence predicates.';
