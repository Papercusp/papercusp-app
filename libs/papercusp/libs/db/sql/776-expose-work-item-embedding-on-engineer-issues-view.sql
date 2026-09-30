-- 776: expose work_items.embedding + embedding_mode on the engineer_issues view.
--
-- WHY. `search:semantic`'s hybrid fusion asks each SearchSource for an
-- `embedding()` leg. The `work_item` source (agent-tools/search/sources.ts) had
-- none, so work-items were reachable only lexically — the gap recorded as D-078
-- on context-injection-retrieval-reach-and-visibility-2026-08-03 ("injection's
-- semantic reach is ONE SOURCE WIDE") and as P-005 there / P-012 on
-- semantic-search-fingerprint-coverage-2026-08-03.
--
-- The source's own comment blamed a missing column: "harness_shared.engineer_issues
-- has no embedding column yet". That was true of the VIEW and false of the data.
-- Measured 2026-08-09: `harness_shared.work_items` carries `embedding vector(768)`
-- populated on 36,302 of 36,304 rows (99.99%, mode 'gemma') behind an HNSW cosine
-- index (`work_items_embedding_hnsw_idx`). The embeddings, the index and the
-- backfill were all already there; the view simply did not select the column, and
-- the view is what the source queries.
--
-- This is the same shape as the severity trap documented in CLAUDE.md: the view
-- explodes `payload->'_ei'` into columns and DROPS what it does not name, so an
-- accessor that is correct against the table returns nothing against the view —
-- silently, with no error. Widening the view (rather than pointing the new leg at
-- the base table) keeps BOTH legs of the source on ONE relation: the scope
-- derivation (`CASE ... 'harness:'||harness_slug`), the `severity` COALESCE and the
-- `item_kind IN (bug,change,task)` row set stay defined exactly once. A leg reading
-- the base table would have to restate all three, which is precisely how they drift.
--
-- SHAPE. `CREATE OR REPLACE VIEW` may only APPEND columns, so `embedding` and
-- `embedding_mode` go last; every existing column keeps its name, type and
-- ordinal. The view's INSTEAD OF DML triggers are attached to the relation and
-- survive the replace untouched — they address columns by name and neither new
-- column is writable through them (embeddings are written by the fingerprint
-- pipeline against the base table, never through this view).
--
-- ⚠ HAZARD THIS ARMS, stated so it is not rediscovered the expensive way: a
-- `SELECT *` against this view now ships a 768-dimension vector per row.
-- `engineer_issues` list reads are the single largest DB consumer in this system
-- (WI-6993), so that would be an expensive mistake. Measured 2026-08-09 before
-- writing this: there are ZERO `SELECT *` sites against the view in product code
-- (the only two matches are SQL *string literals* inside pg-read-query.test.ts,
-- which exercise a query parser and execute nothing). Every real read names its
-- columns. Keep it that way.
--
-- Idempotent: CREATE OR REPLACE.

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
    -- APPENDED BY 776. Both columns are READ-ONLY through this view.
    embedding,
    embedding_mode
   FROM harness_shared.work_items
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);

COMMENT ON VIEW harness_shared.engineer_issues IS
  'Issue-family (bug/change/task) projection of harness_shared.work_items. '
  'Explodes payload->''_ei'' into columns and DROPS the blob, so an _ei accessor '
  'that is correct against the base table returns NULL here (see CLAUDE.md). '
  'Exposes embedding/embedding_mode (776) for the work_item SearchSource''s '
  'embedding() leg — never SELECT * from this view, the vector is 768-dim.';
