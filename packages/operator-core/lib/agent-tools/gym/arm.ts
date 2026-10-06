/**
 * gym:arm — enable/disable + budget the gym autoloop for ONE pot, writing BOTH
 * spend-gating layers atomically (self-learning-public-release-readiness P-011).
 *
 * Arming the gym has always required two hand-coordinated writes: the autoloop
 * config (harness_shared.gym_autoloop_config — what the gym-cycle round-robin
 * reads) AND the matching `gym:<slug>` learning-governor row
 * (harness_shared.learning_governor_loops — what the spend governor enforces).
 * Every manual arming so far has had to remember both; forgetting one leaves a
 * pot that either never cycles or cycles ungoverned. This tool is the single
 * audited switch: one call, both layers, verified together, one-call revert.
 * The Blender pane's Arming section drives it through the run-tool bridge.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import { getAutoloop, setAutoloop, type GymAutoloopConfig } from '../../gym/control-plane';
import { getLearningLoop, registerLearningLoop } from '../../learning-governor/store';
import { gymLoopId, type LearningLoopRegistration } from '../../learning-governor/core';

interface ArmSnap {
  autoloop: GymAutoloopConfig | null;
  loop: LearningLoopRegistration | null;
}

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'gym:arm',
  profile: 'engineer',
  description:
    'Arm/disarm the gym autoloop for ONE pot: enable/disable and/or set the USD budget, writing BOTH gating layers atomically — the autoloop config (gym_autoloop_config, what the gym-cycle round-robin picks up) and the matching gym:<slug> learning-governor row (what the spend governor enforces). One call replaces the two hand-coordinated writes arming has always needed; forgetting one layer leaves a pot that never cycles or cycles ungoverned. Audited + one-call-revertible; omitted fields are preserved on both layers.',
  capability: 'operator:write',
  guidance: {
    when: "Turn the gym on/off for a pot or change its budget — the owner's Blender-pane Arming section and the agent path are this same switch. Also the repair when the two layers have drifted (enabled on one, off on the other): pass the desired state once and both converge.",
    notWhen: 'For a non-gym learning lane (red-queen, regret, transfer, …) use governor:arm. To pause the gym-cycle SCHEDULE itself (all pots at once) use routines:set on the gym-cycle routine. To read state without writing, gym:signals or the Blender pane.',
    chaining: 'Verify pickup afterwards via harness_gym_durable.gym_cycles / the Gym tab — the round-robin runs one pot per tick, so an armed pot waits for the in-flight cycle to finish.',
    seeAlso: ['governor:arm (any learning-governor lane by loopId)', 'routines:set (the gym-cycle schedule)', 'gym:signals (read-side)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    harness: z.string().min(1).max(80).describe('Pot / harness slug to arm the gym for, e.g. "papercusp".'),
    enabled: z.boolean().optional().describe('true = arm the gym for this pot, false = disarm. Omitted = leave as-is (budget-only change).'),
    budgetUsd: z
      .number()
      .finite()
      .min(0)
      .max(100_000)
      .nullable()
      .optional()
      .describe('USD budget for the autoloop + governor row. number sets, null clears (governor then refuses unattended spend), omitted preserves.'),
    dryRun: z.boolean().optional(),
  }).refine((args) => args.enabled !== undefined || args.budgetUsd !== undefined, {
    message: 'provide enabled and/or budgetUsd — a call with neither changes nothing',
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('gym:arm requires operator, architect, or mug role');
    }
    if (args.enabled === undefined && args.budgetUsd === undefined) {
      throw new Error('gym:arm requires enabled and/or budgetUsd — a call with neither changes nothing');
    }

    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();
    const harnessSlug = args.harness;
    const loopId = gymLoopId(harnessSlug);

    const readSnap = async (): Promise<ArmSnap> => ({
      autoloop: await getAutoloop(sql, { workspaceId, harnessSlug }),
      loop: await getLearningLoop(sql, { workspaceId, loopId }),
    });

    const writeBoth = async (enabled: boolean | undefined, budgetUsd: number | null | undefined): Promise<void> => {
      await setAutoloop(sql, { workspaceId, harnessSlug, enabled, budgetUsd });
      await registerLearningLoop(sql, {
        workspaceId,
        loopId,
        potSlug: harnessSlug,
        displayName: `Gym autoloop (${harnessSlug})`,
        enabled,
        budgetUsd,
      });
    };

    const outcome = await runControlMutation<ArmSnap>(
      {
        action: 'gym:arm',
        subject: `${harnessSlug} (${loopId})`,
        actor: `role:${ctx.role}`,
        capturePrev: readSnap,
        apply: async () => {
          await writeBoth(args.enabled, args.budgetUsd);
          return readSnap();
        },
        revertTo: async (prev) => {
          // Restore each layer to its captured state; a layer that did not exist
          // before is disarmed (there is no delete on these upsert stores, and a
          // disabled row is behaviorally identical to an absent one).
          await setAutoloop(sql, {
            workspaceId,
            harnessSlug,
            enabled: prev.autoloop?.enabled ?? false,
            budgetUsd: prev.autoloop ? prev.autoloop.budgetUsd : null,
          });
          await registerLearningLoop(sql, {
            workspaceId,
            loopId,
            enabled: prev.loop?.enabled ?? false,
            budgetUsd: prev.loop ? prev.loop.budgetUsd : null,
          });
        },
        verify: async () => {
          const cur = await readSnap();
          const wantEnabled = args.enabled;
          const wantBudget = args.budgetUsd;
          const layerOk = (enabled: boolean | undefined, budget: number | null | undefined): boolean =>
            (wantEnabled === undefined || enabled === wantEnabled) &&
            (wantBudget === undefined || (budget ?? null) === wantBudget);
          const ok =
            cur.autoloop !== null &&
            cur.loop !== null &&
            layerOk(cur.autoloop.enabled, cur.autoloop.budgetUsd) &&
            layerOk(cur.loop.enabled, cur.loop.budgetUsd);
          return { ok, detail: ok ? undefined : 'autoloop config and/or governor row did not reflect the change' };
        },
        describe: (prev) => ({
          current: {
            autoloop: prev.autoloop ? { enabled: prev.autoloop.enabled, budgetUsd: prev.autoloop.budgetUsd, spentUsd: prev.autoloop.spentUsd } : null,
            governor: prev.loop ? { enabled: prev.loop.enabled, budgetUsd: prev.loop.budgetUsd, spentUsd: prev.loop.spentUsd } : null,
          },
          proposed: { enabled: args.enabled ?? 'unchanged', budgetUsd: args.budgetUsd === undefined ? 'unchanged' : args.budgetUsd },
        }),
      },
      { dryRun: args.dryRun },
    );

    // Refresh the Blender pane's Arming section the moment the write commits
    // (same never-fail-the-mutation posture as routines:set).
    if (outcome.applied && !outcome.dryRun) {
      try {
        const { notifySyncInvalidate } = await import('../../sync-sse');
        notifySyncInvalidate('automation.catalog');
      } catch {
        /* SSE hub unavailable — the pane still refreshes on its next poll */
      }
    }

    return json({
      ok: true,
      harness: harnessSlug,
      loopId,
      dryRun: outcome.dryRun,
      applied: outcome.applied,
      reverted: outcome.reverted,
      preview: outcome.preview,
      verify: outcome.verify,
      auditId: outcome.auditId,
    });
  },
});
