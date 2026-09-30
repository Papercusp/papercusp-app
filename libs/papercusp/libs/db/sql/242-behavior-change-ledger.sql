-- 242-behavior-change-ledger.sql
--
-- self-learning-frontier-2026-06-12 (P-004 / FB-02, D-003): the APPEND-ONLY
-- ledger of behavior-affecting changes — every prompt/rule mutation from any
-- source. The gym, shadow ablation (FB-09), and any future probation window all
-- mutate the prompt layer; without one ledger the fleet EKG's (P-030)
-- distribution shifts are unattributable. One row per mutation, written
-- best-effort AT MUTATION TIME by:
--
--   - the gym committer (decideProposal accept → harness_prompt_overrides
--     upsert; packages/operator-core/lib/gym/control-plane.ts)
--   - the prompt-override API (PUT/DELETE/reset-all on /harness/:slug/prompts,
--     both the commit-reproject and pg-override branches)
--   - the repo prompt-file scanner (system:change-ledger-scan — playbook /
--     persona / spawn-prompt file edits recovered from git log)
--   - the (future) FB-09 ablation seam — any ablation-driven live prompt edit
--
-- Vocabulary (source / mutation_class / action / target_kind) is OWNED by
-- packages/operator-core/lib/change-ledger/change-ledger.ts — columns stay
-- plain text so the seam can evolve it (mirroring improvement_dispatches, 238).
-- mutation_class is the D-003 mutation-calendar serialization unit ('gym' |
-- 'manual-prompt' | 'repo-prompt' | 'ablation'); one-live-class-at-a-time is
-- ADVISORY (surfaced by the calendar read), never enforced here.
--
-- APPEND-ONLY is enforced at the grant level: harness_app gets SELECT + INSERT
-- only (no UPDATE/DELETE). Rows are never driven through states — a mutation
-- happened or it didn't.
--
-- The dedupe index makes idempotent writers cheap: the repo scanner re-reads a
-- trailing git-log window every tick and relies on ON CONFLICT DO NOTHING over
-- (workspace_id, source, diff_ref, target). Sources without a natural identity
-- pass diff_ref NULL — NULLS DISTINCT keeps every such row insertable.
--
-- Control-plane state in the live operator DB's harness_shared schema, scoped
-- by workspace_id, mirroring improvement_dispatches (238) / watchdog_ticks (202).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.behavior_change_ledger (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id    text NOT NULL,
    recorded_at     timestamptz NOT NULL DEFAULT now(),
    -- The writing system ('gym:accept' | 'gym:promotion' | 'prompts-api' |
    -- 'repo-scan' | 'ablation' | 'manual' — see change-ledger.ts).
    source          text NOT NULL,
    -- The D-003 calendar serialization unit ('gym' | 'manual-prompt' |
    -- 'repo-prompt' | 'ablation').
    mutation_class  text NOT NULL,
    -- What happened to the target ('set' | 'clear' | 'clear-all' | 'edit').
    action          text NOT NULL,
    -- What kind of thing mutated ('prompt-override' | 'prompt-file').
    target_kind     text NOT NULL,
    -- The mutated thing: '<harness>/<role>' for an override, the repo-relative
    -- path for a prompt file.
    target          text NOT NULL,
    harness_slug    text,
    role            text,
    -- Reference to the change content: gym proposal id, git commit sha,
    -- commit-reproject commit, ablation run id. NULL when none exists.
    diff_ref        text,
    -- Who made the change (commit author, deciding caller, routine name).
    actor           text,
    summary         text,
    payload         jsonb
);

-- Primary read path: recent changes for a workspace, newest first (the
-- mutation calendar + change_ledger:list + future EKG attribution).
CREATE INDEX IF NOT EXISTS behavior_change_ledger_ws_recorded_idx
    ON harness_shared.behavior_change_ledger (workspace_id, recorded_at DESC);

-- Per-class reads (the calendar's live-class window scan).
CREATE INDEX IF NOT EXISTS behavior_change_ledger_ws_class_idx
    ON harness_shared.behavior_change_ledger (workspace_id, mutation_class, recorded_at DESC);

-- Idempotent-writer dedupe (see header). NULLS DISTINCT (the default): rows
-- without a diff_ref never collide.
CREATE UNIQUE INDEX IF NOT EXISTS behavior_change_ledger_dedupe_idx
    ON harness_shared.behavior_change_ledger (workspace_id, source, diff_ref, target);

-- Workspace isolation, mirroring improvement_dispatches (238). The operator
-- connects as harness_admin (superuser, bypasses RLS); the policy keeps any
-- non-superuser path workspace-scoped + consistent with the rest of
-- harness_shared.
ALTER TABLE harness_shared.behavior_change_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS behavior_change_ledger_workspace_isolation ON harness_shared.behavior_change_ledger;
CREATE POLICY behavior_change_ledger_workspace_isolation ON harness_shared.behavior_change_ledger
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants: APPEND-ONLY for the app role — SELECT + INSERT, no
-- UPDATE/DELETE (the ledger's core invariant, enforced here not in code).
GRANT SELECT, INSERT ON harness_shared.behavior_change_ledger TO harness_app;
GRANT SELECT ON harness_shared.behavior_change_ledger TO harness_zero;
