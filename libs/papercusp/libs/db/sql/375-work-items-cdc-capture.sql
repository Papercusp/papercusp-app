-- 375: work_items CDC/federation capture — the "migrate federation/CDC/projection"
-- phase of the work-item unification (work-item-deps-and-readiness-2026-06-22 P-010).
--
-- WHY: mig 374 made work_items the base table by RENAMEing harness_features_consolidated
-- → work_items. The generic capture_substrate_outbox() (000-baseline) stamps the outbox
-- row's table_name = TG_TABLE_NAME, so after the rename EVERY captured row carries
-- table_name='work_items'. But the read-side projections demux by table_name:
--   • harness-features.ts expects 'harness_features_consolidated'
--   • engineer-issues.ts   expects 'engineer_issues'
-- so BOTH families silently stopped federating, and every table_name='engineer_issues'
-- consumer (inbox fan-out, auto-subscribe, topics:feed, issue_blocks projection) stopped
-- firing for issues. mig 374 also DROPped the engineer_issues table → its mig-197 custom
-- capture (which stamped table_name='engineer_issues' + the issue wire-shape + the
-- scope→Hive-home slug derivation) is gone.
--
-- FIX: one kind-branching capture on work_items that restores the ORIGINAL per-family
-- contracts — stamps the right table_name + the right wire-shape, ports mig-197's
-- scope→slug derivation for issues, and reuses the feature path (row shape unchanged:
-- work_items has the old hfc columns) for features. Drop the rename-inherited generic
-- capture triggers so issue rows are not double-captured under table_name='work_items'.
--
-- Idempotent; composes onto 374. Wire-shape MUST match EngineerIssueRow
-- (projections/engineer-issues.ts) + the harness-features projection's column reads.

\set ON_ERROR_STOP on
BEGIN;

-- ── Drop the rename-inherited generic capture (stamped table_name='work_items'). ─────
DROP TRIGGER IF EXISTS capture_substrate_outbox_trg     ON harness_shared.work_items;
DROP TRIGGER IF EXISTS capture_substrate_outbox_upd_trg ON harness_shared.work_items;

