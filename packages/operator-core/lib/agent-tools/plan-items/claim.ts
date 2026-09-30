/**
 * plan_items:claim — take the live, leased grip on a plan item (Phase 1/2).
 *
 * Enforces the policy: an ASSIGNED item may only be claimed by its assignee-NAME
 * (so adopt that name first); an UNASSIGNED item is a pool pull (gated by work-group
 * membership when the plan has a work-group). The lease's liveness mode is resolved
 * from the harness (LOCAL=availability / SHARED=activity) unless forced.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): claim ONE inline
 * ({ plan, item, … }), MANY in the SAME plan ({ plan, itemIds:[…] }), or MANY
 * heterogeneous (items:[{ plan, item, intent?, mode?, ttl_sec?, harness? }]) →
 * { ok, results:[{ ok, plan, item, result, convertStatus?, workItem? }], counts }.
 * Each result self-describes its { plan, item } and carries that item's claim
 * envelope; a refused/conflicted claim is that item's ok:false WITHOUT failing the
 * rest (top-level ok = "the batch ran", counts.failed is the truth). The per-item
 * `result` is the SAME claim/convert payload the single call always returned.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText, LIMITS } from '../limits';
import { resolveAgentIdentity, isEphemeralMcpCallIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { claimPlanItem } from '../../plan-items/liveness';
import { convertPlanItem } from '../../plan-items/convert';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { holderContextReader, resolveHolderAdvisory } from '../coordination/holder-advisory';
import { planItemRef } from '../../agent-goal-ref';
import type { CellReader } from '../../cell-registry';
import type { LivenessMode } from '../../plan-items/claims';
import { getClaimTimeCheckpointHint } from '../../work-item-checkpoint';
import {
  buildClaimTimeEnrichment,
  type ClaimTimeEnrichment,
  type ClaimTimeEnrichmentSubject,
} from '../../claim-time-enrichment';

/**
 * P-027 / D-055 A5 — attach the blocking holder's goal to a plan-item claim
 * CONFLICT, and to nothing else.
 *
 * Shared by the two result paths (bare claim and auto-convert) because they
 * return the same conflict shape by design — "a refused/conflict convert maps
 * back to the same claim-shaped failure the bare path returns". Two copies of
 * the injection would be the drift D-038 axis 5 forbids at the smallest possible
 * scale, and this is precisely where such copies are easiest to miss.
 *
 * ⚠ CONFLICT ONLY. A `claimed` result means nothing is blocking you, and a
 * non-conflict refusal (assignment policy, work-group membership) has no holder
 * to name — decorating either would attach an unrelated agent's goal to a
 * verdict they had no part in.
 *
 * ⚠ ADVISORY: returns a spreadable `{}` on every path where there is nothing to
 * say, so it can never alter the `ok` verdict or the `result` payload it rides
 * beside. Total — `resolveHolderAdvisory` never throws.
 */
async function planItemConflictAdvisory(
  result: unknown,
  planSlug: string,
  itemId: string,
  reader: CellReader | null,
): Promise<{ holderContext?: unknown }> {
  const r = result as { status?: string; conflict?: { owner?: string } } | null | undefined;
  if (r?.status !== 'conflict' || !r.conflict?.owner) return {};
  const holderContext = await resolveHolderAdvisory({
    holder: r.conflict.owner,
    reader,
    // D-094: the plan item IS the subject, so the holder must never be reported
    // as also competing on the very item whose refusal is being explained.
    //
    // ⚠ THE QUALIFIED REF VIA THE CANONICAL MINTER, NOT THE BARE `itemId` — the
    // LIVE exercise caught the bare form here, where the comparison silently never
    // matched ('P-006' vs 'some-plan-2026-07-27#P-006') and the subtraction was a
    // no-op on every real row. `planItemRef` is the SAME function that builds the
    // refs going INTO `competing`, so the two sides cannot drift apart.
    subjectRef: planItemRef(planSlug, itemId),
  });
  return holderContext ? { holderContext } : {};
}

