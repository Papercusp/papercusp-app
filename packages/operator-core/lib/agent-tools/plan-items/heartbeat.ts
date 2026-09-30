/**
 * plan_items:heartbeat — renew a claim's lease (the liveness pulse, D-003).
 *
 * The MODE governs what renews: on a LOCAL (availability) harness ANY heartbeat
 * keeps the claim (the session proving it is alive); on a SHARED (activity) harness
 * only an 'activity' (a completed turn) or an explicit 'extend' renews it — a bare
 * 'keepalive' does NOT, so an idle shared claim lapses and returns to the pool.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): heartbeat ONE inline
 * ({ plan, item, kind?, … }), MANY in the SAME plan with the SAME kind
 * ({ plan, itemIds:[…], kind? }), or MANY heterogeneous
 * (items:[{ plan, item, kind?, ttl_sec?, claim_id?, harness? }]) → { ok,
 * results:[{ ok, plan, item, renewed?, held?, … | note }], counts }. Each result
 * self-describes its { plan, item }; holding no claim on one item never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { getClaim, heartbeatClaim, type HeartbeatKind } from '../../plan-items/claims';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

const KIND = z.enum(['activity', 'extend', 'keepalive']);

interface HeartbeatSpecItem {
  plan: string;
  item: string;
  harness?: string;
  kind?: HeartbeatKind;
  ttl_sec?: number;
  claim_id?: string;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  kind: KIND.optional().describe('activity = a completed turn (default); extend = long op (+ttl_sec); keepalive = liveness-only'),
  ttl_sec: z.number().int().positive().max(7200).optional().describe('new lease TTL (use with kind="extend")'),
  claim_id: z.string().uuid().optional().describe('the claim_id (default: your current claim on the item)'),
});

export default defineTool({
  name: 'plan_items:heartbeat',
  description:
    'Renew your claim\'s lease on one OR many plan items. Send kind="activity" when you complete a unit of work (the turn-based pulse a SHARED harness needs), kind="extend" with a larger ttl_sec for a legitimately long single operation, or kind="keepalive" to prove liveness on a LOCAL harness. claim_id optional (resolved from your current claim). Single: { plan, item, kind? }. Many same plan+kind: { plan, itemIds:[…], kind? }. Many heterogeneous: items:[{ plan, item, kind?, ttl_sec?, claim_id?, harness? }]. Returns { ok, results:[{ ok, plan, item, renewed?, held?, … | note }], counts } — correlate by { plan, item }; holding no claim on one item never fails the rest.',
  guidance: {
    when: 'Periodically while holding a claim — ideally once per completed turn (kind="activity"), or kind="extend" before a long uninterrupted op. Pulse several held items at once via itemIds:[…] or items:[…].',
    notWhen: 'You are done — that is plan_items:release. The claim has already lapsed — re-acquire with plan_items:claim (a lapsed claim cannot be heartbeated back to life).',
    chaining: 'plan_items:claim → plan_items:heartbeat { kind: "activity" } per turn → plan_items:release.',
    seeAlso: [
      'plan_items:claim (what you are keeping alive)',
      'plan_items:release (stop and hand it back)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-heartbeat shorthand: the plan-item id (P-NNN)'),
      kind: KIND.optional().describe('applies to the inline item / every id in `itemIds` (default activity)'),
      ttl_sec: z.number().int().positive().max(7200).optional().describe('new lease TTL (use with kind="extend" for a long op); applies to the inline item / itemIds'),
      claim_id: z.string().uuid().optional().describe('the claim_id (default: your current claim on the inline item)'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('heartbeat MANY items in `plan` with the same `kind` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('heartbeat many plan items at once — each { plan, item, kind?, ttl_sec?, claim_id?, harness? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.plan) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))), {
      message: 'pass { plan, item } for one, { plan, itemIds:[…] } for many of the same plan, or items:[{ plan, item }] for many',
    }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const list: HeartbeatSpecItem[] = args.items?.length
      ? args.items.map((it) => ({
          plan: it.plan,
          item: it.item,
          harness: it.harness ?? args.harness,
          kind: it.kind ?? args.kind,
          ttl_sec: it.ttl_sec ?? args.ttl_sec,
          claim_id: it.claim_id,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({ plan: args.plan as string, item, harness: args.harness, kind: args.kind, ttl_sec: args.ttl_sec }))
        : [{ plan: args.plan as string, item: args.item as string, harness: args.harness, kind: args.kind, ttl_sec: args.ttl_sec, claim_id: args.claim_id }];
    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        let claimId = it.claim_id;
        if (!claimId) {
          const current = await getClaim(workspaceId, harnessSlug, it.plan, it.item);
          if (!current || current.owner !== id.ownerId) {
            return {
              ok: false,
              plan: it.plan,
              item: it.item,
              renewed: false,
              held: false,
              note: 'you hold no claim on this item — re-acquire with plan_items:claim',
            };
          }
          claimId = current.claimId;
        }
        const result = await heartbeatClaim(
          workspaceId,
          harnessSlug,
          it.plan,
          it.item,
          claimId,
          id.ownerId,
          it.kind ?? 'activity',
          it.ttl_sec,
        );
        return { ok: result.held, plan: it.plan, item: it.item, ...result };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );
    return bulkContent(env);
  },
});
