-- 194-scout-routed-ideas.sql
--
-- Scout loop P-013 (hive-creative-ideation-2026-06-08, D-009): the routed-idea
-- PROVENANCE + OUTCOME ledger — the substrate that lets the Hive meta-learn
-- which creative lenses win.
--
-- The Scout loop generates ideas (each tagged with the CreativeLens that
-- produced it) and routes the survivors into a rail (plan / gym / improvement,
-- P-007). To later ask "did this idea pan out, and therefore is its lens worth
-- favouring?" we need the one fact the Change Feed cannot carry: WHICH LENS
-- produced WHICH routed artifact. That linkage is genuine new state (not a
-- duplicate of any completion source, so self-learning-central D-005 holds — the
-- Change Feed stays a pure projection); this table is its home.
--
-- Read path (P-013): join `routed_ref` against the Change Feed (a projection over
-- work_items / gym_proposals / harness_plans) to derive each idea's outcome, then
-- aggregate per lens. `outcome`/`outcome_checked_at` are a recomputable CACHE of
-- that derivation so the Queen's "which lenses win" report is a cheap read.
--
-- Control-plane state (small, durable, operator-readable), so it lives in the
-- live operator DB's harness_shared schema, scoped by (workspace_id,
-- harness_slug) — mirrors gym_proposals (migration 110).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.scout_routed_ideas (
    -- The generated idea's id (Idea.id, P-004). One routing record per idea.
    idea_id                text PRIMARY KEY,
    workspace_id           text NOT NULL,
    harness_slug           text NOT NULL,
    -- The Scout cycle this idea came from (optional grouping for per-cycle reports).
    cycle_id               text,
    -- The CreativeLens that produced the idea — the attribution key (D-009):
    -- analogical | first-principles | reframing | constraint-removal.
    lens                   text NOT NULL,
    -- Which rail P-007 routed it into: plan | gym | improvement.
    rail                   text NOT NULL,
    -- The Change Feed `ref` of the artifact the routing created — the join key:
    -- 'plan:<slug>' | 'gym:<proposal-id>' | 'wi:<issue-id>'.
    routed_ref             text NOT NULL,
    -- One-line idea title (report drill-down).
    title                  text,
    -- The corpus MetaPattern.refs the idea targeted (grounding evidence).
    addresses_pattern_refs jsonb,
    -- When the idea was routed (epoch ms, matching the gym_proposals convention).
    routed_at              bigint NOT NULL,
    -- Outcome CACHE, recomputed from the Change Feed (won | lost | pending);
    -- null until the first refresh. The source of truth is the join, not this.
    outcome                text,
    outcome_checked_at     bigint
);

CREATE INDEX IF NOT EXISTS scout_routed_ideas_ws_harness_idx
    ON harness_shared.scout_routed_ideas (workspace_id, harness_slug);
CREATE INDEX IF NOT EXISTS scout_routed_ideas_ws_harness_lens_idx
    ON harness_shared.scout_routed_ideas (workspace_id, harness_slug, lens);
CREATE INDEX IF NOT EXISTS scout_routed_ideas_routed_ref_idx
    ON harness_shared.scout_routed_ideas (routed_ref);

-- Workspace isolation, mirroring gym_proposals (110). The operator connects as a
-- superuser role (harness_admin) which bypasses RLS; the policy keeps any
-- non-superuser path workspace-scoped + consistent with the rest of harness_shared.
ALTER TABLE harness_shared.scout_routed_ideas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scout_routed_ideas_workspace_isolation ON harness_shared.scout_routed_ideas;
CREATE POLICY scout_routed_ideas_workspace_isolation ON harness_shared.scout_routed_ideas
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (the scout:* / read paths run under the app role).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.scout_routed_ideas TO harness_app;
GRANT SELECT ON harness_shared.scout_routed_ideas TO harness_zero;
