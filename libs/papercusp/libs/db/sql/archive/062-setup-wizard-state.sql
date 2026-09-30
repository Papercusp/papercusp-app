-- 062-setup-wizard-state.sql
--
-- Per-workspace state for the Setup Wizard at /setup and
-- /settings/setup-wizard. Same single-row-per-workspace JSONB pattern
-- as the other operator_* tables introduced by migration 020.
--
-- Payload shape (governed by SetupWizardState in
-- apps/operator/app/api/desktop/setup-wizard-state/route.ts):
--   {
--     step_status: { [stepId]: 'dismissed' | 'completed' },
--     last_visited_step?: string,
--     finished_at?: string,
--     update_channel?: 'alpha' | 'beta' | 'stable',
--     telemetry_enabled?: boolean,        -- OFF by default; flipped by Step 12.
--                                         --   Not a sufficient gate on its own —
--                                         --   forwarding also requires the shared
--                                         --   PostHog config (lib/posthog-config)
--                                         --   to have testingFeatures: true. See
--                                         --   docs.papercupai.com/posthog.
--     install_id?: string,                -- Per-install random UUID. Stable
--                                         --   PostHog distinct_id across
--                                         --   workspace creation/deletion.
--     updated_at?: string,
--   }

CREATE TABLE IF NOT EXISTS harness_shared.setup_wizard_state (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

-- Inbound ring buffer for telemetry crash/diagnostic reports submitted
-- via POST /api/desktop/telemetry-report when the user has opted in.
-- Bounded in the application (last 100). The flush worker drains this
-- into telemetry_reports_archive on a timer.
--
-- Payload shape:
--   {
--     reports: [
--       { received_at: string, kind: string, app_version?: string,
--         os?: string, payload: unknown, forwarded_at?: string },
--       ...
--     ]
--   }

CREATE TABLE IF NOT EXISTS harness_shared.telemetry_reports (
  workspace_id TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  updated_at   BIGINT NOT NULL DEFAULT 0
);

-- Long-term archive for telemetry reports. The flush worker
-- (apps/operator/lib/telemetry-flush.ts) moves entries out of the ring
-- buffer into this table as they arrive. One row per report (not per
-- workspace) so retention is a simple
--   DELETE WHERE received_at < now() - interval.
--
-- `forwarded_at` is NULL until a remote-sink POST succeeds; the worker
-- replays NULL rows each tick so a flaky sink doesn't drop reports.
CREATE TABLE IF NOT EXISTS harness_shared.telemetry_reports_archive (
  id             BIGSERIAL PRIMARY KEY,
  workspace_id   TEXT NOT NULL,
  received_at    TIMESTAMPTZ NOT NULL,
  kind           TEXT NOT NULL,
  app_version    TEXT,
  os             TEXT,
  payload        JSONB,
  forwarded_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS telemetry_reports_archive_received_at_idx
  ON harness_shared.telemetry_reports_archive (received_at DESC);

CREATE INDEX IF NOT EXISTS telemetry_reports_archive_forwarded_at_idx
  ON harness_shared.telemetry_reports_archive (forwarded_at)
  WHERE forwarded_at IS NULL;

CREATE INDEX IF NOT EXISTS telemetry_reports_archive_workspace_idx
  ON harness_shared.telemetry_reports_archive (workspace_id, received_at DESC);
