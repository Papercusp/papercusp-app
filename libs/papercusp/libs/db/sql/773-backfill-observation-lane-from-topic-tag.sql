-- 773 — backfill payload.lane='observation' for rows tagged papercusp-observation
-- whose lane is NULL.
--
-- P-006 / plan learning-loop-identity-and-consumption-2026-08-08, decision D-031.
--
-- WHY. Two different definitions of "the observation lane" were in use, in OPPOSITE
-- directions, and they disagreed by 834 rows (measured live 2026-08-09):
--
--   * EXCLUSION keys on the `lane` column: `lane IS DISTINCT FROM 'observation'`
--     (issues-engineer's excludeObservationLane, work-items.ts's
--     observationLaneExclusionSql) is what keeps observations out of the claim/triage
--     queue, per D-005.
--   * INCLUSION keyed on a `coord_links` topic-tag join, fenced to
--     `cl.workspace_id = coordScopeWorkspace()`.
--
-- A row tagged as an observation but with lane NULL therefore fell through the
-- exclusion while still being READ as an observation: measured 33 such rows, 6 of them
-- OPEN `bug` items sitting in the triage queue (EI-9245, EI-9246, EI-9268, EI-9414,
-- EI-9416, EI-13197 — all '[replication-liveness] no_replicator'), which is exactly
-- what D-005 says must never happen. D-031 makes `lane` the single canonical identity
-- and switches the readers onto it; this migration closes the remaining gap by giving
-- those already-tagged rows the lane they should always have had.
--
-- `lane` is GENERATED ALWAYS AS (payload ->> 'lane') STORED, so the write targets
-- `payload`; the column follows automatically. No DDL — data only, no destructive
-- change, nothing for FORWARD-COMPAT to acknowledge (the currently-deployed release
-- reads both definitions and is strictly better off with them agreeing).
--
-- Deliberately NOT done here: the inverse gap (471 lane rows carrying no tag edge, and
-- 330 whose edge is filed under the legacy workspace_id='default' from the
-- coordScopeWorkspace() cutover — EI-2760 / WI-4308). Under D-031 the tag is a label
-- rather than an identity, so re-scoping legacy edges is churn against a column that
-- is already correct.
--
-- Scope note: intentionally NOT filtered by workspace_id. The predicate is "this row
-- is tagged as an observation", and the whole point of D-031 is that the tag edge's
-- own workspace scope is unreliable — filtering on it here would reproduce the bug the
-- migration exists to fix. Joining on src_ref alone is safe because work-item ids are
-- globally unique (`coord_links.src_ref` -> `work_items.feature_id`).

UPDATE harness_shared.work_items w
   SET payload = jsonb_set(COALESCE(w.payload, '{}'::jsonb), '{lane}', '"observation"'::jsonb)
 WHERE w.payload ->> 'lane' IS NULL
   AND EXISTS (
         SELECT 1
           FROM harness_shared.coord_links cl
          WHERE cl.src_kind = 'issue'
            AND cl.rel = 'tagged'
            AND cl.dst_kind = 'topic'
            AND cl.dst_ref = 'papercusp-observation'
            AND cl.src_ref = w.feature_id
       );
