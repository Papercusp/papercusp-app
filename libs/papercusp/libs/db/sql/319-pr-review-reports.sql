-- 319: PR agent-reviewer report store
-- (PLAN-pr-system-completion-dogfood Phase PR-2 — agent-reviewer + report).
--
-- The agent half of the owner's "human OR agent review" model. The poll daemon
-- (PR-1) triggers the agent-reviewer (packages/operator-core/lib/pr-host/
-- agent-reviewer.ts) for a new/updated PR; the reviewer reads the PR diff + its
-- WI/feature context (harness_feature_prs, PR-4) and writes a structured report
-- HERE. The PR-3 GUI renders it; PR-1's daemon reads `recommendation` to fold
-- into decideAutoReview in AUTO mode. The reviewer NEVER posts the GitHub
-- approval itself — it only stores a recommendation.
--
-- LOCAL table (no federation triggers): per Brief PR-4 the report is served from
-- the host's own DB via the GUI, not mirrored to members (default LOCAL + GUI-
-- served). Mirrors the sibling local PR tables auto_review_audit /
-- pr_check_status_cache (RLS workspace isolation, no fed_ts/outbox).
--
-- Keyed by (workspace_id, harness_slug, pr_number, head_sha): re-reviewing the
-- SAME diff is an idempotent UPSERT; a NEW head_sha is a fresh row, so per-diff
-- review history is preserved (audit/determinism — Brief PR-2 step 4).
--
-- The migration runner wraps each file in its own transaction (and strips psql
-- metacommands), so this file carries NO top-level BEGIN;/COMMIT; — an inner
-- COMMIT would end the runner's wrapper txn early (lint:migrations).

CREATE TABLE IF NOT EXISTS harness_shared.pr_review_reports (
    workspace_id    text NOT NULL DEFAULT ''::text,
    harness_slug    text NOT NULL,
    pr_number       integer NOT NULL,
    pr_url          text NOT NULL,
    head_sha        text NOT NULL DEFAULT ''::text,  -- diff fingerprint: which commit was reviewed
    feature_id      text,                            -- linked WI (PR-4 harness_feature_prs); null until linked
    recommendation  text NOT NULL,                   -- approve | request_changes | reject
    summary         text NOT NULL,
    rationale       text NOT NULL,
    risks           jsonb NOT NULL DEFAULT '[]'::jsonb,
    checks_observed jsonb NOT NULL DEFAULT '{}'::jsonb,  -- deterministic facts (CI/secret/tests/empty)
    -- Provenance: which model produced this on what diff, at what cost (audit).
    model           text NOT NULL,
    tokens_in       bigint NOT NULL DEFAULT 0,
    tokens_out      bigint NOT NULL DEFAULT 0,
    cost_usd_cents  bigint NOT NULL DEFAULT 0,
    reviewed_at     timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT pr_review_reports_recommendation_check
      CHECK (recommendation = ANY (ARRAY['approve'::text, 'request_changes'::text, 'reject'::text]))
);

DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pr_review_reports_pkey') THEN
    ALTER TABLE ONLY harness_shared.pr_review_reports
      ADD CONSTRAINT pr_review_reports_pkey
      PRIMARY KEY (workspace_id, harness_slug, pr_number, head_sha);
  END IF;
END
$body$;

-- GUI/daemon read path: newest report for a PR.
CREATE INDEX IF NOT EXISTS pr_review_reports_pr_idx
  ON harness_shared.pr_review_reports (workspace_id, harness_slug, pr_number, reviewed_at DESC);

ALTER TABLE harness_shared.pr_review_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pr_review_reports_workspace_isolation ON harness_shared.pr_review_reports;
CREATE POLICY pr_review_reports_workspace_isolation ON harness_shared.pr_review_reports
  USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
  WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Extend the auto_review_audit action vocabulary: the agent-reviewer records an
-- `agent_review` (or `agent_review_error`) event so a recommendation is
-- traceable (Brief PR-2 step 4). DROP+ADD the CHECK (no inner txn control).
ALTER TABLE harness_shared.auto_review_audit
  DROP CONSTRAINT IF EXISTS auto_review_audit_action_check;
ALTER TABLE harness_shared.auto_review_audit
  ADD CONSTRAINT auto_review_audit_action_check
  CHECK (action = ANY (ARRAY[
    'auto_approve'::text, 'auto_merge'::text,
    'manual_approve'::text, 'manual_merge'::text,
    'skipped_untrusted'::text, 'skipped_checks_failing'::text,
    'error'::text,
    'agent_review'::text, 'agent_review_error'::text
  ]));
