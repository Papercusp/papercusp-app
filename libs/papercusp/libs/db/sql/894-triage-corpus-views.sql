-- 894-triage-corpus-views.sql
-- P-003 of plan learning-loop-backlog-triage-2026-08-22 (work-item WI-40670).
--
-- The corpus predicate has now been hand-re-derived several times across this
-- plan, and it has three traps that each produce a plausible-looking wrong
-- number rather than an error:
--
--   1. FAN-OUT. 127 items are routed more than once. Without DISTINCT on the
--      routing CTE the corpus reads 1006 instead of 870.
--   2. TWO TERMINAL EVIDENCE SURFACES. `dropped` closes write
--      terminal_completion_ref; `done` closes write payload->'_completionEvidence';
--      NO route writes both. A reader that checks only one surface reports the
--      other route's closes as evidence-free, which looks like a finding rather
--      than a query gap.
--   3. TENANT/HARNESS SCOPE. The predicate is workspace-scoped but not
--      harness-scoped. Corpus 1 currently happens to be 100% harness 'papercusp',
--      but the full routed join spans FOUR harnesses, so widening the status
--      filter to include terminal rows silently mixes harnesses.
--
-- Encoding it once as a view removes the re-derivation, per the repo's
-- derive-don't-hand-maintain rule.
--
-- Purely additive (CREATE OR REPLACE VIEW, no DDL against existing relations),
-- so no FORWARD-COMPAT acknowledgment is required.

-- Every loop-routed work-item, terminal or not, with the routing dimensions
-- attached and the fan-out already collapsed.
CREATE OR REPLACE VIEW harness_shared.triage_routed_items AS
WITH first_routing AS (
  -- Keyed by (workspace_id, feature_id), NOT feature_id alone: picking the
  -- globally-earliest routing would let another workspace's routing row supply
  -- the lens/month for this workspace's item.
  SELECT DISTINCT ON (workspace_id, split_part(routed_ref, ':', 2))
         workspace_id                        AS routed_workspace_id,
         split_part(routed_ref, ':', 2)      AS fid,
         lens,
         to_timestamp(routed_at / 1000.0)    AS routed_at   -- routed_at is MILLIS
    FROM harness_shared.scout_routed_ideas
   WHERE routed_ref LIKE 'wi:%'
   ORDER BY workspace_id, split_part(routed_ref, ':', 2), routed_at ASC
)
SELECT w.workspace_id,
       w.harness_slug,
       w.feature_id,
       w.origin,
       (w.origin = 'local')                                   AS actionable,
       w.status,
       (w.status NOT IN ('done','resolved','passed','closed','deprecated','dropped'))
                                                              AS non_terminal,
       (w.lane IS NULL OR w.lane <> 'observation')             AS non_observation,
       fr.lens,
       date_trunc('month', fr.routed_at)::date                 AS routed_month,
       to_timestamp(w.closed_ts / 1000.0)                      AS closed_at,
       w.terminal_completion_ref,
       -- Both evidence surfaces, unified. Neither alone is sufficient.
       (w.terminal_completion_ref IS NOT NULL
        OR (w.payload ? '_completionEvidence'))                AS has_completion_evidence,
       (w.terminal_completion_ref LIKE 'P-008-MERGE%')         AS closed_by_triage
  FROM harness_shared.work_items w
  JOIN first_routing fr
    ON fr.fid = w.feature_id
   AND fr.routed_workspace_id = w.workspace_id;

COMMENT ON VIEW harness_shared.triage_routed_items IS
  'Every loop-routed work-item with routing dimensions, fan-out collapsed (127 items are routed more than once) and BOTH terminal evidence surfaces unified. Filter with non_terminal AND non_observation to get corpus 1. ALWAYS also filter workspace_id and harness_slug: the routing ledger spans four harnesses even though corpus 1 currently does not.';

-- Drain attribution: why items LEFT the corpus. This is deliberately a LIVE
-- view, not a snapshot -- it is the flow measurement whose baseline is the
-- stamped triage_snapshots row (D-020). Reporting drain against a live
-- denominator is the error this separation exists to prevent.
CREATE OR REPLACE VIEW harness_shared.triage_burndown AS
SELECT workspace_id,
       harness_slug,
       CASE WHEN closed_by_triage THEN 'triage' ELSE 'background' END AS cause,
       origin,
       count(*)                                                  AS items,
       count(*) FILTER (WHERE has_completion_evidence)            AS with_evidence,
       count(*) FILTER (WHERE NOT has_completion_evidence)        AS without_evidence,
       count(*) FILTER (WHERE closed_at > now() - interval '24 hours') AS closed_24h,
       count(*) FILTER (WHERE closed_at > now() - interval '7 days')   AS closed_7d
  FROM harness_shared.triage_routed_items
 WHERE NOT non_terminal
   AND non_observation
 GROUP BY workspace_id, harness_slug, cause, origin;

COMMENT ON VIEW harness_shared.triage_burndown IS
  'Corpus EXITS split by cause. The triage bucket is identified by the P-008-MERGE stamp in terminal_completion_ref. Measured 2026-08-22: triage 5, background 482 -- so ~99% of corpus drain is ordinary fleet work, and any burn-down that does not split these credits the triage with drain it did not cause (D-020).';
