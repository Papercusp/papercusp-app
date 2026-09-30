/**
 * plan-scope-cascade-deps.ts — production wiring for {@link propagatePlanScopeWrite}
 * (review-system-rework-reduction-2026-09-23 P-030). Kept apart from the pure cascade so
 * the cascade's guard runs without Postgres; every seam here REUSES an existing writer:
 * the `_claimHold` durable park (`setWorkItemClaimHold`), the shared release-contract
 * resolver, the plan lock + Now replacement, the canonical acceptance gate, and the
 * plan-event rail orient already reads.
 */

import { getOrgPg } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { isClaimHoldParked, setWorkItemClaimHold } from '../../work-items';
import { buildDurableParkReleaseContract } from '../../durable-park-release-contract';
import { planAcceptanceChangedKey } from '../../agent-obligations';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { sendMessage } from '../coordination/messages';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import {
  stampBarReadinessNowBlock,
  stampMootCarrierNowBlock,
  type BarReadinessDeps,
  type CarrierCandidate,
  type PlanScopeCascadeDeps,
} from './plan-scope-cascade';

/** Hard cap on candidate rows read per scope write; carriers are rare (single digits). */
const CANDIDATE_LIMIT = 500;

export function defaultPlanScopeCascadeDeps(ctx: unknown, actor: string): PlanScopeCascadeDeps {
  return {
    async listCandidates({ workspaceId, harnessSlug, subjectSlug }) {
      const { sql } = getOrgPg();
      // A cheap substring pre-filter; the exact carrier test (whole-slug token + a verb
      // before it) is `isMootCarrierTitle`, applied by the cascade itself.
      const rows = await sql<
        Array<{
          feature_id: string;
          workspace_id: string;
          harness_slug: string | null;
          source_plan_slug: string;
          source_plan_item_ids: string[] | null;
          title: string | null;
          status: string;
          taken_by: string | null;
          payload: unknown;
        }>
      >`
        SELECT feature_id, workspace_id, harness_slug, source_plan_slug, source_plan_item_ids,
               title, status, taken_by, payload
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           ${harnessSlug ? sql`AND harness_slug = ${harnessSlug}` : sql``}
           AND source_plan_slug IS NOT NULL
           AND source_plan_slug <> ${subjectSlug}
           AND lane IS DISTINCT FROM 'observation'
           AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[]))
           AND strpos(lower(COALESCE(title, '')), lower(${subjectSlug})) > 0
         LIMIT ${CANDIDATE_LIMIT}`;
      return rows.map(
        (r): CarrierCandidate => ({
          featureId: r.feature_id,
          workspaceId: r.workspace_id,
          harnessSlug: r.harness_slug,
          sourcePlanSlug: r.source_plan_slug,
          sourcePlanItemIds: Array.isArray(r.source_plan_item_ids) ? r.source_plan_item_ids : [],
          title: r.title ?? '',
          status: r.status,
          takenBy: r.taken_by,
          payload: r.payload,
        }),
      );
    },
    isParked: isClaimHoldParked,
    async park(carrier, park) {
      const releaseContract = await buildDurableParkReleaseContract(
        { condition: park.condition, trigger: park.trigger, owner: park.owner },
        actor,
      );
      const written = await setWorkItemClaimHold(carrier.featureId, true, {
        ...(carrier.harnessSlug ? { harness: carrier.harnessSlug } : {}),
        parkedBy: actor,
        parkedReason: park.reason,
        releaseContract,
      });
      return written?.applicable === true;
    },
    async notifyHolder(carrier, summary) {
      const holder = carrier.takenBy?.trim();
      if (!holder) return;
      await sendMessage(resolveAgentIdentity(ctx as ResolveIdentityCtx), {
        to: [holder],
        summary,
        ...(carrier.harnessSlug ? { harnessSlug: carrier.harnessSlug } : {}),
        extra: { auto: true, lifecycle: 'moot-carrier-park', work_item: carrier.featureId },
      });
    },
    async evaluateGate(planSlug, harnessSlug) {
      const { evaluatePlanAcceptanceGate } = await import('../../plan-acceptance-gate');
      const verdict = await evaluatePlanAcceptanceGate(planSlug, harnessSlug ? { harnessSlug } : {});
      return { satisfied: verdict.satisfied, code: verdict.code ?? null };
    },
    async stampNow(planSlug, scope, stamp) {
      const result = await withPlanLock<boolean>(
        ctx as never,
        {
          slug: planSlug,
          intent: `plan supersede cascade: stamp moot carriers of ${stamp.subjectSlug}`,
          ...(scope.harnessSlug ? { harnessSlug: scope.harnessSlug } : {}),
          workspaceId: scope.workspaceId,
          actorId: actor,
        },
        async (current) => {
          if (current === null) return { newBody: null, value: false };
          const stamped = stampMootCarrierNowBlock(current, stamp);
          return stamped === null
            ? { newBody: null, value: false }
            : { newBody: bumpUpdatedDate(stamped), value: true };
        },
      );
      return result.kind === 'applied' && result.value === true;
    },
    async emitPlanEvent(planSlug, detail) {
      await emitPlanEventForCaller(ctx as ResolveIdentityCtx, { planSlug, event: 'now_updated', detail });
    },
    releaseTrigger: planAcceptanceChangedKey,
  };
}

/**
 * Production seam for the P-031 leg: read the SAME live acceptance-bar contract snapshot the
 * ship gate reads (so the codes are the gate's own), and restamp the plan's Now under the
 * plan lock. Called AFTER the triggering write has released its own lock.
 */
export function defaultBarReadinessDeps(ctx: unknown, actor: string): BarReadinessDeps {
  return {
    async readBarReadiness(planSlug, harnessSlug) {
      const { readAcceptanceBarContractSnapshot } = await import('../../acceptance-bar-contract-snapshot');
      const snapshot = await readAcceptanceBarContractSnapshot(planSlug, {}, harnessSlug ? { harnessSlug } : {});
      const { state, codes, nextRepair } = snapshot.readiness;
      return {
        state,
        codes: [...codes],
        nextRepair: nextRepair
          ? { code: nextRepair.code, barKey: nextRepair.barKey, action: nextRepair.action }
          : null,
      };
    },
    async restampNow(planSlug, scope, reading, cause) {
      const result = await withPlanLock<boolean>(
        ctx as never,
        {
          slug: planSlug,
          intent: `scope-write cascade: restamp BAR readiness after ${cause}`,
          ...(scope.harnessSlug ? { harnessSlug: scope.harnessSlug } : {}),
          workspaceId: scope.workspaceId,
          actorId: actor,
        },
        async (current) => {
          if (current === null) return { newBody: null, value: false };
          const stamped = stampBarReadinessNowBlock(current, reading, cause);
          return stamped === null
            ? { newBody: null, value: false }
            : { newBody: bumpUpdatedDate(stamped), value: true };
        },
      );
      return result.kind === 'applied' && result.value === true;
    },
  };
}
