/**
 * plans:disarm-schedule — stop a scheduled plan from firing (pause).
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-016/P-017).
 *
 * Sets schedule_active=false and deactivates the plan's routine. The authored schedule
 * columns are kept, so re-arming (plans:arm-schedule) is one call. Same `schedule-arm`
 * autonomy category as arming.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getPlanRow } from './source';
import { disarmPlanSchedule } from '../../harness/routines/arm-plan-schedule';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).optional().describe('Plan slug (the scheduled template) to disarm/pause.'),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Scheduled plan slugs to disarm in one call.'),
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
});

export default defineTool({
  name: 'plans:disarm-schedule',
  description:
    'Disarm (pause) a scheduled plan so it stops firing runs — sets schedule_active=false + deactivates its routine. The authored schedule is kept; plans:arm-schedule re-arms it.',
  guidance: {
    when: 'Pausing a scheduled plan so it stops firing, without discarding its schedule.',
    notWhen: 'Permanently removing the schedule — use plans:set-schedule { schedule: null }.',
    chaining: 'plans:disarm-schedule (pause) ↔ plans:arm-schedule (resume).',
    seeAlso: [
      'plans:arm-schedule (resume the schedule)',
      'plans:set-schedule (edit the schedule)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const plan = await getPlanRow(slug, opts);
        if (!plan) return { ok: false as const, slug, error: 'not_found' };
        await disarmPlanSchedule({ workspaceId: plan.workspaceId, harnessSlug: plan.harnessSlug, templateSlug: slug });
        return { ok: true as const, slug };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
