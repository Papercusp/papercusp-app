-- 333-scout-routed-ideas-source-target-hive.sql
--
-- workspace-scoped-coordination-2026-06-20 P-001 / D-003 — source-hive tagging,
-- "the linchpin". The Scout half: tag every routed idea with the SOURCE HIVE it
-- came from (required, always known) + an OPTIONAL TARGET hive (a best-effort
-- cross-hive hint the workspace-Scout/Queen later resolves + routes on).
--
-- WHY — the workspace-scoped Scout (P-002) widens its corpus-digest to read ALL
-- the workspace's hives' routed ideas and must GROUP BY the source hive (and route
-- each idea/plan to its source/target hive). scout_routed_ideas (migration 194)
-- carries (workspace_id, harness_slug) but NO explicit hive: a harness is a MEMBER
-- of a hive (harness != hive in a multi-member hive), so the source hive is the
-- harness's hive-home, not its slug. This makes the hive an explicit, indexed
-- column so the cross-hive GROUP BY is a cheap read instead of a per-row
-- harness->hive re-resolution.
--
-- REUSE-FIRST (D-003): this EXTENDS the existing ledger with ONE more dimension
-- (the hive); it does NOT fork a parallel table. Mirrors the observation half
-- (rubric-driven-observations-2026-06-20 — engineer_issues.payload.observation
-- .sourceHive/targetHive), which already shipped (capture write-path + migration
-- 325 backfill); this is the same tag on the other cross-cutting artifact.
--
-- NULLABLE BY DESIGN (deploy-order safety) — source_hive is "REQUIRED" in the
-- D-003 sense of ALWAYS POPULATED, enforced at the WRITE PATH (recordRoutedIdea
-- resolves the hive-home from harness_slug and never writes null), NOT by a DB
-- NOT NULL constraint. A NOT NULL column would break the OLD live scout writer
-- (which does not yet supply the column) in the window before the writer change
-- deploys — and that window is wide right now (the green-deploy gate is frozen).
-- Same precedent as the observation sourceHive: optional in the type, guaranteed
-- by the write path. Every existing row is backfilled below, so the column is
-- non-null in practice and the P-002 GROUP BY has no null bucket.
--
-- BACKFILL — for existing rows, source_hive = harness_slug. This is the same
-- harness-slug-as-hive-home approximation migration 325 used ("the only
-- harness-scoped rows are standalone harnesses whose slug IS their hive
-- identity"); a member->home refinement is a v2 concern and the live write path
-- resolves it correctly going forward via hiveHomeSlugForHarness. target_hive is
-- left NULL (it is an optional hint only an explicit caller sets).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; backfill only fills NULLs; CREATE INDEX
-- IF NOT EXISTS); additive; fresh-migrate-safe. The table's RLS policy + grants
-- (migration 194) cover the new columns unchanged. Applies on :5432.

\set ON_ERROR_STOP on
BEGIN;

ALTER TABLE harness_shared.scout_routed_ideas
  ADD COLUMN IF NOT EXISTS source_hive text,
  ADD COLUMN IF NOT EXISTS target_hive text;

COMMENT ON COLUMN harness_shared.scout_routed_ideas.source_hive IS
  'The hive the routed idea came FROM (D-003 source-hive tag). Required-in-practice: '
  'the write path (recordRoutedIdea) resolves it from harness_slug->hive-home and never '
  'writes null; nullable only for deploy-order safety. The workspace-Scout groups by it.';
COMMENT ON COLUMN harness_shared.scout_routed_ideas.target_hive IS
  'Optional best-effort hint: the hive the idea is ABOUT / where resulting work would land. '
  'The workspace brain (P-002/P-003) resolves the true target + routes on it (D-003).';

-- Backfill existing rows: source_hive = harness_slug (the standalone-harness
-- hive-home proxy, mirroring migration 325). Only fills NULLs -> re-run safe,
-- never clobbers a write-path value.
UPDATE harness_shared.scout_routed_ideas
   SET source_hive = harness_slug
 WHERE source_hive IS NULL;

-- Supporting index for the workspace-scoped Scout corpus-digest (P-002):
-- GROUP BY source hive across all the workspace's hives.
CREATE INDEX IF NOT EXISTS scout_routed_ideas_ws_source_hive_idx
  ON harness_shared.scout_routed_ideas (workspace_id, source_hive);

COMMIT;
