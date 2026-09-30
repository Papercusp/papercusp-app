/**
 * plans:arm-schedule — arm a scheduled plan so it starts firing runs on its cadence.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-016/P-017).
 *
 * Authoring (plans:set-schedule) does NOT arm; this does — it materializes the plan's
 * routine (which fires system:plan-run on the computed next_fire_at) and sets
 * schedule_active. Autonomy-gated: the capability→category map classifies this as the
 * `schedule-arm` category (D-017, seeded never-auto), so the autonomy dispatch gate
 * escalates an autonomous arm to the owner until that category graduates; the owner arms
 * directly.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getPlanRow } from './source';
import { checkPlanStartable } from './plan-start-gate';
import { armPlanSchedule } from '../../harness/routines/arm-plan-schedule';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z
  .object({
    harness: harnessArg,
    slug: z.string().min(1).optional().describe('Plan slug (the scheduled template) to arm.'),
    slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Scheduled plan slugs to arm in one call.'),
  })
  .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
    message: 'pass `slug` or `slugs`',
  });

export default defineTool({
  name: 'plans:arm-schedule',
  description:
    'Arm a scheduled plan so it starts firing runs on its cadence (materializes its routine + sets schedule_active). Authoring (plans:set-schedule) does not arm; this does. Autonomy-gated (schedule-arm category): an autonomous arm is escalated to the owner until that category graduates; the owner arms directly.',
  guidance: {
    when: 'Activating a plan you already scheduled (plans:set-schedule) so it begins firing runs.',
    notWhen: 'Authoring/editing the cadence (plans:set-schedule). Firing one run by hand (plans:run-now).',
    chaining:
      'plans:set-schedule → plans:arm-schedule → the routine fires system:plan-run on cadence. plans:disarm-schedule stops it.',
    seeAlso: [
      'plans:set-schedule (author the schedule to arm)',
      'plans:disarm-schedule (pause the armed schedule)',
      'plans:run-now (fire one run immediately)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    if (!(await getFlag(FLAGS.SCHEDULED_PLANS, 'system'))) {
      return bulkContent({
        ok: true,
        results: mergeIds(args.slug, args.slugs).map((slug) => ({
          ok: false,
          slug,
          error: 'feature_disabled',
          detail: 'the papercusp-scheduled-plans flag is off',
        })),
        counts: { ok: 0, failed: mergeIds(args.slug, args.slugs).length },
      });
    }
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const plan = await getPlanRow(slug, opts);
        if (!plan) return { ok: false as const, slug, error: 'not_found' };
        if (!plan.schedule && !plan.scheduledAt) {
          return {
            ok: false as const,
            slug,
            error: 'not_scheduled',
            detail: 'author a schedule with plans:set-schedule first',
          };
        }
        // P-006/P-008 start gate. Arming runs nothing itself, which is exactly why it
        // is checked here: an armed plan whose required inputs are unset would fail in
        // an unattended 03:00 routine instead of in front of whoever armed it.
        // Door 'scheduled': arming is what makes the plan fire unattended later, so
        // the admission verdict this door needs is the one the scheduled fire needs.
        const gate = await checkPlanStartable(slug, opts, null, 'scheduled');
        // The refusal already carries `slug` — spreading it is the whole result.
        if (!gate.ok) return { ok: false as const, ...gate.refusal };
        const res = await armPlanSchedule({
          workspaceId: plan.workspaceId,
          harnessSlug: plan.harnessSlug,
          templateSlug: slug,
          schedule: plan.schedule,
          scheduledAt: plan.scheduledAt,
          concurrency: plan.schedule?.concurrency,
        });
        if (!res.ok) return { ok: false as const, slug, error: res.reason };
        return { ok: true as const, slug, routineId: res.routineId, nextFireAt: res.nextFireAt };
      },
      { keyOf: (slug) => ({ slug }) },
    );
    return bulkContent(env);
  },
});
