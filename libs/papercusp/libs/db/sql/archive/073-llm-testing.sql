-- 073 — LLM testing framework tables.
--
-- Generic-from-day-1 framework for testing any LLM-driven chat surface
-- (operator first; architect / scoper / worker / brain-debug / oracle
-- next). Plan: apps/operator/docs/plans/llm-testing-framework-2026-05-14.md
--
-- Tables:
--   - llm_test_runs              one row per Scenario × Persona × Model invocation
--   - llm_test_findings          assertion violations + judge findings (with promotion lineage)
--   - llm_test_fixtures          version-controlled transcripts for replay
--   - operator_continue_chains   ledger for B3/B4 deterministic asserts (V8 continue-chain caps)
--   - llm_test_matrix_results    aggregate view over runMatrix groups (§2.4)
--
-- Idempotent (CREATE TABLE IF NOT EXISTS). Named dollar-quoted block per
-- `feedback_named_dollar_quote_in_sql` memory rule.

BEGIN;

-- ============================================================================
-- llm_test_runs — one row per single SUT-vs-Sim run.
-- A runMatrix.repeat=N scenario produces N rows, all sharing matrix_group_id.
-- ============================================================================

CREATE TABLE IF NOT EXISTS harness_shared.llm_test_runs (
  id                   uuid          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- scenario identity
  scenario_id          text          NOT NULL,             -- e.g. 'op-S01-status-quick'
  scenario_version     int           NOT NULL,             -- bumps when behavior contract changes
  scenario_target      text          NOT NULL,             -- ChatTarget.id (e.g. 'operator')
  scenario_hash        text          NOT NULL,             -- sha256 of scenario file at run time

  -- comparability hash: same identity = directly comparable across runs/time
  identity_hash        text          NOT NULL,             -- sha256(scenario, persona_traits, rubric_version, sut_model, judge_model)

  -- runMatrix grouping (§2.4)
  matrix_group_id      uuid,                                -- NULL if scenario.runMatrix.repeat = 1
  matrix_index         int,                                 -- 0..N-1 within matrix_group_id

  -- versions / models
  rubric_version       text          NOT NULL,
  sut_model            text          NOT NULL,              -- 'claude-sonnet-4-6', etc.
  judge_model          text          NOT NULL,              -- 'claude-sonnet-4-6' or 'claude-opus-4-7'

  -- persona (resolved blends → traits)
  persona_id           text          NOT NULL,              -- blend name or 'inline'
  persona_traits_json  jsonb         NOT NULL,              -- resolved PersonaTraits

  -- run mode
  workspace_mode       text          NOT NULL,              -- 'isolated' | 'real'
  transport_mode       text          NOT NULL,              -- 'in-process' | 'http-sse'

  -- lifecycle
  status               text          NOT NULL,              -- 'running'|'passed'|'failed'|'errored'|'aborted'|'preview'
  started_at           timestamptz   NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  cost_usd             numeric(10,6) NOT NULL DEFAULT 0,
  cap_breaches         text[]        NOT NULL DEFAULT '{}', -- 'turns'|'wallclock'|'cost'

  -- denormalised summary for cheap list queries
  scores_json          jsonb,                                -- { axis: 0..5 }
  findings_count       jsonb         NOT NULL DEFAULT '{}'::jsonb, -- { error: 2, warn: 5, info: 1 }

  -- full payload
  transcript_raw_zstd  bytea,                                -- zstd-compressed JSONL of SSE events
  transcript_norm_json jsonb         NOT NULL DEFAULT '{}'::jsonb, -- normalised TurnResult[]
  telemetry_json       jsonb         NOT NULL DEFAULT '{}'::jsonb, -- pulled tool_invocations rows
  asserts_json         jsonb         NOT NULL DEFAULT '{}'::jsonb, -- { definitions, violations }
  judge_json           jsonb,                                -- raw judge response
  metadata_json        jsonb         NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS llm_test_runs_target_scenario_started_idx
  ON harness_shared.llm_test_runs (scenario_target, scenario_id, started_at DESC);

CREATE INDEX IF NOT EXISTS llm_test_runs_identity_started_idx
  ON harness_shared.llm_test_runs (identity_hash, started_at DESC);

CREATE INDEX IF NOT EXISTS llm_test_runs_matrix_group_idx
  ON harness_shared.llm_test_runs (matrix_group_id) WHERE matrix_group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS llm_test_runs_status_idx
  ON harness_shared.llm_test_runs (status, started_at DESC);

-- ============================================================================
-- llm_test_findings — assertion violations + judge findings.
-- Carries shape + promotion lineage for the novel-failure promotion loop (§6.6).
-- ============================================================================

CREATE TABLE IF NOT EXISTS harness_shared.llm_test_findings (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 uuid        NOT NULL REFERENCES harness_shared.llm_test_runs(id) ON DELETE CASCADE,
  source                 text        NOT NULL,                   -- 'assert' | 'judge' | 'variance'
  severity               text        NOT NULL,                   -- 'error' | 'warn' | 'info'
  axis                   text,                                    -- nullable for assert-source
  assert_kind            text,                                    -- nullable for judge-source
  shape                  text,                                    -- sha256(axis + summary_normalized)
  evidence_turn_idx      int,
  claim                  text        NOT NULL,
  suggestion             text,
  copy_prompt            text,                                    -- pre-formatted "send to fixer agent"
  promoted_to_assert_id  text,                                    -- non-null once promoted to a built-in
  promoted_from          text[]      NOT NULL DEFAULT '{}',       -- finding-ids the promoted assert came from
  acknowledged           boolean     NOT NULL DEFAULT false,
  acknowledged_by        text,
  acknowledged_at        timestamptz
);

CREATE INDEX IF NOT EXISTS llm_test_findings_run_severity_idx
  ON harness_shared.llm_test_findings (run_id, severity);

CREATE INDEX IF NOT EXISTS llm_test_findings_shape_severity_idx
  ON harness_shared.llm_test_findings (shape, severity) WHERE shape IS NOT NULL;

CREATE INDEX IF NOT EXISTS llm_test_findings_ack_severity_idx
  ON harness_shared.llm_test_findings (acknowledged, severity);

-- ============================================================================
-- llm_test_fixtures — version-controlled SSE tapes for replay.
-- The /tmp/v8-e2e-recordings/ scenarios get imported here in Phase 0.
-- ============================================================================

CREATE TABLE IF NOT EXISTS harness_shared.llm_test_fixtures (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id           text        NOT NULL,
  label                 text        NOT NULL,                    -- e.g. 'baseline-2026-05-14'
  sse_tape_json         jsonb       NOT NULL,                    -- recorded SSE events keyed by turn
  user_inputs_json      jsonb       NOT NULL,                    -- recorded sim-user actions
  recorded_at           timestamptz NOT NULL DEFAULT now(),
  recorded_from_run_id  uuid        REFERENCES harness_shared.llm_test_runs(id) ON DELETE SET NULL,
  UNIQUE (scenario_id, label)
);

CREATE INDEX IF NOT EXISTS llm_test_fixtures_scenario_idx
  ON harness_shared.llm_test_fixtures (scenario_id, recorded_at DESC);

-- ============================================================================
-- operator_continue_chains — V8 continue-chain ledger.
-- Promoted from "follow-up" to Phase 0 blocker by Round-2 review.
-- The operator provider/handler writes one row per turn in a continue chain.
-- Runner queries by ui_client_id (which carries the test runId) for B3/B4
-- asserts in scenarios S03 (cap-count) and S04 (cap-time).
-- ============================================================================

CREATE TABLE IF NOT EXISTS harness_shared.operator_continue_chains (
  id                     bigserial   PRIMARY KEY,
  conversation_id        uuid        NOT NULL,
  ui_client_id           text        NOT NULL,                   -- matches metadata_json->>'uiClientId' on tool_invocations
  chain_id               uuid        NOT NULL,                   -- groups one chain (continuous <continue/> turns)
  turn_idx               int         NOT NULL,                   -- 0-indexed within chain
  trigger                text        NOT NULL,                   -- 'continue' | 'auto_fire_terminal' | 'reset'
  started_at             timestamptz NOT NULL DEFAULT now(),
  elapsed_secs_in_chain  numeric(10,3) NOT NULL,
  was_capped             boolean     NOT NULL DEFAULT false,
  cap_reason             text                                    -- 'max_turns' | 'max_secs' | NULL
);

CREATE INDEX IF NOT EXISTS operator_continue_chains_chain_turn_idx
  ON harness_shared.operator_continue_chains (chain_id, turn_idx);

CREATE INDEX IF NOT EXISTS operator_continue_chains_uic_started_idx
  ON harness_shared.operator_continue_chains (ui_client_id, started_at DESC);

CREATE INDEX IF NOT EXISTS operator_continue_chains_conversation_idx
  ON harness_shared.operator_continue_chains (conversation_id, started_at DESC);

-- ============================================================================
-- View: matrix-aggregate results — one row per matrix_group_id with mean/stddev/majority.
-- ============================================================================

CREATE OR REPLACE VIEW harness_shared.llm_test_matrix_results AS
  SELECT matrix_group_id,
         scenario_id,
         scenario_version,
         identity_hash,
         COUNT(*)                          AS n_runs,
         mode() WITHIN GROUP (ORDER BY status) AS majority_status,
         jsonb_object_agg(axis, stddev_score) AS stddev_by_axis
  FROM (
    SELECT r.matrix_group_id,
           r.scenario_id,
           r.scenario_version,
           r.identity_hash,
           r.status,
           k.key                                                                   AS axis,
           stddev_pop((k.value)::numeric) OVER (PARTITION BY r.matrix_group_id, k.key) AS stddev_score
    FROM harness_shared.llm_test_runs r,
         LATERAL jsonb_each_text(r.scores_json) k
    WHERE r.matrix_group_id IS NOT NULL
      AND r.scores_json IS NOT NULL
  ) s
  GROUP BY matrix_group_id, scenario_id, scenario_version, identity_hash;

-- ============================================================================
-- Grants — harness_admin can do everything; harness_read can SELECT.
-- ============================================================================

DO $body$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.llm_test_runs           TO harness_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.llm_test_findings       TO harness_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.llm_test_fixtures       TO harness_admin;
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.operator_continue_chains TO harness_admin;
    GRANT SELECT                          ON harness_shared.llm_test_matrix_results TO harness_admin;
    GRANT USAGE, SELECT ON SEQUENCE harness_shared.operator_continue_chains_id_seq TO harness_admin;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_read') THEN
    GRANT SELECT ON harness_shared.llm_test_runs            TO harness_read;
    GRANT SELECT ON harness_shared.llm_test_findings        TO harness_read;
    GRANT SELECT ON harness_shared.llm_test_fixtures        TO harness_read;
    GRANT SELECT ON harness_shared.operator_continue_chains TO harness_read;
    GRANT SELECT ON harness_shared.llm_test_matrix_results  TO harness_read;
  END IF;
END
$body$;

COMMIT;
