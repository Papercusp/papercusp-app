-- WI-10006321: give every live plan body a matching plan_revisions row.
--
-- The plan-parts reconcile sweep (packages/operator-core/lib/plan-parts/reconcile.ts,
-- defaultLoadPlans) dates a body by the latest plan_revisions row whose content_hash
-- equals harness_plans.content_hash, capped by updated_at. With no matching row it falls
-- back to updated_at alone, which non-content writes also bump (op_status, archived,
-- supersede; WI-10006276). Measured 2026-10-06 in papercusp-workspace: 338 local and 214
-- remote live plans had no matching revision. The writers behind them were raw SQL
-- outside withPlanLock (plan-run instance clone/retire, flagship seed/refresh, ad-hoc
-- spec scope) and pre-guard awaiting-acceptance flips; they now record a revision in the
-- same transaction as the body, so this one-shot only closes the historical gap.
--
-- Each backfilled row is stamped created_at = the plan's updated_at at backfill time.
-- That pins the content clock: a later non-content bump moves updated_at but not the
-- matching revision, so LEAST(...) stays put. Inflation that already happened is not
-- recoverable and stays as it is.
--
-- Idempotent: rows are inserted only where no revision matches, so a re-run is a no-op,
-- and a fresh install (no plans) is a no-op.
--
-- NO top-level BEGIN;/COMMIT; here — the migration runner already wraps this file in a
-- transaction together with its schema_migrations ledger INSERT.

-- 1. The ad-hoc spec scope was inserted with content only, so content_hash kept its ''
--    default and could never equal any revision's hash. Repair the hash on LOCAL rows;
--    a remote row is the origin's to correct, and rewriting it here would re-publish it
--    from this node. The update fires the usual capture/outbox triggers, which is the
--    correct federation of a real local correction.
UPDATE harness_shared.harness_plans
   SET content_hash = encode(sha256(convert_to(content, 'UTF8')), 'hex')
 WHERE content_hash = ''
   AND content IS NOT NULL
   AND origin IS DISTINCT FROM 'remote';

-- 2. Serialise against live revision writers for the rest of this transaction, so the
--    per-plan MAX(seq)+1 below cannot collide with a concurrent insert. Taken after the
--    harness_plans update above: writers lock harness_plans rows, then plan_revisions,
--    and this keeps the same order.
LOCK TABLE harness_shared.plan_revisions IN SHARE ROW EXCLUSIVE MODE;

-- 3. One SYSTEM revision per live body with no matching revision. Only bodies whose
--    stored hash IS the canonical hash of their content (hashPlanContent: hex sha256 of
--    the UTF-8 bytes) are snapshotted; a row whose hash disagrees with its body is a
--    different defect, and recording it would write a revision that lies about its bytes.
INSERT INTO harness_shared.plan_revisions (
  workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot, rationale,
  author_kind, author_id, session_id, session_kind, created_at
)
SELECT p.workspace_id,
       p.harness_slug,
       p.plan_slug,
       COALESCE((SELECT max(r.seq)
                   FROM harness_shared.plan_revisions r
                  WHERE r.workspace_id = p.workspace_id
                    AND r.harness_slug = p.harness_slug
                    AND r.plan_slug = p.plan_slug), 0) + 1,
       p.content_hash,
       p.content,
       'Backfill (migration 1376, WI-10006321): this live body had no matching revision. '
         || 'created_at is the plan''s updated_at when the backfill ran.',
       'system',
       'plan-revisions:live-body-backfill',
       NULL,
       NULL,
       (EXTRACT(EPOCH FROM COALESCE(p.updated_at, p.created_at, now())) * 1000)::bigint
  FROM harness_shared.harness_plans p
 WHERE p.archived = false
   AND p.content IS NOT NULL
   AND p.content_hash = encode(sha256(convert_to(p.content, 'UTF8')), 'hex')
   AND NOT EXISTS (
         SELECT 1
           FROM harness_shared.plan_revisions r
          WHERE r.workspace_id = p.workspace_id
            AND r.harness_slug = p.harness_slug
            AND r.plan_slug = p.plan_slug
            AND r.content_hash = p.content_hash);
