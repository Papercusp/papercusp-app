-- 1333-slack-org-sync-routine.sql — enterprise-data-sources-2026-10-01 P-016 / D-026
--
-- Seeds the routine that RUNS the Slack organization connector. Each fire, for
-- every Slack source connected with the customer's own internal app
-- (admin route POST /admin/triggers/slack/connect-org — an HTTP route, not an
-- MCP verb, so tokens never travel as agent tool args), the
-- system:slack-org-sync action re-syncs
-- channel membership when it is due (it feeds each channel's permission list)
-- and then takes up to max_steps paced backfill steps. The connector owns the
-- pacing and every Slack 429 Retry-After; concurrency 'skip' keeps fires from
-- overlapping.
--
-- INERT WHILE DARK: the action returns before listing a single source while the
-- papercusp-slack-org-connector flag is off, and that flag stays off until the
-- legal read of Slack's API terms (WI-10005258) is on record. So active=TRUE here
-- reads nothing, fetches nothing and writes nothing until the flag is flipped.
--
-- FORWARD-COMPAT: an older routines host fail-soft skips an unregistered
-- system action, so applying this row before the runtime deploy is a no-op.

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_slack_org_sync', 'papercusp', 'papercusp-workspace',
   'slack-org-sync', 'cron',
   '{"cron":"45 * * * * *","max_steps":5,"membership_interval_sec":3600}'::jsonb,
   'system:slack-org-sync', 'skip', 'skip-old', TRUE, now(), 'durable')
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
