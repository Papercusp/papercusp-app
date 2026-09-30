/**
 * pot:start — the global "Start Pot" control
 * (start-hive-wake-orchestration-2026-06-09 P-005, D-005/D-006).
 *
 * Distinct from PlanRail's per-plan Start (plans:start drives the feature
 * pipeline): THIS boots the brain. START =
 *   1. persist `hive_started = true` (P-004 — the bit the watchdog keys on),
 *   2. re-affirm the Mug's default event subscriptions (P-002, ENSURE mode —
 *      her runtime tuning is preserved),
 *   3. set the global wake-mode default to `auto` (the Pause primitive's
 *      inverse, D-005),
 *   4. wake the Mug NOW (floor/coalesced via the urgent-wake path).
 * The watchdog needs no explicit arm — its every seam gates on the started bit.
 *
 * OQ-4 (resolved as recommended): Start is BRAIN-ONLY — it does not resume
 * per-harness feature loops (autoloop routines); steering dispatch is the
 * Mug's judgment once awake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { anyPotPlacementStarted, setPotStarted, setPotPlacementStarted } from '../../pot/started';
import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';
import { armDefaultPotWakeSubscriptions } from '../../pot/wake-defaults';
import { setDefaultWakeMode } from '../coordination/wake-mode';
import { requestUrgentPotWake } from '../../pot/urgent-wake';
import { isWorkspaceCoordinationOn } from '../../workspace-brain-scope';
import { softText, clampText, LIMITS } from '../limits';
import { trackDetached } from '../../detached-imports';

export default defineTool({
  name: 'pot:start',
  profile: 'engineer',
  description:
    'START the pot (the global control, distinct from a per-plan Start): persist hive_started=true, re-affirm the Mug\'s default event-wake subscriptions (plan-started / work-item-created / escalation), set the global wake-mode to auto, and wake the Mug now (floor-debounced). The liveness watchdog holds "a wake is always armed" from here until pot:pause.',
  guidance: {
    when: "The user clicks Start Pot / asks to boot the fleet, or you are bringing a paused pot back to autonomous operation.",
    notWhen:
      'To wake the Mug once without changing the started state — pot:wake. To start one plan — plans:start. To create a pot — pot:create.',
    chaining: 'pot:status to verify (started, subscriptions, next wake); pot:pause to suspend.',
    seeAlso: [
      'pot:status (verify started + next wake)',
      'pot:pause (suspend autonomous operation)',
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
    kickoff: softText(LIMITS.ANNOTATION).optional().describe('Kickoff context for the immediate wake. Auto-truncated to 2000 chars if longer.'),
  }),
  async handler(args, ctx) {
    // RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-010 / D-017).
    // FIRST statement in the handler: this tool's whole body is the restart —
    // setPotStarted(true) + arm subscriptions + wake-mode auto + an urgent wake.
    // The engine gate (P-007/D-016) makes getPotStarted RESOLVE false, but this
    // tool would still write the row and fire the wake, so the engine gate alone
    // does not cover it.
    const retired = await refuseIfMugKettleRetired(
      'start the Mug',
      'Drive the app with an su session (GOAL mode) instead.',
    );
    if (retired) return retired;
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

    // WI-3681: workspace coordination intentionally collapses the Mug's
    // wake routine to one workspace-papercup row. A second started install
    // would overwrite that row's launchInstallSlug and silently redirect the
    // real workspace's wake to the bogus install. Reject the conflicting
    // start before any state or wake writes; callers can pause the existing
    // install first, or keep workspace coordination scoped to one install.
    if (await isWorkspaceCoordinationOn() && (await anyPotPlacementStarted(workspaceId, installSlug))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'workspace_install_conflict',
              message:
                'Workspace coordination already has another started install; pause it before starting this install.',
              workspace: workspaceId,
              harness: installSlug,
            }),
          },
        ],
      };
    }

    // Per-pot start-stop (2026-06-30): mark THIS pot's placement bit so its work
    // is placed, AND arm the workspace Mug LOOP (the papercup) so she's running.
    await setPotPlacementStarted(workspaceId, installSlug, true);
    await setPotStarted(workspaceId, installSlug, true);
    // ENSURE (not replace): the Mug's runtime-tuned subscriptions survive a
    // Pause→Start cycle; only uncovered defaults are added (P-002 / D-001).
    const subs = await armDefaultPotWakeSubscriptions(workspaceId, { mode: 'ensure', installSlug });
    await setDefaultWakeMode('auto');
    const wake = await requestUrgentPotWake({
      reason: clampText(args.kickoff, LIMITS.ANNOTATION) ?? 'Start Pot — the user started the pot; survey and get the fleet moving',
      harness: installSlug,
      workspaceId,
    });
    // Live UI reflection (P-006): the AdvShell harness-bar control
    // (AdvNowRunning) reads pot.controlState.
    void trackDetached(import('../../sync-sse'))
      .then(({ notifySyncInvalidate }) => notifySyncInvalidate('pot.controlState', {}))
      .catch(() => {});

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            harness: installSlug,
            started: true,
            wakeMode: 'auto',
            subscriptions: { liveRules: subs.rules, defaultsAdded: subs.added },
            wake,
          }),
        },
      ],
    };
  },
});
