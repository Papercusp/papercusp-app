/**
 * plans:run-now — fire one run of a scheduled plan immediately (a manual run),
 * independent of its cadence.
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-014).
 *
 * Mints an instance plan + plan_runs row (trigger='manual') + run-scoped work items —
 * exactly like a scheduled fire (runScheduledPlanFire), just triggered by hand. Works
 * whether or not the plan's schedule is armed.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { getPlanRow } from './source';
import { checkPlanStartable, planGateRefusalContent } from './plan-start-gate';
import { runScheduledPlanFire } from '../../harness/routines/plan-run-action';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z.string().min(1).describe('Plan slug (the template) to run once now.'),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Per-invocation input overrides, shallow-merged over the plan's stored values and validated before the run is created (plan-structured-inputs P-011). This is what lets ONE scheduled plan serve many parameterizations instead of N near-duplicate plans. Omit to run with the plan's stored values.",
    ),
});

export default defineTool({
  name: 'plans:run-now',
  description:
    'Fire one run of a scheduled plan immediately (a manual run), independent of its cadence — mints an instance plan + plan_runs row + run-scoped work items, like a scheduled fire.',
  guidance: {
    when: 'Manually triggering a run of a scheduled plan now — testing the schedule, or an out-of-band run.',
    notWhen:
      'Changing the cadence (plans:set-schedule). Launching a plan as an interactive chat session (plans:launch).',
    chaining: 'plans:set-schedule (author) → plans:run-now (fire one) → plans:runs (inspect the runs).',
    seeAlso: [
      'plans:runs (list past / active runs)',
      'plans:set-schedule (author the schedule this fires from)',
      'plans:run-transcript (watch the fired run)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const opts = await ctxToPlanSourceOpts(harnessScopedCtx(args.harness, ctx));
    const plan = await getPlanRow(args.slug, opts);
    if (!plan) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_found', slug: args.slug }) }],
        isError: true,
      };
    }
    // P-006 start gate — with any per-invocation overrides merged in FIRST, so what is
    // validated is exactly what the run will execute with, not the stored values.
    const gate = await checkPlanStartable(args.slug, opts, args.inputs ?? null, 'run-now');
    // Whole result, not `.refusal`: this door can now be refused for readiness OR for
    // P-004 admission, and the two carry different error tags.
    if (!gate.ok) return planGateRefusalContent(gate);

    const { sql } = getOrgPg();
    const res = await runScheduledPlanFire(sql, {
      installSlug: plan.harnessSlug,
      workspaceId: plan.workspaceId,
      templateSlug: args.slug,
      trigger: 'manual',
      // Persist the SAME resolved inputs the gate approved — never a second merge.
      inputs: gate.inputs,
    });
    if (res.started === false) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: false, slug: args.slug, ...res }),
          },
        ],
        // Concurrency is a deliberate policy skip, not an execution error.
        ...(res.reason === 'concurrency-skip' ? {} : { isError: true }),
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, ...res }),
        },
      ],
    };
  },
});
