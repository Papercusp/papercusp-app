-- 450-features-issues-registry-fallback-backfill.sql
--
-- WI-1612 (same class as WI-1572 / migration 448) — backfill `harness_shared.work_items`
-- feature-family rows and `harness_shared.harness_issues_consolidated` rows STRANDED at
-- workspace_id='default' by the BEFORE-INSERT triggers `fill_ws_features_trg` /
-- `fill_ws_issues_trg`, whose shared fill function
-- (`harness_shared.fill_workspace_id_from_projects`) consults ONLY the sparse,
-- non-authoritative `harness_shared.projects` projection — with NO fallback to the
-- authoritative `harness_shared.harness_registry` (payload->'projects' per workspace).
-- A harness registered only in the registry (papercusp itself: no `projects` row, but a
-- real registry entry under workspace 'papercusp-workspace') silently defaulted to
-- 'default' on every trigger-filled INSERT. The code-level fix (this migration's
-- sibling change) now writes workspace_id explicitly on every hyperbee-federation
-- projection INSERT (sync/hyperbee/projections/harness-features.ts + issues.ts), so the
-- incomplete trigger fallback never gets a say going forward. THIS migration is the
-- one-time backfill for rows that already landed wrong (confirmed live 2026-07-02: 179
-- work_items feature-family rows + 1 harness_issues_consolidated row at 'default').
--
-- Backfill rule (conservative — only touches an UNAMBIGUOUS resolution, mirrors
-- migration 448 exactly): a stranded row's harness_slug must appear in EXACTLY ONE
-- workspace's registry `projects` array; a slug appearing in 2+ workspaces (a
-- same-name collision) is left untouched rather than guessed.
--
-- Idempotent: re-running only touches rows still at 'default' whose slug still
-- resolves unambiguously; already-backfilled rows no longer match the WHERE clause.

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
UPDATE harness_shared.work_items w
   SET workspace_id = a.workspace_id
  FROM unambiguous a
 WHERE w.workspace_id = 'default'
   AND w.item_kind NOT IN ('bug', 'change', 'task')
   AND w.harness_slug = a.slug
   AND a.workspace_id IS NOT NULL
   AND a.workspace_id <> ''
   AND a.workspace_id <> 'default';

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
UPDATE harness_shared.harness_issues_consolidated u
   SET workspace_id = a.workspace_id
  FROM unambiguous a
 WHERE u.workspace_id = 'default'
   AND u.harness_slug = a.slug
   AND a.workspace_id IS NOT NULL
   AND a.workspace_id <> ''
   AND a.workspace_id <> 'default';
