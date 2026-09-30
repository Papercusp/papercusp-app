/**
 * goals:start-from-package — the deliberate act that turns an INSTALLED goal
 * package into a pursued goal (work-on-everything-goal-2026-08-23 P-017,
 * D-002: install ≠ start).
 *
 * Thin wrapper: all semantics live in `goals/start-from-package.ts` (the core),
 * which adopts the seeded stub or mints a fresh instance and converges on
 * `startGoalById` — D-006's one activation primitive — with the kickoff brief
 * built from the package content via the shared `buildGoalKickoffBrief`.
 */

import type { Sql } from 'postgres';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { startGoalFromPackage } from '../../goals/start-from-package';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';
import { assertGoalWriteAuthorityForCaller } from '../../goals/write-authority';

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

export default defineTool({
  name: 'goals:start-from-package',
  needsWorkspaceTx: true,
  description:
    'START an installed goal PACKAGE: adopt its seeded inactive stub (or mint a fresh instance) and spawn the GOAL-mode holder — the deliberate second half of install ≠ start. ' +
    '{ ref, harness?, inputs?, startBlocked?, startBlockedReason? }. Typed inputs are validated against the package inputSchema; standing packages get holder { requireLive: true, onLoss: \'respawn\' } and a weekly budget window unless the package pins its own; already-active instances of the same package are reported as info, never a gate. Returns the goal id, the holder ownerId, and every default applied.',
  guidance: {
    when:
      "Starting a goal that exists as an INSTALLED package (cupboard:install-goal landed a paused stub, or a bundled package ships in the release) — e.g. the work-on-everything standing goal.",
    notWhen:
      'A brand-new goal stated ad hoc: goals:start. Installing the package (no start): cupboard:install-goal. Re-activating an arbitrary existing goal that came from no package: flip its status deliberately, then the trigger/schedule legs or goals:start family.',
    chaining:
      "cupboard:search { kind: 'goal' } → cupboard:install-goal → goals:start-from-package. The spawned holder orients in GOAL mode; watch coord:presence by the returned ownerId.",
    seeAlso: ['cupboard:install-goal (the install half)', 'goals:start (a new ad-hoc goal + agent)'],
  },
  capability: 'goals:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    ref: z
      .string()
      .min(1)
      .max(200)
      .describe("the installed package's ref (its subdir identity — cupboard:search { kind: 'goal' })"),
    harness: z
      .string()
      .max(120)
      .optional()
      .describe(
        'Harness slug for a freshly-minted instance (required when no unstarted stub exists to adopt). An adopted stub keeps its own install_slug.',
      ),
    inputs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "the values this instance is started with, validated against the package's inputSchema (P-021) — a missing required field refuses the start",
      ),
    startBlocked: z
      .boolean()
      .optional()
      .describe('Acknowledge starting DESPITE unsatisfied blocked-by prerequisites (the activation gate warn-refuses once without it).'),
    startBlockedReason: z
      .string()
      .max(2000)
      .optional()
      .describe('Why starting blocked is right — recorded as the audit trail.'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    if (!workspaceId) {
      return err('No concrete workspace in scope — a goal cannot be started workspace-less.');
    }
    await assertGoalWriteAuthorityForCaller(ctx, workspaceId, ctx.tx as unknown as Sql);
    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }
    const harness =
      args.harness?.trim() || (ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null);

    const res = await startGoalFromPackage(ctx.tx as unknown as Sql, {
      workspaceId,
      ref: args.ref,
      harness,
      inputs: args.inputs ?? null,
      launcherOwnerId: callerOwnerId,
      startBlocked: args.startBlocked,
      startBlockedReason: args.startBlockedReason,
    });

    if (!res.ok) {
      const instances = res.activeInstances?.length
        ? ` Already-active instances of this package (info, not the refusal): ${res.activeInstances
            .map((i) => `${i.id} (${i.status})`)
            .join(', ')}.`
        : '';
      return err(`start-from-package refused (${res.reason}): ${res.detail}${instances}`);
    }

    return {
      data: {
        id: res.goalId,
        agent_owner_id: res.ownerId,
        adopted_stub: res.adopted,
        applied_defaults: res.appliedDefaults,
        active_instances: res.activeInstances,
        drain_fleet: res.drainFleet,
        ...(res.warnings.length ? { warning: res.warnings.join('\n') } : {}),
      },
    };
  },
});
