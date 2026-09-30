-- 404 — migrate existing plans from member-harness scope to Hive-home scope.
--
-- Plans are now Hive-scoped: harness_shared.harness_plans.harness_slug stores the
-- Hive home slug. Member harness callers still pass their harness, but the plan
-- source resolver collapses member -> home before reads/writes. This migration
-- moves already-authored plan rows and their dependent plan metadata to that
-- home slug using the workspace harness_registry membership map.

CREATE TEMP TABLE IF NOT EXISTS plan_hive_scope_moves (
  workspace_id text NOT NULL,
  from_harness text NOT NULL,
  to_hive text NOT NULL,
  PRIMARY KEY (workspace_id, from_harness)
) ON COMMIT DROP;

TRUNCATE plan_hive_scope_moves;

INSERT INTO plan_hive_scope_moves (workspace_id, from_harness, to_hive)
SELECT r.workspace_id,
       p.project ->> 'slug' AS from_harness,
       CASE
         WHEN p.project ->> 'harness_kind' = 'hive' THEN p.project ->> 'slug'
         ELSE NULLIF(BTRIM(p.project ->> 'hive_slug'), '')
       END AS to_hive
  FROM harness_shared.harness_registry r
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.payload -> 'projects', '[]'::jsonb)) AS p(project)
 WHERE p.project ? 'slug'
   AND COALESCE(p.project ->> 'slug', '') <> ''
   AND CASE
         WHEN p.project ->> 'harness_kind' = 'hive' THEN p.project ->> 'slug'
         ELSE NULLIF(BTRIM(p.project ->> 'hive_slug'), '')
       END IS NOT NULL
   AND p.project ->> 'slug' <>
       CASE
         WHEN p.project ->> 'harness_kind' = 'hive' THEN p.project ->> 'slug'
         ELSE NULLIF(BTRIM(p.project ->> 'hive_slug'), '')
       END;

DO $$
DECLARE
  conflict_count integer;
BEGIN
  WITH moved_plans AS (
    SELECT hp.workspace_id, m.from_harness, m.to_hive, hp.plan_slug
      FROM harness_shared.harness_plans hp
      JOIN plan_hive_scope_moves m
        ON m.workspace_id = hp.workspace_id
       AND m.from_harness = hp.harness_slug
  ),
  target_rows AS (
    SELECT mp.workspace_id, mp.to_hive, mp.plan_slug, count(*) AS sources
      FROM moved_plans mp
     GROUP BY mp.workspace_id, mp.to_hive, mp.plan_slug
  ),
  existing_target AS (
    SELECT 1
      FROM target_rows tr
      JOIN harness_shared.harness_plans hp
        ON hp.workspace_id = tr.workspace_id
       AND hp.harness_slug = tr.to_hive
       AND hp.plan_slug = tr.plan_slug
     LIMIT 1
  ),
  duplicate_sources AS (
    SELECT 1 FROM target_rows WHERE sources > 1 LIMIT 1
  )
  SELECT count(*) INTO conflict_count
    FROM (
      SELECT * FROM existing_target
      UNION ALL
      SELECT * FROM duplicate_sources
    ) c;

  IF conflict_count > 0 THEN
    RAISE EXCEPTION
      'Cannot migrate plans to Hive scope: one or more target Hive plan keys already exist or multiple member harnesses share a plan slug.';
  END IF;
END $$;

UPDATE harness_shared.plan_revisions r
   SET harness_slug = m.to_hive
  FROM plan_hive_scope_moves m
 WHERE r.workspace_id = m.workspace_id
   AND r.harness_slug = m.from_harness
   AND EXISTS (
     SELECT 1 FROM harness_shared.harness_plans hp
      WHERE hp.workspace_id = r.workspace_id
        AND hp.harness_slug = m.from_harness
        AND hp.plan_slug = r.plan_slug
   );

UPDATE harness_shared.plan_runs r
   SET harness_slug = m.to_hive
  FROM plan_hive_scope_moves m
 WHERE r.workspace_id = m.workspace_id
   AND r.harness_slug = m.from_harness
   AND EXISTS (
     SELECT 1 FROM harness_shared.harness_plans hp
      WHERE hp.workspace_id = r.workspace_id
        AND hp.harness_slug = m.from_harness
        AND hp.plan_slug = r.plan_slug
   );

DO $$
BEGIN
  IF to_regclass('harness_shared.harness_plan_parts') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE harness_shared.harness_plan_parts p
         SET harness_slug = m.to_hive
        FROM plan_hive_scope_moves m
       WHERE p.workspace_id = m.workspace_id
         AND p.harness_slug = m.from_harness
         AND EXISTS (
           SELECT 1 FROM harness_shared.harness_plans hp
            WHERE hp.workspace_id = p.workspace_id
              AND hp.harness_slug = m.from_harness
              AND hp.plan_slug = p.plan_slug
         )
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('harness_shared.harness_plan_assertions') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE harness_shared.harness_plan_assertions a
         SET harness_slug = m.to_hive
        FROM plan_hive_scope_moves m
       WHERE a.workspace_id = m.workspace_id
         AND a.harness_slug = m.from_harness
         AND EXISTS (
           SELECT 1 FROM harness_shared.harness_plans hp
            WHERE hp.workspace_id = a.workspace_id
              AND hp.harness_slug = m.from_harness
              AND hp.plan_slug = a.plan_slug
         )
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('harness_shared.plan_item_claims') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE harness_shared.plan_item_claims c
         SET harness_slug = m.to_hive
        FROM plan_hive_scope_moves m
       WHERE c.workspace_id = m.workspace_id
         AND c.harness_slug = m.from_harness
         AND EXISTS (
           SELECT 1 FROM harness_shared.harness_plans hp
            WHERE hp.workspace_id = c.workspace_id
              AND hp.harness_slug = m.from_harness
              AND hp.plan_slug = c.plan_slug
         )
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('harness_shared.plan_item_assignments') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE harness_shared.plan_item_assignments a
         SET harness_slug = m.to_hive
        FROM plan_hive_scope_moves m
       WHERE a.workspace_id = m.workspace_id
         AND a.harness_slug = m.from_harness
         AND EXISTS (
           SELECT 1 FROM harness_shared.harness_plans hp
            WHERE hp.workspace_id = a.workspace_id
              AND hp.harness_slug = m.from_harness
              AND hp.plan_slug = a.plan_slug
         )
    $sql$;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('harness_shared.plan_work_group_members') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE harness_shared.plan_work_group_members g
         SET harness_slug = m.to_hive
        FROM plan_hive_scope_moves m
       WHERE g.workspace_id = m.workspace_id
         AND g.harness_slug = m.from_harness
         AND EXISTS (
           SELECT 1 FROM harness_shared.harness_plans hp
            WHERE hp.workspace_id = g.workspace_id
              AND hp.harness_slug = m.from_harness
              AND hp.plan_slug = g.plan_slug
         )
    $sql$;
  END IF;
