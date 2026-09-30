-- 382: operator-issue scope removal — drop the harness_slug='' sentinel
-- (data-scoping-audit-2026-06-22, D-003 / D-007).
--
-- WHY: operator-scoped issues live in work_items with harness_slug='' (the sentinel).
-- The work_items PK is (harness_slug, feature_id), so '' is shared across ALL
-- workspaces — a latent cross-workspace PK collision (the audit's trigger). This
-- re-homes operator issues to a per-workspace slug 'operator:<workspace_id>' so the
-- key is workspace-unique, and makes `scope` derive PURELY from harness_slug
-- (harness_slug LIKE 'operator:%' => operator; else harness:<slug>) — dropping the
-- redundant payload._ei.scope reliance in the view + the CDC capture.
--
-- Blast radius: 2392 operator issues (verified). NO FKs reference work_items (no
-- cascade). feature_ids are globally unique among operator issues (the '' PK holds
-- today) so the re-key preserves uniqueness. The re-key runs with work_items
-- triggers DISABLED so the internal encoding change does NOT emit 2392 federation /
-- sync events (peers see the new state on their next read).
--
-- No app-code change: the engineer_issues view's `scope` API is unchanged (issues
-- still read/write scope='operator'|'harness:<slug>'); only the underlying
-- harness_slug encoding + the scope derivations change. The 4 dirty payload._ei.scope
-- rows ('papercusp'/'papercup'/a file path) are auto-normalized — the view + capture
-- now derive scope from harness_slug, ignoring the stale payload value.
--
-- Idempotent (re-key guarded on harness_slug=''). The runner provides the
-- transaction — NO BEGIN/COMMIT here (lint:migrations).

-- ── 1. Re-key existing operator issues, WITHOUT firing federation/sync triggers. ─────
ALTER TABLE harness_shared.work_items DISABLE TRIGGER USER;
UPDATE harness_shared.work_items
   SET harness_slug = 'operator:' || COALESCE(NULLIF(workspace_id, ''), 'default')
 WHERE item_kind IN ('bug', 'change', 'task')
   AND harness_slug = '';
ALTER TABLE harness_shared.work_items ENABLE TRIGGER USER;

-- ── 2. engineer_issues view: derive scope from harness_slug (drop the harness_slug=''
--       branch + the payload._ei.scope COALESCE primacy). Same columns/types/order,
--       so CREATE OR REPLACE is valid and the INSTEAD OF trigger stays attached. ─────
CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
  SELECT workspace_id,
     feature_id AS issue_id,
     CASE WHEN harness_slug LIKE 'operator:%' THEN 'operator'
          ELSE 'harness:' || harness_slug END AS scope,
     title,
     COALESCE(summary, '') AS body,
     COALESCE((payload -> '_ei') ->> 'severity', 'minor') AS severity,
     COALESCE((payload -> '_ei') ->> 'source', 'engineer') AS source,
     status AS state,
     taken_by AS assignee,
     (payload -> '_ei') ->> 'found_during' AS found_during,
     (payload -> '_ei') ->> 'linked_feature_id' AS linked_feature_id,
     (payload -> '_ei') ->> 'created_by' AS created_by,
     to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at,
     to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at,
     author_pubkey,
     origin,
     _search,
     item_kind AS kind,
     payload - '_ei' AS payload,
     (payload -> '_ei') ->> 'assigned_by' AS assigned_by,
     taken_at AS assigned_at,
     assignee_rank,
     rank_writer,
     rank_updated_at,
     fed_ts,
     COALESCE((payload -> '_ei') ->> 'signal_origin', 'local') AS signal_origin,
     fed_hlc
    FROM harness_shared.work_items
   WHERE item_kind = ANY (ARRAY['bug', 'change', 'task']);

