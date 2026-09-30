-- 766-goal-projects-rls.sql — goal-mode-2026-08-07 P-016, follow-up to 765
--
-- WHAT 765 MISSED
--
--   765 created harness_shared.goal_projects with a workspace_id column, a NOT NULL and a
--   non-empty CHECK on it — all the shape of workspace ownership — but never enabled row-level
--   security. Verified immediately after it applied:
--
--     relname        | relrowsecurity
--     goals          | t
--     work_items     | t
--     goal_projects  | f      <-- this migration
--
--   So the new table was the ONLY member of the goal triple without isolation. Both tables it
--   joins (goals via the FK, work_items via harness_slug/goal_id) enforce it, which is exactly
--   what makes the omission easy to miss: every query written against the join reads correctly
--   in development, because the two constrained sides mask the unconstrained one.
--
--   The exposure is real, not theoretical. goal_projects is the table that answers "which
--   projects does this goal own" and "which goals does this project serve" — the second read
--   backs the goal chip on a pot card, so an unisolated row set means one workspace's pot could
--   render a chip naming another workspace's goal, by title.
--
--   ⚠ It is also invisible to the obvious check: harness_admin has rolbypassrls = true, so
--   `psql -U harness_admin` and dev:pg_query BOTH return the same rows with RLS on or off. The
--   absence had to be read off pg_class.relrowsecurity, not inferred from a query returning
--   sensible results.
--
-- THE POLICY
--
--   Byte-identical in shape to goals_workspace_isolation (000-baseline.sql:8923) and
--   work_items' equivalent: permissive, FOR ALL, USING and WITH CHECK both comparing
--   workspace_id to the app.workspace_id GUC. Deliberately the same expression rather than a
--   join through goals.workspace_id — a policy that reads another table is a policy that can
--   recurse, and the column is already NOT NULL and non-empty here.
--
--   WITH CHECK matters as much as USING: without it a session could INSERT a pairing stamped
--   with someone else's workspace_id and simply not be able to read it back.
--
-- FORWARD-COMPAT: the table was introduced by 765 in this same series and NO deployed code reads
-- or writes it yet (goal_projects has 0 rows; the tools that use it are unshipped), so enabling
-- RLS cannot break the release currently serving :3070. Enabling isolation on a table that
-- already had live readers would be the risky case — this is not that.

ALTER TABLE harness_shared.goal_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS goal_projects_workspace_isolation ON harness_shared.goal_projects;

CREATE POLICY goal_projects_workspace_isolation ON harness_shared.goal_projects
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
