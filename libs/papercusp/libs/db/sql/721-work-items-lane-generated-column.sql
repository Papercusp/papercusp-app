-- 721 — WI-6934: stop the `lane` filter from detoasting every work_items payload.
--
-- PROBLEM (measured, plan db-performance-remediation-2026-07-26 Phase 1).
-- The `engineer_issues` family is ~18.6% of live DB time across 6 queryids. Its hot
-- predicate is the observation-lane floor, written five ways in issues-engineer.ts as
--
--     COALESCE(payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
--
-- `payload` on the view is the computed `payload - '_ei'` column, and ANY jsonb operator
-- forces the WHOLE payload datum to be fetched and decompressed. payload/_search are large
-- and out-of-line (heap 56MB, indexes 99MB, TOAST 131MB), so a filter that needs ONE short
-- string reads the entire TOAST relation on every call.
--
-- Measured A/B on the live workspace (EXPLAIN ANALYZE, BUFFERS) for the histogram shape:
--     without the payload predicate   7,188 buffers  ~62 ms
--     with the payload predicate     21,966 buffers  ~186 ms   (3.06x)
-- 21,966 matches live queryid -1607068794715562087's 22,037 blks/call, so the A/B is
-- measuring the real statement and not a lookalike.
--
-- FIX. Materialise just that one string as a STORED generated column and filter on it.
-- The predicate then never touches payload, so the TOAST reads disappear.
--
-- WHY GENERATED rather than a plain column + backfill + trigger: drift becomes
-- STRUCTURALLY impossible instead of a discipline every future writer has to remember.
-- That matters on THIS relation specifically — it is the same shape as the documented
-- severity-accessor trap, where the wrong accessor returns NULL for every row WITHOUT
-- erroring, i.e. a well-formed, plausible, wrong answer. A hand-maintained lane column
-- would recreate exactly that failure mode.
--
-- EQUIVALENCE (proven transactionally on live data before writing this, then rolled back):
--   * the generated expression is legal — Postgres accepted the ALTER, so `payload->>'lane'`
--     is immutable as required;
--   * 0 disagreements between the column and `payload->>'lane'` over the sampled rows;
--   * NULL semantics match the live predicate EXACTLY. `COALESCE(payload,'{}')->>'lane'`
--     yields NULL for a NULL payload, the generated column yields NULL, and
--     `NULL IS DISTINCT FROM 'observation'` is TRUE either way — 2,468 rows both ways.
--   * `lane` is a TOP-LEVEL payload key, so `(payload - '_ei') ->> 'lane'` (what the view
--     exposes) and `payload ->> 'lane'` (what this column computes) are the same value.
--
-- LOCK COST. Adding a STORED generated column rewrites the table under ACCESS EXCLUSIVE.
-- Measured on a full 30,419-row copy of this exact table: **1.51 s**. Bounded and
-- acceptable for a fleet-hot relation; it is not an online-migration case.

-- ⚠ LOCK ORDER IS LOAD-BEARING — do not reorder these two statements.
--
-- A reader of engineer_issues locks the VIEW first and then the base table underneath it.
-- This migration touches the same two objects in the opposite order (ALTER the table, then
-- CREATE OR REPLACE the view), and on a fleet-hot table that inversion deadlocks — observed,
-- not theorised, on the first apply attempt:
--
--   ERROR: deadlock detected
--   Process A waits for AccessExclusiveLock on engineer_issues; blocked by process B.
--   Process B waits for AccessShareLock on work_items; blocked by process A.
--
-- Taking both locks up front, in the SAME order readers take them, removes the cycle: by the
-- time we touch either object we already hold both, so no reader can be half-way between them.
-- This also collapses two lock waits into one, which matters here because every wait on
-- work_items queues the whole fleet behind it (~105 active agents).
LOCK TABLE harness_shared.engineer_issues IN ACCESS EXCLUSIVE MODE;
LOCK TABLE harness_shared.work_items IN ACCESS EXCLUSIVE MODE;

ALTER TABLE harness_shared.work_items
  ADD COLUMN IF NOT EXISTS lane text GENERATED ALWAYS AS (payload ->> 'lane') STORED;

COMMENT ON COLUMN harness_shared.work_items.lane IS
  'WI-6934: materialised payload->>''lane'' so the observation-lane floor filters without '
  'detoasting payload. GENERATED ALWAYS — never write it directly; write payload.lane.';

-- Re-declare the view with `lane` appended. CREATE OR REPLACE VIEW permits adding columns
-- only at the END of the select list, which is why `lane` is last; every existing column
-- keeps its current name, type and ordinal.
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
    lane
   FROM harness_shared.work_items
  WHERE item_kind = ANY (ARRAY['bug'::text, 'change'::text, 'task'::text]);
