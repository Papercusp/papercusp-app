/** fleet:headcount-target — persist a bounded fleet member target for the
 * background governor. The first wave still uses fleet:launch-on-plan; this
 * tool records the validated recipe that later routine ticks may top up. */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import {
  getFleet,
  getFleetHeadcountTarget,
  setFleetHeadcountTarget,
  type FleetHeadcountTarget,
} from '../../agent-fleets-store';
// Pure rule helpers live outside agent-fleets-store: this module reads the
// constants at load time (the zod schema), and that store is fully vi.mock'ed
// by many test files.
import {
  FLEET_TOP_UP_RULE_DEFAULT_HOURS,
  FLEET_TOP_UP_RULE_MAX_HOURS,
  parseFleetTopUpRule,
  type FleetTopUpRule,
  type FleetTopUpRuleKind,
} from '../../fleet/top-up-rule';
import { FLEET_MAX_TARGET_MEMBERS } from '../../agent-config-constants';
import { resolveHarnessPlansDir, readPlanBySlug } from '../plans/source';
import {
  normalizePersistedFleetLaunchConfig,
  resolveLoadedSavedFleetLaunchSpec,
} from './saved-launch-spec';
import { json, resolveFleetCaller } from './_shared';

/**
 * P-005 / D-030: build the no-top-up rule a call ratifies. What it SUSPENDS is
 * read from the row as it stands before this write; a re-ratification of a rule
 * that already suspended the target carries the original values forward, so a
 * renewal can never lose the target the expiry will restore.
 */
export function buildFleetTopUpRule(args: {
  kind: FleetTopUpRuleKind;
  existing: FleetHeadcountTarget | null;
  /** The target this write leaves in force (supervise-revoked); null for target-disabled. */
  targetInForce: number | null;
  ratifiedBy: string;
  reason: string;
  untilHours?: number;
  now: number;
}): FleetTopUpRule {
  const prior = parseFleetTopUpRule(args.existing?.config?.topUpRule);
  const suspendedTarget =
    args.kind === 'supervise-revoked'
      ? args.targetInForce
      : args.existing?.enabled
        ? args.existing.target
        : prior?.kind === 'target-disabled'
          ? prior.suspendedTarget
          : null;
  const currentSupervise = args.existing?.config?.supervise;
  const suspendedSupervise =
    currentSupervise === true ? true : prior ? prior.suspendedSupervise : currentSupervise === false ? false : null;
  const hours = Math.min(args.untilHours ?? FLEET_TOP_UP_RULE_DEFAULT_HOURS, FLEET_TOP_UP_RULE_MAX_HOURS);
  return {
    kind: args.kind,
    ratifiedBy: args.ratifiedBy,
    ratifiedAt: args.now,
    reason: args.reason,
    until: args.now + Math.round(hours * 3_600_000),
    suspendedTarget,
    suspendedSupervise,
  };
}

