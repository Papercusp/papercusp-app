-- 221: backfill blank harness_text_artifacts.workspace_id (EI-280).
--
-- Audit P-012 put the workspace-isolation RLS policy to work on
-- harness_text_artifacts (reads/writes moved off the rolbypassrls admin
-- handle onto the GUC-scoped ctx.tx). Rows written BEFORE that fix carry the
-- legacy '' stamp, which makes them (a) invisible to artifacts:load from
-- every workspace and (b) poison pills for artifacts:save — the upsert's
-- ON CONFLICT hits the blank row, whose UPDATE fails the policy.
--
-- Mapping precedence per harness registration:
--   1. harness_shared.projects (the registry; authoritative where present)
--   2. harness_shared.token_index, only where the slug maps to exactly ONE
--      workspace (ambiguous slugs are skipped by this leg)
--   3. 'default' — the standing workspace of a single-workspace install.
--      (A multi-workspace dev box may need a one-time manual correction for
--      unregistered slugs, as recorded on EI-280; new writes self-stamp so
--      the class does not regrow.)
--
-- Idempotent: only touches rows whose workspace_id is '' / NULL.

UPDATE harness_shared.harness_text_artifacts a
   SET workspace_id = p.workspace_id
  FROM harness_shared.projects p
 WHERE COALESCE(a.workspace_id, '') = ''
   AND p.slug = a.harness_slug
   AND COALESCE(p.workspace_id, '') <> '';

UPDATE harness_shared.harness_text_artifacts a
   SET workspace_id = ti.workspace_id
  FROM (
        SELECT harness_slug, MIN(workspace_id) AS workspace_id
          FROM harness_shared.token_index
         WHERE COALESCE(workspace_id, '') <> ''
         GROUP BY harness_slug
        HAVING COUNT(DISTINCT workspace_id) = 1
       ) ti
 WHERE COALESCE(a.workspace_id, '') = ''
   AND ti.harness_slug = a.harness_slug;

UPDATE harness_shared.harness_text_artifacts
   SET workspace_id = 'default'
 WHERE COALESCE(workspace_id, '') = '';
