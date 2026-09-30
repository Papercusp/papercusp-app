-- 1021 — repair per-harness feature views that bypassed the feature-family filter
--
-- EI-21650884970130146: live pg_stat_statements showed the papercusp harness
-- repeatedly running `SELECT * FROM harness_features WHERE harness_slug = $1
-- ORDER BY feature_id` with ~18s mean execution and ~289k rows/call.  The
-- per-harness view had been replayed against `harness_shared.work_items`
-- directly, so issue-family rows (bug/change/task) were included and every read
-- used a parallel sequential scan of the 2.8GB work_items table.  The canonical
-- feature projection is harness_shared.harness_features_consolidated, which
-- excludes issue-family rows.
--
-- Migration 648 refreshed dependents that referenced the consolidated view, but
-- views replayed from an older direct-work_items definition were not in its
-- dependency cursor.  Rebuild only those malformed aliases, preserving owner
-- and ACLs.  A dependent object is a hard error: silently CASCADE-dropping a
-- consumer would trade a load bug for a data-plane outage.

DO $repair_per_harness_feature_views$
DECLARE
  r record;
  g record;
  v_def text;
  v_slug text;
  v_registry_slug text;
  v_grantee text;
  v_dependents integer;
BEGIN
  FOR r IN
    SELECT c.oid,
           n.nspname AS schema_name,
           pg_get_userbyid(c.relowner) AS owner_role,
           c.relacl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'v'
       AND c.relname = 'harness_features'
       AND n.nspname LIKE 'harness_%'
       AND n.nspname <> 'harness_shared'
  LOOP
    v_def := pg_get_viewdef(r.oid, true);

    -- The defining SQL normally retains the slug predicate.  Registry lookup
    -- is the fallback for an old unfiltered alias; schema names are the same
    -- lowercase + hyphen→underscore transform used by scaffold-harness-schema.
    v_slug := substring(v_def FROM 'harness_slug[[:space:]]*=[[:space:]]*''([^'']*)''');
    IF v_slug IS NULL THEN
      SELECT p.value->>'slug'
        INTO v_registry_slug
        FROM harness_shared.harness_registry hr
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(hr.payload->'projects', '[]'::jsonb)) p
       WHERE lower('harness_' || replace(p.value->>'slug', '-', '_')) = r.schema_name
       ORDER BY hr.updated_at DESC
       LIMIT 1;
      v_slug := v_registry_slug;
    END IF;

    -- Unknown/unscoped aliases are left untouched rather than guessed.  The
    -- normal scaffold always supplies a slug, and a human can repair an alias
    -- that has neither a predicate nor a registry identity.
    IF v_slug IS NULL OR v_slug = '' THEN
      RAISE NOTICE '1021: skipping %.harness_features — no reliable harness_slug', r.schema_name;
      CONTINUE;
    END IF;

    -- Correct aliases either reference the consolidated feature view or carry
    -- the same item-kind exclusion after PostgreSQL deparses that view.  Only
    -- direct work_items aliases without the exclusion are malformed.
    IF v_def !~* 'FROM[[:space:]]+harness_shared[.]work_items'
       OR v_def ~* 'item_kind[[:space:]]*(<>|!=|NOT[[:space:]]+IN)' THEN
      CONTINUE;
    END IF;

    SELECT count(*)::integer
      INTO v_dependents
      FROM pg_depend d
      JOIN pg_rewrite rw ON rw.oid = d.objid
      JOIN pg_class dependent ON dependent.oid = rw.ev_class
     WHERE d.refobjid = r.oid
       AND dependent.oid <> r.oid;
    IF v_dependents > 0 THEN
      RAISE EXCEPTION
        '1021: refusing to rebuild %.harness_features with % dependent object(s)',
        r.schema_name, v_dependents;
    END IF;

    -- No CASCADE: the dependency check above makes a missing dependent an
    -- explicit migration failure instead of silently deleting its rule.
    EXECUTE format('DROP VIEW %I.%I', r.schema_name, 'harness_features');
    EXECUTE format($view$
      CREATE VIEW %1$I.harness_features AS
        SELECT * FROM harness_shared.harness_features_consolidated
         WHERE harness_slug = %2$L
        WITH CASCADED CHECK OPTION
    $view$, r.schema_name, v_slug);

    IF r.owner_role IS NOT NULL THEN
      EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', r.schema_name, 'harness_features', r.owner_role);
    END IF;
    IF r.relacl IS NOT NULL THEN
      FOR g IN SELECT (aclexplode(r.relacl)).* LOOP
        v_grantee := COALESCE((SELECT rolname FROM pg_roles WHERE oid = g.grantee), 'PUBLIC');
        BEGIN
          EXECUTE format(
            'GRANT %s ON %I.%I TO %s',
            g.privilege_type,
            r.schema_name, 'harness_features',
            CASE WHEN v_grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(v_grantee) END
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE '1021: skipped ACL replay for %.harness_features (% to %): %',
            r.schema_name, g.privilege_type, v_grantee, SQLERRM;
        END;
      END LOOP;
    END IF;
  END LOOP;
END
$repair_per_harness_feature_views$;
