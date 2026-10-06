-- 1379-retire-linear-jira-sync-plugins.sql — linear-asana-task-sync-2026-10-05 P-009 (WI-10006369)
--
-- Retires the pre-contract tracker-sync plugins @papercupai/linear-sync and
-- @papercupai/jira-sync. Their packages (libs/papercusp/plugins/linear-sync,
-- libs/papercusp/plugins/jira-sync) are deleted in the same change; Linear now
-- arrives as a ticket provider on the generalized provider contract (plan D-002),
-- and a Jira provider would be a follow-up on that same contract. No
-- compatibility layer (generalized-integrations D-008).
--
-- What was live when this was written (2026-10-06, snapshot 78236 taken first):
--   plugin_linear_sync / plugin_jira_sync: links 0 rows, conflicts 0 rows,
--   cursors 45 rows each, every one still at remote_cursor = epoch and
--   last_full_sync NULL — neither plugin ever completed a sync.
--   plugin_audit_log: 0 rows for either plugin; no routines row for either.
--   Registry leftovers from May 2026, all in workspace 'default':
--   plugin_enables 5, plugin_configs 1, plugin_capability_grants 75,
--   hidden_plugins 1 (jira-sync, seeded by archive/036).
--
-- FORWARD-COMPAT: the release still serving on :3070 never touches these two schemas or registry rows, because neither plugin can load there — their global-plugins entries are dangling symlinks, no routine is installed for either, and plugin_audit_log has no row for either, so dropping them removes nothing a running build reads.

DROP SCHEMA IF EXISTS plugin_linear_sync CASCADE;
DROP SCHEMA IF EXISTS plugin_jira_sync CASCADE;

DELETE FROM harness_shared.plugin_enables
 WHERE plugin_slug IN ('@papercupai/linear-sync', '@papercupai/jira-sync', 'linear-sync', 'jira-sync');

DELETE FROM harness_shared.plugin_configs
 WHERE plugin_slug IN ('@papercupai/linear-sync', '@papercupai/jira-sync', 'linear-sync', 'jira-sync');

DELETE FROM harness_shared.plugin_capability_grants
 WHERE plugin_name IN ('@papercupai/linear-sync', '@papercupai/jira-sync', 'linear-sync', 'jira-sync');

DELETE FROM harness_shared.plugin_kv
 WHERE plugin_id IN ('@papercupai/linear-sync', '@papercupai/jira-sync', 'linear-sync', 'jira-sync');

DELETE FROM harness_shared.plugin_reload_state
 WHERE plugin_id IN ('@papercupai/linear-sync', '@papercupai/jira-sync', 'linear-sync', 'jira-sync');

DELETE FROM harness_shared.hidden_plugins
 WHERE basename IN ('linear-sync', 'jira-sync');
