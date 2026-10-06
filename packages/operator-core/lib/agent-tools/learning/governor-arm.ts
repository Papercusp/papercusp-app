/**
 * governor:arm — enable/disable + budget ONE learning-governor lane by loopId
 * (self-learning-public-release-readiness P-011).
 *
 * The learning-governor rows (harness_shared.learning_governor_loops) gate every
 * learning lane's spend, but until this tool the only write paths were each
 * lane's own registration code or raw SQL — the Frontier view rendered them
 * read-only and the owner had no switch anywhere. This is the audited single
 * switch for an EXISTING lane; it deliberately refuses to mint new rows (a row
 * nothing consumes is dead config — gym lanes are created via gym:arm, every
 * other lane by its own registrant).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { runControlMutation } from '../../gateway-control/control-harness';
import { getLearningLoop, registerLearningLoop } from '../../learning-governor/store';
import type { LearningLoopRegistration } from '../../learning-governor/core';

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export default defineTool({
  name: 'governor:arm',
  profile: 'engineer',
  description:
    "Enable/disable and/or set the USD budget of ONE EXISTING learning-governor lane (harness_shared.learning_governor_loops) by loopId — e.g. 'red-queen', 'regret-mining', 'blender:<pot>'. The audited write the read-only Frontier view lacked; the Blender pane's Arming section drives it. Refuses an unknown loopId (a governor row nothing consumes is dead config — gym lanes are minted via gym:arm, other lanes by their own registrants). Omitted fields are preserved; audited + one-call-revertible.",
  capability: 'operator:write',
  guidance: {
    when: "Turn a learning lane's spend gate on/off or change its budget live — tighten a lane mid-incident, disarm an experiment's lane, or re-arm a lane the governor disabled.",
    notWhen: 'For the gym lane of a pot use gym:arm (it writes the autoloop config AND the gym:<slug> governor row atomically). To pause the lane\'s SCHEDULE use routines:set. For the workspace-wide Blender ceiling use learning:set-scout-budget.',
    chaining: 'Read current lanes first (the Frontier/Blender pane, or SELECT via dev:pg_query on learning_governor_loops) to get the exact loopId.',
    seeAlso: ['gym:arm (gym lanes, both layers)', 'learning:set-scout-budget (workspace-wide Blender ceiling)', 'routines:set (the schedule layer)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 20 } },
  args: z.object({
    loopId: z.string().min(1).max(120).describe("Exact loop_id of an existing lane, e.g. 'red-queen', 'frontier:replay-harness', 'gym:papercusp'."),
    enabled: z.boolean().optional().describe('true = arm the lane, false = disarm. Omitted = leave as-is (budget-only change).'),
    budgetUsd: z
      .number()
      .finite()
      .min(0)
      .max(100_000)
      .nullable()
      .optional()
      .describe('USD budget. number sets, null clears (the governor then refuses unattended spend), omitted preserves.'),
    dryRun: z.boolean().optional(),
  }).refine((args) => args.enabled !== undefined || args.budgetUsd !== undefined, {
    message: 'provide enabled and/or budgetUsd — a call with neither changes nothing',
  }),
  async handler(args, ctx) {
    if (!isOperatorConfigWriteRole(ctx.role)) {
      throw new Error('governor:arm requires an operator-config write role (operator, architect, or mug; the isOperatorConfigWriteRole set is operator-equivalent write authority, NOT any su/worker role)');
    }
    if (args.enabled === undefined && args.budgetUsd === undefined) {
      throw new Error('governor:arm requires enabled and/or budgetUsd — a call with neither changes nothing');
    }

    const { sql } = getOrgPg();
    const workspaceId = activeWorkspaceId();

    const readSnap = async (): Promise<LearningLoopRegistration> => {
      const row = await getLearningLoop(sql, { workspaceId, loopId: args.loopId });
      if (!row) {
        throw new Error(
          `governor:arm: no learning-governor lane '${args.loopId}' — this tool arms EXISTING lanes only (gym lanes are created via gym:arm; other lanes by their own registrants)`,
        );
      }
      return row;
    };

    const outcome = await runControlMutation<LearningLoopRegistration>(
      {
        action: 'governor:arm',
        subject: args.loopId,
        actor: `role:${ctx.role}`,
        capturePrev: readSnap,
        apply: async () => {
          await registerLearningLoop(sql, {
            workspaceId,
            loopId: args.loopId,
            enabled: args.enabled,
            budgetUsd: args.budgetUsd,
          });
          return readSnap();
        },
        revertTo: async (prev) => {
          await registerLearningLoop(sql, {
            workspaceId,
            loopId: args.loopId,
            enabled: prev.enabled,
            budgetUsd: prev.budgetUsd,
          });
        },
        verify: async () => {
          const cur = await readSnap();
          const ok =
            (args.enabled === undefined || cur.enabled === args.enabled) &&
            (args.budgetUsd === undefined || (cur.budgetUsd ?? null) === args.budgetUsd);
          return { ok, detail: ok ? undefined : 'governor row did not reflect the change' };
        },
        describe: (prev) => ({
          current: { enabled: prev.enabled, budgetUsd: prev.budgetUsd, spentUsd: prev.spentUsd, potSlug: prev.potSlug },
          proposed: { enabled: args.enabled ?? 'unchanged', budgetUsd: args.budgetUsd === undefined ? 'unchanged' : args.budgetUsd },
        }),
      },
      { dryRun: args.dryRun },
    );

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
      loopId: args.loopId,
      dryRun: outcome.dryRun,
      applied: outcome.applied,
      reverted: outcome.reverted,
      preview: outcome.preview,
      verify: outcome.verify,
      auditId: outcome.auditId,
    });
  },
});
