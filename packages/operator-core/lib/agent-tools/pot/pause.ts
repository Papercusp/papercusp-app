/**
 * pot:pause — the global "Pause Pot" control
 * (start-hive-wake-orchestration-2026-06-09 P-005, D-005/D-006).
 *
 * Pause stops the Mug loop and, by default, leaves the coordination wake-mode alone:
 *   1. persist `hive_started = false` (disarms every watchdog seam — else
 *      Pause would be undone by its own safety net, P-013),
 *   2. clear the Mug's pending time wake,
 *   4. optionally send every live cup the graceful drain cue (the harder stop).
 * Passing `stageAllWakes:true` explicitly opts into the old global manual-wake
 * gate, and the result names the resulting mode so a caller can report it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';
import { CUE_AUTHORITY_FIELD, hiveWideCueAuthority } from '../coordination/cue-authority';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { pausePotState } from '../../pot/pause-core';
import { trackDetached } from '../../detached-imports';

export default defineTool({
  name: 'pot:pause',
  profile: 'engineer',
  description:
    'PAUSE the pot: persist hive_started=false (disarms the liveness watchdog) and clear the pot\'s pending time wake. The coordination wake-mode is preserved by default; pass stageAllWakes:true to explicitly stage every autonomous wake for review. Optionally drain live cups gracefully. Resume with pot:start.',
  guidance: {
    when: 'The user clicks Pause Pot / asks to freeze autonomous operation, or you need the fleet quiet (incident, review, cost control).',
    notWhen:
      'To stop ONE cup — fleet:drain / fleet:cancel. To pause one plan — plans:pause. Pausing does not kill running turns; they finish. Use stageAllWakes:true only when their follow-on wakes should stage for owner review.',
    chaining:
      'pot:pause { stageAllWakes:true, drainCups:true } for an explicit harder stop → coord:wake-queue to review staged wakes → pot:start to resume.',
    seeAlso: [
      'pot:start (resume autonomous operation)',
      'coord:wake-queue (review staged wakes while paused)',
      'pot:dissolve (tear down permanently instead of pausing)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Pot home-harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    drainCups: z
      .boolean()
      .default(false)
      .describe('Also send every live cup the graceful drain cue (checkpoint, release locks/claims, exit).'),
    stageAllWakes: z
      .boolean()
      .default(false)
      .describe('Explicitly set the GLOBAL wake-mode to manual so autonomous wakes stage for owner review; default preserves the current mode.'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const installSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_POT_HOME_SLUG) — the started state is per-pot.',
            }),
          },
        ],
      };
    }
    const { sql } = getOrgPg();

    // The state transition itself lives in pot/pause-core so the goal stop
    // fan-out (EI-20013729460455061) performs the IDENTICAL transition — including
    // the P-013 ordering and the WI-3261/WI-3309 `deliberate` markers that stop the
    // recovery sweep auto-resuming a deliberate pause.
    const paused = await pausePotState(sql, workspaceId, installSlug, { stageAllWakes: args.stageAllWakes });
    const loopIdle = paused.workspaceLoopIdle;
    // Live UI reflection (P-006): the AdvShell harness-bar control
    // (AdvNowRunning) reads pot.controlState.
    void trackDetached(import('../../sync-sse'))
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('pot.controlState', {}))
      .catch(() => {});

    // Optional harder stop: the graceful drain cue to every live cup (the same
    // message fleet:drain sends per-cup — propose/dispose preserved).
    let drained: string[] = [];
    if (args.drainCups) {
      const identity = resolveAgentIdentity(ctx);
      const rows = await sql<Array<{ session_owner: string | null }>>`
        SELECT session_owner FROM harness_shared.spawned_agents
        WHERE workspace_id = ${workspaceId} AND status IN ('running', 'restarting')
          AND child_role = 'cup' AND session_owner IS NOT NULL`;
      drained = [...new Set(rows.map((r) => r.session_owner).filter((s): s is string => Boolean(s)))];
      if (drained.length > 0) {
        await sendMessage(identity, {
          to: drained,
          summary: 'Graceful drain cue: the pot is being paused',
          body:
            'The pot is being PAUSED. Checkpoint your state (commit pending edits), release your locks ' +
            '(locks:release { all_mine: true }), return claimed work-items to the pool (work_items:release), ' +
            'and end your turn cleanly. You will not be re-woken until the pot is started again.',
          // P-003: an intrinsically POT-WIDE Mug control — stamp it so a recipient
          // reads it as a real pot pause, not a fleet-leader draining its members.
          extra: { [CUE_AUTHORITY_FIELD]: hiveWideCueAuthority(installSlug) },
        });
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            started: false,
            wakeMode: paused.wakeMode,
            stageAllWakes: args.stageAllWakes,
            wakeModeNote: args.stageAllWakes
              ? 'Global wake-mode set to manual; autonomous wakes are staged for owner review until coord:wake-mode or pot:start restores auto.'
              : `Global wake-mode preserved at ${paused.wakeMode}; pot:pause stopped the pot wake loop without muting agent-to-agent wakes.`,
            workspaceLoopIdle: loopIdle,
            timeWakeCleared: loopIdle,
            drainedCups: drained,
          }),
        },
      ],
    };
  },
});
