-- 911 — dependency-unlock score for claim-spec ranking.
--
-- Extends the work-item dependency/readiness seam rather than creating a second graph:
-- work_item_deps remains the edge source, endpoint resolution keeps the exact feature-vs-
-- issue ref grammar used by work_item_is_blocked(), and terminal/absent blockers retain
-- the scheduler floor's semantics. The score is deliberately ONE-HOP: it counts downstream
-- work-items for which this candidate is the last PRESENT non-terminal blocker, i.e. rows
-- that completing the candidate would make dependency-ready immediately. Descendant count
-- would overstate impact by crediting work that remains blocked at the next hop.
--
-- The function takes the candidate row's four stable identity columns so every rank compiler
-- call site can use the same oracle without depending on that query's table alias. It is
-- STABLE and read-only; the reverse blocker index from migration 367 supplies the first hop.

CREATE OR REPLACE FUNCTION harness_shared.work_item_dependency_unlock_score(
    p_workspace text,
    p_harness   text,
    p_item      text,
    p_kind      text
)
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $function$
  WITH candidate AS (
    SELECT CASE
             WHEN p_kind = ANY (ARRAY['bug','change','task']) THEN p_item
             ELSE p_harness || '#' || p_item
           END AS candidate_ref
  ), immediately_unlocked AS (
    SELECT DISTINCT d.blocked_ref
      FROM candidate c
      JOIN harness_shared.work_item_deps d
        ON d.workspace_id = 'default'
       AND d.dep_type = 'blocks'
       AND d.blocker_ref = c.candidate_ref
      JOIN harness_shared.work_items blocked
        ON blocked.workspace_id = p_workspace
       AND d.blocked_ref = CASE
             WHEN blocked.item_kind = ANY (ARRAY['bug','change','task'])
               THEN blocked.feature_id
             ELSE blocked.harness_slug || '#' || blocked.feature_id
           END
     WHERE blocked.status NOT IN ('passed','deprecated','resolved','closed','done','dropped')
       AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.work_item_deps other
          WHERE other.workspace_id = d.workspace_id
            AND other.dep_type = 'blocks'
            AND other.blocked_ref = d.blocked_ref
            AND other.blocker_ref IS DISTINCT FROM c.candidate_ref
            AND (
              EXISTS (
                SELECT 1
                  FROM harness_shared.work_items bf
                 WHERE bf.workspace_id = blocked.workspace_id
                   AND bf.item_kind <> ALL (ARRAY['bug','change','task'])
                   AND (bf.harness_slug || '#' || bf.feature_id) = other.blocker_ref
                   AND bf.status NOT IN ('passed','deprecated','done','dropped')
              )
              OR EXISTS (
                SELECT 1
                  FROM harness_shared.work_items bi
                 WHERE bi.workspace_id = blocked.workspace_id
                   AND bi.item_kind = ANY (ARRAY['bug','change','task'])
                   AND bi.feature_id = other.blocker_ref
                   AND bi.status NOT IN ('resolved','closed','done','dropped')
              )
            )
       )
  )
  SELECT count(*)::integer FROM immediately_unlocked;
$function$;

COMMENT ON FUNCTION harness_shared.work_item_dependency_unlock_score(text, text, text, text) IS
  'One-hop dependency leverage: number of present non-terminal work-items for which this candidate is the last unresolved work_item_deps blocker. Used by claim-spec dependency_unlock_score ranking and exposed on claimability rows for explanation.';
