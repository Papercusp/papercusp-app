-- 647-harness-features-consolidated-drift-normalize.sql
--
-- WI-5635 (split from work-item-status-full-unify-2026-07-19 P-009; the
-- engineer_issues half was fixed durably in migration 646).
--
-- PROBLEM (relkind/attnum-verified against BOTH the live dev DB and a fresh
-- 000->646 replay on a scratch DB, 2026-07-20):
--
-- 1. UN-MIGRATED LIVE DDL. Migration 638 added work_items.terminal_reason;
--    migration 640 deliberately deferred re-exposing it on the two family
--    compat views "to P-007" (both migrations explicitly do NOT touch the
--    views). P-007 re-exposed it on harness_features_consolidated via a live
--    `CREATE OR REPLACE VIEW ... SELECT *` that was NEVER captured as a
--    migration, so a fresh chain (000->head) builds the view WITHOUT
--    terminal_reason (confirmed: a real 000->646 replay on a scratch DB
--    produces a 70-column view; terminal_reason is entirely absent).
--
-- 2. LIVE<->CHAIN COLUMN-ORDER DRIFT (mig 640's header flagged `wave` /
--    `verified_done_at_remote_ts` as swapped; THIS migration's own
--    ground-truth diff — live pg_get_viewdef vs a real fresh 000->646
--    replay's pg_get_viewdef — found the drift is WIDER than that single
--    pair: `wave` is also displaced ~5 positions earlier on live than the
--    chain's ADD-COLUMN order, and `swarm_affinity`/`redundancy` (migrations
--    191/195) are ALSO swapped on live relative to migration-number order.
--    Because `SELECT *` freezes column order at CREATE-time from the
--    underlying table's CURRENT physical layout, and CREATE OR REPLACE VIEW
--    can only ever APPEND columns (never reorder/rename existing ones), no
--    bare CREATE OR REPLACE can make live and a fresh chain converge on one
--    shape — only a DROP + CREATE with an EXPLICIT column list (immune to
--    future physical reordering) can. Per mig 640's own guidance: "the view
--    SELECT must be rebuilt from the MIGRATION-CHAIN column order — NOT the
--    live pg_get_viewdef". The explicit list below IS that migration-chain
--    order (ground-truth verified against a real 000->646 scratch replay),
--    with `terminal_reason` appended as the final column — mirroring mig
--    646's append-at-the-end convention for the sibling engineer_issues fix.
--
-- 3. CHECK OPTION SILENTLY DROPPED. Migrations 374/551 defined this view
--    WITH CASCADED CHECK OPTION (a write through the view that doesn't
--    satisfy `item_kind NOT IN ('bug','change','task')` is rejected at the
--    view). CREATE OR REPLACE VIEW does not preserve a prior check option
--    unless re-specified; the live un-migrated edit omitted it, so live's
--    check_option is currently NONE (verified via information_schema.views).
--    Restored here.
--
-- BLAST RADIUS (the reason this needs a DROP CASCADE, not just the base
-- view): harness_features_consolidated has real dependents beyond itself —
-- `harness_shared.harness_features` (migration 497's fixed alias) on every
-- install, PLUS one `harness_<slug>.harness_features` auto-updatable view
-- PER PROVISIONED HARNESS (packages/operator-core/lib/scaffold-harness-schema.ts,
-- `SELECT * FROM harness_shared.harness_features_consolidated WHERE
-- harness_slug = '<slug>' WITH CHECK OPTION` — not migration-owned, created
-- live at onboarding time). On the live dev DB this is currently 34 views
-- across as many harness schemas; DROP ... CASCADE removes all of them along
-- with their grants. This migration is written GENERICALLY (no hardcoded
-- harness list) so it is correct on ANY install regardless of which/how many
-- harnesses are provisioned: it snapshots every dependent view's exact
-- defining SQL + ACL via pg_depend/pg_get_viewdef/relacl BEFORE dropping,
-- then replays each one verbatim (same owner-qualified CREATE VIEW text,
-- same grants) after the base view is rebuilt. On a bare fresh install this
-- snapshot has exactly one row (`harness_shared.harness_features`); on live
-- it is all 34 — same code path, no branching.
--
-- IMPACT if unfixed (bounded, non-functional for readers): all 18 code
-- consumers of terminal_reason read it off the work_items BASE table, never
-- through these views, so there is no functional reader regression on any
-- box. Federation APPLY also writes to the base table. The residual harm was
-- (a) fresh-install/fresh-chain schema incompleteness, (b) the
-- federated-column-completeness.integration.test.ts guard could not exercise
-- the FEATURE mapper's terminal_reason carry (it introspects the chain view,
-- which lacked the column), and (c) the un-migrated-DDL rule violation.
--
-- VERIFIED (2026-07-20, su-772cf615): applied end-to-end against a scratch
-- DB seeded by a REAL 000->646 migration replay (pgvector/pgcrypto/pg_trgm
-- installed to match live) with a simulated per-harness dependent view
-- (mirroring scaffold-harness-schema.ts's exact template) standing in for
-- the live 34: (1) pg_get_viewdef shows terminal_reason present, appended
-- last; (2) check_option = CASCADED restored; (3) both the fixed
-- harness_shared.harness_features alias AND the simulated per-harness
-- dependent survive byte-identical (same defining SQL, same grants) after
-- the migration; (4) DML through the base view (INSERT/UPDATE/DELETE) still
-- round-trips; (5) re-running the migration file a second time is a clean
-- no-op (idempotent — DROP ... CASCADE / CREATE VIEW / snapshot-replay all
-- tolerate re-application). Live application intentionally NOT performed by
-- this migration's author: the item explicitly flags this as needing a
-- careful, ideally owner-present, supervised drained apply given the
-- dependent-view blast radius discovered above — this migration file is
-- authored + tested and ready for that supervised apply, not yet run live.
--
-- The migration runner wraps each file in its own transaction (files >=215),
-- so the DROP CASCADE + rebuild + dependent-replay is atomic — no window
-- where the view or any dependent is missing; a failure anywhere rolls the
-- whole file back as a unit.

DO $wi5635$
DECLARE
  r record;
  g record;
  v_grantee text;
BEGIN
  -- ── 1. Snapshot every dependent view's exact defining SQL + owner + ACL,
  --      BEFORE the DROP CASCADE destroys them. Generic: works whether there
  --      are 0, 1 (fresh install), or N (live) dependents. ──────────────────
  CREATE TEMP TABLE _wi5635_dep_snapshot
    (schema_name text, view_name text, viewdef text, owner_role text, acl aclitem[], check_option text)
    ON COMMIT DROP;

  -- NOTE: pg_get_viewdef() deliberately does NOT include a WITH CHECK OPTION
  -- clause (it is stored as a separate view reloption, not part of the
  -- view's query text) — capturing + replaying viewdef alone would silently
  -- drop it, the exact same class of defect this migration exists to fix.
  -- Pull it from information_schema.views.check_option and restore it via a
  -- separate ALTER VIEW ... SET (check_option = ...) after each replay.
  INSERT INTO _wi5635_dep_snapshot (schema_name, view_name, viewdef, owner_role, acl, check_option)
  SELECT DISTINCT
    dependent_ns.nspname,
    dependent_view.relname,
    pg_get_viewdef(dependent_view.oid, true),
    pg_get_userbyid(dependent_view.relowner),
    dependent_view.relacl,
    iv.check_option
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
    AND dependent_view.relname != 'harness_features_consolidated';

  -- ── 2. Drop the base view + every cascaded dependent in one shot. ───────
  DROP VIEW IF EXISTS harness_shared.harness_features_consolidated CASCADE;

  -- ── 3. Recreate with an EXPLICIT canonical column list (migration-chain
  --      order, ground-truth verified; terminal_reason appended last) — no
  --      longer `SELECT *`, so this is immune to future physical
  --      ALTER-TABLE-ADD-COLUMN reordering drift by construction. ─────────
  CREATE VIEW harness_shared.harness_features_consolidated AS
    SELECT
      harness_slug, feature_id, title, summary, status, attempts, claims, notes,
      metadata, kind, project_id, expected_cost_cents, tags, needs_human_review,
      ts, created_ts, updated_ts, parent_id, goal_id, taken_by, taken_at,
      expires_at, workspace_id, _search, deprecation_reason, see_also,
      needs_design, design_status, design_spec_id, discarded_design_work,
      completion_ref, created_by_github_user_id, working_users, worked_by_history,
      verified_done_at_remote_ts, verifier_last_error, verifier_last_checked_at,
      source_plan_slug, source_plan_item_ids, wave, feature_order, author_pubkey,
      origin, audit_verdict, audit_reasons, audited_at, item_kind, payload,
      assignee_rank, rank_writer, rank_updated_at, fed_ts, swarm_affinity,
      redundancy, verified_author_github_user_id, schedule, schedule_active,
      scheduled_at, tzid, template_slug, run_seq, requeue_count, fed_hlc,
      last_progress_at, terminal_owner, terminal_completion_ref, last_released_by,
      last_released_at, embedding, embedding_mode, terminal_reason
    FROM harness_shared.work_items
    WHERE item_kind NOT IN ('bug', 'change', 'task')
    WITH CASCADED CHECK OPTION;

  GRANT SELECT, INSERT, UPDATE, DELETE ON harness_shared.harness_features_consolidated TO harness_app;
  GRANT SELECT ON harness_shared.harness_features_consolidated TO harness_zero;

  -- ── 4. Replay every snapshotted dependent verbatim — identical defining
  --      SQL, so each converges cleanly whether it previously targeted the
  --      old (drifted) column order or not; SELECT * on the rebuilt base
  --      view now resolves to the full, correct, canonical column set. ────
  FOR r IN SELECT * FROM _wi5635_dep_snapshot LOOP
    EXECUTE format('CREATE VIEW %I.%I AS %s', r.schema_name, r.view_name, r.viewdef);
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
          -- A grantee role that no longer exists / a privilege that doesn't
          -- apply to views — skip rather than fail the whole migration over
          -- a single stale ACL entry.
          RAISE NOTICE 'wi5635: skipped ACL replay for %.% (% to %): %',
            r.schema_name, r.view_name, g.privilege_type, v_grantee, SQLERRM;
        END;
      END LOOP;
    END IF;
  END LOOP;
END
$wi5635$;
