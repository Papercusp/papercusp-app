/**
 * work_items:link — Linkable (D-003). Creates a typed edge from this work-item to a target.
 * Work-item blocking persists in work_item_deps; polymorphic/non-block relations use coord_links.
 * ACROSS kinds (a bug can block a feature) — the substrate keys on (kind, ref),
 * not the physical table. Target is another work-item (by id) or an explicit
 * coord ObjectRef (e.g. a plan_item: { target_kind:'plan_item', target_ref:'<plan>#<item>' }).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): create ONE edge inline
 * or MANY (items:[{ id, rel, target_id|target_kind+target_ref, remove? }]) — a natural
 * fan-out (one source → many targets) → { ok, results:[{ ok, id, rel, dst? | error }], counts }.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { linkWorkItem, unlinkWorkItem, resolveWorkItemRef } from '../../work-items';
import { guardFeatureBlockEdgeAcyclic } from '../../dbos/feature-blockers-edges';
import { EVENT_SUBSCRIPTION_KIND } from '../coordination/event-subscriptions';
import type { ObjectRef } from '@papercusp/coordination/capabilities';
import { runBulk, bulkContent } from '../_bulk';

/**
 * The typed-link vocabulary (WI-3956). `coord_links.rel` is free-form text at the
 * store layer, so this enum is the ONE place the vocabulary is pinned — widen it
 * here and both the single + bulk schemas and the handler cast stay in sync (a
 * second copy would silently drift). Beyond the original dependency rels
 * (blocks/relates/duplicates/fixes) it adds the investigation/causal rels the
 * linking audit called for: `investigates` (this item digs into a target bug/EI/
 * event), `about` (this item concerns a target — a topic, event key, or object),
 * `caused-by` (this item was caused by the target), and `revises` (this item is
 * a new revision of the target). All are polymorphic: the
 * target is another work-item (target_id) OR any coord ObjectRef (target_kind +
 * target_ref, e.g. an event key or plan_item). Only `blocks` carries scheduler
 * semantics (the acyclicity guard below); the rest are descriptive edges surfaced
 * in work_items:get { detail:true }.
 */
export const LINK_RELS = [
  'blocks',
  'relates',
  'duplicates',
  'fixes',
  'about',
  'investigates',
  'caused-by',
  'revises',
] as const;
export type LinkRel = (typeof LINK_RELS)[number];

/**
 * Spellings a caller naturally types for a CONDITION edge (WI-10004344). The
 * condition store (`findConditionObjects`) reads only edges whose dst kind is
 * EVENT_SUBSCRIPTION_KIND, which is also what `linkWorkItemToCondition` writes.
 * A hand link with `target_kind:'condition'` therefore stored an edge no reader
 * honours: on 2026-09-30 the owning gate-red-streak item was invisible, the
 * gate-ownership cell read 'unowned' while a live fixer held it, and a second
 * owner was filed whose claim then blocked the real fixer's repair-queue admit.
 */
const CONDITION_TARGET_KIND_ALIASES: ReadonlySet<string> = new Set([
  'condition',
  'conditionkey',
  'condition-key',
  'condition_key',
]);

/**
 * Canonicalise an explicit `target_kind`. Condition aliases map to the one kind
 * the condition store reads; every other kind passes through unchanged.
 */
export function canonicalLinkTargetKind(kind: string): { kind: string; normalizedFrom?: string } {
  if (CONDITION_TARGET_KIND_ALIASES.has(kind.trim().toLowerCase())) {
    return { kind: EVENT_SUBSCRIPTION_KIND, normalizedFrom: kind };
  }
  return { kind };
}