-- ── Kind-branching capture: feature-family vs issue-family, each with its ORIGINAL
--    table_name + wire-shape so the existing projections demux unchanged. ────────────
CREATE OR REPLACE FUNCTION harness_shared.capture_work_items_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_op     TEXT;
      v_rec    RECORD;
      v_ws     TEXT;
      v_slug   TEXT;
      v_scope  TEXT;
      v_tbl    TEXT;
      v_key    TEXT;
      v_row    JSONB;
      v_cnt    INT;
    BEGIN
      IF TG_OP = 'DELETE' THEN v_op := 'del'; v_rec := OLD; ELSE v_op := 'put'; v_rec := NEW; END IF;

      -- Echo-loop guard: skip remote-origin writes (the projections' own applies).
      IF COALESCE(v_rec.origin, 'local') <> 'local' THEN RETURN v_rec; END IF;

      v_ws  := COALESCE(v_rec.workspace_id, '');
      v_key := v_rec.feature_id;

      IF v_rec.item_kind IN ('bug', 'change', 'task') THEN
        -- ── ISSUE family (port mig-197). ────────────────────────────────────────────
        -- SU cross-workspace meta + unscoped rows have no single Hive to ride → local.
        IF v_ws = '' OR v_ws = '*' THEN RETURN v_rec; END IF;
        v_scope := COALESCE(v_rec.payload->'_ei'->>'scope',
                     CASE WHEN v_rec.harness_slug = '' THEN 'operator'
                          ELSE 'harness:' || v_rec.harness_slug END);
        IF v_scope LIKE 'harness:%' THEN
          v_slug := substr(v_scope, 9);
        ELSIF v_scope = 'operator' THEN
          -- Operator/Queen shared backlog rides the workspace's single Hive home.
          -- 0 or >1 Hive homes → ambiguous → stay local (multi-Hive pointer is a follow).
          SELECT count(*)::int, min(home_slug) INTO v_cnt, v_slug
            FROM harness_shared.hives WHERE workspace_id = v_ws;
          IF v_cnt <> 1 THEN RETURN v_rec; END IF;
        ELSE
          RETURN v_rec;  -- unknown scope shape → local
        END IF;
        IF v_slug IS NULL OR v_slug = '' THEN RETURN v_rec; END IF;

        v_tbl := 'engineer_issues';
        -- Rebuild the engineer_issues wire-shape (mirrors the 374 compat view's SELECT),
        -- stamping the resolved federation slug for the projection's per-harness demux.
        v_row := jsonb_strip_nulls(jsonb_build_object(
          'workspace_id',      v_ws,
          'issue_id',          v_rec.feature_id,
          'scope',             v_scope,
          'title',             v_rec.title,
          'body',              COALESCE(v_rec.summary, ''),
          'severity',          COALESCE(v_rec.payload->'_ei'->>'severity', 'minor'),
          'source',            COALESCE(v_rec.payload->'_ei'->>'source', 'engineer'),
          'state',             v_rec.status,
          'assignee',          v_rec.taken_by,
          'assigned_by',       v_rec.payload->'_ei'->>'assigned_by',
          'assigned_at',       v_rec.taken_at,
          'found_during',      v_rec.payload->'_ei'->>'found_during',
          'linked_feature_id', v_rec.payload->'_ei'->>'linked_feature_id',
          'created_by',        v_rec.payload->'_ei'->>'created_by',
          'kind',              v_rec.item_kind,
          'payload',           (v_rec.payload - '_ei'),
          'origin',            v_rec.origin,
          'author_pubkey',     v_rec.author_pubkey,
          'fed_ts',            v_rec.fed_ts,
          'fed_hlc',           v_rec.fed_hlc,
          'signal_origin',     COALESCE(v_rec.payload->'_ei'->>'signal_origin', 'local'),
          'harness_slug',      v_slug));
      ELSE
        -- ── FEATURE family: original table_name + the (unchanged) hfc row shape. ──────
        v_tbl  := 'harness_features_consolidated';
        v_slug := v_rec.harness_slug;
        v_row  := to_jsonb(v_rec);
      END IF;

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES
        (v_ws, v_slug, v_tbl, v_op, v_key, v_row, (extract(epoch from now()) * 1000)::bigint);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || COALESCE(v_slug, ''));
      RETURN v_rec;
    END;
    $$;

-- INSERT/DELETE always capture (the echo-guard handles remote); the function branches.
CREATE OR REPLACE TRIGGER capture_work_items_outbox_ins_del_trg
  AFTER INSERT OR DELETE ON harness_shared.work_items
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_work_items_outbox();

-- Feature UPDATE: match the baseline contract (any column change; the projection LWW
-- dedups the updated_ts churn).
CREATE OR REPLACE TRIGGER capture_work_items_feature_upd_trg
  AFTER UPDATE ON harness_shared.work_items
  FOR EACH ROW
  WHEN (NEW.item_kind NOT IN ('bug', 'change', 'task') AND (OLD.* IS DISTINCT FROM NEW.*))
  EXECUTE FUNCTION harness_shared.capture_work_items_outbox();

-- Issue UPDATE: only on a FEDERATED-field change (mig-197's guard, mapped to work_items
-- columns) — NOT on a bare updated_ts bump, so an assignment touch does not re-federate.
CREATE OR REPLACE TRIGGER capture_work_items_issue_upd_trg
  AFTER UPDATE ON harness_shared.work_items
  FOR EACH ROW
  WHEN (
       NEW.item_kind IN ('bug', 'change', 'task')
    AND (
         OLD.title         IS DISTINCT FROM NEW.title
      OR OLD.summary       IS DISTINCT FROM NEW.summary
      OR OLD.status        IS DISTINCT FROM NEW.status
      OR OLD.taken_by      IS DISTINCT FROM NEW.taken_by
      OR OLD.taken_at      IS DISTINCT FROM NEW.taken_at
      OR OLD.item_kind     IS DISTINCT FROM NEW.item_kind
      OR OLD.harness_slug  IS DISTINCT FROM NEW.harness_slug
      OR OLD.payload       IS DISTINCT FROM NEW.payload
      OR OLD.fed_ts        IS DISTINCT FROM NEW.fed_ts
      OR OLD.fed_hlc       IS DISTINCT FROM NEW.fed_hlc
    )
  )
  EXECUTE FUNCTION harness_shared.capture_work_items_outbox();

COMMIT;
