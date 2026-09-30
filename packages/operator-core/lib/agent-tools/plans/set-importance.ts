/**
 * plans:set-importance — change one OR many items' importance level.
 *
 * Importance (urgent|high|normal|low) is a 4th axis orthogonal to
 * status — see planning-attention-importance-2026-05-31 / the plan-format
 * spec §Importance. add-item sets it at creation (required); this verb
 * changes it afterward, e.g. escalating a stuck/aging item or correcting
 * a level set wrong.
 *
 * Surgical line edit: find the item line by its P-NNN id, then add /
 * replace / remove the trailing `importance:` keyword. Setting `normal`
 * (the parser default) REMOVES the keyword so routine lines stay clean.
 * Whitespace, status token, item text, blocked-by, and decision refs are
 * otherwise preserved. Writes inside the lock; auto-bumps `updated:`.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, itemId, importance }, many of one plan to one level
 * { slug, itemIds:[…], importance }, or heterogeneous items:[{ slug, itemId,
 * importance, … }] → { ok, results:[{ ok, slug, itemId, … | error }], counts }.
 * Correlate by { slug, itemId } not array position; one failure never fails the
 * rest. Each result embeds what the single call returned.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { IMPORTANCE_LEVELS, maskFences, type Importance } from './parser';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

const IMPORTANCE = z
  .enum([...IMPORTANCE_LEVELS] as [string, ...string[]])
  .describe('urgent | high | normal | low. Setting `normal` removes the keyword (it is the default).');

const itemSpec = z.object({
  slug: z.string().min(1),
  item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  importance: IMPORTANCE.optional().describe('per-item importance (else the batch `importance`)'),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: z.string().optional().describe('per-item revision rationale (else the batch `rationale`)'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional(),
    item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required').optional(),
    importance: IMPORTANCE.optional(),
    itemIds: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .min(1)
      .max(200)
      .optional()
      .describe('set MANY items of the SAME plan `slug` to the same `importance` (homogeneous)'),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('set many items at once — each { slug, item, importance, harness?, rationale? }'),
    rationale: z
      .string()
      .optional()
      .describe('Optional — why the importance changed (e.g. "stuck 3 days, escalating"). Stored on the plan revision (D-009).'),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0 ||
      (Boolean(a.slug) && Boolean(a.importance) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))),
    { message: 'pass { slug, item, importance } for one, { slug, itemIds:[…], importance } for many of one plan, or items:[{ slug, item, importance }] for heterogeneous' },
  );

interface ImportanceItem {
  slug: string;
  itemId: string;
  importance: Importance;
  harness?: string;
  rationale?: string;
}

type SetImportanceValue =
  | { ok: true; oldImportance: string; newImportance: Importance; itemId: string }
  | { ok: false; code: 'not_found' | 'item_not_found' };

/**
 * Add / replace / remove the `importance:` keyword on one item line.
 * Returns the prior importance (defaulting to `normal` when the line
 * carried no keyword). Mirrors flipStatusInBody: anchor on the id,
 * match against the fence-masked body (the item line is outside any
 * fence, so captured groups equal the real text), splice by index.
 */
export function setImportanceInBody(
  body: string,
  itemId: string,
  importance: Importance,
): { newBody: string; found: boolean; oldImportance: string } {
  const re = new RegExp(
    String.raw`^(\s*[-*]\s+\*\*\s*` +
      itemId.replace(/-/g, '\\-') +
      String.raw`\s*\*\*\s+\x60[a-z-]+\x60\s+)(.*)$`,
    'm',
  );
  const m = re.exec(maskFences(body));
  if (!m) return { newBody: body, found: false, oldImportance: 'normal' };

  const prefix = m[1] ?? '';
  const rest = m[2] ?? '';

  const impRe = /\s*\bimportance\s*:\s*([a-z]+)\b/i;
  const impM = impRe.exec(rest);
  const oldImportance = impM ? (impM[1] ?? '').toLowerCase() : 'normal';

  let restNoImp = impM
    ? rest.slice(0, impM.index) + rest.slice(impM.index + impM[0].length)
    : rest;
  // Tidy any whitespace the removal left behind (keyword is normally at
  // line end; if it was mid-line, collapse the resulting double space).
  restNoImp = restNoImp.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '');

  const newRest = importance === 'normal' ? restNoImp : `${restNoImp} importance: ${importance}`;
  const newLine = prefix + newRest;
  const newBody = body.slice(0, m.index) + newLine + body.slice(m.index + m[0].length);
  return { newBody, found: true, oldImportance };
}