const itemSpec = z.object({
  id: z.string().min(1).describe('the source work-item id'),
  rel: z.enum(LINK_RELS),
  target_id: z.string().max(120).optional().describe('a target work-item id (resolved to its coord ref)'),
  target_harness: z.string().max(80).optional().describe('harness for a feature target_id (disambiguation)'),
  target_kind: z
    .string()
    .max(40)
    .optional()
    .describe('explicit coord ObjectRef kind (e.g. plan_item) — use with target_ref'),
  target_ref: z.string().max(160).optional().describe('explicit coord ObjectRef ref — use with target_kind'),
  harness: z.string().max(80).optional().describe('harness for the source id (feature disambiguation)'),
  remove: z.boolean().optional(),
  satisfaction: z
    .enum(['settled', 'success'])
    .optional()
    .describe(
      'blocks-only outcome requirement; valid with target_id (or target_kind:"issue"/"feature" + target_ref); plan_item/event/topic targets cannot carry satisfaction; omitted defaults to settled',
    ),
}).refine(
  (item) =>
    !item.satisfaction ||
    Boolean(item.target_id) ||
    ((item.target_kind === 'issue' || item.target_kind === 'feature') && Boolean(item.target_ref)),
  {
    path: ['satisfaction'],
    message:
      'satisfaction requires a work-item target: use target_id (or target_kind issue/feature + target_ref), not a plan_item/event/topic target',
  },
);

