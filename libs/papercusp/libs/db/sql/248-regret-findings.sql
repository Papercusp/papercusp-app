-- 248-regret-findings.sql
--
-- self-learning-frontier-2026-06-12 (P-021 / FB-07): regret mining — one row
-- per mined BAD historical session (high burn / validator bounces / human
-- rescue), recording where the trajectory diverged, the candidate
-- what-would-have-helped changes, and (once the FB-06 replay leg runs) their
-- counterfactual replay scores.
--
-- Rows are ADDITIVE per session (PK workspace+run): a re-mine upserts the
-- detection columns but CARRIES FORWARD report_improvement_id and replay
-- results (the FB-04 carry-forward rule — a filed report never re-files, a
-- paid-for replay never re-runs).
--
--   badness_score / badness_reasons: selection-heuristic output (token-burn
--     percentile within the role cohort over agent_usage_samples /
--     transcript size, failed/cancelled status, timeout exit, validator
--     bounces via harness_features_consolidated.attempts).
--   divergence_turn / kind / evidence: transcript-level detection over the
--     persisted stream (harness_run_output.jsonl_body) — the assistant-turn
--     index where the trajectory went bad. NULL = no transcript or no signal
--     above bar.
--   candidate_changes: templated what-would-have-helped rule deltas (jsonb
--     array) — the counterfactual replay inputs.
--   replay_status: pending (awaiting the FB-06 replay leg) | replayed |
--     skipped (no transcript / no divergence — nothing to replay).
--   replay_scores: per-candidate improvement scores from the replay harness
--     (origin=replay spend, learning-governor budgeted).
--   report_improvement_id: engineer_issues id once the scored report was
--     filed through the capture core (origin=replay; dark until P-001).
--
-- No RLS (mirrors 245-negative-space-demand): the miner and readers scope by
-- workspace_id explicitly.

CREATE TABLE IF NOT EXISTS harness_shared.regret_findings (
    workspace_id          text NOT NULL,
    run_id                text NOT NULL,
    harness_slug          text NOT NULL,
    role                  text,
    badness_score         double precision NOT NULL,
    badness_reasons       jsonb NOT NULL DEFAULT '[]'::jsonb,
    divergence_turn       integer,
    divergence_kind       text,
    divergence_evidence   jsonb,
    candidate_changes     jsonb NOT NULL DEFAULT '[]'::jsonb,
    replay_status         text NOT NULL DEFAULT 'pending',
    replay_scores         jsonb,
    report_improvement_id text,
    mined_at              timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT regret_findings_pkey PRIMARY KEY (workspace_id, run_id),
    CONSTRAINT regret_findings_replay_status_check
      CHECK (replay_status IN ('pending', 'replayed', 'skipped')),
    CONSTRAINT regret_findings_divergence_kind_check
      CHECK (divergence_kind IS NULL
             OR divergence_kind IN ('error-loop', 'repeat-loop', 'burn-inflection', 'rescue-marker'))
);

CREATE INDEX IF NOT EXISTS regret_findings_pending_idx
  ON harness_shared.regret_findings (workspace_id, mined_at DESC)
  WHERE replay_status = 'pending';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.regret_findings TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.regret_findings TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