/** Apply one importance change, returning the self-describing bulk result. Carries
 *  the full single-call payload on success ({ slug, itemId, oldImportance,
 *  newImportance, filePath, revision }) and the prior error codes (busy / not_found /
 *  item_not_found) on failure — PRESERVING the lock + revision logic per item. */
async function setImportanceOne(it: ImportanceItem, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  const sctx = harnessScopedCtx(it.harness, ctx);
  const harnessSlug = resolveCtxHarnessSlug(sctx);
  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    it.rationale,
    harnessSlug ? { harnessSlug } : {},
  );
  const result = await withPlanLock<SetImportanceValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:set-importance ${it.itemId} → ${it.importance}`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: SetImportanceValue }> => {
      if (current === null) {
        return { newBody: null, value: { ok: false, code: 'not_found' } };
      }
      const { newBody, found, oldImportance } = setImportanceInBody(current, it.itemId, it.importance);
      if (!found) {
        return { newBody: null, value: { ok: false, code: 'item_not_found' } };
      }
      const finalBody = bumpUpdatedDate(newBody);
      return {
        newBody: finalBody,
        value: { ok: true, oldImportance, newImportance: it.importance, itemId: it.itemId },
      };
    },
  );

  if (result.kind === 'busy') {
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: 'busy',
      busy: result.busy.map((b) => ({
        path: b.path,
        owner_label: b.owner_label,
        intent: b.intent,
        expires_ts: b.expires_ts,
      })),
    };
  }
  if (!result.value.ok) {
    return { ok: false, slug: it.slug, itemId: it.itemId, error: result.value.code };
  }
  return {
    slug: it.slug,
    ...result.value,
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
  };
}

export default defineTool({
  name: 'plans:set-importance',
  description:
    "Change one OR many items' importance (urgent|high|normal|low). Adds/replaces the trailing `importance:` keyword; setting `normal` removes it. Auto-bumps frontmatter updated:. Single: { slug, item, importance }. Many of one plan: { slug, itemIds:[…], importance }. Heterogeneous: items:[{ slug, item, importance }]. Returns { ok, results:[{ ok, slug, itemId, … | error }], counts } — correlate by { slug, itemId }, not position; one failure never fails the rest.",
  guidance: {
    when: "An item's importance changes — escalating a stuck or aging item, or correcting a level set wrong at creation. Re-rank several at once via itemIds:[…] (one plan) or items:[…].",
    notWhen:
      "Setting importance when creating an item — that's plans:add-item's required arg. Changing lifecycle status — plans:set-status.",
    chaining: 'plans:items (sorted urgent→low) → plans:set-importance to re-rank what the human sees first.',
    seeAlso: [
      'plans:set-priority (order whole PLANS in the rail, not items within one)',
      'plans:set-status (change an item\'s lifecycle state, not its rank)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: ImportanceItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          itemId: it.item,
          importance: (it.importance ?? args.importance) as Importance,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({
            slug: args.slug as string,
            itemId,
            importance: args.importance as Importance,
            harness: args.harness,
            rationale: args.rationale,
          }))
        : [
            {
              slug: args.slug as string,
              itemId: args.item as string,
              importance: args.importance as Importance,
              harness: args.harness,
              rationale: args.rationale,
            },
          ];
    const env = await runBulk(list, (it) => setImportanceOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug, itemId: it.itemId }),
    });
    return bulkContent(env);
  },
});
