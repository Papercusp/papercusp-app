-- 192-drop-org-sim-tables.sql
--
-- Retire the deprecated papercup-org / department simulation (D-008). The
-- multi-department "org" harness model (an org-root project with departments
-- that exchange ProjectKickoff/Proposal/Directive messages) was superseded and
-- has no creation path anymore — no blueprint mints a kind='department' harness,
-- its DepartmentHarnessDashboard + fs-watcher mirrors are removed in the same
-- change, and the data was stale demo fixtures (Apr 2026). The tables only
-- caused confusion (agents mistook harness_shared.org_inbox for the real agent
-- inbox / messages_consolidated), so drop the whole family.
--
-- CASCADE drops the per-table RLS policies (org_inbox_workspace_isolation, …)
-- with the tables. Verified pre-drop: no pg_proc body or view references any
-- org_* table, so CASCADE has nothing else to rewrite. Idempotent.

DROP TABLE IF EXISTS harness_shared.org_inbox      CASCADE;
DROP TABLE IF EXISTS harness_shared.org_outbox     CASCADE;
DROP TABLE IF EXISTS harness_shared.org_charter    CASCADE;
DROP TABLE IF EXISTS harness_shared.org_departments CASCADE;
DROP TABLE IF EXISTS harness_shared.org_projects   CASCADE;
DROP TABLE IF EXISTS harness_shared.org_notes      CASCADE;
DROP TABLE IF EXISTS harness_shared.org_decisions  CASCADE;
