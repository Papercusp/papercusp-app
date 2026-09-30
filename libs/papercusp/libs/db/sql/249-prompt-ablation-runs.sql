-- 249-prompt-ablation-runs.sql
--
-- self-learning-frontier-2026-06-12 (P-023 / FB-09): prompt sedimentology —
-- the shadow-ablation evidence ledger. One row per ablation cycle: the
-- weekly routine removes ONE governance rule from the SU playbook (shadow
-- only — the live prompt is NEVER mutated), replays the llm-testing `su`
-- scenario suite baseline-vs-ablated, and records the behavioral delta.
--
-- The dead-weight report aggregates THESE rows across weeks: a rule that
-- survives repeated ablation with zero behavioral delta is a dead-weight
-- candidate for owner review (any actual removal is a normal reviewed edit
-- riding the behavior-change ledger + release gate — never automated here).
--
--   playbook_path/playbook_hash: the source file + body sha256 at run time —
--                             evidence is only comparable while the hash holds.
--   rule_key:               stable id `<section-slug>/<rule-slug>` from the
--                             playbook segmentation (lib/ablation/rules.ts).
--   rule_hash:              sha256 (12 hex) of the normalized rule text —
--                             evidence resets when the rule's wording changes.
--   origin:                 always 'shadow' (D-002 provenance vocabulary) —
--                             these rows are synthetic self-experimentation,
--                             never organic learning signals.
--   verdict:                scoring.ts behavioral-delta verdict for the cycle.
--   capped:                 the per-cycle governor budget stopped the suite
--                             early (partial evidence; weighed accordingly).
--   ledger_context:         recent behavior-change-ledger rows touching prompt
--                             sources (D-003 conditioning — a delta is only
--                             attributable while no live mutation overlapped).
--   detail:                 per-scenario arms (pass/fail, judge axes, cost,
--                             regressions) — the full evidence for the report.
--   replay_leg:             reserved for the FB-06 replay-sample leg (NULL
--                             until that evidence leg is wired).
--
-- Volume: one row per weekly cycle — trivially small. No RLS (mirrors
-- 245-negative-space-demand): writer + readers scope by workspace_id.

CREATE TABLE IF NOT EXISTS harness_shared.prompt_ablation_runs (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id       text NOT NULL,
    started_at         timestamptz NOT NULL,
    finished_at        timestamptz NOT NULL DEFAULT now(),
    playbook_path      text NOT NULL,
    playbook_hash      text NOT NULL,
    rule_key           text NOT NULL,
    rule_hash          text NOT NULL,
    rule_excerpt       text NOT NULL,
    origin             text NOT NULL DEFAULT 'shadow',
    scenario_count     integer NOT NULL DEFAULT 0,
    baseline_pass_rate double precision,
    ablated_pass_rate  double precision,
    pass_rate_delta    double precision,
    verdict            text NOT NULL,
    capped             boolean NOT NULL DEFAULT false,
    cost_usd           double precision NOT NULL DEFAULT 0,
    ledger_context     jsonb,
    detail             jsonb NOT NULL,
    replay_leg         jsonb,
    CONSTRAINT prompt_ablation_runs_origin_check
      CHECK (origin = 'shadow'),
    CONSTRAINT prompt_ablation_runs_verdict_check
      CHECK (verdict IN ('load-bearing', 'no-delta', 'improved', 'inconclusive'))
);

CREATE INDEX IF NOT EXISTS prompt_ablation_runs_rule_idx
  ON harness_shared.prompt_ablation_runs (workspace_id, rule_key, finished_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON harness_shared.prompt_ablation_runs TO harness_app;
DO $z$ BEGIN
  GRANT SELECT ON harness_shared.prompt_ablation_runs TO harness_zero;
EXCEPTION WHEN undefined_object THEN NULL;
END $z$;
