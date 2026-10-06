-- 1267-connected-app-alert-sweep.sql — external-app-access-to-workspaces-2026-09-29 P-328 (D-030)
--
-- Scheduled sweep alerts for connected apps, split from P-011 by D-028 #5.
--
--   1. harness_shared.connected_app_auth_failures: an hourly counter of refused uses of a KNOWN
--      key (wrong secret, rotated-out secret, revoked, expired, token-endpoint-only). One row per
--      key per UTC hour, so a flood of bad bearers costs one upsert each and never a row each.
--      Counts and the last refusal reason only: never the presented secret, never an address.
--   2. The `connected-app-alert-sweep` routine: every 15 minutes, `system:connected-app-alert-sweep`
--      raises the usage-spike, repeated-auth-failure, key-expiring and creator-removed alerts on
--      the owner-attention rail (notifyAttentionOnce), each under a stable dedupe key.
--
-- FORWARD-COMPAT: additive only (a new table, a new routine row). The routines engine treats an
-- unregistered system action as a fail-soft skipped fire, so a host still on the previous release
-- skips the row until the action module ships with it; nothing in the current release reads or
-- writes the new table.

CREATE TABLE IF NOT EXISTS harness_shared.connected_app_auth_failures (
  app_id       text        NOT NULL,
  workspace_id text        NOT NULL,
  -- date_trunc('hour', now()) at the time of the refusal.
  hour         timestamptz NOT NULL,
  failures     integer     NOT NULL DEFAULT 0,
  last_reason  text        NOT NULL,
  last_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, hour),
  CONSTRAINT connected_app_auth_failures_failures_nonnegative_ck CHECK (failures >= 0)
);

CREATE INDEX IF NOT EXISTS connected_app_auth_failures_hour_idx
  ON harness_shared.connected_app_auth_failures (hour DESC, workspace_id);

COMMENT ON TABLE harness_shared.connected_app_auth_failures IS
  'P-328 (D-030): refused uses of a known connected-app key, counted per key per UTC hour. Read by the connected-app alert sweep (repeated auth failures). Holds no secret and no address.';

ALTER TABLE harness_shared.connected_app_auth_failures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS connected_app_auth_failures_workspace_isolation
  ON harness_shared.connected_app_auth_failures;
CREATE POLICY connected_app_auth_failures_workspace_isolation
  ON harness_shared.connected_app_auth_failures
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.connected_app_auth_failures TO harness_app;

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_connected_app_alert_sweep', 'papercusp', 'papercusp-workspace',
   'connected-app-alert-sweep', 'cron',
   '{"cron":"0 */15 * * * *"}'::jsonb,
   'system:connected-app-alert-sweep', 'skip', 'skip-old', TRUE, now(), 'durable')
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
