-- 251-fleet-ekg.sql
--
-- self-learning-frontier-2026-06-12 (P-030 / FB-10): the Fleet EKG — the
-- system's behavioral heartbeat. Two tables:
--
-- fleet_ekg_sessions — one row per agent SESSION (owner_id + session_id over
-- harness_shared.agent_activity, the per-CLI native+MCP tool stream; NOT
-- tool_invocations, whose spawn_id is per-call/per-surface for the bulk of
-- traffic — see agent-insights/fleet-ekg-session-substrate). The row is the
-- session's behavioral embedding, recomputed idempotently by the
-- system:fleet-ekg-scan cadence (upsert; an active session's vector converges
-- as it ends):
--   features: numeric feature map (error rate, pacing gaps, burstiness,
--             repeat/retry rhythm, category shares — lib/fleet-ekg/features.ts
--             owns the registry).
--   tool_mix: tool-CATEGORY frequency counts (bash/read/edit/...).
--   bigrams:  category-bigram counts (consecutive-call rhythm).
--
-- fleet_ekg_shifts — one row per detected distribution shift per (feature,
-- window day): the scan compares the trailing window cohort against the
-- preceding baseline cohort (PSI for numeric features, Jensen-Shannon for
-- mixes), then attributes the shift against the behavior-change ledger
-- (migration 242, D-003): ledger rows in the lookback window become
-- ledger_candidates and attributed=true; an unattributable MAJOR shift alarms
-- through the attention rail ONCE (notified_at). The UNIQUE (workspace,
-- feature, window_date) key makes re-scans update-in-place, never duplicate.
--
-- Volume: sessions = a few hundred per day; shifts = a handful per day at
-- most. No RLS (mirrors 245-negative-space-demand): the scan and the
-- learning.ekg resolver scope by workspace_id explicitly.

CREATE TABLE IF NOT EXISTS harness_shared.fleet_ekg_sessions (
    workspace_id text NOT NULL,
    owner_id     text NOT NULL,
    session_id   text NOT NULL,
    agent        text,
    harness_slug text,
    started_at   timestamptz NOT NULL,
    ended_at     timestamptz NOT NULL,
    event_count  integer NOT NULL,
    features     jsonb NOT NULL,
    tool_mix     jsonb NOT NULL,
    bigrams      jsonb NOT NULL,
    computed_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fleet_ekg_sessions_pkey
      PRIMARY KEY (workspace_id, owner_id, session_id),
    CONSTRAINT fleet_ekg_sessions_event_count_check CHECK (event_count > 0)
);

CREATE INDEX IF NOT EXISTS fleet_ekg_sessions_ended_idx
  ON harness_shared.fleet_ekg_sessions (workspace_id, ended_at);

CREATE TABLE IF NOT EXISTS harness_shared.fleet_ekg_shifts (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id      text NOT NULL,
    window_date       date NOT NULL,
    feature           text NOT NULL,
    kind              text NOT NULL,
    score             double precision NOT NULL,
    severity          text NOT NULL,
    direction         text,
    window_start      timestamptz NOT NULL,
    window_end        timestamptz NOT NULL,
    baseline_sessions integer NOT NULL,
    window_sessions   integer NOT NULL,
    baseline_summary  double precision,
    window_summary    double precision,
    attributed        boolean NOT NULL DEFAULT false,
    ledger_candidates jsonb,
    notified_at       timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT fleet_ekg_shifts_dedup
      UNIQUE (workspace_id, feature, window_date),
    CONSTRAINT fleet_ekg_shifts_kind_check
      CHECK (kind IN ('numeric', 'mix', 'bigram')),
    CONSTRAINT fleet_ekg_shifts_severity_check
      CHECK (severity IN ('moderate', 'major'))
);

CREATE INDEX IF NOT EXISTS fleet_ekg_shifts_recent_idx
  ON harness_shared.fleet_ekg_shifts (workspace_id, window_date DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.fleet_ekg_sessions TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.fleet_ekg_shifts TO harness_app;
GRANT USAGE, SELECT
  ON SEQUENCE harness_shared.fleet_ekg_shifts_id_seq TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.fleet_ekg_sessions TO harness_zero;
  GRANT SELECT ON harness_shared.fleet_ekg_shifts TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
