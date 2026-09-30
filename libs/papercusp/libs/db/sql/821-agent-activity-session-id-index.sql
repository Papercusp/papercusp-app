-- 821: index harness_shared.agent_activity by (session_id, id).
--
-- EI-20309400427356782 gave activity:recent a `session_id` filter — the row's own
-- column, always returned but never filterable, so recovering one CLI session's tool
-- stream meant over-fetching by `owner` and filtering client-side (one owner spans
-- many sessions across respawns).
--
-- Without this index that filter is a seq-scan: measured 2026-08-13 the table is
-- 375,672 rows / 290 MB over 5,260 distinct sessions (~71 rows each), and the read is
-- `WHERE session_id = $1 ORDER BY id DESC LIMIT n` — for an OLD session the backward
-- PK walk reads nearly the whole table before it finds 50 matching rows.
--
-- Shape mirrors the existing agent_activity_owner_id_idx / agent_activity_harness_idx:
-- the filter column leads, `id` trails so the ORDER BY id (both the DESC recency read
-- and the ASC since_id catch-up) is served by the same index. NOT partial, unlike the
-- harness index — only 343 of 375,672 rows have a NULL session_id (0.09%), so a
-- partial predicate would exclude nothing worth excluding and would only stop the
-- planner from using the index for an IS NULL probe.

CREATE INDEX IF NOT EXISTS agent_activity_session_id_idx
    ON harness_shared.agent_activity USING btree (session_id, id);

COMMENT ON INDEX harness_shared.agent_activity_session_id_idx IS
    'Per-CLI-session activity stream: activity:recent { session_id } and activity:tool-log, filter-then-ORDER BY id (EI-20309400427356782).';
