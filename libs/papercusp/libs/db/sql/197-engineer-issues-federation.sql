-- 197: engineer_issues federation — flip the work-queue domain onto the Hive peer-log
-- (fed-reanchor brief B5; closes the engineer-issues-2026-06-03 D-009 "federation deferred").
--
-- engineer_issues = work_items[kind ∈ bug|change|task] — the issue/task half of the
-- unified work_items surface (mig 159). The feature half (harness_features_consolidated,
-- kind ∈ feature|research-task|chunk) ALREADY federates (baseline capture trigger +
-- projections/harness-features.ts); the issue/task half did NOT (mig 131 shipped the
-- federation-ready columns origin/author_pubkey but classified the table sync:'none').
-- So a bug/change/task work-item never reached another Swarm. THIS migration makes the
-- whole work-queue federate.
--
-- CANONICAL SCOPING (shared-hive-federation-2026-06-08 D-009 + this plan's D-009):
-- federation keys on the Hive (its kind:'hive' home harness slug), with the within-Hive
-- harness slug as the capture/demux scope. We DO NOT add a NULL=fleet-domain path
-- (that lean was REJECTED). So the capture trigger derives the federation slug from the
-- row's `scope`:
--   • scope = 'harness:<slug>'  → federate under <slug> (rides that harness's binding;
--     resolveHiveSwarmBinding routes a member harness → its Hive topic, else the
--     harness's own topic — exactly how coord_event_log / harness_issues federate).
--   • scope = 'operator'        → the Hive's shared backlog. Resolve to the workspace's
--     single kind:'hive' HOME (the canonical "operator coordination rides the kind:'hive'
--     home-harness slug"). 0 or >1 Hive homes → NOT enqueued (stays local; we do not
--     guess which Hive owns it — the multi-Hive operator-owner pointer is a follow-on).
--   • any other scope / workspace_id IN ('', '*') (SU cross-workspace meta) → local.
-- The resolved slug is stamped into the outbox row's jsonb as `harness_slug` so the
-- read-side projection (projections/engineer-issues.ts, tableTag 'engineer-issues')
-- demuxes per-harness exactly like hive_settings / plan_item_assignments.
--
-- Mechanism = the established federated-table pattern (migs 125/150/186/189): a custom
-- capture fn (engineer_issues' scope column needs derivation, like hive_members'
-- hive_home_slug) → substrate_outbox; INSERT/DELETE always (echo-guard skips remote),
-- UPDATE only on a federated-field change (not on the BEFORE-trigger updated_at bump).
-- The standard fed columns (origin/author_pubkey already on the table; fed_ts added
-- here) carry echo-guard + provenance + LWW.
--
-- Must land WITH the code (projections/engineer-issues.ts + register-all.ts +
-- projection-engine.ts PEER_LOG_TAG_TO_TABLE + feature-issue-op-keys.ts mapper +
-- table-registry.ts move to PEER_LOG_WORKSPACE_OWNED). Apply after an operator restart
-- so the drain can dispatch the new table_name. Idempotent; composes onto 000-baseline
-- + 131 (engineer_issues) + 142/152 (kind/payload) + 184 (hives).

\set ON_ERROR_STOP on
BEGIN;

-- Federation LWW column (origin + author_pubkey shipped in mig 131). fed_ts is the
-- last-writer-wins clock the projection compares + stamps on apply.
ALTER TABLE harness_shared.engineer_issues
    ADD COLUMN IF NOT EXISTS fed_ts bigint;

COMMENT ON COLUMN harness_shared.engineer_issues.fed_ts IS
    'Federation LWW clock (B5 work-queue flip). NULL for never-federated local rows; set from the op ts on a projection apply. The PG-level LWW guard drops a strictly-older op.';

-- ── Custom capture fn: derive the federation slug from `scope`, stamp it into the
--    outbox row jsonb (projection demux), enqueue local-origin writes. ─────────────
CREATE OR REPLACE FUNCTION harness_shared.capture_engineer_issues_outbox() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_op      TEXT;
      v_rec     RECORD;
      v_origin  TEXT;
      v_key     TEXT;
      v_row     JSONB;
      v_ws      TEXT;
      v_scope   TEXT;
      v_slug    TEXT;
      v_cnt     INT;
      v_keycol  TEXT := TG_ARGV[0];
    BEGIN
      IF (TG_OP = 'DELETE') THEN
        v_op := 'del';
        v_rec := OLD;
      ELSE
        v_op := 'put';
        v_rec := NEW;
      END IF;

      v_row := to_jsonb(v_rec);
      v_origin := v_row ->> 'origin';

      -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
      IF COALESCE(v_origin, 'local') <> 'local' THEN
        RETURN v_rec;
      END IF;

      v_ws := COALESCE(v_row ->> 'workspace_id', '');
      -- SU cross-workspace meta (workspace_id '*') + unscoped rows have no single Hive
      -- to ride → stay local.
      IF v_ws = '' OR v_ws = '*' THEN
        RETURN v_rec;
      END IF;

      -- Derive the federation slug from `scope` (the canonical Hive-home keying).
      v_scope := v_row ->> 'scope';
      IF v_scope LIKE 'harness:%' THEN
        v_slug := substr(v_scope, 9);
      ELSIF v_scope = 'operator' THEN
        -- Operator/Queen shared backlog rides the workspace's single Hive home.
        -- 0 or >1 Hive homes → ambiguous → stay local (do NOT guess; the multi-Hive
        -- operator-owner pointer is a documented follow-on).
        SELECT count(*)::int, min(home_slug) INTO v_cnt, v_slug
          FROM harness_shared.hives WHERE workspace_id = v_ws;
        IF v_cnt <> 1 THEN
          RETURN v_rec;
        END IF;
      ELSE
        -- Unknown scope shape → stay local.
        RETURN v_rec;
      END IF;

      IF v_slug IS NULL OR v_slug = '' THEN
        RETURN v_rec;
      END IF;

      v_key := v_row ->> v_keycol;
      -- Stamp the resolved federation slug into the wire row so the read-side
      -- projection can demux per-harness (engineer_issues has no harness_slug column).
      v_row := v_row || jsonb_build_object('harness_slug', v_slug);

      INSERT INTO harness_shared.substrate_outbox
        (workspace_id, harness_slug, table_name, op, key, row, ts)
      VALUES
        (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
         (extract(epoch from now()) * 1000)::bigint);

      PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

      RETURN v_rec;
    END;
    $$;

-- INSERT/DELETE always capture (the echo-guard handles remote). The key column is
-- issue_id (matches the projection composeKey).
CREATE OR REPLACE TRIGGER capture_engineer_issues_outbox_trg
  AFTER INSERT OR DELETE ON harness_shared.engineer_issues
  FOR EACH ROW EXECUTE FUNCTION harness_shared.capture_engineer_issues_outbox('issue_id');

-- UPDATE only when a FEDERATED field changes — NOT on the BEFORE-trigger updated_at
-- bump (engineer_issues_updated_at_trg sets updated_at on every UPDATE, so an
-- OLD.* IS DISTINCT FROM NEW.* guard would re-federate every touch).
CREATE OR REPLACE TRIGGER capture_engineer_issues_outbox_upd_trg
  AFTER UPDATE ON harness_shared.engineer_issues
  FOR EACH ROW WHEN (
       OLD.scope             IS DISTINCT FROM NEW.scope
    OR OLD.title             IS DISTINCT FROM NEW.title
    OR OLD.body              IS DISTINCT FROM NEW.body
    OR OLD.severity          IS DISTINCT FROM NEW.severity
    OR OLD.source            IS DISTINCT FROM NEW.source
    OR OLD.state             IS DISTINCT FROM NEW.state
    OR OLD.assignee          IS DISTINCT FROM NEW.assignee
    OR OLD.assigned_by       IS DISTINCT FROM NEW.assigned_by
    OR OLD.assigned_at       IS DISTINCT FROM NEW.assigned_at
    OR OLD.found_during      IS DISTINCT FROM NEW.found_during
    OR OLD.linked_feature_id IS DISTINCT FROM NEW.linked_feature_id
    OR OLD.kind              IS DISTINCT FROM NEW.kind
    OR OLD.payload           IS DISTINCT FROM NEW.payload
    OR OLD.created_by        IS DISTINCT FROM NEW.created_by
  )
  EXECUTE FUNCTION harness_shared.capture_engineer_issues_outbox('issue_id');

COMMIT;
