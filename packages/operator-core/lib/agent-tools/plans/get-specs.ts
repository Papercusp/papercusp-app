/** plans:get-specs — exact structured reads of canonical plan spec revisions. */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { listSpecClauses } from './spec-clauses-store';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug owning the clauses.'),
  specIds: z.array(z.string().min(1)).min(1).max(200).optional(),
  sourceValIds: z
    .array(z.string().regex(/^VAL-[A-Za-z0-9._-]+$/))
    .min(1)
    .max(200)
    .optional(),
  planItemIds: z
    .array(z.string().regex(/^P-\d{3,}$/))
    .min(1)
    .max(200)
    .optional()
    .describe('Restrict to clauses owned by these P-NNN plan items. Aliases: `itemId`/`planItemId` (one id).'),
  // tool-contract-repair-2026-09-05 P-006 / EI-21722550422531809: a caller
  // filtering to one plan item reached for the singular `itemId` — the spelling
  // plans:items and plans:get-item use — and hit invalid_args before any read
  // ran. `itemId` has no second meaning on this tool (the only item-shaped
  // filter is planItemIds), so it aliases; `planItemIds` wins when both are
  // supplied.
  itemId: z
    .string()
    .regex(/^P-\d{3,}$/)
    .optional()
    .describe('Compatibility alias for planItemIds (a single P-NNN id); planItemIds wins when both are supplied.'),
  planItemId: z
    .string()
    .regex(/^P-\d{3,}$/)
    .optional()
    .describe('Compatibility alias for planItemIds (a single P-NNN id); planItemIds wins when both are supplied.'),
  revision: z.number().int().positive().optional().describe('Read this exact revision number.'),
  includeHistory: z.boolean().optional().describe('Return every immutable revision; current only by default.'),
});

export default defineTool({
  name: 'plans:get-specs',
  description:
    'Read canonical first-class spec clauses for one plan. Current revisions only by default; filter by stable spec id, source VAL alias, plan item, or exact revision, and opt into immutable history.',
  guidance: {
    when: 'Inspecting the behavioral contract a plan/item owns, resolving a VAL alias, or auditing exact historical revisions.',
    notWhen: 'Reading plan-item outcome text — plans:get-item. Reading legacy test verdicts — testing/coverage tools.',
    chaining: 'plans:get-specs → plans:set-specs with expectedRevision for an optimistic-CAS revision.',
    seeAlso: ['plans:set-specs (append a revision)', 'plans:get-item (read the owning outcome)'],
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // The evidence-only gym judge must read the canonical clauses it is grading
  // against. Keep this explicit: broadening SU_ROLES would grant unrelated
  // roles access, while omitting judge forces it to substitute derived rows.
  agentRoles: [...SU_ROLES, 'kettle', 'worker', 'cup', 'judge'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const specs = await listSpecClauses({
      harnessSlug,
      planSlug: args.slug,
      specIds: args.specIds,
      sourceValIds: args.sourceValIds,
      // `itemId`/`planItemId` are singular compatibility aliases; an explicit
      // `planItemIds` wins (tool-contract-repair-2026-09-05 P-006).
      planItemIds:
        args.planItemIds ??
        (args.planItemId ? [args.planItemId] : undefined) ??
        (args.itemId ? [args.itemId] : undefined),
      revision: args.revision,
      includeHistory: args.includeHistory,
    });
    return {
      data: {
        ok: true,
        slug: args.slug,
        harnessSlug,
        specs,
        count: specs.length,
        mode: args.revision !== undefined ? 'exact-revision' : args.includeHistory ? 'history' : 'current',
      },
    };
  },
});