/**
 * EI-19963837641363759: `plan_items:claim` is the natural verb for claiming a
 * PLAN ITEM — and the one an su reaches for right after `coord:orient
 * { planItems }` fails to claim — yet it was the one claim surface the
 * agent-trap-guards-2026-07-26 P-003b decisions brief never reached (it was
 * wired at scheduler:get_next / work_items:claim / work_items:claim_next
 * only). Unlike those three, we already KNOW the plan slug from the call
 * args — no work-item back-pointer to derive it from, and none needed.
 * Fail-soft (never throws): decoration on a successful claim, never a new way
 * for the claim to fail.
 */
/**
 * WI-41182: this surface used to hand-roll its own two-leg batch (plan Decisions
 * + prior attempts) while the other three claim surfaces hand-rolled their own
 * five- and six-leg batches. It was the thinnest of the four — an agent claiming
 * here got no premise check, no retraction warning, no authorship revalidation,
 * and no plan-says-done contradiction (WI-39498's zombie guard), silently, purely
 * because this file was written before those guards existed and nothing pointed
 * back at it when they were added.
 *
 * All six now come from `buildClaimTimeEnrichment`, which is also what the parity
 * test enumerates — so the next guard cannot land at three surfaces and miss the
 * fourth.
 *
 * ⚠ The CONVERT path passes the minted/resumed work-item, so it gets all six; the
 * BARE path has no work-item by definition and gets the two that a plan pointer
 * alone can answer. That asymmetry is real (the work-item-keyed guards have
 * nothing to key on until an item exists) rather than the drift above — and it is
 * now visible in one place instead of implied by four files.
 */
async function claimTimeContext(
  planSlug: string,
  planItemId: string,
  workItem: ClaimTimeEnrichmentSubject | null,
  harness: string | undefined,
  workspaceId: string,
): Promise<ClaimTimeEnrichment> {
  return buildClaimTimeEnrichment({
    planSlug,
    planItemId,
    workItem,
    harness: harness ?? null,
    workspaceId,
  });
}

interface ClaimTimeCheckpointContext {
  checkpoint?: string;
  checkpointAgeMs?: number | null;
  checkpointWarning?: string;
}

/**
 * EI-21574679768631502: a resumed plan-item claim has a real work-item row, so
 * carry the prior holder's checkpoint onto the same claim receipt as the other
 * claim surfaces. The bare lease path intentionally has no work-item to query.
 *
 * Fail-soft by design: checkpoint context is an advisory guard and must never
 * turn a successful claim into a failed one.
 */
async function claimTimeCheckpointContext(
  workItem: ClaimTimeEnrichmentSubject | null,
  harness: string | undefined,
  workspaceId: string,
): Promise<ClaimTimeCheckpointContext> {
  if (!workItem?.id) return {};
  const hint = await getClaimTimeCheckpointHint({
    harness: workItem.harness ?? harness ?? null,
    workItemId: workItem.id,
    workspaceId,
  }).catch(() => null);
  return hint
    ? {
        checkpoint: hint.checkpoint,
        checkpointAgeMs: hint.checkpointAgeMs,
        checkpointWarning:
          'A PRIOR holder left an in-flight checkpoint on this item — it may already be DONE or partly done. Read it before building: verify against the tree/tests first, do not assume greenfield (EI-529).',
      }
    : {};
}

interface ClaimSpecItem {
  plan: string;
  item: string;
  harness?: string;
  intent?: string;
  mode?: LivenessMode;
  ttl_sec?: number;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  intent: hardText(LIMITS.SHORT_TITLE).optional().describe('one line on what you are doing'),
  mode: z.enum(['availability', 'activity']).optional().describe('force the liveness mode'),
  ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds'),
});

