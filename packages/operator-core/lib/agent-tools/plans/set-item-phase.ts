/**
 * plans:set-item-phase — move one OR many items to a different phase
 * (plan-templates-and-rubric-v2-2026-06-20 P-003).
 *
 * An item's phase is POSITIONAL: the parser assigns each item the most-recent
 * `## Phase …` heading above it. So "change the phase" means RELOCATING the whole
 * item line under the target phase heading — there is no inline `phase:` keyword to
 * flip. Before, this required a plans:edit cut-and-paste (error-prone — easy to drop
 * the status token or blocked-by). This is the structured move: it lifts the exact
 * item line (every token preserved) out of its current phase and re-inserts it under
 * the target, REUSING add-item's appendItemToBody (which creates the phase section if
 * it doesn't exist, just before `## Decisions`). A no-op when the item is already in
 * the target phase. Inside the plan lock; records a revision.
 *
 * Bulk by default (the house keyed-array contract, bulk-endpoint-standardization-
 * 2026-06-21): single { slug, itemId, phase }, many of one plan to one phase
 * { slug, itemIds:[…], phase }, or heterogeneous items:[{ slug, itemId, phase }] →
 * { ok, results:[{ ok, slug, itemId, fromPhase, toPhase, moved, createdPhase |
 * error }], counts }. Correlate by { slug, itemId } not array position; one failure
 * never fails the rest.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { parsePlan, maskFences, type LegacyReason } from './parser';
import { appendItemToBody, PHASE } from './add-item';
import { planRevisionCapture, type PlanRevisionCtx } from './revisions';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';
import { softText, clampText, LIMITS } from '../limits';

// EI-8811: PHASE (auto-prefixing z.preprocess + the /^Phase\b/i regex) is
// shared from add-item.ts — this tool has the exact same grammar + auto-fix
// requirement, so it reused a hand-duplicated copy of the old hard-reject
// version instead of the single source of truth.

/** Normalize a phase heading the way the parser does (strip a leading `N. ` /
 *  `N.M ` numeric prefix) so a no-op compare against a parsed item.phase is exact.
 *  Exported for tests. */
export function normalizePhaseHeading(heading: string): string {
  return heading.trim().replace(/^\d+(?:\.\d+)?\.\s+/, '');
}

/**
 * Lift one item line out of the body and re-insert it under `phase` (via add-item's
 * appendItemToBody). The item line is matched by id against the fence-masked body and
 * spliced out VERBATIM (status, text, blocked-by, importance, risk, authority all
 * preserved); a blank-line run left at the removal seam is collapsed to one. Returns
 * createdPhase when the target phase section did not exist. Exported for tests.
 */
export function moveItemToPhase(
  body: string,
  itemId: string,
  phase: string,
): { newBody: string; found: boolean; createdPhase: boolean } {
  const re = new RegExp(
    String.raw`^[-*]\s+\*\*\s*` +
      itemId.replace(/-/g, '\\-') +
      String.raw`\s*\*\*\s+\x60[a-z-]+\x60\s+.*$`,
    'm',
  );
  const masked = maskFences(body);
  const m = re.exec(masked);
  if (!m) return { newBody: body, found: false, createdPhase: false };

  const lineStart = m.index;
  const lineEnd = m.index + m[0].length; // end of the line text (before its newline)
  const itemLine = body.slice(lineStart, lineEnd).trim();

  // Remove the line plus its trailing newline.
  let removeEnd = lineEnd;
  if (body[removeEnd] === '\n') removeEnd++;
  const before = body.slice(0, lineStart);
  let after = body.slice(removeEnd);
  // Seam tidy: a blank line both before AND after the removed item would leave a
  // double blank — collapse to one.
  if (/\n[ \t]*\n$/.test(before) && /^[ \t]*\n/.test(after)) {
    after = after.replace(/^[ \t]*\n/, '');
  }
  const without = before + after;

  const { newBody, createdPhase } = appendItemToBody(without, phase, itemLine);
  return { newBody, found: true, createdPhase };
}

const itemSpec = z.object({
  slug: z.string().min(1).describe('Plan slug (filename stem).'),
  item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'),
  phase: PHASE.optional().describe('per-item target phase (else the batch `phase`)'),
  harness: harnessArg.describe('per-item harness (else the batch `harness` default)'),
  rationale: softText(LIMITS.ANNOTATION).optional().describe('per-item revision rationale (else the batch `rationale`). Auto-truncated to 2000 chars if longer.'),
});

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (filename stem).'),
    item: z.string().regex(/^P-\d{3,}$/, 'P-NNN form required').optional(),
    phase: PHASE.optional(),
    itemIds: z
      .array(z.string().regex(/^P-\d{3,}$/, 'P-NNN form required'))
      .min(1)
      .max(200)
      .optional()
      .describe('move MANY items of the SAME plan `slug` to the same `phase` (homogeneous)'),
    items: z
      .array(itemSpec)
      .min(1)
      .max(200)
      .optional()
      .describe('move many items at once — each { slug, item, phase, harness?, rationale? }'),
    rationale: softText(LIMITS.ANNOTATION)
      .optional()
      .describe('Optional — why the item moved phase. Stored on the plan revision (D-009). Auto-truncated to 2000 chars if longer.'),
  })
  .refine(
    (a) =>
      (a.items?.length ?? 0) > 0 ||
      (Boolean(a.slug) && Boolean(a.phase) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))),
    { message: 'pass { slug, item, phase } for one, { slug, itemIds:[…], phase } for many of one plan, or items:[{ slug, item, phase }] for heterogeneous' },
  );

