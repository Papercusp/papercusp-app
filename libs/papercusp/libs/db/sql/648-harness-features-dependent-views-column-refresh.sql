-- 648-harness-features-dependent-views-column-refresh.sql
--
-- EI-18159810588110766 (found while applying migration 647): each of the 34
-- per-harness `<schema>.harness_features` dependent views (the auto-updatable
-- alias `SELECT * FROM harness_shared.harness_features_consolidated WHERE
-- harness_slug = '<slug>' [WITH CHECK OPTION]` that scaffold-harness-schema.ts
-- creates live at harness-onboarding time — see also the one un-slug-filtered
-- alias `harness_shared.harness_features` from migration 497) is frozen at
-- ITS OWN older column count, because `pg_get_viewdef()` on a view created as
-- bare `SELECT *` returns the EXPANDED explicit column list frozen at that
-- view's own CREATE/CREATE-OR-REPLACE time — Postgres's ruleutils.c only
-- re-collapses a target list back to literal `*` in the printed SQL when it
-- still exactly matches the referenced relation's CURRENT columns. Migration
-- 647 fixed exactly this class of bug for the BASE view (harness_features_consolidated
-- itself, which selected from work_items) by switching it to an explicit,
-- append-immune column list; it also correctly replayed each dependent's
-- pre-existing (already-frozen) definition verbatim during its DROP CASCADE
-- rebuild, so it did not regress the dependents — but replaying the OLD
-- frozen definition also did not FIX them: they remain frozen at whatever
-- column count they had before, still missing embedding / embedding_mode /
-- terminal_reason (and still in each dependent's own frozen column ORDER,
-- which predates 647's wave/swarm_affinity/redundancy re-ordering fix on the
-- base view).
--
-- IMPACT: purely cosmetic / schema-completeness. Confirmed (647's own
-- analysis, unchanged by this finding): no code consumer reads
-- terminal_reason — or any of the other newly-added columns — through these
-- per-harness alias views; every real reader goes through the work_items base
-- table directly. A column-order change in a VIEW is safe for every consumer
-- in this codebase: postgres.js / pg return rows as name-keyed objects, never
-- positional tuples, and grep confirms no `SELECT * FROM harness_features`
-- consumer here destructures by array position. VERIFIED LEAF-CHECK
-- (2026-07-20): a live pg_depend query found ZERO objects depending on any of
-- the 34 `<schema>.harness_features` views — they are leaves, so a bare
-- DROP + CREATE (no further CASCADE) is sufficient; no snapshot-of-dependents
-- step is needed here (unlike 647, which had to handle a two-level fan-out).
--
-- FIX: for each of the 34 dependent views, snapshot its owner/ACL/check_option
-- (same technique as 647) PLUS its own `harness_slug = '<slug>'` filter
-- (extracted from its current pg_get_viewdef text — every dependent observed
-- live is either exactly `SELECT * FROM harness_features_consolidated` with
-- NO filter (the one un-filtered alias, harness_shared.harness_features) or
-- exactly `SELECT * FROM harness_features_consolidated WHERE harness_slug =
-- '<slug>'::text` with no other qualifiers — verified against all 34 rows
-- before writing this migration), then DROP + CREATE fresh with a BARE
-- (unqualified) `SELECT *`, which Postgres resolves against the base view's
-- CURRENT (post-647) column set at CREATE time — no explicit column list to
-- maintain here, by construction it can never re-drift this way again: the
-- next base-view column addition will show up here automatically, the same
-- guarantee scaffold-harness-schema.ts's own live onboarding-time CREATE
-- already gives every NEWLY onboarded harness.
--
-- Idempotent: re-running is a clean no-op result-wise (each DROP IF EXISTS +
-- CREATE just rebuilds to the same fresh definition). Wrapped in one DO block
-- = one implicit transaction (files >=215 get the runner's own transaction
-- wrap too) — a failure on any one view rolls the whole file back, so there
-- is no partial-drift window.
--
-- INCIDENT (caught + fixed live same-day, 2026-07-20): the FIRST applied
-- version of this file omitted DISTINCT on the cursor query below. pg_depend
-- carries roughly one row PER COLUMN REFERENCE from a dependent view's rule
-- back to harness_features_consolidated, so the un-DISTINCT'd cursor iterated
-- each dependent ~71 TIMES instead of once. Iteration 1 correctly rebuilt the
-- view with its slug filter; every subsequent iteration re-read
-- `pg_get_viewdef(r.view_oid, ...)` against the NOW-STALE oid captured before
-- iteration 1's DROP — pg_get_viewdef on a stale oid returns NULL, so v_slug
-- came back NULL, the "unrecognized shape" safety valve's `!~` comparison
-- against a NULL v_viewdef evaluated to NULL (not TRUE) and fell through
-- instead of skipping, and the view got dropped+recreated a SECOND time with
-- NO WHERE clause at all — silently exposing every OTHER harness's rows
-- through what should have been a slug-scoped view, for all 33 real
-- (non-harness_shared) dependents. Caught immediately by a post-apply
-- row-count sanity check (a slug-scoped harness showing the SAME total row
-- count as the deliberately-unfiltered alias), root-caused, and corrected
-- live within the same maintenance window (reconstructed each correct slug
-- from harness_shared.work_items + harness_shared.harness_registry via the
-- same `harnessSchemaName` forward transform scaffold-harness-schema.ts
-- uses, since the stale-oid failure meant the ORIGINAL filter text was gone
-- by the time the bug was noticed). The `SELECT DISTINCT` below is the fix —
-- collapses the cursor to exactly one row per dependent view, so
-- `v_viewdef`/`v_slug` are read ONCE per view, before that view's own DROP.

