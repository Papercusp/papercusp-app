-- 1336-github-issues-sync-routine.sql — enterprise-data-sources-2026-10-01 P-019 / D-025
--
-- Seeds the routine that RUNS the GitHub Issues ticket connector. Each fire, for
-- every GitHub Issues data source (kind 'github', config objects 'issues'), the
-- system:github-issues-sync action skips a source the connector paused for a
-- GitHub rate limit, re-syncs repository collaborators into the repository's
-- permission list when that is due, and then takes one bounded poll: issues as
-- ticket records, open/close transitions as ticket-status-change events and
-- comments as documents. The connector owns paging bounds, the cursor and every
-- 403/429 back-off; concurrency 'skip' keeps fires from overlapping.
--
-- Every five minutes (at :15 seconds). With no GitHub Issues source connected
-- the fire lists nothing and writes nothing.
--
-- FORWARD-COMPAT: an older routines host fail-soft skips an unregistered
-- system action, so applying this row before the runtime deploy is a no-op.

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_github_issues_sync', 'papercusp', 'papercusp-workspace',
   'github-issues-sync', 'cron',
   '{"cron":"15 */5 * * * *","membership_interval_sec":3600}'::jsonb,
   'system:github-issues-sync', 'skip', 'skip-old', TRUE, now(), 'durable')
ON CONFLICT (install_slug, name) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  trigger_kind = EXCLUDED.trigger_kind,
  trigger_config = EXCLUDED.trigger_config,
  target_role = EXCLUDED.target_role,
  concurrency = EXCLUDED.concurrency,
  catchup = EXCLUDED.catchup,
  tier = EXCLUDED.tier,
  -- Preserve an operator's explicit pause on re-apply/re-seed.
  active = harness_shared.routines.active,
  updated_at = now();
