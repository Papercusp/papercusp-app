-- 193-gym-qd-archive.sql
--
-- The gym QUALITY-DIVERSITY (MAP-Elites) ARCHIVE — P-010 (hive-creative-ideation-2026-06-08,
-- D-008): one row per occupied niche cell (scope/domain/risk), holding the best-fitness
-- elite in that cell. This reframes the gym from objective-driven hill-climbing into
-- novelty/quality-diversity search — the best idea in EVERY region of the behavior space is
-- preserved (diversity + stepping-stones), not just the global champion.
--
-- D-020 placement: this is durable, cross-run CONTROL-PLANE state (like gym_proposals /
-- migration 110) — NOT per-run execution data (which stays in the ephemeral gym PG, D-018).
-- It must persist and be readable by the live operator (Scout reads stepping-stones; P-013
-- attributes outcomes), so it lives here in harness_shared, scoped by (workspace_id,
-- harness_slug). candidate_id = the gym variant_id, so P-013 joins it to
-- gym_proposals.variant_id for outcome attribution (no niche_key needed on gym_proposals).
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.gym_qd_archive (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    -- Canonical MAP-Elites cell key: `scope|domain|risk`.
    niche_key    text NOT NULL,
    -- The elite candidate's id = the gym variant_id (join to gym_proposals.variant_id), or
    -- a Scout-seeded id (source='scout').
    candidate_id text NOT NULL,
    -- The cell coordinates, denormalized for cheap querying/grouping.
    scope        text NOT NULL,
    domain       text NOT NULL,
    risk         text NOT NULL,
    -- Higher = better (the gym train-aggregate judge composite, or a Scout prior).
    fitness      double precision NOT NULL,
    -- The full BehaviorDescriptor (coords + the normalized feature vector for novelty-distance).
    descriptor   jsonb NOT NULL,
    -- 'gym' (a gym candidate) | 'scout' (a Scout-seeded distant niche, P-012).
    source       text NOT NULL DEFAULT 'gym',
    rationale    text,
    created_at   bigint NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint,
    updated_at   bigint NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, niche_key)
);

CREATE INDEX IF NOT EXISTS gym_qd_archive_ws_harness_fitness_idx
    ON harness_shared.gym_qd_archive (workspace_id, harness_slug, fitness DESC);
CREATE INDEX IF NOT EXISTS gym_qd_archive_candidate_idx
    ON harness_shared.gym_qd_archive (workspace_id, harness_slug, candidate_id);
CREATE INDEX IF NOT EXISTS gym_qd_archive_source_idx
    ON harness_shared.gym_qd_archive (workspace_id, harness_slug, source);

-- Workspace isolation, mirroring gym_proposals (migration 110). The operator connects as a
-- SUPERUSER role (harness_admin) which bypasses RLS; the policy keeps any non-superuser path
-- workspace-scoped + consistent with the rest of harness_shared.
ALTER TABLE harness_shared.gym_qd_archive ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gym_qd_archive_workspace_isolation ON harness_shared.gym_qd_archive;
CREATE POLICY gym_qd_archive_workspace_isolation ON harness_shared.gym_qd_archive
    USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
    WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));

-- Runtime-role grants (gym/scout read+write under the app role; zero reads for sync).
GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.gym_qd_archive TO harness_app;
GRANT SELECT ON harness_shared.gym_qd_archive TO harness_zero;
