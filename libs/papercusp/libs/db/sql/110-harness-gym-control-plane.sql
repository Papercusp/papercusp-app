-- 110-harness-gym-control-plane.sql
--
-- The gym CONTROL PLANE — the small, user-facing, persistent state behind the
-- generalized harness-gym UI (plan harness-gym-eval-optimizer-2026-06-02, the
-- generalize-to-any-harness arc + gym-ui-handoff-2026-06-02).
--
-- D-020 (refines D-018): the gym's heavy EXECUTION data — the real pipeline run,
-- transcripts, DBOS, per-task score vectors — stays in the dedicated ephemeral gym
-- PG (D-018 intact, isolated per run). But the *control plane* the UI reads and the
-- user acts on — the proposer's suggested prompt changes awaiting review, and the
-- per-harness autoloop config — must PERSIST and be readable by the live operator.
-- Those are small structured rows (like features/issues), so they live here in the
-- live operator DB's harness_shared schema, scoped by (workspace_id, harness_slug).
-- Prompt text itself already lives in harness_shared.harness_prompt_overrides
-- (000-baseline) — the gym writes proposed prompts there on accept.
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

-- The proposer's suggested prompt changes, one row PER ROLE (the user accepts or
-- rejects per role — gym-ui-handoff "accepting or rejecting per role"). The diff
-- the UI renders is (original_md → proposed_md) for `role`; the numbers beside it
-- are the candidate's hard signals at proposal time.
CREATE TABLE IF NOT EXISTS harness_shared.gym_proposals (
    id               text PRIMARY KEY,
    workspace_id     text NOT NULL,
    harness_slug     text NOT NULL,
    cycle            integer NOT NULL DEFAULT 0,
    -- The variant this proposal came from (traceability back to the gym run).
    variant_id       text,
    -- Which role's prompt is proposed to change ('judge' = the rubric prompt).
    role             text NOT NULL,
    -- The role's prompt at proposal time (the diff's left side) and the proposed
    -- full replacement (the diff's right side). original_md may be null when the
    -- role had no override yet (diff against empty).
    original_md      text,
    proposed_md      text NOT NULL,
    rationale        text,
    -- Hard numbers shown beside the diff (the candidate's, not per-role).
    dev_anchor_delta double precision,
    cost_delta       double precision,
    probe_status     text,
    -- pending | accepted | rejected | superseded
    status           text NOT NULL DEFAULT 'pending',
    created_at       bigint NOT NULL,
    decided_at       bigint
);

CREATE INDEX IF NOT EXISTS gym_proposals_ws_harness_status_idx
    ON harness_shared.gym_proposals (workspace_id, harness_slug, status);
CREATE INDEX IF NOT EXISTS gym_proposals_ws_harness_cycle_idx
    ON harness_shared.gym_proposals (workspace_id, harness_slug, cycle);

-- Per-harness autoloop control: the toggle + budget the UI drives, plus the
-- engine's running status. One row per (workspace, harness).
CREATE TABLE IF NOT EXISTS harness_shared.gym_autoloop_config (
    workspace_id  text NOT NULL,
    harness_slug  text NOT NULL,
    enabled       boolean NOT NULL DEFAULT false,
    -- USD budget cap for the loop; null = uncapped.
    budget_usd    double precision,
    spent_usd     double precision NOT NULL DEFAULT 0,
    -- idle | running | paused | exhausted
    status        text NOT NULL DEFAULT 'idle',
    last_cycle    integer,
    last_cycle_at bigint,
    updated_at    bigint NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug)
);

-- Workspace isolation, mirroring harness_prompt_overrides (000-baseline). The
-- operator connects as a SUPERUSER role (harness_admin) which bypasses RLS, but
-- the policy keeps any non-superuser path workspace-scoped + is consistent with
-- the rest of harness_shared.
ALTER TABLE harness_shared.gym_proposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_proposals_workspace_isolation ON harness_shared.gym_proposals;
CREATE POLICY gym_proposals_workspace_isolation ON harness_shared.gym_proposals
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

ALTER TABLE harness_shared.gym_autoloop_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_autoloop_config_workspace_isolation ON harness_shared.gym_autoloop_config;
CREATE POLICY gym_autoloop_config_workspace_isolation ON harness_shared.gym_autoloop_config
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (the gym:* routes read/write under the app role via
-- routeWithWorkspace). Explicit so the migration is self-contained regardless of
-- 109's ALTER DEFAULT PRIVILEGES timing. The roles are guaranteed to exist (109
-- already references harness_app).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.gym_proposals TO harness_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.gym_autoloop_config TO harness_app;
GRANT SELECT ON harness_shared.gym_proposals TO harness_zero;
GRANT SELECT ON harness_shared.gym_autoloop_config TO harness_zero;
