-- 585-system-health-v2 — health-tab-v2-2026-07-12 P-004 / P-005.
--
-- Three tables for the Health tab's v2 pass:
--   1. system_health_acks        — per-panel owner acknowledge/snooze (P-004). An acked
--                                  panel renders muted and is EXCLUDED from `overall`;
--                                  the ack auto-clears on recovery (panel returns to ok)
--                                  or when the incident signature changes (a NEW incident
--                                  re-alarms). At most one ack per (workspace, panel).
--   2. system_health_transitions — per-panel status-change ledger (P-005): one row each
--                                  time a panel's status flips, written by the ~30s tick.
--                                  Powers "crit since <t>" + the incident timeline.
--   3. system_health_ticks       — compact per-tick snapshot (ts, overall, statuses jsonb)
--                                  with 14d retention (deleted by the tick itself). Powers
--                                  the per-panel 24h uptime strips.
--
-- Idempotent. Retention is enforced by the writer (system-health/history.ts), not a job.

CREATE TABLE IF NOT EXISTS harness_shared.system_health_acks (
  workspace_id TEXT        NOT NULL,
  panel        TEXT        NOT NULL,
  -- The incident signature the ack covers: '<status>' at ack time. A panel whose
  -- current severity EXCEEDS the acked severity re-alarms (ack does not cover it).
  status       TEXT        NOT NULL CHECK (status IN ('warn', 'crit')),
  reason       TEXT        NOT NULL,
  acked_by     TEXT        NOT NULL,
  acked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Optional hard expiry; NULL = until recovery/signature-change.
  snooze_until TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, panel)
);

CREATE TABLE IF NOT EXISTS harness_shared.system_health_transitions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id TEXT        NOT NULL,
  panel        TEXT        NOT NULL,
  from_status  TEXT        NOT NULL,
  to_status    TEXT        NOT NULL,
  summary      TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shealth_transitions_ws_at
  ON harness_shared.system_health_transitions (workspace_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_shealth_transitions_ws_panel_at
  ON harness_shared.system_health_transitions (workspace_id, panel, at DESC);

CREATE TABLE IF NOT EXISTS harness_shared.system_health_ticks (
  workspace_id TEXT        NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  overall      TEXT        NOT NULL,
  -- { "<panelKey>": "ok" | "warn" | "crit" | "unknown", ... }
  statuses     JSONB       NOT NULL,
  PRIMARY KEY (workspace_id, at)
);

CREATE INDEX IF NOT EXISTS idx_shealth_ticks_at
  ON harness_shared.system_health_ticks (at);
