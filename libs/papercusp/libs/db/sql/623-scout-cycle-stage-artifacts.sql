-- 623-scout-cycle-stage-artifacts.sql
--
-- learning-tab-visibility-2026-07-18 P-009 (plan D-001): persist the per-cycle
-- INTERMEDIATE pipeline artifacts the Scout engine computes but never ledgers,
-- so the Learning tab's Analyze stage can show the owner what actually happens
-- inside idea generation instead of hiding it.
--
-- ScoutCycleResult (scout/cycle.ts) already carries every stage in memory —
-- divergent-generation ideas (per-ideator, with lens), adversarial-critique
-- verdicts (keep/moonshot/reject + critic detail), and debate/recombine
-- proposals (sourceIdeaIds fusions) — but only the FINAL routed rows
-- (scout_routed_ideas), tick economics (scout_ticks), and the input digest
-- (scout_digest_snapshots, 582) persist. This table completes the picture:
-- ONE ROW PER FIRED CYCLE, one jsonb column per stage, joined to its siblings
-- by cycle_id. No digest column (582 owns it) and no cost/stop columns
-- (scout_ticks owns them) — join, don't duplicate.
--
-- Written best-effort at the run.ts tick seam (an artifact-persist outage must
-- never disturb the cycle — digest-snapshots contract); pruned inline to the
-- newest N rows per workspace (keep-30, days of history at current cadence).
--
-- Control-plane state (small, durable, operator-readable) → harness_shared in
-- the live operator DB, workspace-scoped, mirroring scout_ticks (208) / 582.
--
-- Idempotent (CREATE ... IF NOT EXISTS); additive; fresh-migrate-safe.

CREATE TABLE IF NOT EXISTS harness_shared.scout_cycle_stage_artifacts (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id   text NOT NULL,
    -- Same scope key as scout_ticks / the digest snapshots.
    install_slug   text,
    -- The fired cycle these artifacts belong to (scout_ticks detail.cycleId,
    -- scout_digest_snapshots.cycle_id, scout_routed_ideas provenance). The
    -- persist seam skips cycles without an id — nothing to join them to.
    cycle_id       text NOT NULL,
    -- Divergent generation (P-004 stage): Idea[] — per-ideator raw ideas incl.
    -- the creative lens each rode.
    ideas          jsonb,
    -- Adversarial critics (P-005 stage): ScoredIdea[] — verdict buckets
    -- (keep/moonshot/reject), novelty/feasibility notes, skeptic downgrades.
    scored         jsonb,
    -- Debate + recombine (P-006 stage): Proposal[] — fusions with
    -- sourceIdeaIds[] chains.
    proposals      jsonb,
    -- Per-slot ideator outcomes (EI-13119 lastIdeation): which roster slots
    -- ran/failed/emitted, for the ideation-roster leg of the Analyze view.
    ideator_slots  jsonb,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- One artifacts row per cycle per workspace — the read is a single row.
    CONSTRAINT scout_cycle_stage_artifacts_ws_cycle_uniq UNIQUE (workspace_id, cycle_id)
);

-- Primary read path: newest N cycles for a workspace (the Analyze view) and
-- the inline keep-N prune.
CREATE INDEX IF NOT EXISTS scout_cycle_stage_artifacts_ws_created_idx
    ON harness_shared.scout_cycle_stage_artifacts (workspace_id, created_at DESC);

DO $$ BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class
           WHERE oid = 'harness_shared.scout_cycle_stage_artifacts'::regclass) THEN
    ALTER TABLE harness_shared.scout_cycle_stage_artifacts ENABLE ROW LEVEL SECURITY;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'harness_shared'
                  AND tablename = 'scout_cycle_stage_artifacts'
                  AND policyname = 'scout_cycle_stage_artifacts_workspace_isolation') THEN
    CREATE POLICY scout_cycle_stage_artifacts_workspace_isolation
        ON harness_shared.scout_cycle_stage_artifacts
        USING ((workspace_id = current_setting('app.workspace_id'::text, true)))
        WITH CHECK ((workspace_id = current_setting('app.workspace_id'::text, true)));
  END IF;
  IF NOT has_table_privilege('harness_app', 'harness_shared.scout_cycle_stage_artifacts', 'INSERT') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.scout_cycle_stage_artifacts TO harness_app;
  END IF;
  IF NOT has_table_privilege('harness_zero', 'harness_shared.scout_cycle_stage_artifacts', 'SELECT') THEN
    GRANT SELECT ON harness_shared.scout_cycle_stage_artifacts TO harness_zero;
  END IF;
END $$;