export default defineTool({
  name: 'plan_items:claim',
  description:
    'Take the live, heartbeat-leased grip on one OR many plan items — what you call when you actually START them. Refused per item if it is assigned to a different agent-name, or unassigned in a plan whose work-group you have not joined. Single: { plan, item }. Many same plan: { plan, itemIds:[…] }. Many heterogeneous: items:[{ plan, item, intent?, mode?, ttl_sec?, harness? }]. Returns { ok, results:[{ ok, plan, item, result (claim with claim_id + lease expiry), convertStatus?, workItem?, planDecisions?, planDecisionsNote? }], counts } — correlate by { plan, item }; a refused/conflicted claim is that item\'s ok:false without failing the rest. A successful claim inlines the plan\'s current governing Decisions (planDecisions) — read them before building. Keep a claim alive with plan_items:heartbeat, drop it with plan_items:release.',
  guidance: {
    when: 'You are about to begin work on item(s) (yours via assignment, or pulled from the pool). Claim several at once via itemIds:[…] or items:[…].',
    notWhen: 'You only want to mark intent for later without starting — that is assignment, not a claim. Renewing an existing claim — that is plan_items:heartbeat.',
    chaining: 'plan_items:claim { harness, plan, item } → work → plan_items:heartbeat (per turn) → plan_items:release when done.',
    seeAlso: [
      'plan_items:heartbeat (keep the claim alive per turn)',
      'plan_items:release (release when done)',
      'plan_items:status (find a claimable item)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-claim shorthand: the plan-item id (P-NNN)'),
      intent: hardText(LIMITS.SHORT_TITLE).optional().describe('one line on what you are doing (the inline item / every id in `itemIds`)'),
      mode: z.enum(['availability', 'activity']).optional().describe('force the liveness mode (default: resolved from the harness — LOCAL=availability, SHARED=activity); the inline item / itemIds'),
      ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds (default 1200 availability / 1800 activity); the inline item / itemIds'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('claim MANY items in `plan` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('claim many plan items at once — each { plan, item, intent?, mode?, ttl_sec?, harness? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.plan) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))), {
      message: 'pass { plan, item } for one, { plan, itemIds:[…] } for many of the same plan, or items:[{ plan, item }] for many',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    // EI-8509: this tool always claims for the CALLER's own identity (no explicit
    // assignee param) — refuse the whole batch when the caller is scripts/mcp-call.mjs's
    // auto-generated fallback (`mcp-call-<pid>`), a one-shot process with no
    // heartbeat/liveness and no fleet cup behind it. Unguarded, this is the same
    // "placed but nothing ever executes it" failure mode EI-8509 found on
    // work_items:claim / plans:set-status.
    if (isEphemeralMcpCallIdentity(id.ownerId)) {
      const list0: ClaimSpecItem[] = args.items?.length
        ? args.items
        : args.itemIds?.length
          ? args.itemIds.map((item) => ({ plan: args.plan as string, item }))
          : [{ plan: args.plan as string, item: args.item as string }];
      const env = await runBulk(
        list0,
        async (it): Promise<BulkItemResult> => ({
          ok: false,
          plan: it.plan,
          item: it.item,
          result: {
            status: 'refused',
            reason: 'ephemeral_mcp_call_identity',
            hint:
              'Refused: this call arrived under scripts/mcp-call.mjs\'s auto-generated fallback identity (mcp-call-<pid>) — a one-shot process with no liveness/heartbeat and no fleet cup behind it — claiming here would silently "place" work that nothing executes (EI-8509). Spawn a real cup and let IT claim.',
          },
        }),
        { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
      );
      return bulkContent(env);
    }
    const ownerUser = bestEffortOwnerUser(ctx);
    // work-queue-completeness Phase A (ENFORCEMENT): when the auto-convert flag is ON,
    // a claim is no longer a bare lease — it mints (or idempotently resumes) a tracked
    // work_item via convertPlanItem (policy-checked lease → resume-or-mint → claim →
    // back-link). Because convertPlanItem re-runs claimPlanItem and is idempotent, this
    // is safe in the same spot a bare claim happened. Fail-safe to OFF on a flag-IO error
    // (today's bare-claim behavior). Read ONCE for the whole batch (SYNC at the tool
    // layer, like convert.ts does for COMPILED_BRIEFS — keeps the core flag-mock-free).
    const autoConvert = await getFlag(FLAGS.PLAN_ITEM_CLAIM_AUTO_CONVERT, 'system').catch(() => false);

    // P-027 / D-055 A5 — resolved ONCE for the batch (the advisory is
    // reader-relative and every item shares one reader). Guarded, so an
    // unattributable caller gets no advisory rather than a failed claim.
    const reader = holderContextReader(ctx as Parameters<typeof holderContextReader>[0]);

    const list: ClaimSpecItem[] = args.items?.length
      ? args.items.map((it) => ({
          plan: it.plan,
          item: it.item,
          harness: it.harness ?? args.harness,
          intent: it.intent ?? args.intent,
          mode: it.mode ?? args.mode,
          ttl_sec: it.ttl_sec ?? args.ttl_sec,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({ plan: args.plan as string, item, harness: args.harness, intent: args.intent, mode: args.mode, ttl_sec: args.ttl_sec }))
        : [{ plan: args.plan as string, item: args.item as string, harness: args.harness, intent: args.intent, mode: args.mode, ttl_sec: args.ttl_sec }];

    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        // workspace-work-scope-policy-2026-09-04 P-006: a plan item homed outside the
        // workspace work-scope policy is refused for every claimant before any lease or
        // work-item mint. Held, never deleted; the denial lands on the policy ledger.
        {
          const { gateWorkScope } = await import('../../work-scope-policy');
          const scope = await gateWorkScope('plan_items:claim', { harness: harnessSlug, plan: it.plan, actor: id.ownerId });
          if (!scope.allowed) {
            return {
              ok: false,
              plan: it.plan,
              item: it.item,
              result: { status: 'refused', reason: scope.code, hint: scope.message },
            };
          }
        }
        const ownerName = await resolveAdoptedName(workspaceId, id.ownerId);

        if (autoConvert) {
          const conv = await convertPlanItem({
            workspaceId,
            harnessSlug,
            planSlug: it.plan,
            itemId: it.item,
            owner: id.ownerId,
            ownerLabel: id.ownerLabel,
            ownerName,
            ownerUser,
            intent: it.intent,
            livenessMode: it.mode,
            ttlSec: it.ttl_sec,
          });
          // Re-shape into the same { ok, result } envelope today's callers read, plus the
          // minted/resumed workItem. A refused/conflict convert maps back to the same
          // claim-shaped failure the bare path returns (its embedded `claim` payload).
          if (conv.status === 'converted' || conv.status === 'resumed') {
            const [checkpointContext, enrichment] = await Promise.all([
              claimTimeCheckpointContext(conv.workItem, it.harness ?? args.harness, workspaceId),
              claimTimeContext(
                it.plan,
                it.item,
                conv.workItem,
                it.harness ?? args.harness,
                workspaceId,
              ),
            ]);
            return {
              ok: true,
              plan: it.plan,
              item: it.item,
              result: { status: 'claimed', claim: conv.claim, mode: conv.mode, viaAssignment: conv.viaAssignment },
              convertStatus: conv.status,
              workItem: { id: conv.workItem.id, kind: conv.workItem.kind, harness: conv.workItem.harness ?? null },
              // WI-41182: pass the whole minted/resumed row, not just its id — the
              // premise, retraction, authorship and contradiction guards key on the
              // payload/title/summary/state that only the full row carries. Handing
              // over the id alone is exactly how this surface stayed at 2 of 6.
              // Cross-plan affects authority in enrichment must serialize before
              // the plan-local checkpoint/carry prose it can supersede.
              ...enrichment,
              ...checkpointContext,
            };
          }
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            result: conv,
            ...(await planItemConflictAdvisory(conv, it.plan, it.item, reader)),
          };
        }

        const result = await claimPlanItem({
          workspaceId,
          harnessSlug,
          planSlug: it.plan,
          itemId: it.item,
          owner: id.ownerId,
          ownerLabel: id.ownerLabel,
          ownerName,
          ownerUser,
          intent: it.intent,
          livenessMode: it.mode,
          ttlSec: it.ttl_sec,
        });
        return {
          ok: result.status === 'claimed',
          plan: it.plan,
          item: it.item,
          result,
          ...(await planItemConflictAdvisory(result, it.plan, it.item, reader)),
          ...(result.status === 'claimed'
            ? await claimTimeContext(it.plan, it.item, null, it.harness ?? args.harness, workspaceId)
            : {}),
        };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );
    return bulkContent(env);
  },
});
