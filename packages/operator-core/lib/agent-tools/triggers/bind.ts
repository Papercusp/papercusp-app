import { z } from 'zod';
import { dataConditionSchema } from '@papercusp/rules';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  createExternalTriggerBinding,
  migrateExternalTriggerPlanBindingToOperation,
} from '../../external-triggers/admin';
import { data, invalidateTriggers, triggerToolContext } from './_shared';

export default defineTool({
  name: 'triggers:bind',
  profile: 'engineer',
  description:
    'Install a disarmed external-event binding from one source to one target — preferably a registered blueprint operation, or a legacy plan, goal, or canonical Email direct work-item kind — with an optional payload filter and storm policy.',
  guidance: {
    when: 'Attach an existing external source event pattern (ext:<source>:<event>) to a blueprint operation ({ operationHarnessSlug, operationId, input? }), legacy plan ({ harness, plan }), goal ({ goal }), or Email direct work-item ingress. For compatibility migration, pass migrateFromBindingId plus the operation target: source/filter/storm policy are copied exactly and the replacement remains DISARMED.',
    notWhen:
      'To activate it use triggers:arm separately. For schedules use plans:set-schedule then plans:arm-schedule. For manual starts use plans:run-now.',
    chaining:
      'triggers:list → triggers:bind → inspect the returned disarmed binding → triggers:arm { bindingId, confirm:true }.',
    seeAlso: ['triggers:arm (activate the installed binding)', 'plans:set-schedule (time trigger)'],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      sourceId: z.string().uuid().optional(),
      migrateFromBindingId: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Legacy launch-plan binding to copy into a disarmed operation replacement; replay returns the same replacement.',
        ),
      harness: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('target plan harness (with `plan`; omit for a goal binding)'),
      plan: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('target plan slug (with `harness`; omit for a goal binding)'),
      goal: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'target GOAL id (P-020) — matches ACTIVATE this goal instead of launching a plan; exactly one of plan/goal',
        ),
      workItemHarnessSlug: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('direct work-item target harness (P-018; currently `email`, with workItemKind)'),
      workItemKind: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('direct work-item target kind (P-018; currently `email-draft-proposal`, with workItemHarnessSlug)'),
      operationHarnessSlug: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('registered blueprint harness (with operationId); the standard P-016 automation target'),
      operationId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('registered blueprint operation id (with operationHarnessSlug)'),
      input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('literal operation or plan input overlaid on the redacted event routing envelope'),
      datatype: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('queue only canonical events of this catalog datatype (portable binding)'),
      eventPattern: z.string().min(5).max(500).optional().describe('ext:<source>:<event> key or anchored glob'),
      filter: dataConditionSchema.optional().describe('payload condition using the shared rules vocabulary'),
      stormPolicy: z
        .object({
          maxRuns: z.number().int().positive().max(1_000_000).nullable().optional(),
          windowSeconds: z
            .number()
            .int()
            .positive()
            .max(31 * 24 * 60 * 60)
            .optional(),
          maxAgeSeconds: z
            .number()
            .int()
            .positive()
            .max(31 * 24 * 60 * 60)
            .optional()
            .describe('drop a queued run never dispatched within this many seconds (default 86400)'),
        })
        .optional(),
    })
    .superRefine((value, context) => {
      if (value.migrateFromBindingId) {
        if (!value.operationHarnessSlug || !value.operationId) {
          context.addIssue({
            code: 'custom',
            path: ['operationId'],
            message: 'migration requires operationHarnessSlug and operationId',
          });
        }
        for (const field of [
          'sourceId',
          'harness',
          'plan',
          'goal',
          'workItemHarnessSlug',
          'workItemKind',
          'eventPattern',
          'filter',
          'stormPolicy',
          'datatype',
        ] as const) {
          if (value[field] !== undefined) {
            context.addIssue({
              code: 'custom',
              path: [field],
              message: `${field} is copied from migrateFromBindingId`,
            });
          }
        }
        return;
      }
      if (!value.sourceId) context.addIssue({ code: 'custom', path: ['sourceId'], message: 'sourceId is required' });
      if (!value.eventPattern)
        context.addIssue({ code: 'custom', path: ['eventPattern'], message: 'eventPattern is required' });
    }),
  async handler(args, ctx) {
    const { sql, workspaceId, actorId } = triggerToolContext(ctx);
    if (args.migrateFromBindingId) {
      const migration = await migrateExternalTriggerPlanBindingToOperation(sql, workspaceId, {
        bindingId: args.migrateFromBindingId,
        operationHarnessSlug: args.operationHarnessSlug!,
        operationId: args.operationId!,
        operationInput: args.input,
        createdBy: actorId,
      });
      await invalidateTriggers(workspaceId);
      return data({ ok: true, migration });
    }
    const planTarget = Boolean(args.harness || args.plan);
    const binding = await createExternalTriggerBinding(sql, workspaceId, {
      sourceId: args.sourceId!,
      planHarnessSlug: args.harness ?? null,
      planSlug: args.plan ?? null,
      goalId: args.goal ?? null,
      workItemHarnessSlug: args.workItemHarnessSlug ?? null,
      workItemKind: args.workItemKind ?? null,
      operationHarnessSlug: args.operationHarnessSlug ?? null,
      operationId: args.operationId ?? null,
      ...(planTarget ? { planInput: args.input } : { operationInput: args.input }),
      datatypeId: args.datatype ?? null,
      eventPattern: args.eventPattern!,
      eventFilter: args.filter as Record<string, unknown> | undefined,
      stormPolicy: args.stormPolicy,
      createdBy: actorId,
    });
    await invalidateTriggers(workspaceId);
    return data({ ok: true, binding });
  },
});