-- ── 3. engineer_issues INSTEAD OF DML trigger: operator scope => harness_slug
--       'operator:<workspace_id>' (was ''). Only v_slug's ELSE branch changes. ───────
CREATE OR REPLACE FUNCTION harness_shared.engineer_issues_view_dml()
 RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE v_slug text; v_ei jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = OLD.workspace_id AND feature_id = OLD.issue_id
       AND item_kind IN ('bug', 'change', 'task');
    RETURN OLD;
  END IF;
  v_slug := CASE WHEN COALESCE(NEW.scope, 'operator') LIKE 'harness:%'
                 THEN substr(NEW.scope, 9)
                 ELSE 'operator:' || COALESCE(NULLIF(NEW.workspace_id, ''), 'default') END;
  v_ei := jsonb_strip_nulls(jsonb_build_object(
     'scope', NEW.scope, 'severity', NEW.severity, 'source', NEW.source,
     'found_during', NEW.found_during, 'linked_feature_id', NEW.linked_feature_id,
     'created_by', NEW.created_by, 'assigned_by', NEW.assigned_by, 'signal_origin', NEW.signal_origin));
  IF TG_OP = 'INSERT' THEN
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, taken_by, taken_at,
       expires_at, item_kind, origin, author_pubkey, assignee_rank, rank_writer,
       rank_updated_at, fed_ts, fed_hlc, ts, created_ts, updated_ts, payload)
    VALUES
      (COALESCE(NEW.workspace_id, 'default'), v_slug, NEW.issue_id, NEW.title,
       COALESCE(NEW.body, ''), COALESCE(NEW.state, 'open'), NEW.assignee, NEW.assigned_at,
       CASE WHEN NEW.assigned_at IS NOT NULL THEN NEW.assigned_at + INTERVAL '7 days' ELSE NULL END,
       COALESCE(NEW.kind, 'bug'), COALESCE(NEW.origin, 'local'), NEW.author_pubkey,
       NEW.assignee_rank, NEW.rank_writer, NEW.rank_updated_at, NEW.fed_ts, NEW.fed_hlc,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.created_at, now())) * 1000)::bigint,
       (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
       COALESCE(NEW.payload, '{}'::jsonb) || jsonb_build_object('_ei', v_ei));
    RETURN NEW;
  ELSE
    UPDATE harness_shared.work_items SET
      harness_slug = v_slug, title = NEW.title, summary = COALESCE(NEW.body, ''),
      status = NEW.state, taken_by = NEW.assignee, taken_at = NEW.assigned_at,
      item_kind = COALESCE(NEW.kind, 'bug'), origin = COALESCE(NEW.origin, 'local'),
      author_pubkey = NEW.author_pubkey, assignee_rank = NEW.assignee_rank,
      rank_writer = NEW.rank_writer, rank_updated_at = NEW.rank_updated_at,
      fed_ts = NEW.fed_ts, fed_hlc = NEW.fed_hlc,
      updated_ts = (extract(epoch FROM COALESCE(NEW.updated_at, now())) * 1000)::bigint,
      payload = (COALESCE(NEW.payload, '{}'::jsonb) - '_ei') || jsonb_build_object('_ei', v_ei)
    WHERE workspace_id = OLD.workspace_id AND feature_id = OLD.issue_id
      AND item_kind IN ('bug', 'change', 'task');
    RETURN NEW;
  END IF;
END;
$function$;

-- ── 4. CDC capture: derive the federation scope from harness_slug (drop the
--       payload._ei.scope COALESCE + the harness_slug='' branch). Only v_scope
--       changes; the harness->slug + operator->Hive-home resolution is unchanged. ────
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
        -- scope derived PURELY from harness_slug (D-003): operator:<ws> => operator;
        -- harness slug otherwise. (Was: COALESCE(payload._ei.scope, harness_slug='' …).)
        v_scope := CASE WHEN v_rec.harness_slug LIKE 'operator:%' THEN 'operator'
                        ELSE 'harness:' || v_rec.harness_slug END;
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
