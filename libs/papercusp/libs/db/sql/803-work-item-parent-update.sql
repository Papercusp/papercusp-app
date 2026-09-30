-- 803-work-item-parent-update.sql — EI-20018021869343311
--
-- The unified work_items base table has carried parent_id for feature/chunk rows,
-- but the engineer_issues compatibility view dropped it. That made an existing
-- issue-family duplicate/child relation impossible to create through
-- work_items:create, impossible to read through work_items:get, and impossible to
-- update through work_items:update. Expose the already-existing base column at the
-- end of the view and thread it through the INSTEAD OF DML trigger.
--
-- Additive only: parent_id already exists on harness_shared.work_items. CREATE OR
-- REPLACE VIEW appends the new column, preserving every existing ordinal and the
-- trigger relation. The trigger surgery is guarded by exact anchors so a future
-- restructured trigger fails loudly instead of installing a partial no-op.

CREATE OR REPLACE VIEW harness_shared.engineer_issues AS
 SELECT workspace_id,
    feature_id AS issue_id,
        CASE
            WHEN harness_slug ~~ 'operator:%'::text OR harness_slug = ''::text THEN 'operator'::text
            ELSE 'harness:'::text || harness_slug
        END AS scope,
    title,
    COALESCE(summary, ''::text) AS body,
    COALESCE((payload -> '_ei'::text) ->> 'severity'::text, 'minor'::text) AS severity,
    COALESCE((payload -> '_ei'::text) ->> 'source'::text, 'engineer'::text) AS source,
    status AS state,
    taken_by AS assignee,
    (payload -> '_ei'::text) ->> 'found_during'::text AS found_during,
    (payload -> '_ei'::text) ->> 'linked_feature_id'::text AS linked_feature_id,
    (payload -> '_ei'::text) ->> 'created_by'::text AS created_by,
    to_timestamp((created_ts::numeric / 1000.0)::double precision) AS created_at,
    to_timestamp((updated_ts::numeric / 1000.0)::double precision) AS updated_at,
    author_pubkey,
    origin,
    _search,
    item_kind AS kind,
    payload - '_ei'::text AS payload,
    (payload -> '_ei'::text) ->> 'assigned_by'::text AS assigned_by,
    taken_at AS assigned_at,
    assignee_rank,
    rank_writer,
    rank_updated_at,
    fed_ts,
    COALESCE((payload -> '_ei'::text) ->> 'signal_origin'::text, 'organic'::text) AS signal_origin,
    fed_hlc,
    terminal_owner,
    terminal_completion_ref,
    last_progress_at,
    harness_slug AS base_harness_slug,
    origin AS base_origin,
    feature_order,
    terminal_reason,
    authority,
    closed_ts,
    lane,
    embedding,
    embedding_mode,
    goal_id,
    parent_id
   FROM harness_shared.work_items
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);

DO $parent_dml$
DECLARE
  v_def text;
  v_insert_cols text := 'terminal_owner, terminal_completion_ref, last_progress_at, authority)';
  v_insert_vals text := 'NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at, NEW.authority);';
  v_update_set text := 'terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref, authority = NEW.authority';
BEGIN
  SELECT pg_get_functiondef('harness_shared.engineer_issues_view_dml()'::regprocedure) INTO v_def;
  IF position('NEW.parent_id' IN v_def) > 0 THEN
    RAISE NOTICE '803: engineer_issues_view_dml already carries parent_id — no-op';
    RETURN;
  END IF;
  IF position(v_insert_cols IN v_def) = 0
     OR position(v_insert_vals IN v_def) = 0
     OR position(v_update_set IN v_def) = 0 THEN
    RAISE EXCEPTION '803: engineer_issues_view_dml anchors not found — trigger was restructured; re-derive the surgery instead of installing a partial parent update';
  END IF;
  v_def := replace(v_def, v_insert_cols,
    'terminal_owner, terminal_completion_ref, last_progress_at, authority, parent_id)');
  v_def := replace(v_def, v_insert_vals,
    'NEW.terminal_owner, NEW.terminal_completion_ref, NEW.last_progress_at, NEW.authority, NEW.parent_id);');
  v_def := replace(v_def, v_update_set,
    'terminal_owner = NEW.terminal_owner, terminal_completion_ref = NEW.terminal_completion_ref, authority = NEW.authority, parent_id = NEW.parent_id');
  IF position('NEW.parent_id' IN v_def) = 0 THEN
    RAISE EXCEPTION '803: engineer_issues_view_dml parent_id surgery did not produce NEW.parent_id';
  END IF;
  EXECUTE v_def;
END
$parent_dml$;
