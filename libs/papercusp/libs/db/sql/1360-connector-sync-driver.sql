-- 1360-connector-sync-driver.sql — generalized-integrations-google-migration-cupboard-workflows-2026-10-05
-- P-004 (WI-10006068) / D-006 / requirement R-3.
--
-- One host-owned connector sync driver advances every registered provider's
-- sources (packages/operator-core/lib/providers/connector-runtime.ts). The host
-- owns the stateful half of the provider contract, so the per-source driver
-- state lives on the source row itself (reuse-first: one more set of fields on
-- harness_shared.data_sources, not a parallel table):
--
--   sync_lease_owner / sync_lease_expires_at
--       an expiring lease; a crashed driver's lease lapses and the next fire
--       resumes from the last COMMITTED cursor.
--   sync_next_attempt_at
--       backoff after a rate limit or transient failure, and the incremental
--       poll cadence after a clean sync. NULL means due now.
--   sync_failure_count
--       consecutive failures; drives exponential backoff and the degraded
--       health status.
--   sync_last_success_at
--       when the source last completed a sync pass (health).
--   sync_wake_requested_at
--       a push channel (webhook, Pub/Sub doorbell) asked for reconciliation;
--       it only wakes the driver for this source, it is never a data path.
--
-- The provider's opaque cursor stays in the existing `cursor` jsonb and the
-- backfill/incremental mode in the existing `backfill_status` column.
--
-- All additions are nullable or defaulted, so the currently deployed release,
-- which never reads them, is unaffected (expand-only).
--
-- The routine row seeds `system:connector-sync`. FORWARD-COMPAT: an older
-- routines host fail-soft skips an unregistered system action, so applying this
-- row before the runtime deploy is a no-op. With no registered provider source
-- the fire lists nothing and writes nothing.

ALTER TABLE harness_shared.data_sources
  ADD COLUMN IF NOT EXISTS sync_lease_owner text,
  ADD COLUMN IF NOT EXISTS sync_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sync_last_success_at timestamptz,
  ADD COLUMN IF NOT EXISTS sync_wake_requested_at timestamptz;

COMMENT ON COLUMN harness_shared.data_sources.sync_lease_owner IS
  'Connector sync driver lease holder (P-004). NULL when no driver holds the source.';
COMMENT ON COLUMN harness_shared.data_sources.sync_lease_expires_at IS
  'Connector sync driver lease expiry; an expired lease is free to take.';
COMMENT ON COLUMN harness_shared.data_sources.sync_next_attempt_at IS
  'Earliest next connector sync attempt (backoff or poll cadence). NULL means due now.';
COMMENT ON COLUMN harness_shared.data_sources.sync_failure_count IS
  'Consecutive connector sync failures; reset to 0 on a clean pass.';
COMMENT ON COLUMN harness_shared.data_sources.sync_last_success_at IS
  'When the connector sync driver last completed a pass for this source.';
COMMENT ON COLUMN harness_shared.data_sources.sync_wake_requested_at IS
  'Push-wake request for this source; consumed by the next connector sync pass.';

INSERT INTO harness_shared.routines
  (id, install_slug, workspace_id, name, trigger_kind, trigger_config,
   target_role, concurrency, catchup, active, next_fire_at, tier)
VALUES
  ('rt_papercusp_connector_sync', 'papercusp', 'papercusp-workspace',
   'connector-sync', 'cron',
   '{"cron":"45 * * * * *"}'::jsonb,
   'system:connector-sync', 'skip', 'skip-old', TRUE, now(), 'durable')
ON CONFLICT (install_slug, name) DO UPDATE SET
  workspace_id = EXCLUDED.workspace_id,
  trigger_kind = EXCLUDED.trigger_kind,
  trigger_config = EXCLUDED.trigger_config,
  target_role = EXCLUDED.target_role,
  concurrency = EXCLUDED.concurrency,
  catchup = EXCLUDED.catchup,
  -- Preserve an operator's explicit pause on re-apply/re-seed.
  active = harness_shared.routines.active,
  updated_at = now();