interface PhaseItem {
  slug: string;
  itemId: string;
  phase: string;
  harness?: string;
  rationale?: string;
}

type SetPhaseValue =
  | { ok: true; itemId: string; fromPhase: string | null; toPhase: string; moved: boolean; createdPhase: boolean }
  | { ok: false; code: 'not_found' | 'item_not_found' }
  | { ok: false; code: 'legacy_plan'; reason?: LegacyReason };

/** Move one item to a phase, returning the self-describing bulk result. PRESERVES the
 *  no-op-when-already-there + legacy guards, lock, revision, and sync-invalidate. */
async function setPhaseOne(it: PhaseItem, ctx: UnifiedToolContext): Promise<BulkItemResult> {
  const sctx = harnessScopedCtx(it.harness, ctx);
  const harnessSlug = resolveCtxHarnessSlug(sctx);
  const targetPhase = normalizePhaseHeading(it.phase);
  const rev = planRevisionCapture(
    ctx as PlanRevisionCtx,
    it.slug,
    clampText(it.rationale, LIMITS.ANNOTATION),
    harnessSlug ? { harnessSlug } : {},
  );

  const result = await withPlanLock<SetPhaseValue>(
    ctx as never,
    {
      slug: it.slug,
      intent: `plans:set-item-phase ${it.itemId} → ${targetPhase.slice(0, 40)}`,
      ...(harnessSlug ? { harnessSlug } : {}),
      afterWrite: rev.afterWrite,
    },
    async (current): Promise<{ newBody: string | null; value: SetPhaseValue }> => {
      if (current === null) return { newBody: null, value: { ok: false, code: 'not_found' } };
      const parsed = parsePlan(current, { filePath: it.slug + '.md' });
      if (parsed.isLegacy) {
        return {
          newBody: null,
          value: { ok: false, code: 'legacy_plan', reason: parsed.legacyReason ?? undefined },
        };
      }
      const item = parsed.items.find((i) => i.id === it.itemId);
      if (!item) return { newBody: null, value: { ok: false, code: 'item_not_found' } };

      const fromPhase = item.phase;
      // Already under the target phase — no write, no revision.
      if (fromPhase !== null && fromPhase === targetPhase) {
        return {
          newBody: null,
          value: { ok: true, itemId: it.itemId, fromPhase, toPhase: targetPhase, moved: false, createdPhase: false },
        };
      }

      const { newBody, found, createdPhase } = moveItemToPhase(current, it.itemId, it.phase);
      if (!found) return { newBody: null, value: { ok: false, code: 'item_not_found' } };
      return {
        newBody: bumpUpdatedDate(newBody),
        value: { ok: true, itemId: it.itemId, fromPhase, toPhase: targetPhase, moved: true, createdPhase },
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
    return {
      ok: false,
      slug: it.slug,
      itemId: it.itemId,
      error: result.value.code,
      ...('reason' in result.value && result.value.reason ? { reason: result.value.reason } : {}),
    };
  }

  // Refresh the per-plan item rail so the item's new phase grouping shows immediately.
  try {
    const { notifySyncInvalidate } = await import('../../sync-sse');
    await notifySyncInvalidate('planItems.byPlan', { planSlug: it.slug });
  } catch {
    /* best-effort — the next natural refresh picks it up */
  }

  return {
    slug: it.slug,
    ...result.value,
    filePath: result.filePath,
    revision: rev.recorded.current ? { seq: rev.recorded.current.seq } : null,
  };
}

export default defineTool({
  name: 'plans:set-item-phase',
  description:
    "Move one OR many items to a different phase — relocates the whole item line under the target `## Phase …` heading (an item's phase is positional, not an inline keyword), every token preserved. Creates the phase section if it doesn't exist. No-op when already there. Inside the plan lock, records a revision. Single: { slug, item, phase }. Many of one plan: { slug, itemIds:[…], phase }. Heterogeneous: items:[{ slug, item, phase }]. Returns { ok, results:[{ ok, slug, itemId, fromPhase, toPhase, moved, createdPhase | error }], counts } — correlate by { slug, itemId }, not position; one failure never fails the rest.",
  guidance: {
    when: 'An item belongs under a different phase — re-sequencing work across phases, or correcting a mis-placed item. The structured alternative to manually cutting + pasting the line with plans:edit. Move several at once via itemIds:[…] (one plan) or items:[…].',
    notWhen:
      'Adding a NEW item (plans:add-item — it takes the phase directly). Changing status/importance/blockers (their dedicated setters). Renaming a phase heading itself (plans:edit / plans:set-content).',
    chaining: 'plans:get-item { slug, item } to see the current phase → plans:set-item-phase.',
    seeAlso: [
      'plans:get-item (see the current phase first)',
      'plans:add-item (add to a phase instead of moving an existing item)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const list: PhaseItem[] = args.items?.length
      ? args.items.map((it) => ({
          slug: it.slug,
          itemId: it.item,
          phase: (it.phase ?? args.phase) as string,
          harness: it.harness ?? args.harness,
          rationale: it.rationale ?? args.rationale,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((itemId) => ({
            slug: args.slug as string,
            itemId,
            phase: args.phase as string,
            harness: args.harness,
            rationale: args.rationale,
          }))
        : [
            {
              slug: args.slug as string,
              itemId: args.item as string,
              phase: args.phase as string,
              harness: args.harness,
              rationale: args.rationale,
            },
          ];
    const env = await runBulk(list, (it) => setPhaseOne(it, ctx), {
      keyOf: (it) => ({ slug: it.slug, itemId: it.itemId }),
    });
    return bulkContent(env);
  },
});
