/**
 * plans:get-item — read ONE or MANY plan items (P-NNN) with resolved effectiveStatus,
 * WITHOUT loading + parsing the whole plan (plan-templates-and-rubric-v2 P-003).
 *
 * The interface audit found no single-item read: to inspect one P-NNN you had to
 * plans:get the whole plan (+ scan it) or plans:items (cross/whole-plan). This
 * returns just the named item(s) from the PG-canonical structured index
 * (planItemsForRow — a markdown parse only if the derived index is absent), with
 * effectiveStatus + the open-issue block overlay — exactly the resolution plans:items
 * does, scoped to specific ids. Read-only.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, item }, many of one plan { slug, itemIds:[…] }, or
 * cross-plan items:[{ slug, item }] → { ok, results:[{ ok, slug, itemId, item? |
 * error }], counts }. Correlate by { slug, itemId } not array position; one missing
 * item never fails the rest. The per-row work (getPlanRow + issue-block overlay) is
 * memoized per slug across the batch so N items of one plan parse it once.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getPlanRow, planItemsForRow, type PlanRow } from './source';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx, resolveHarnessScope } from '../_harness-scope';
import { recoverHarnessFromSlugs, slugScopeErrorResult } from './slug-scope';
import { resolveEffectiveStatusForItems } from './effective-status';
import { getAllBlockedPlanItems, applyPlanItemBlocks, planItemRef } from '../../issue-blocks-merge';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

const itemSpec = z.object({
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  item: z.string().regex(/^P-\d{3,}$/).describe('The plan item id, e.g. "P-003".'),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (filename stem) — with `item` (one) or `itemIds` (many of one plan).'),
    item: z
      .string()
      .regex(/^P-\d{3,}$/)
      .optional()
      .describe('single-read shorthand: the plan item id, e.g. "P-003".'),
    // EI-21901062936431252 added `itemId` here as an accepted alias. REMOVED: it
    // contradicted the ratified alpha vocabulary policy (P-005 / EI-11400), which
    // `semantic-argument-vocabulary.test.ts` enforces for this exact tool — "a breaking
    // rename, not a compatibility-alias layer: one public spelling, strict rejection,
    // and define-tool's did-you-mean hint teaches callers the correction." The two
    // tests could not both pass and the tree stayed red. The friction that motivated
    // the alias is real but its cause is elsewhere: plans:audit keys its per-item
    // entries `itemId` while the whole plans:* item family uses `item` — tracked
    // separately rather than papered over per-tool. EI-10897 (work_items:comment's
    // `body`/`comment`) is NOT precedent here: that tool is outside the guard's list.
    itemIds: z
      .array(z.string().regex(/^P-\d{3,}$/))
      .min(1)
      .max(200)
      .optional()
      .describe('read MANY items of the SAME plan `slug` (homogeneous)'),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('read many items across plans — each { slug, item, harness? }'),
  })
  .superRefine((a, ctx) => {
    const hasSingle = Boolean(a.item);
    const ok = (a.items?.length ?? 0) > 0 || (Boolean(a.slug) && ((a.itemIds?.length ?? 0) > 0 || hasSingle));
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        message: 'pass { slug, item } for one, { slug, itemIds:[…] } for many of one plan, or items:[{ slug, item }] for cross-plan',
      });
    }
  });

interface ReadItem {
  slug: string;
  itemId: string;
  harness?: string;
}

export default defineTool({
  name: 'plans:get-item',
  description:
    'Read ONE or MANY plan items (P-NNN) — each one\'s text, storedStatus + resolved effectiveStatus, importance, phase, blockedBy, and any blocking engineer-issues — from the PG-canonical structured index, WITHOUT loading + parsing the whole plan. Single: { slug, item }. Many of one plan: { slug, itemIds:[…] }. Cross-plan: items:[{ slug, item, harness? }]. Returns { ok, results:[{ ok, slug, itemId, item? | error }], counts } — correlate by { slug, itemId }, not position; a missing item never fails the rest.',
  guidance: {
    when: 'Inspecting one or more specific P-NNN (their status / blockers / phase / importance) without pulling the whole plan. The targeted read between plans:items (many by status) and plans:get (the whole plan). Read several at once via itemIds:[…] (one plan) or items:[…] (cross-plan).',
    notWhen: 'You need the whole plan (Now / decisions / prose) — plans:get. Many items by status — plans:items.',
    chaining: 'plans:get-item { slug, item } → plans:set-status / plans:set-item-blocked-by / plans:set-item-phase to act on it.',
    seeAlso: [
      'plans:set-status (advance the item)',
      'plans:set-item-phase (move it to another phase)',
      'plans:set-item-blocked-by (record its blockers)',
    ],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // overwatch reads plan items (read-only) to ground its nudges, like plans:items.
  agentRoles: [...SU_ROLES, 'kettle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const singleItem = args.item;
    const list: ReadItem[] = args.items?.length
      ? args.items.map((it) => ({ slug: it.slug, itemId: it.item, harness: it.harness ?? args.harness }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({ slug: args.slug as string, itemId, harness: args.harness }))
        : [{ slug: args.slug as string, itemId: singleItem as string, harness: args.harness }];

    // Match plans:get / plans:items: an exact homogeneous plan slug is enough to
    // recover the owning harness in an operator/superuser session whose ambient
    // scope is only the '*' wildcard. Cross-plan reads still require an explicit
    // per-item or batch harness because one call must stay within one scope.
    const homogeneousSlug = args.items?.length ? undefined : args.slug;
    const scope = resolveHarnessScope(args.harness, ctx);
    let autoResolvedHarness: string | undefined;
    if (scope.kind === 'none' && homogeneousSlug) {
      const decision = await recoverHarnessFromSlugs(ctx, [homogeneousSlug]);
      if (decision.status !== 'resolved') return slugScopeErrorResult('plans:get-item', decision);
      autoResolvedHarness = decision.harnessSlug;
      const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
      ctxAny.metadata?.({
        harnessAutoResolved: decision.bySlug,
        ...(Object.keys(decision.ambiguous).length > 0
          ? { harnessAmbiguous: decision.ambiguous }
          : {}),
      });
    }

    // The all-blocked overlay is workspace-wide, not per-slug — fetch it ONCE for
    // the whole batch (non-fatal; degrades to resolver-only on error).
    let allBlocked = new Map<string, string[]>();
    try {
      allBlocked = await getAllBlockedPlanItems();
    } catch {
      /* non-fatal — no issue-block overlay */
    }

    // Memoize the per-slug row fetch + parse so N items of one plan parse it once.
    type RowResult = { kind: 'ok'; row: PlanRow } | { kind: 'error'; error: string };
    const rowCache = new Map<string, RowResult>();
    const resolveRow = async (slug: string, harness?: string): Promise<RowResult> => {
      const key = `${harness ?? ''}::${slug}`;
      const cached = rowCache.get(key);
      if (cached) return cached;
      const effectiveHarness =
        harness ?? (autoResolvedHarness && homogeneousSlug === slug ? autoResolvedHarness : undefined);
      const sctx = harnessScopedCtx(effectiveHarness, ctx);
      const opts = await ctxToPlanSourceOpts(sctx);
      const row = await getPlanRow(slug, opts);
      let res: RowResult;
      if (!row) res = { kind: 'error', error: 'not_found' };
      else if (row.isLegacy) res = { kind: 'error', error: 'legacy_plan' };
      else res = { kind: 'ok', row };
      rowCache.set(key, res);
      return res;
    };

    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const rr = await resolveRow(it.slug, it.harness);
        if (rr.kind === 'error') return { ok: false, slug: it.slug, itemId: it.itemId, error: rr.error };
        const row = rr.row;
        const { items, blockingIssues } = applyPlanItemBlocks(
          resolveEffectiveStatusForItems(planItemsForRow(row)).items,
          (id) => allBlocked.get(planItemRef(row.planSlug, id)),
        );
        const item = items.find((i) => i.id === it.itemId);
        if (!item) return { ok: false, slug: it.slug, itemId: it.itemId, error: 'item_not_found' };
        return {
          ok: true,
          slug: it.slug,
          itemId: it.itemId,
          plan: row.planSlug,
          archived: row.archived,
          item,
          ...(blockingIssues[item.id] ? { blockedByIssues: blockingIssues[item.id] } : {}),
        };
      },
      { keyOf: (it) => ({ slug: it.slug, itemId: it.itemId }) },
    );
    return bulkContent(env);
  },
});