export default defineTool({
  name: 'fleet:headcount-target',
  description:
    'Persist a bounded target member count and canonical launch recipe for a fleet. target:null disables automatic top-up but PRESERVES the launch recipe for takeover/respawn. target:null or supervise:false records an attributed no-top-up rule (reason required) that EXPIRES after untilHours (default 24, max 72), when the governor restores what it suspended; re-call to re-ratify. Existing boot-baked settings fail closed unless replaceExisting:true includes an audit reason.',
  guidance: {
    when: 'After a fleet:launch-on-plan wave, when the fleet should maintain a target member count across member death and operator restarts.',
    notWhen: 'For a one-off launch wave, use fleet:launch-on-plan. Disable the governor with target:null; the saved launch recipe deliberately survives.',
  },
  capability: 'fleet:headcount-target',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    fleet: z.string().min(1).describe('Existing fleet slug.'),
    target: z.number().int().min(1).max(FLEET_MAX_TARGET_MEMBERS).nullable().describe('Desired live member count, or null to disable the governor.'),
    productiveCapacityFloor: z
      .number()
      .int()
      .min(1)
      .max(FLEET_MAX_TARGET_MEMBERS)
      .optional()
      .describe('Worker-ready members required before the governor may open a multi-member refill wave. Defaults to one canary.'),
    supervise: z
      .boolean()
      .optional()
      .describe('R5 per-fleet governor grant: true opts this fleet into fleet-headcount auto-top-up while FLEET_HEADCOUNT_GOVERNOR is ON; false revokes; omit preserves the stored grant. A governance knob, not a boot setting — changing it needs no replaceExisting.'),
    harness: z.string().min(1).describe('Harness for the launch recipe and optional plan validation.'),
    plan: z.string().min(1).optional().describe('Plan whose work the top-up members should pull. Omit for a planless claim-spec fleet.'),
    agent: z.enum(['claude', 'omp', 'codex']).optional().describe('Agent backend. Omit to preserve an existing profile; a new profile defaults to claude.'),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).max(40).optional(),
    account: z.string().min(1).optional(),
    headless: z.boolean().optional().describe('Persisted placement. Defaults true for background restoration.'),
    role: z.string().min(1).optional(),
    brief: z.string().min(1).max(4000).optional(),
    launchContext: z
      .string()
      .min(1)
      .optional()
      .describe('Readable PATH to a launch-context file. Put inline instructions in brief; prose here is refused before persistence.'),
    contextSize: z.literal('trimmed').optional(),
    compactionLimit: z.number().int().min(20_000).max(900_000).optional(),
    carry: z.enum(['warm', 'cold']).optional(),
    extraArgs: z.array(z.string()).max(20).optional(),
    replaceExisting: z.boolean().optional().default(false).describe('Allow an intentional change to an existing canonical launch recipe. Requires reason.'),
    reason: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe('Audit reason. Required with replaceExisting:true, and for a no-top-up rule (target:null or supervise:false), where it is shown to every later leader.'),
    untilHours: z
      .number()
      .min(1)
      .max(FLEET_TOP_UP_RULE_MAX_HOURS)
      .optional()
      .describe(`No-top-up rules only: hours until the rule expires and the governor restores what it suspended (default ${FLEET_TOP_UP_RULE_DEFAULT_HOURS}, max ${FLEET_TOP_UP_RULE_MAX_HOURS}). Re-call to re-ratify.`),
  }).superRefine((args, ctx) => {
    if (args.replaceExisting && !args.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'reason is required when replaceExisting=true' });
    }
    const ratifiesRule = args.target == null || args.supervise === false;
    if (ratifiesRule && !args.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message:
          'reason is required for a no-top-up rule (target:null or supervise:false): the rule is attributed, expires, and is shown to every later leader of this fleet',
      });
    }
    if (!ratifiesRule && args.untilHours != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['untilHours'],
        message: 'untilHours applies only to a no-top-up rule (target:null or supervise:false)',
      });
    }
    if (args.target != null && args.productiveCapacityFloor != null && args.productiveCapacityFloor > args.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productiveCapacityFloor'],
        message: 'productiveCapacityFloor cannot exceed target',
      });
    }
  }),
  async handler(args, ctx) {
    const { workspaceId, ownerId } = resolveFleetCaller(ctx);
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) return json({ ok: false, error: `no fleet '${args.fleet}' in this workspace` }, true);
    if (args.target == null) {
      // `target:null` is intentionally a disable-only operation. Before this
      // guard, every optional launch/governance field was silently ignored on
      // this early return, so a caller could receive `ok:true` while believing
      // it had repaired the profile that takeover/respawn will later consume.
      // Refuse every field this branch cannot apply; the required-only disable
      // path still avoids rereading or mutating the saved recipe.
      const ignoredFields = [
        'productiveCapacityFloor',
        'supervise',
        'agent',
        'model',
        'effort',
        'account',
        'headless',
        'role',
        'brief',
        'launchContext',
        'contextSize',
        'compactionLimit',
        'carry',
        'extraArgs',
        'replaceExisting',
      ].filter((field) => {
        const value = (args as Record<string, unknown>)[field];
        // replaceExisting defaults to false during schema parsing; that
        // default is not a requested update and must not break disable-only
        // calls. An explicit true is refused because it cannot be honored on
        // this branch.
        return field === 'replaceExisting' ? value === true : value !== undefined;
      });
      if (ignoredFields.length > 0) {
        return json({
          ok: false,
          error: 'invalid_args',
          offending: ignoredFields,
          message:
            '`target:null` is a disable-only operation and cannot update launch recipe fields. ' +
            `These fields would be ignored: ${ignoredFields.join(', ')}. ` +
            'Pass a non-null target to update the recipe, or omit the recipe fields to disable the governor.',
        }, true);
      }
      // P-005 / D-030: a disable is a no-top-up RULE — attributed, reasoned and
      // expiring — never a silent null a successor inherits without knowing it.
      const existingProfile = await getFleetHeadcountTarget(workspaceId, args.fleet);
      const topUpRule = buildFleetTopUpRule({
        kind: 'target-disabled',
        existing: existingProfile,
        targetInForce: null,
        ratifiedBy: ownerId,
        reason: args.reason as string,
        untilHours: args.untilHours,
        now: Date.now(),
      });
      await setFleetHeadcountTarget({ workspaceId, fleetSlug: args.fleet, target: null, topUpRule });
      return json({
        ok: true,
        fleet: args.fleet,
        target: null,
        disabled: true,
        launchProfilePreserved: existingProfile != null,
        // A row with no saved recipe cannot store the rule (nothing to restore).
        topUpRule: existingProfile != null ? topUpRule : null,
        by: ownerId,
      });
    }
    let resolvedHarness: Awaited<ReturnType<typeof resolveHarnessPlansDir>>;
    try {
      resolvedHarness = await resolveHarnessPlansDir(args.harness, { workspaceId });
    } catch (error) {
      return json({ ok: false, error: `could not validate harness: ${error instanceof Error ? error.message : String(error)}` }, true);
    }
    const existing = await getFleetHeadcountTarget(workspaceId, args.fleet);
    const planToValidate = args.plan ?? existing?.config.plan;
    if (planToValidate) {
      try {
        const plan = await readPlanBySlug(planToValidate, {
          harnessSlug: resolvedHarness.harnessSlug,
          workspaceId: resolvedHarness.workspaceId,
        });
        if (!plan) {
          return json({ ok: false, error: `plan '${planToValidate}' was not found in harness '${args.harness}'` }, true);
        }
      } catch (error) {
        return json({ ok: false, error: `could not validate plan: ${error instanceof Error ? error.message : String(error)}` }, true);
      }
    }
    let replacementConflicts: unknown[] = [];
    if (existing) {
      const resolution = resolveLoadedSavedFleetLaunchSpec({
        target: existing,
        workspaceId,
        fleetSlug: args.fleet,
        requested: args,
        reusePath: 'fleet:headcount-target canonical recipe update',
      });
      if (!resolution.ok) {
        if (resolution.error !== 'saved_launch_spec_conflict' || !args.replaceExisting) {
          return json({
            ok: false,
            error: resolution.error,
            message: resolution.message,
            conflicts: resolution.conflicts,
            hint: resolution.error === 'saved_launch_spec_conflict'
              ? 'Re-call with replaceExisting:true and a concrete reason for an intentional audited boot-setting change.'
              : undefined,
          }, true);
        }
        replacementConflicts = resolution.conflicts;
      }
    }
    // P-005 / D-030: the no-top-up rule is not part of the launch recipe. It is
    // decided below and written apart, so a stale stored rule never rides the
    // recipe spread into the response.
    const { topUpRule: _storedRule, ...existingRecipe } = (existing?.config ?? {}) as Partial<
      FleetHeadcountTarget['config']
    >;
    const config = normalizePersistedFleetLaunchConfig({
      ...existingRecipe,
      ...(args.plan !== undefined ? { plan: args.plan } : {}),
      harness: args.harness,
      agent: args.agent ?? existing?.config.agent ?? 'claude',
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.account ? { account: args.account } : {}),
      ...(args.productiveCapacityFloor != null
        ? { productiveCapacityFloor: args.productiveCapacityFloor }
        : {}),
      // R5: the supervise grant is deliberately outside the saved-spec conflict
      // fields — granting/revoking supervision is a governance act, not an
      // audited boot-setting change. Omission preserves the stored value via
      // the `existing.config` spread above.
      ...(args.supervise != null ? { supervise: args.supervise } : {}),
      headless: args.headless ?? existing?.config.headless ?? true,
      ...(args.role ? { role: args.role } : {}),
      ...(args.brief ? { brief: args.brief } : {}),
      ...(args.launchContext ? { launchContext: args.launchContext } : {}),
      ...(args.contextSize ? { contextSize: args.contextSize } : {}),
      ...(args.compactionLimit ? { compactionLimit: args.compactionLimit } : {}),
      ...(args.carry ? { carry: args.carry } : {}),
      ...(args.extraArgs?.length ? { extraArgs: args.extraArgs } : {}),
    });
    // The governor and respawn path pass this value to psu as --launch-context,
    // which is a FILE PATH (not an inline brief). Validate the effective value,
    // including an inherited value from an older profile, before persisting it;
    // otherwise a prose value is accepted here and only kills a replacement
    // member later when psu attempts to open it (EI-22682725231684697).
    const rawLaunchContext = (config as { launchContext?: unknown }).launchContext;
    const launchContext = typeof rawLaunchContext === 'string' ? rawLaunchContext.trim() : undefined;
    if (rawLaunchContext !== undefined && (!launchContext || typeof rawLaunchContext !== 'string')) {
      return json({
        ok: false,
        error: 'invalid_launch_context',
        message: 'launchContext must be a non-empty readable file path before the fleet launch recipe can be persisted. Use brief for inline instructions.',
      }, true);
    }
    if (launchContext) {
      try {
        readFileSync(launchContext, 'utf8');
      } catch (error) {
        return json({
          ok: false,
          error: 'invalid_launch_context',
          launchContext,
          message:
            `launchContext must be a readable file path before the fleet launch recipe can be persisted: ` +
            `could not read \`${launchContext}\` (${error instanceof Error ? error.message : String(error)}). ` +
            'Use brief for inline instructions.',
        }, true);
      }
      // Persist the canonical trimmed spelling. A path that is readable only
      // before surrounding whitespace is stripped would otherwise fail when
      // the governor forwards the stored value to psu.
      (config as { launchContext?: string }).launchContext = launchContext;
    }
    // P-005 / D-030: supervise:false ratifies a rule; an untouched supervise keeps
    // a still-standing supervise-revoked rule; anything else ends the rule.
    const priorRule = parseFleetTopUpRule(existing?.config?.topUpRule);
    const topUpRule: FleetTopUpRule | undefined =
      args.supervise === false
        ? buildFleetTopUpRule({
            kind: 'supervise-revoked',
            existing,
            targetInForce: args.target,
            ratifiedBy: ownerId,
            reason: args.reason as string,
            untilHours: args.untilHours,
            now: Date.now(),
          })
        : args.supervise === undefined && priorRule?.kind === 'supervise-revoked'
          ? priorRule
          : undefined;
    await setFleetHeadcountTarget({ workspaceId, fleetSlug: args.fleet, target: args.target, config, topUpRule });
    return json({
      ok: true,
      fleet: args.fleet,
      target: args.target,
      config,
      topUpRule: topUpRule ?? null,
      enabled: true,
      launchProfile: {
        existed: !!existing,
        replaced: replacementConflicts.length > 0,
        conflicts: replacementConflicts,
        reason: replacementConflicts.length > 0 ? args.reason : undefined,
      },
      by: ownerId,
    });
  },
});