export default defineTool({
  name: 'work_items:link',
  profile: 'engineer',
  description:
    'Link one or many work-items to targets: `{id, rel, target_id}` or `items:[{id, rel, target_id|target_kind+target_ref, remove?}]`. Source `id` is subject; legacy `source_id` is accepted as its alias. src BLOCKS dst (dst held up), src FIXES dst, src DUPLICATES dst (dst canonical), src INVESTIGATES dst, src is ABOUT dst, src was CAUSED-BY dst, src REVISES dst; `relates` is symmetric. Targets are work-items (`target_id`) or coord ObjectRefs (`target_kind` + `target_ref`: plan_item, event key, topic). `satisfaction` is only for `blocks`; plan_item/event/topic targets cannot carry satisfaction. `blocks` works across kinds; default-on complete typed candidate graph validation rejects cycles, endpoint defects, and newly stranded work atomically. `remove:true` unlinks. Returns `{ok, results:[{ok,id,rel,dst?|error}], counts}`.',
  guidance: {
    when: 'For typed relationships: `blocks` = src gates dst (only scheduler rel; refuses cycles, bad endpoints, and newly stranded work); `fixes` = src resolves dst; `duplicates` = src duplicates dst; `investigates` = src is the digging/diagnosis task for dst; `about` = src concerns a target; `caused-by` = src exists because of dst; `revises` = src is a newly-filed revision of dst; `relates` = worth a cross-reference. Use items:[…] for several edges.',
    chaining: 'work_items:get both sides → work_items:link { id, rel:"blocks", target_id } (or items:[…]).',
    seeAlso: [
      'work_items:get (inspect both endpoints before linking)',
      'work_items:create (its inline links:[…] writes these same edges at creation time)',
      'work_items:subscribe (follow an item a dependency now points at)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the source work-item id'),
      source_id: z
        .string()
        .min(1)
        .optional()
        .describe('legacy compatibility alias for id; if both are supplied, they must match'),
      rel: z.enum(LINK_RELS).optional().describe('single shorthand: the relationship'),
      target_id: z.string().max(120).optional(),
      target_harness: z.string().max(80).optional(),
      target_kind: z.string().max(40).optional(),
      target_ref: z.string().max(160).optional(),
      harness: z.string().max(80).optional().describe('default harness for the source id / items that omit one'),
      remove: z.boolean().optional(),
      satisfaction: z
        .enum(['settled', 'success'])
        .optional()
        .describe(
          'blocks-only outcome requirement; valid with target_id (or target_kind:"issue"/"feature" + target_ref); plan_item/event/topic targets cannot carry satisfaction; omitted defaults to settled',
        ),
      items: z.array(itemSpec).min(1).max(100).optional().describe('create many edges at once'),
    })
    .refine((a) => !a.id || !a.source_id || a.id === a.source_id, {
      path: ['source_id'],
      message: 'source_id is a compatibility alias for id; when both are supplied they must match',
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id ?? a.source_id) && Boolean(a.rel)), {
      // EI-7049: the ellipsis truncated the actual required field name, costing a
      // failed retry (a caller without the schema loaded guessed a literal `target`
      // field, which doesn't exist — only target_id / target_kind+target_ref do).
      // Name them exactly; never elide a required field name in an error hint.
      message:
        'pass { id, rel, target_id } (or target_kind + target_ref instead of target_id) for one, or items:[…] for many',
    })
    .refine(
      (args) =>
        !args.satisfaction ||
        Boolean(args.target_id) ||
        ((args.target_kind === 'issue' || args.target_kind === 'feature') && Boolean(args.target_ref)),
      {
        path: ['satisfaction'],
        message:
          'satisfaction requires a work-item target: use target_id (or target_kind issue/feature + target_ref), not a plan_item/event/topic target',
      },
    ),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const items = args.items?.length
      ? args.items
      : [
          {
            id: (args.id ?? args.source_id) as string,
            rel: args.rel as LinkRel,
            target_id: args.target_id,
            target_harness: args.target_harness,
            target_kind: args.target_kind,
            target_ref: args.target_ref,
            harness: args.harness,
            remove: args.remove,
            satisfaction: args.satisfaction,
          },
        ];
    const env = await runBulk(
      items,
      async (it) => {
        let dst: ObjectRef | null = null;
        let normalizedFrom: string | undefined;
        if (it.target_id) {
          dst = await resolveWorkItemRef(it.target_id, it.target_harness);
          if (!dst)
            return {
              ok: false as const,
              id: it.id,
              rel: it.rel,
              error: `target work_item '${it.target_id}' not found`,
            };
        } else if (it.target_kind && it.target_ref) {
          const canon = canonicalLinkTargetKind(it.target_kind);
          dst = { kind: canon.kind, ref: it.target_ref };
          normalizedFrom = canon.normalizedFrom;
        } else {
          return { ok: false as const, id: it.id, rel: it.rel, error: 'pass target_id, or target_kind + target_ref' };
        }
        const harness = it.harness ?? args.harness;
        if (it.satisfaction && it.rel !== 'blocks') {
          return { ok: false as const, id: it.id, rel: it.rel, error: 'satisfaction is valid only for rel=blocks' };
        }
        if (it.satisfaction && !['issue', 'feature'].includes(dst.kind)) {
          return { ok: false as const, id: it.id, rel: it.rel, error: 'satisfaction requires a work-item target' };
        }
        // Acyclicity (P-003, F4): a feature→feature `blocks` edge that closes a cycle silently
        // deadlocks the scheduler frontier. The link tools write through the canonical dependency seam
        // syncFeatureBlockEdges' replace-semantics guard), so reject the cycle-closing edge here.
        // The coord_links convention is src=blocker → dst=blocked, so the SOURCE work-item is the
        // blocker and `dst` is the blocked feature.
        if (!it.remove && it.rel === 'blocks') {
          const srcRef = await resolveWorkItemRef(it.id, harness);
          if (srcRef) {
            const cycleErr = await guardFeatureBlockEdgeAcyclic(srcRef.ref, dst.ref);
            if (cycleErr) return { ok: false as const, id: it.id, rel: it.rel, error: cycleErr };
          }
        }
        const res = it.remove
          ? await unlinkWorkItem(it.id, dst, it.rel, { harness })
          : await linkWorkItem(it.id, dst, it.rel, {
              harness,
              by: ident.ownerId,
              ...(it.satisfaction ? { satisfaction: it.satisfaction } : {}),
            });
        return 'error' in res
          ? { ok: false as const, id: it.id, rel: it.rel, error: res.error }
          : {
              ok: true as const,
              id: it.id,
              rel: it.rel,
              dst,
              ...(normalizedFrom
                ? {
                    targetKindNormalized: {
                      from: normalizedFrom,
                      to: dst.kind,
                      why: 'condition edges are stored under the kind the condition store reads',
                    },
                  }
                : {}),
            };
      },
      { keyOf: (it) => ({ id: it.id, rel: it.rel }) },
    );
    return bulkContent(env);
  },
});
