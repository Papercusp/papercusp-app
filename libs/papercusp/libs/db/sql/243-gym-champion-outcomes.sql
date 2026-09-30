-- 243-gym-champion-outcomes.sql
--
-- Gym POST-ACCEPTANCE outcome tracking (self-improvement-consume-edges-2026-06-12
-- P-030 / brief B-09) — closes the gym's "did it actually help" gap.
--
-- One row per ACCEPTED gym proposal (the durable "champion" event — production is
-- always human-gated via decideProposal, D-020). At acceptance we snapshot the
-- candidate's gym-eval numbers (dev-anchor Δ / cost Δ / probe status, off the
-- proposal row) plus a LIVE-RUN baseline: the spawned_agents success/failure
-- counts for the accepted role over a window BEFORE acceptance. Once the same
-- window has elapsed AFTER acceptance, the gym tick finalizes the row: post
-- counts, success-rate delta, and a verdict. Recent verdicts prime the proposer
-- (lib/gym/post-acceptance-outcomes.ts mirrors lib/scout/ideator-feedback-priming).
--
-- Lives in the control plane (live operator DB), NOT the gym execution PG — the
-- execution DB is an ephemeral per-cycle testcontainer (D-018/D-020); anything
-- that must survive a cycle lives here in harness_shared.
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.gym_champion_outcomes (
    -- The accepted harness_shared.gym_proposals row (acceptance is per role-proposal).
    proposal_id               text PRIMARY KEY,
    workspace_id              text NOT NULL,
    harness_slug              text NOT NULL,
    -- Which role's prompt the accepted change targets ('judge' = the rubric; judge
    -- rows have no spawned_agents runs and settle as insufficient-data).
    role                      text NOT NULL,
    variant_id                text,
    cycle                     integer NOT NULL DEFAULT 0,
    accepted_at               bigint NOT NULL,
    -- Acceptance-time gym-eval snapshot (copied from the proposal row).
    baseline_dev_anchor_delta double precision,
    baseline_cost_delta       double precision,
    baseline_probe_status     text,
    -- Live-run baseline: spawned_agents terminal counts for (harness, role) over
    -- [accepted_at - window, accepted_at). done ⇒ succeeded, failed ⇒ failed;
    -- running/cancelled/reaped are indeterminate and excluded.
    baseline_runs             integer NOT NULL DEFAULT 0,
    baseline_succeeded        integer NOT NULL DEFAULT 0,
    baseline_failed           integer NOT NULL DEFAULT 0,
    -- The post-acceptance comparison window is [accepted_at, post_window_ends_at).
    post_window_ends_at       bigint NOT NULL,
    -- Written at finalization (null until the window closes).
    post_runs                 integer,
    post_succeeded            integer,
    post_failed               integer,
    -- post success rate minus baseline success rate (null when either side has no runs).
    success_rate_delta        double precision,
    -- pending | improved | regressed | neutral | insufficient-data
    verdict                   text NOT NULL DEFAULT 'pending',
    evaluated_at              bigint
);

CREATE INDEX IF NOT EXISTS gym_champion_outcomes_ws_harness_accepted_idx
    ON harness_shared.gym_champion_outcomes (workspace_id, harness_slug, accepted_at DESC);
-- The finalizer's scan: pending rows whose window has elapsed.
CREATE INDEX IF NOT EXISTS gym_champion_outcomes_pending_due_idx
    ON harness_shared.gym_champion_outcomes (post_window_ends_at)
    WHERE verdict = 'pending';

-- Workspace isolation + grants, mirroring 110-harness-gym-control-plane.sql.
ALTER TABLE harness_shared.gym_champion_outcomes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_champion_outcomes_workspace_isolation ON harness_shared.gym_champion_outcomes;
CREATE POLICY gym_champion_outcomes_workspace_isolation ON harness_shared.gym_champion_outcomes
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.gym_champion_outcomes TO harness_app;
GRANT SELECT ON harness_shared.gym_champion_outcomes TO harness_zero;
