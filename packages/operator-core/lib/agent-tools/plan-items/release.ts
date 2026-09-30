/**
 * plan_items:release — drop the live claim on a plan item (keeps the assignment).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): release ONE inline
 * ({ plan, item, claim_id? }), MANY in the SAME plan ({ plan, itemIds:[…] }), or
 * MANY heterogeneous (items:[{ plan, item, harness?, claim_id? }]) → { ok,
 * results:[{ ok, plan, item, released? | note }], counts }. Each result
 * self-describes its { plan, item }; holding no claim on one item is a polite
 * ok:false note that never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { forceReleaseClaim, getClaim, releaseClaim } from '../../plan-items/claims';
import { planItemEffectiveStatuses } from '../../plan-items/assignments';
import { isTerminalPlanItemStatus } from '../../work-item-plan-item-landed';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import {
  assessForceRelease,
  forceRefusalHint,
  notifyForceTransition,
  recordForceTransitionAudit,
  type ForceReleaseBasis,
} from '../work_items/release-force-guard';
import {
  buildDispatchHandle,
  type DispatchCandidate,
  type DispatchHandleResult,
} from '../coordination/dispatch-handle';

interface ReleaseSpecItem {
  plan: string;
  item: string;
  harness?: string;
  claim_id?: string;
  force?: boolean;
  reason?: string;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  claim_id: z.string().uuid().optional().describe('the claim_id (default: your current claim on the item)'),
  force: z.boolean().optional().describe('checked override for a foreign claim (requires reason)'),
  reason: z.string().max(500).optional().describe('reason required when force clears another agent claim'),
});

export default defineTool({
  name: 'plan_items:release',
  description:
    'Drop your live claim on one OR many plan items so each returns to your assignee status (if assigned) or the pool (if pulled). Does NOT clear the assignment — the item stays yours by name; you just stop holding it. claim_id is optional (resolved from your current claim). Single: { plan, item, claim_id? }. Many same plan: { plan, itemIds:[…] }. Many heterogeneous: items:[{ plan, item, harness?, claim_id? }]. Returns { ok, results:[{ ok, plan, item, released? | note }], counts } — correlate by { plan, item }; holding no claim on one item never fails the rest.',
  guidance: {
    when: 'You finished (or are pausing) work on item(s) you claimed and want to free the live grip. Release several at once via itemIds:[…] or items:[…].',
    notWhen: 'You want to give up the item entirely — also plan_items:unassign it.',
    chaining: 'plan_items:claim → … → plan_items:release { harness, plan, item }.',
    seeAlso: [
      'plan_items:claim (claim another item next)',
      'plan_items:status (see what is left)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
    plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
    item: z.string().min(1).optional().describe('single-release shorthand: the plan-item id (P-NNN)'),
    claim_id: z.string().uuid().optional().describe('the claim_id (default: your current claim on the inline item)'),
      force: z.boolean().optional().describe('checked override for a foreign claim; requires reason'),
      reason: z.string().max(500).optional().describe('reason required when force clears another agent claim'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('release MANY items in `plan` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('release many plan items at once — each { plan, item, harness?, claim_id? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.plan) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))), {
      message: 'pass { plan, item } for one, { plan, itemIds:[…] } for many of the same plan, or items:[{ plan, item }] for many',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const list: ReleaseSpecItem[] = args.items?.length
      ? args.items.map((it) => ({
          plan: it.plan,
          item: it.item,
          harness: it.harness ?? args.harness,
          claim_id: it.claim_id,
          force: it.force ?? args.force,
          reason: it.reason ?? args.reason,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({
            plan: args.plan as string,
            item,
            harness: args.harness,
            force: args.force,
            reason: args.reason,
          }))
        : [
            {
              plan: args.plan as string,
              item: args.item as string,
              harness: args.harness,
              claim_id: args.claim_id,
              force: args.force,
              reason: args.reason,
            },
          ];
    // EI-22073881694336970: the dispatch handle below needs each released item's
    // harness to read its status, and the per-item harness is resolved HERE (per
    // row, from it.harness). Capture it rather than re-deriving later from the
    // batch-level args.harness, which is wrong for a heterogeneous items:[…] call.
    // `#` is the separator this file already uses for a plan/item pair (see
    // notifyForceTransition's itemId above).
    const harnessByKey = new Map<string, string>();
    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        harnessByKey.set(`${it.plan}#${it.item}`, harnessSlug);
        const force = it.force ?? false;
        const reason = it.reason?.trim() ?? '';
        const current = await getClaim(workspaceId, harnessSlug, it.plan, it.item);
        if (!current) {
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            released: false,
            error: 'not_holder',
            note: 'the item has no live claim to release',
          };
        }
        const requestedClaimId = it.claim_id ?? current.claimId;
        const currentOwner = current.owner;
        if (currentOwner !== id.ownerId) {
          if (!force) {
            return {
              ok: false,
              plan: it.plan,
              item: it.item,
              released: false,
              error: 'not_holder',
              holder: current,
              note: `claim is held by ${current.owner}; only the holder may release it`,
            };
          }
          if (!reason) {
            return {
              ok: false,
              plan: it.plan,
              item: it.item,
              released: false,
              error: 'force_requires_reason',
              holder: current,
              hint: `force would clear ${current.owner}'s claim — pass a \`reason\` the holder and owner can audit (EI-21618203307569668).`,
            };
          }
          const verdict = await assessForceRelease({
            callerOwnerId: id.ownerId,
            holderOwnerId: current.owner,
            workspaceId,
            // Plan-item claims do not carry a separate item-progress column.
            // The claim's activity timestamp is the safest available lower-bound
            // signal; fresh activity can only make this guard more conservative.
            itemLastProgressAt: current.lastActivityTs,
          });
          if (!verdict.allowed) {
            return {
              ok: false,
              plan: it.plan,
              item: it.item,
              released: false,
              error: 'force_unauthorized',
              holder: current,
              holderLiveness: verdict.holderLiveness,
              hint: forceRefusalHint(current.owner),
            };
          }
          const released = await forceReleaseClaim({
            workspaceId,
            harnessSlug,
            planSlug: it.plan,
            itemId: it.item,
            claimId: requestedClaimId,
            owner: currentOwner,
          });
          if (!released) {
            const raced = await getClaim(workspaceId, harnessSlug, it.plan, it.item);
            return {
              ok: false,
              plan: it.plan,
              item: it.item,
              released: false,
              error: raced ? 'claim_conflict' : 'not_holder',
              ...(raced ? { holder: raced } : {}),
              note: raced
                ? 'the claim changed after the authorization read; no claim was cleared'
                : 'the authorized claim disappeared before the force release',
            };
          }
          const forced = {
            holder: current.owner,
            basis: verdict.basis as ForceReleaseBasis,
            reason,
          };
          await recordForceTransitionAudit(id.ownerId, it.item, 'release', {
            plan: it.plan,
            item: it.item,
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            harness: harnessSlug,
          }, 'plan_items');
          await notifyForceTransition(id, {
            itemId: `${it.plan}#${it.item}`,
            holder: forced.holder,
            basis: forced.basis,
            reason: forced.reason,
            harness: harnessSlug,
            operation: 'release',
            surface: 'plan_items',
          });
          return { ok: true, plan: it.plan, item: it.item, released: true, forced };
        }

        // An explicit claim_id must still match the current holder's claim. A
        // stale/foreign id is not a successful no-op; report it as not_holder.
        if (requestedClaimId !== current.claimId) {
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            released: false,
            error: 'not_holder',
            holder: current,
            note: 'claim_id does not identify the current claim on this item',
          };
        }
        const released = await releaseClaim(workspaceId, harnessSlug, it.plan, it.item, requestedClaimId, id.ownerId);
        if (!released) {
          const raced = await getClaim(workspaceId, harnessSlug, it.plan, it.item);
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            released: false,
            error: raced ? 'claim_conflict' : 'not_holder',
            ...(raced ? { holder: raced } : {}),
            note: raced ? 'the claim changed before release; no claim was cleared' : 'the claim disappeared before release',
          };
        }
        return { ok: true, plan: it.plan, item: it.item, released: true };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );

    // ── P-012 (coordination-spec-adoption-2026-08-03): the second dispatch
    // handle site. Releasing a plan lane is the exact moment a peer could take
    // it, and this surface natively speaks dispatch's shape — (plan, P-NNN).
    //
    // NB the plan item named work_items:release for this. That is the WRONG
    // surface and would have shipped a broken handle: coord:dispatch's `items`
    // are PLAN items, work_items:release releases WORK items, and the two are
    // linked only through a plan_item_stamp relation — so a handle there needs a
    // per-row join on a bulk write path, or it ships a target with no items,
    // which is precisely the "bare wake that reads as a hand-off" shape
    // dispatch-handle.ts exists to refuse. plan_items:release is the sibling
    // that already holds the lane.
    //
    // Fail-soft BY CONTRACT: this is an affordance on a WRITE that has already
    // committed. A presence hiccup must degrade to no handle, never to a failed
    // release.
    const releasedLane = env.results.filter(
      (r): r is BulkItemResult & { plan: string; item: string } =>
        Boolean((r as { ok?: boolean }).ok) && Boolean((r as { released?: boolean }).released),
    );
    // ── EI-22073881694336970: NEVER offer a TERMINAL lane for pickup.
    //
    // The handle's own note says "the lane is free … Claim and continue", so
    // emitting it for a done/dropped item invites a peer to reopen finished work
    // — and a release is exactly when that happens, because winding a plan down
    // means force-releasing the stale claims of items that are ALREADY terminal.
    // Reproduced twice on P-008/WI-2008163 after terminal wind-down: each force
    // release suggested handing the completed lane to an unrelated parked agent.
    //
    // This is the same dead-dispatch class the sibling surface already guards:
    // plan_items:assign refuses to (re)assign an ALREADY-TERMINAL item because
    // doing so "does nothing but fire a stale wake" (EI-2295). Releasing is the
    // pull leg of it; assign was the push leg.
    //
    // FAIL-OPEN, deliberately, matching planItemEffectiveStatus's stated contract:
    // only an item whose status we positively READ as terminal is withheld. An
    // undeterminable status (missing plan, un-normalized row, read hiccup) still
    // gets its handle — suppressing on unknown would silently kill the affordance
    // for a whole class of plans, and the harm here is specific to items that
    // really are finished.
    const dispatchable: typeof releasedLane = [];
    if (releasedLane.length > 0) {
      try {
        // One plan read per distinct (harness, plan) — not one per item.
        const byPlan = new Map<string, { harness: string; plan: string; items: string[] }>();
        for (const r of releasedLane) {
          const harness = harnessByKey.get(`${r.plan}#${r.item}`);
          if (!harness) continue;
          const key = `${harness}#${r.plan}`;
          const bucket = byPlan.get(key) ?? { harness, plan: r.plan, items: [] };
          bucket.items.push(r.item);
          byPlan.set(key, bucket);
        }
        const terminal = new Set<string>();
        for (const b of byPlan.values()) {
          const statuses = await planItemEffectiveStatuses(b.harness, b.plan, b.items);
          for (const [itemId, status] of statuses) {
            if (status && isTerminalPlanItemStatus(status)) terminal.add(`${b.plan}#${itemId}`);
          }
        }
        for (const r of releasedLane) {
          if (!terminal.has(`${r.plan}#${r.item}`)) dispatchable.push(r);
        }
      } catch {
        // Status unreadable ⇒ fail open, exactly as above: offer the whole lane.
        dispatchable.length = 0;
        dispatchable.push(...releasedLane);
      }
    }

    let dispatch: DispatchHandleResult = null;
    if (dispatchable.length > 0) {
      try {
        // Dynamic import: presence-snapshot pulls the whole wakeability layer, and
        // a static import here would drag it into every plan-items caller
        // (EI-19281789650149592 is the same trap in coupling-divergence-stamp).
        const { resolvePresenceScope, assemblePresenceSnapshot } = await import(
          '../coordination/presence-snapshot'
        );
        const scope = await resolvePresenceScope(
          ctx as { workspaceId?: string | null; harnessSlug?: string | null } | undefined,
        );
        const snap = await assemblePresenceSnapshot(scope);
        const peers = (snap.active ?? []) as unknown as DispatchCandidate[];
        dispatch = buildDispatchHandle(
          {
            planSlug: dispatchable[0].plan,
            items: dispatchable.map((r) => r.item),
            harness: args.harness ?? null,
            note: `Releasing ${dispatchable[0].plan} ${dispatchable.map((r) => r.item).join(', ')} — the lane is free and the item bodies are inlined below. Claim and continue.`,
          },
          peers ?? [],
          { selfOwnerId: id.ownerId },
        );
      } catch {
        dispatch = null;
      }
    }

    const out = bulkContent(env);
    return dispatch ? { ...out, data: { ...(out as { data?: object }).data, dispatch } } : out;
  },
});
