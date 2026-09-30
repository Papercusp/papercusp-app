-- 448-usage-events-registry-fallback-backfill.sql
--
-- WI-1572 — backfill contributor_usage_events rows STRANDED at workspace_id
-- ='default' by the BEFORE-INSERT `fill_ws_usage_trg` (migration 301), whose
-- fill function (`harness_shared.fill_workspace_id_from_projects`) consults
-- ONLY the sparse, non-authoritative `harness_shared.projects` projection —
-- with NO fallback to the authoritative `harness_shared.harness_registry`
-- (payload->'projects' per workspace). A harness registered only in the
-- registry (papercusp itself: no `projects` row, but a real registry entry
-- under workspace 'papercusp-workspace') silently defaulted to 'default' on
-- every INSERT, and the drain never matches 'default' rows against the real
-- workspace → permanently stranded (843 papercusp rows observed live,
-- 2026-07-02). App-side fix (packages/operator-core/lib/harness/usage-events.ts
-- emitUsageEvent) now resolves via `resolveWorkspaceForHarness` (projects,
-- THEN the registry) and sets workspace_id explicitly on every future INSERT,
-- so the incomplete trigger fallback never gets a say going forward. THIS
-- migration is the one-time backfill for rows that already landed wrong.
--
-- Backfill rule (conservative — only touches an UNAMBIGUOUS resolution):
-- a stranded row's harness_slug must appear in EXACTLY ONE workspace's
-- registry `projects` array; a slug appearing in 2+ workspaces (a same-name
-- collision) is left untouched rather than guessed (mirrors
-- `lookupProjectWorkspaceIds`'s fail-loud-on-collision stance in
-- packages/operator-core/lib/agent-tools/plans/source.ts).
--
-- Named dollar-quote convention N/A (no plpgsql body needed — a plain CTE
-- UPDATE). Idempotent: re-running only touches rows still at 'default' whose
-- slug still resolves unambiguously; already-backfilled rows no longer match
-- the WHERE clause.

WITH registry_slugs AS (
  SELECT elem->>'slug' AS slug, r.workspace_id
    FROM harness_shared.harness_registry r,
         jsonb_array_elements(COALESCE(r.payload->'projects', '[]'::jsonb)) elem
   WHERE elem->>'slug' IS NOT NULL
), unambiguous AS (
  SELECT slug, MIN(workspace_id) AS workspace_id
    FROM registry_slugs
   GROUP BY slug
  HAVING COUNT(DISTINCT workspace_id) = 1
)
UPDATE harness_shared.contributor_usage_events u
   SET workspace_id = a.workspace_id
  FROM unambiguous a
 WHERE u.workspace_id = 'default'
   AND u.harness_slug = a.slug
   AND a.workspace_id IS NOT NULL
   AND a.workspace_id <> ''
   AND a.workspace_id <> 'default';