END $$;

UPDATE harness_shared.harness_plans hp
   SET harness_slug = m.to_hive
  FROM plan_hive_scope_moves m
 WHERE hp.workspace_id = m.workspace_id
   AND hp.harness_slug = m.from_harness;

DO $$
DECLARE
  move record;
  plan record;
  run_ids bigint[];
BEGIN
  FOR move IN
    SELECT * FROM (
      VALUES
        ('papercusp-workspace'::text, 'papercup'::text, 'papercusp-workspace'::text, 'papercusp'::text),
        ('default'::text, 'papercusp'::text, 'papercusp-workspace'::text, 'papercusp'::text)
    ) AS v(from_ws, from_harness, to_ws, to_hive)
  LOOP
    FOR plan IN
      SELECT plan_slug
        FROM harness_shared.harness_plans
       WHERE workspace_id = move.from_ws
         AND harness_slug = move.from_harness
    LOOP
      IF EXISTS (
        SELECT 1
          FROM harness_shared.harness_plans
         WHERE workspace_id = move.to_ws
           AND harness_slug = move.to_hive
           AND plan_slug = plan.plan_slug
      ) THEN
        RAISE EXCEPTION 'Cannot migrate retired Papercup plan %.%/%: target exists',
          move.from_ws, move.from_harness, plan.plan_slug;
      END IF;

      SELECT array_agg(id) INTO run_ids
        FROM harness_shared.plan_runs
       WHERE workspace_id = move.from_ws
         AND harness_slug = move.from_harness
         AND plan_slug = plan.plan_slug;

      IF run_ids IS NOT NULL THEN
        UPDATE harness_shared.plan_run_turns
           SET workspace_id = move.to_ws
         WHERE plan_run_id = ANY(run_ids);
      END IF;

      UPDATE harness_shared.plan_revisions
         SET workspace_id = move.to_ws, harness_slug = move.to_hive
       WHERE workspace_id = move.from_ws
         AND harness_slug = move.from_harness
         AND plan_slug = plan.plan_slug;

      UPDATE harness_shared.plan_runs
         SET workspace_id = move.to_ws, harness_slug = move.to_hive
       WHERE workspace_id = move.from_ws
         AND harness_slug = move.from_harness
         AND plan_slug = plan.plan_slug;

      IF to_regclass('harness_shared.harness_plan_parts') IS NOT NULL THEN
        UPDATE harness_shared.harness_plan_parts
           SET workspace_id = move.to_ws, harness_slug = move.to_hive
         WHERE workspace_id = move.from_ws
           AND harness_slug = move.from_harness
           AND plan_slug = plan.plan_slug;
      END IF;

      IF to_regclass('harness_shared.harness_plan_assertions') IS NOT NULL THEN
        UPDATE harness_shared.harness_plan_assertions
           SET workspace_id = move.to_ws, harness_slug = move.to_hive
         WHERE workspace_id = move.from_ws
           AND harness_slug = move.from_harness
           AND plan_slug = plan.plan_slug;
      END IF;

      IF to_regclass('harness_shared.plan_item_claims') IS NOT NULL THEN
        UPDATE harness_shared.plan_item_claims
           SET workspace_id = move.to_ws, harness_slug = move.to_hive
         WHERE workspace_id = move.from_ws
           AND harness_slug = move.from_harness
           AND plan_slug = plan.plan_slug;
      END IF;

      IF to_regclass('harness_shared.plan_item_assignments') IS NOT NULL THEN
        UPDATE harness_shared.plan_item_assignments
           SET workspace_id = move.to_ws, harness_slug = move.to_hive
         WHERE workspace_id = move.from_ws
           AND harness_slug = move.from_harness
           AND plan_slug = plan.plan_slug;
      END IF;

      IF to_regclass('harness_shared.plan_work_group_members') IS NOT NULL THEN
        UPDATE harness_shared.plan_work_group_members
           SET workspace_id = move.to_ws, harness_slug = move.to_hive
         WHERE workspace_id = move.from_ws
           AND harness_slug = move.from_harness
           AND plan_slug = plan.plan_slug;
      END IF;

      UPDATE harness_shared.harness_plans
         SET workspace_id = move.to_ws, harness_slug = move.to_hive
       WHERE workspace_id = move.from_ws
         AND harness_slug = move.from_harness
         AND plan_slug = plan.plan_slug;
    END LOOP;
  END LOOP;
END $$;