DO $wi_ei18159810588110766$
DECLARE
  r record;
  g record;
  v_grantee text;
  v_slug text;
  v_viewdef text;
BEGIN
  FOR r IN
    SELECT DISTINCT
      dependent_ns.nspname AS schema_name,
      dependent_view.relname AS view_name,
      dependent_view.oid AS view_oid,
      pg_get_userbyid(dependent_view.relowner) AS owner_role,
      dependent_view.relacl AS acl,
      iv.check_option AS check_option
    FROM pg_depend
    JOIN pg_rewrite ON pg_depend.objid = pg_rewrite.oid
    JOIN pg_class AS dependent_view ON pg_rewrite.ev_class = dependent_view.oid
    JOIN pg_class AS source_table ON pg_depend.refobjid = source_table.oid
    JOIN pg_namespace dependent_ns ON dependent_ns.oid = dependent_view.relnamespace
    JOIN pg_namespace source_ns ON source_ns.oid = source_table.relnamespace
    JOIN information_schema.views iv
      ON iv.table_schema = dependent_ns.nspname AND iv.table_name = dependent_view.relname
    WHERE source_ns.nspname = 'harness_shared'
      AND source_table.relname = 'harness_features_consolidated'
      AND dependent_view.relkind = 'v'
      AND dependent_view.relname != 'harness_features_consolidated'
  LOOP
    v_viewdef := pg_get_viewdef(r.view_oid, true);
    v_slug := substring(v_viewdef FROM 'harness_slug\s*=\s*''([^'']*)''');

    -- Safety valve: if a dependent's WHERE clause doesn't match the plain
    -- `harness_slug = '<slug>'` shape we verified for all 34 live rows (or
    -- has none), fall back to replaying it VERBATIM rather than guessing —
    -- never silently drop a filter we don't understand.
    IF v_slug IS NULL AND v_viewdef !~ 'harness_features_consolidated;\s*$' THEN
      RAISE NOTICE 'wi_ei18159810588110766: %.% has an unrecognized filter shape — leaving it untouched (replaying as-is): %',
        r.schema_name, r.view_name, v_viewdef;
      CONTINUE;
    END IF;

    EXECUTE format('DROP VIEW IF EXISTS %I.%I', r.schema_name, r.view_name);

    IF v_slug IS NOT NULL THEN
      EXECUTE format(
        'CREATE VIEW %I.%I AS SELECT * FROM harness_shared.harness_features_consolidated WHERE harness_slug = %L',
        r.schema_name, r.view_name, v_slug
      );
    ELSE
      EXECUTE format(
        'CREATE VIEW %I.%I AS SELECT * FROM harness_shared.harness_features_consolidated',
        r.schema_name, r.view_name
      );
    END IF;

    IF r.owner_role IS NOT NULL THEN
      EXECUTE format('ALTER VIEW %I.%I OWNER TO %I', r.schema_name, r.view_name, r.owner_role);
    END IF;
    IF r.check_option IS NOT NULL AND r.check_option <> 'NONE' THEN
      EXECUTE format('ALTER VIEW %I.%I SET (check_option = %L)', r.schema_name, r.view_name, lower(r.check_option));
    END IF;
    IF r.acl IS NOT NULL THEN
      FOR g IN SELECT (aclexplode(r.acl)).* LOOP
        v_grantee := COALESCE((SELECT rolname FROM pg_roles WHERE oid = g.grantee), 'PUBLIC');
        BEGIN
          EXECUTE format(
            'GRANT %s ON %I.%I TO %s',
            g.privilege_type,
            r.schema_name, r.view_name,
            CASE WHEN v_grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(v_grantee) END
          );
        EXCEPTION WHEN OTHERS THEN
          RAISE NOTICE 'wi_ei18159810588110766: skipped ACL replay for %.% (% to %): %',
            r.schema_name, r.view_name, g.privilege_type, v_grantee, SQLERRM;
        END;
      END LOOP;
    END IF;
  END LOOP;
END
$wi_ei18159810588110766$;
