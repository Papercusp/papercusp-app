/** Exact historical recovery through plans:set-plan-status (EI-24954628187176721).
 * A retired rubric remains ineligible for fresh shipment. This restores bytes whose
 * shipment already passed, only when the remote row rolled back to the predecessor.
 */
import { withWorkspace } from '@papercusp/db-org';
import { parsePlan } from '@papercusp/plan-parser';
import { hashPlanContent } from './content-hash';
import { summarizeForcedPast } from './forced-past-stamp';
import { withPlanLock } from './with-plan-lock';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { resolvePlanScope } from './source';
import { emitPlanEventForCaller } from '../coordination/plan-events';

export interface HistoricalShipmentRequest {
  slug: string;
  harnessSlug?: string;
  expectedCurrent: string;
  seq: number;
  contentHash: string;
  expectedVersion: number;
  expectedContentHash: string;
}

export interface HistoricalShipmentWitness {
  version: number;
  content: string;
  contentHash: string;
  origin: string;
  seq: number;
  shippedBody: string;
  shippedHash: string;
  predecessorBody: string;
  localShipmentCaptured: boolean;
  rubricRetiredWithShipment: boolean;
}

type HistoricalShipmentValue =
  | { ok: false; code: string }
  | { ok: true; changed: true; oldStatus: string; newStatus: string;
      restoredShippedRevision: number; restoredContentHash: string };

/** Fail closed on unknown proof, changed work, or an authored lifecycle change. */
export function historicalShipmentRefusal(
  w: HistoricalShipmentWitness | null,
  request: HistoricalShipmentRequest,
): string | null {
  if (!w) return 'historical_shipment_not_found';
  if (w.version !== request.expectedVersion || w.contentHash !== request.expectedContentHash ||
      hashPlanContent(w.content) !== request.expectedContentHash) return 'historical_shipment_stale';
  if (w.seq !== request.seq || w.shippedHash !== request.contentHash ||
      hashPlanContent(w.shippedBody) !== request.contentHash) return 'historical_shipment_head_changed';
  if (parsePlan(w.shippedBody).frontmatter.status !== 'shipped' || summarizeForcedPast(w.shippedBody)) {
    return 'historical_shipment_not_validated';
  }
  if (w.origin !== 'remote' || w.content !== w.predecessorBody ||
      parsePlan(w.content).frontmatter.status !== request.expectedCurrent || w.content === w.shippedBody) {
    return 'historical_shipment_not_remote_rollback';
  }
  if (!w.localShipmentCaptured || !w.rubricRetiredWithShipment) return 'historical_shipment_proof_missing';
  return null;
}

