/**
 * plans:set-schedule — author/update a plan's SCHEDULE (make it recurring, one-shot,
 * or clear it). The agent + UI authoring surface for scheduled-recurring plans.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-014).
 *
 * Writes the operational schedule columns (schedule / scheduled_at / expires_at / tzid)
 * via setPlanSchedule — like the op_* columns, these are structured state, NOT authored
 * markdown. Validates an RRULE before storing it. Authoring does NOT arm the schedule
 * (schedule_active stays false); arming is the separate autonomy-gated flow (D-010).
 * Pass `schedule: null` to clear a recurrence (un-schedule).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { setPlanSchedule } from './source';
import { validateRrule, frequencyWarning } from '../../harness/routines/schedule-next';
import { deletePlanSchedule } from '../../harness/routines/materialize-plan-schedule';

const scheduleSchema = z
  .object({
    kind: z.enum(['rrule', 'cron']).describe('Recurrence dialect.'),
    rrule: z.string().optional().describe('RRULE string (RFC 5545), e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR.'),
    dtstart: z.string().optional().describe('DTSTART anchor (ISO) — required for INTERVAL/COUNT/UNTIL.'),
    tzid: z.string().optional().describe('IANA tz id for calendar-time recurrence (DST-safe).'),
    rdate: z.array(z.string()).optional().describe('Extra one-off occurrences (RDATE, ISO).'),
    exdate: z.array(z.string()).optional().describe('Excluded occurrences (EXDATE, ISO) — holidays, etc.'),
    cron: z.string().optional().describe('Cron dialect (5/6-field) — the alternate input.'),
    concurrency: z.enum(['queue', 'skip', 'cancel-prev']).optional().describe('Overlap policy if a prior run is still going. Default skip.'),
    catchup: z.enum(['skip-old', 'run-all-backlog']).optional(),
    // EI-1388: `carryState` removed — it was accepted + stored but never actually
    // applied by the fire path (runScheduledPlanFire always mints a plain copy of
    // the template), so enabling it silently did nothing. See source.ts's
    // PlanSchedule.carryState removal comment for the full rationale.
    costCapCents: z.number().int().nonnegative().optional().describe('Per-plan spend cap (D-012).'),
    executorKind: z
      .enum(['feature', 'chunk'])
      .optional()
      .describe("Frontier item_kind each run mints (D-006). Default 'feature' (coding spine)."),
    execution: z
      .object({
        appHarnessSlug: z.string().trim().min(1),
        agentName: z.string().trim().min(1),
      })
      .optional()
      .describe('Agentic app queue owner and durable stable agent-name for direct dispatch.'),
    operation: z
      .object({
        harnessSlug: z.string().trim().min(1).max(120),
        operationId: z.string().trim().min(1).max(200),
        input: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional()
      .describe('Registered blueprint operation fired by this schedule; legacy schedules without it retain system:plan-run.'),
  })
  .describe('The recurrence set + policy. Omit/null to clear (un-schedule).');

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (the template).'),
  schedule: scheduleSchema.nullable().optional(),
  scheduledAt: z.string().nullable().optional().describe('One-shot fire time (ISO) — drag-onto-a-day. Fires once, then deactivates.'),
  expiresAt: z.string().nullable().optional().describe('Recurrence end/deadline (ISO). On expiry the schedule deactivates; the plan is not deleted.'),
  tzid: z.string().nullable().optional().describe('Per-plan timezone (overrides schedule.tzid for the column).'),
});

export default defineTool({
  name: 'plans:set-schedule',
  description:
    "Author or clear a plan's schedule — make it recurring (RRULE or cron), one-shot (scheduledAt), and/or give it an expiry. Validates the RRULE. Does NOT arm it (arming is the autonomy-gated flow); pass schedule:null to un-schedule.",
  guidance: {
    when: 'Turning a plan into a scheduled/recurring one, editing its cadence/expiry, or clearing its schedule.',
    notWhen:
      'Arming a saved schedule so it starts firing — that is the autonomy-gated arm step, not authoring. Flipping plan/item status uses plans:set-plan-status / plans:set-status.',
    chaining: 'plans:set-schedule → (arm, autonomy-gated) → the routines engine fires the configured blueprint operation (or legacy system:plan-run); plans:run-now to fire one legacy plan manually.',
    seeAlso: [
      'plans:arm-schedule (arm it after authoring — autonomy-gated)',
      'plans:run-now (fire one run now)',
      'plans:disarm-schedule (pause the schedule)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sched = args.schedule;
    // Validate the recurrence before storing it.
    if (sched) {
      const wantsRrule = sched.kind === 'rrule' || (!!sched.rrule && !sched.cron);
      if (wantsRrule) {
        if (!sched.rrule) {
          return errorOut('rrule_required', 'schedule.kind=rrule requires schedule.rrule');
        }
        const v = validateRrule(sched.rrule);
        if (!v.ok) return errorOut('invalid_rrule', v.error);
      } else if (sched.kind === 'cron' && !sched.cron) {
        return errorOut('cron_required', 'schedule.kind=cron requires schedule.cron');
      }
    }

    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const ok = await setPlanSchedule({
      ...opts,
      slug: args.slug,
      schedule: sched ?? null,
      scheduledAt: args.scheduledAt ?? null,
      expiresAt: args.expiresAt ?? null,
      tzid: args.tzid ?? sched?.tzid ?? null,
    });

    if (!ok) return errorOut('not_found', `plan '${args.slug}' not found`);

    // Clearing the authored recurrence AND one-shot is permanent un-scheduling,
    // not a pause. Remove the materialized routine so inventory cannot retain a
    // stale inactive row. Missing rows are an idempotent no-op.
    if (sched == null && args.scheduledAt == null) {
      await deletePlanSchedule(opts.harnessSlug, args.slug);
    }

    const warn = sched ? frequencyWarning(sched, new Date()) : null; // P-013: warn-on-frequent
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            slug: args.slug,
            scheduled: sched != null || args.scheduledAt != null,
            ...(warn ? { warnings: [warn] } : {}),
          }),
        },
      ],
    };
  },
});

function errorOut(code: string, detail?: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: code, ...(detail ? { detail } : {}) }) }],
    isError: true,
  };
}
