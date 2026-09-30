-- 790-expose-goal-id-on-engineer-issues-view.sql — WI-37711.
--
-- WHY: `work_items.goal_id` (migration 785, P-002) is stamped by
-- `stampGoalProvenance`, but the `engineer_issues` VIEW — the issue family's ONLY
-- read path — never selected it. So the claim-spec JS evaluator
-- (`claim-spec-match.ts`), which admits issue-family rows, had nothing to read:
-- a goal-scoped drain fleet could not be expressed for precisely the rows it
-- exists to drain (an agent in goal mode files bugs/changes/tasks straight onto
-- the queue, carrying a goal_id and no plan).
--
-- The SQL compiler half (`get-next.ts`, feature family) reads the BASE TABLE and
-- so needs no schema change; shipping only that half would make the SAME spec
-- admit an item on one family's path and refuse it on the other's — the
-- documented two-evaluator divergence class (EI-18654360178824151 / WI-5781).
--
-- NOT DESTRUCTIVE, so no FORWARD-COMPAT line is required: this only APPENDS a
-- readable column at the end of the view's select list. The currently-deployed
-- release selects a fixed column list by name and simply never asks for it.
--
-- SAFE UNDER THE INSTEAD-OF TRIGGER (`engineer_issues_view_dml`): both its
-- INSERT and UPDATE branches read the stored row back THROUGH THE VIEW into
-- v_stored and RETURN that (EI-19300744792370081), so `RETURNING <cols>` will
-- carry the real stored goal_id rather than the caller's input. The trigger's
-- UPDATE statement does not touch goal_id, which is exactly the desired
-- behaviour: a write through the view PRESERVES the stamped goal instead of
-- nulling it. Verified against pg_get_functiondef before writing this.
--
-- CREATE OR REPLACE VIEW preserves the relation OID, so the INSTEAD OF trigger
-- and any grants survive. Postgres only permits NEW columns at the END of the
-- list, which is where goal_id goes.

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
    -- WI-37711: NEW — the goal this item was filed under (migration 785).
    goal_id
   FROM harness_shared.work_items
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);