/** Exported for the real-PostgreSQL guard (restore-historical-shipment.integration.test.ts). */
export async function readHistoricalShipmentWitness(
  scope: { workspaceId: string; harnessSlug: string },
  slug: string,
): Promise<HistoricalShipmentWitness | null> {
  return withWorkspace(scope.workspaceId, async (tx) => {
    const rows = await tx<{
      version: string | number; content: string; content_hash: string; origin: string;
      seq: number; shipped_body: string; shipped_hash: string; predecessor_body: string;
      local_shipment_captured: boolean; durable_shipment_attested: boolean;
      rubric_retired_with_shipment: boolean;
    }[]>`
      SELECT p.version, p.content, p.content_hash, p.origin, head.seq,
             head.content_snapshot AS shipped_body, head.content_hash AS shipped_hash,
             prior.content_snapshot AS predecessor_body,
             EXISTS (
               SELECT 1 FROM harness_shared.substrate_outbox o
                WHERE o.workspace_id = p.workspace_id AND o.harness_slug = p.harness_slug
                  AND o.table_name = 'harness_plans' AND o.key = p.plan_slug
                  AND o.row->>'content_hash' = head.content_hash
                  AND o.row->>'status' = 'shipped' AND o.row->>'origin' = 'local'
             ) AS local_shipment_captured,
             -- substrate_outbox is pruned within hours (WI-10006248), so the capture
             -- above expires long before a rollback may be noticed. The durable pair:
             -- the head revision (a remote replay writes no revision row, and
             -- author_id is NOT NULL by schema) and the local-origin shipped event its
             -- own author emitted within minutes of writing it.
             (EXISTS (
               SELECT 1 FROM harness_shared.coord_event_log e
                WHERE e.workspace_id = p.workspace_id AND e.surface = 'plan-events'
                  AND (e.harness_slug IS NULL OR e.harness_slug = p.harness_slug)
                  AND e.origin = 'local' AND e.writer_key = head.author_id
                  AND e.body->>'plan_slug' = p.plan_slug
                  AND e.body->>'event' = 'status_changed' AND e.body->>'after' = 'shipped'
                  AND e.ts BETWEEN to_timestamp(head.created_at / 1000.0) - interval '5 minutes'
                               AND to_timestamp(head.created_at / 1000.0) + interval '5 minutes'
             )) AS durable_shipment_attested,
             EXISTS (
               SELECT 1 FROM harness_shared.harness_plans rubric
               JOIN LATERAL (
                 SELECT r.rationale FROM harness_shared.plan_revisions r
                  WHERE r.workspace_id = rubric.workspace_id AND r.harness_slug = rubric.harness_slug
                    AND r.plan_slug = rubric.plan_slug ORDER BY r.seq DESC LIMIT 1
               ) retired ON true
                WHERE rubric.workspace_id = p.workspace_id AND rubric.template = 'rubric'
                  AND rubric.template_data->>'kind' = 'acceptance'
                  AND rubric.template_data->>'subjectPlan' = p.plan_slug
                  AND rubric.template_data->>'subjectHarnessSlug' = p.harness_slug
                  AND rubric.status = 'superseded'
                  AND retired.rationale = 'acceptance rubric retired with its shipped subject plan'
             ) AS rubric_retired_with_shipment
        FROM harness_shared.harness_plans p
        JOIN LATERAL (
          SELECT r.seq, r.content_snapshot, r.content_hash, r.author_id, r.author_kind, r.created_at
            FROM harness_shared.plan_revisions r
           WHERE r.workspace_id = p.workspace_id AND r.harness_slug = p.harness_slug
             AND r.plan_slug = p.plan_slug ORDER BY r.seq DESC LIMIT 1
        ) head ON true
        -- The body a rollback reinstates is the last PRE-SHIPMENT revision: the latest one
        -- before the head whose hash differs from the shipped head. Not head.seq - 1: a
        -- successful restore writes a revision that duplicates the shipped body, so after a
        -- REPEAT rollback head.seq - 1 is itself the shipped body and could never match
        -- (WI-10006328). The content === predecessor guard below is otherwise unchanged.
        JOIN LATERAL (
          SELECT r.content_snapshot FROM harness_shared.plan_revisions r
           WHERE r.workspace_id = p.workspace_id AND r.harness_slug = p.harness_slug
             AND r.plan_slug = p.plan_slug AND r.seq < head.seq
             AND r.content_hash <> head.content_hash
           ORDER BY r.seq DESC LIMIT 1
        ) prior ON true
       WHERE p.workspace_id = ${scope.workspaceId} AND p.harness_slug = ${scope.harnessSlug}
         AND p.plan_slug = ${slug}
    `;
    const row = rows[0];
    return row ? {
      version: Number(row.version), content: row.content, contentHash: row.content_hash, origin: row.origin,
      seq: Number(row.seq), shippedBody: row.shipped_body, shippedHash: row.shipped_hash,
      predecessorBody: row.predecessor_body,
      localShipmentCaptured: row.local_shipment_captured || row.durable_shipment_attested,
      rubricRetiredWithShipment: row.rubric_retired_with_shipment,
    } : null;
  });
}

export async function restoreHistoricalShipment(ctx: PlanRevisionCtx, request: HistoricalShipmentRequest) {
  const scope = await resolvePlanScope({
    harnessSlug: request.harnessSlug,
    ...((ctx as { workspaceId?: string }).workspaceId ? { workspaceId: (ctx as { workspaceId: string }).workspaceId } : {}),
  });
  const witness = await readHistoricalShipmentWitness(scope, request.slug);
  const refusal = historicalShipmentRefusal(witness, request);
  if (refusal || !witness) return { ok: false as const, code: refusal ?? 'historical_shipment_not_found' };
  const revision = planRevisionCapture(ctx, request.slug,
    `Restored historical shipped revision ${request.seq} after an unrecorded remote rollback`, scope);
  const result = await withPlanLock<HistoricalShipmentValue>(ctx, {
    slug: request.slug, ...scope, loadLatestRevision: true,
    intent: `restore historically shipped revision ${request.seq}`,
    revisionInTransaction: revision.inTransaction,
    inTransaction: async (tx, body, lockedScope) => {
      if (body !== witness.shippedBody) throw new Error('historical shipment changed before commit');
      await tx`
        SELECT set_config('papercusp.plan_shipment_acceptance_gate_receipt', jsonb_build_object(
          'schemaVersion', '1', 'transactionId', txid_current()::text,
          'workspaceId', ${lockedScope.workspaceId}::text,
          'harnessSlug', ${lockedScope.harnessSlug}::text, 'planSlug', ${request.slug}::text
        )::text, true)
      `;
    },
  }, async (current, meta) => {
    if (!meta || current !== witness.content || meta.version !== request.expectedVersion ||
        meta.contentHash !== request.expectedContentHash || meta.latestRevision?.seq !== request.seq ||
        meta.latestRevision.body !== witness.shippedBody) {
      return { newBody: null, value: { ok: false as const, code: 'historical_shipment_stale' } };
    }
    return { newBody: witness.shippedBody, value: {
      ok: true as const, changed: true, oldStatus: request.expectedCurrent, newStatus: 'shipped',
      restoredShippedRevision: request.seq, restoredContentHash: request.contentHash,
    } };
  });
  if (result.kind === 'busy') return { ...result, ok: false as const, code: 'busy' };
  if (result.value.ok) await emitPlanEventForCaller(ctx, {
    planSlug: request.slug, event: 'status_changed', before: request.expectedCurrent, after: 'shipped',
  });
  return { ...result.value, version: result.version, revision: revision.recorded.current };
}
