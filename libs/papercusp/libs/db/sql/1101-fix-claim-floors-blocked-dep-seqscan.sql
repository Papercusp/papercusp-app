-- 1101-fix-claim-floors-blocked-dep-seqscan.sql — EI-22201349964242175
-- Reserved via db:next-migration before editing.
--
-- Follow-up to EI-21553706255036686 / migration 1100 (parallel-safe). 1100 fixed the
-- STATEMENT-TIMEOUT symptom by letting the planner spread work_item_claim_floors(...)
-- across workers; it explicitly did not touch per-row cost. This migration is the
-- "reduce the work" half 1100 deliberately deferred, and targets the SPECIFIC cause,
-- not a general cost re-tune.
--
-- MEASURED CAUSE (2026-09-03, this database) ------------------------------------------
--
-- Claim floor #12 ("blocked-dep", unchanged since migration 654) checks whether a
-- candidate row has a live blocking dependency. For a FEATURE-family blocker it does:
--
--   EXISTS (SELECT 1 FROM harness_shared.harness_features_consolidated bf
--            WHERE (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
--              AND bf.status NOT IN ('passed','deprecated','done','dropped'))
--
-- harness_features_consolidated is `SELECT * FROM work_items WHERE item_kind <> ALL
-- ('{bug,change,task}')` — i.e. a plain filter over the WHOLE base table, every
-- workspace and harness, no scope predicate of its own. The match condition
-- concatenates two columns (`harness_slug || '#' || feature_id`) before comparing, which
-- is un-indexable: no expression index exists over that concatenation, so Postgres
-- cannot push it into work_items_pkey (harness_slug, feature_id) and instead runs a
-- full Seq Scan of the base table for every call that reaches this branch.
--
-- Measured directly (EXPLAIN ANALYZE, BUFFERS, this DB, this table at ~169k rows /
-- 2090MB heap):
--   Seq Scan on work_items … Buffers: shared hit=267508   (216 ms, one call)
-- vs the semantically-equivalent indexed lookup using the SAME pkey columns split back
-- out of blocker_ref:
--   Index Scan using work_items_pkey … Buffers: shared hit=3   (0.03 ms, one call)
-- ~89,000x fewer buffers per call, for an identical result set.
--
-- This branch is gated behind "does this candidate have a work_item_deps row with
-- dep_type='blocks'" (cheap, small table) — most rows never reach it — but the harness
-- currently has 23 distinct blocked_ref-bearing candidates in the papercusp claimable
-- backlog alone; 23 * ~267,508 buffers ≈ 6.2M, the dominant share of the ~10.9M total
-- shared-buffer hits measured on `EXPLAIN (ANALYZE, BUFFERS) SELECT count(*) FROM
-- work_items_claimable WHERE harness_slug='papercusp'` (EI-22201349964242175). This is
-- also why parallelising the scan (1100) barely moved buffer traffic: it distributed
-- the SAME per-call disaster across workers, it did not remove it. And it will only get
-- worse: every harness that accumulates cross-item blocking deps pays this on every
-- claimable read.
--
-- THE FIX ------------------------------------------------------------------------------
--
-- Query-shape only. blocker_ref is produced (by the writer side, unchanged) as exactly
-- `<harness_slug>#<feature_id>`, so it can be split back into its two components with
-- split_part(…, '#', 1|2) and matched against work_items_pkey directly — an ordinary
-- indexed equality lookup instead of a full scan. Neither harness_slug nor feature_id
-- contains '#' anywhere in this database today (verified: 0 rows either way), so the
-- split is a lossless inverse of the original concatenation. The ORIGINAL concatenation
-- predicate is kept alongside the split-based one (redundant once the index has already
-- narrowed to the handful of matching pkey rows) purely as a defense-in-depth equivalence
-- guard — it costs nothing extra there and makes this a semantics-preserving rewrite by
-- construction, not just by argument.
--
-- No floor label, return type, or evaluation semantics change: 'blocked-dep' still means
-- exactly what it meant before, for exactly the same rows. Everything else — floors
-- #1-11 and #13, the STABLE volatility, the hardcoded workspace_id='default' in this
-- floor's work_item_deps/engineer_issues legs (pre-existing, out of scope here) — is
-- carried through unchanged via delegation to the snapshotted prior version, following
-- the same versioned-wrapper pattern as 1070/1072/1081.
--
-- FORWARD-COMPAT: the versioned-function rename and stable public-function recreation
-- commit atomically in one transaction, so a concurrent reader (including the
-- currently-deployed :3070 release, which calls only the stable 9-arg public signature)
-- never observes a window where that signature is missing.

DO $function_guard1101$
BEGIN
  IF to_regprocedure(
       'harness_shared.work_item_claim_floors_v22(text,text,text,text,text,text,text,jsonb,text)'
     ) IS NULL THEN
    IF to_regprocedure(
         'harness_shared.work_item_claim_floors(text,text,text,text,text,text,text,jsonb,text)'
       ) IS NULL THEN
      RAISE EXCEPTION '1101: public work_item_claim_floors function is missing';
    END IF;
    ALTER FUNCTION harness_shared.work_item_claim_floors(
      text, text, text, text, text, text, text, jsonb, text
    ) RENAME TO work_item_claim_floors_v22;
  END IF;
END
$function_guard1101$;

CREATE OR REPLACE FUNCTION harness_shared.work_item_claim_floors(
  p_workspace_id            text,
  p_status                  text,
  p_taken_by                text,
  p_origin                  text,
  p_title                   text,
  p_terminal_owner          text,
  p_terminal_completion_ref text,
  p_payload                 jsonb,
  p_feature_id              text
) RETURNS text[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_remove(
    array_append(
      array_remove(
        harness_shared.work_item_claim_floors_v22(
          p_workspace_id,
          p_status,
          p_taken_by,
          p_origin,
          p_title,
          p_terminal_owner,
          p_terminal_completion_ref,
          p_payload,
          p_feature_id
        ),
        'blocked-dep'::text
      ),
      CASE WHEN EXISTS (
             SELECT 1 FROM harness_shared.work_item_deps d
              WHERE d.workspace_id = 'default' AND d.dep_type = 'blocks' AND d.blocked_ref = p_feature_id
                AND (
                  -- Indexed rewrite of the original
                  -- `(bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref` scan: split
                  -- blocker_ref back into the pkey's two columns and match by equality so the
                  -- planner can use work_items_pkey (harness_slug, feature_id) instead of a
                  -- Seq Scan over the whole base table. The original concatenation form is
                  -- kept too, as a cheap equivalence guard over the tiny candidate set the
                  -- index already narrowed to.
                  EXISTS (
                    SELECT 1 FROM harness_shared.work_items bf
                     WHERE bf.harness_slug = split_part(d.blocker_ref, '#', 1)
                       AND bf.feature_id   = split_part(d.blocker_ref, '#', 2)
                       AND (bf.harness_slug || '#' || bf.feature_id) = d.blocker_ref
                       AND bf.item_kind <> ALL (ARRAY['bug','change','task'])
                       AND bf.status NOT IN ('passed','deprecated','done','dropped')
                  )
                  OR EXISTS (
                    SELECT 1 FROM harness_shared.engineer_issues bi
                     WHERE bi.workspace_id = 'default' AND bi.issue_id = d.blocker_ref
                       AND bi.state NOT IN ('resolved','closed','done','dropped')
                  )
                )
           ) THEN 'blocked-dep'::text
      END
    ),
    NULL::text
  )
$$;

COMMENT ON FUNCTION harness_shared.work_item_claim_floors(
  text, text, text, text, text, text, text, jsonb, text
) IS
  'P-001/P-002 claim-floor SSOT. Mirrors claimNextIssueWorkItem unconditional floors; every prior floor unchanged via delegation. EI-22201349964242175 rewrites floor #12 (blocked-dep)''s feature-family branch to an indexed work_items_pkey (harness_slug, feature_id) lookup instead of an unindexable harness_slug||''#''||feature_id concatenation scan over the whole base table (was ~267K buffer hits per call via Seq Scan, now ~3) — query-shape only, same floor semantics, same result set.';

CREATE OR REPLACE VIEW harness_shared.work_items_claimable AS
  SELECT wi.*
    FROM harness_shared.work_items wi
   WHERE wi.item_kind IN ('bug', 'change', 'task')
     AND wi.status = 'open'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'lane' IS DISTINCT FROM 'observation'
     AND COALESCE(wi.payload, '{}'::jsonb) ->> 'needsOwnerAction' IS DISTINCT FROM 'true'
     AND cardinality(harness_shared.work_item_claim_floors(
           wi.workspace_id, wi.status, wi.taken_by, wi.origin, wi.title,
           wi.terminal_owner, wi.terminal_completion_ref, wi.payload, wi.feature_id
         )) = 0;

COMMENT ON VIEW harness_shared.work_items_claimable IS
  'P-001/P-002 issue-family rows passing every unconditional claim floor. EI-22201349964242175: floor #12''s feature-family branch is now an indexed lookup instead of a full-table scan; view semantics unchanged.';
