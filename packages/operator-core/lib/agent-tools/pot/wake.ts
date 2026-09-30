/**
 * pot:wake — fire the Pot operator NOW (autoloop-hive-operator-rebuild-2026-06-05
 * P0, D-002). The manual/user override and the event-wake target: event-reaction
 * rules registered by pot:declare-wake fire THIS tool, so the floor debounce
 * lives here — a burst of subscribed events collapses to one wake, and a wake
 * within the floor of the previous one is skipped (`force` overrides).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { harnessRequiredResult } from '../_harness-scope';
import { activeWorkspaceId } from '../../workspace-registry';
import { fireLaunchBlueprint } from '../../blueprint/launch-blueprint';
import {
  POT_BLUEPRINT_ID,
  claimPotWakeFire,
  effectivePotWakeFloorSec,
  resolvePotHomeSlug,
} from '../../pot/wake';
import { getPotStarted } from '../../pot/started';
import { refuseIfMugKettleRetired } from '../_mug-kettle-gate';
import { getOrgPg } from '@papercusp/db-org';
import { softText, clampText, LIMITS } from '../limits';
import { getOwnerSteering, isPausedNow } from '../../owner-steering';

/**
 * Placement-DEMAND trigger tools (EI-18654946296495054) — the subset of the
 * always-armed default demand subscriptions (wake-defaults.ts) whose entire
 * purpose is "wake the Mug so she can place new work". When the pot is
 * STARTED but owner steering has `pauseNewWork` (or an un-expired
 * `pausedUntil`), `pot/survey.ts`'s frontier is hard-emptied by design — so an
 * event wake from one of these triggers is GUARANTEED to produce zero
 * placements. `coord:escalate` is deliberately excluded: it wakes the Mug for
 * human-attention, not placement, and must keep firing even while paused.
 */
const PLACEMENT_DEMAND_WAKE_TRIGGERS = new Set(['work_items:create', 'plans:start']);

async function hasRecentOpenMugWake(workspaceId: string, installSlug: string, maxAgeMs = 10 * 60_000): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM harness_shared.adv_sessions
         WHERE workspace_id = ${workspaceId}
           AND label LIKE ${'pot · ' + installSlug + '/%'}
           AND ended_at IS NULL
           AND started_at > now() - (${Math.max(1, Math.floor(maxAgeMs))}::text || ' milliseconds')::interval
      ) AS "exists"
    `;
    return rows[0]?.exists === true;
  } catch {
    return false;
  }
}

export default defineTool({
  name: 'pot:wake',
  profile: 'engineer',
  description:
    'Fire the Pot operator immediately (launches the pot blueprint via the invoke route). Floor-debounced: a wake within the floor window of the previous one is skipped unless force:true. The target of event-wake reaction rules and the manual user override.',
  guidance: {
    when: 'The user asks to wake/kick the operator now, or an event-wake rule fires (it targets this tool automatically).',
    notWhen: 'To schedule a future wake — that is pot:declare-wake.',
    chaining: 'pot:status to see the last/next wake; pot:declare-wake to schedule.',
    seeAlso: [
      'pot:status (see the last / next wake)',
      'pot:declare-wake (schedule a recurring wake instead of firing now)',
    ],
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    reason: softText(LIMITS.ANNOTATION).optional().describe('Why this wake fired — becomes the kickoff context. Auto-truncated to 2000 chars if longer.'),
    source: z.enum(['user', 'event', 'manual']).optional().describe("Provenance label (event-wake rules pass 'event')."),
    trigger: z.string().max(200).optional().describe("The matched event-reaction trigger tool (e.g. 'work_items:create') when source:'event' — used to gate placement-demand wakes on owner steering (EI-18654946296495054). Omitted ⇒ no steering gate is applied (back-compat for a caller that doesn't know its trigger)."),
    harness: z.string().max(120).optional().describe('Home harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    force: z.boolean().optional().describe('Bypass the wake-floor debounce.'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return harnessRequiredResult('pot:wake', ctx);
    }

    // RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-010 / D-017).
    // Deliberately ABOVE the pause check below, and deliberately NOT limited to
    // `source === 'event'`: that carve-out lets an explicit user/manual wake
    // through because "pot:start is the full resume". Under RETIREMENT there is
    // no resume — a manual wake is exactly the hand-restart P-010 exists to
    // stop — so this gate covers EVERY source.
    const retired = await refuseIfMugKettleRetired(
      'wake the Mug',
      'Drive the app with an su session (GOAL mode) instead.',
    );
    if (retired) return retired;

    // WI-2012 (owner directive 2026-07-03): event-wake subscriptions PERSIST across
    // pot:pause, so a reaction rule can fire long after the owner stopped the pot —
    // an autonomous wake on a not-started mug loop is exactly the churn the pause
    // exists to stop. Skip event-sourced wakes while paused; explicit user/manual
    // wakes still fire (deliberate human intent — pot:start is the full resume).
    if (args.source === 'event' && !(await getPotStarted(workspaceId, installSlug))) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, fired: false, skipped: 'pot-paused' }),
          },
        ],
      };
    }

    // EI-18654946296495054 — the started bit is not the only pause concept.
    // A pot can be STARTED yet owner-steering-paused (`pauseNewWork` /
    // un-expired `pausedUntil`), in which case survey.ts hard-empties the
    // placement frontier: a placement-demand event wake (work_items:create,
    // plans:start) is then structurally incapable of placing anything. Skip
    // those specifically — with a DISTINCT `skipped` reason so it's never
    // confused with `pot-paused` in telemetry — while every other event wake
    // (pot:set-steering, coord:escalate, anything not in the demand set)
    // keeps firing, same as an explicit user/manual wake. Reads the identical
    // `isPausedNow` predicate the survey pause-enforcement uses, so the two
    // gates cannot drift apart again.
    if (
      args.source === 'event' &&
      args.trigger &&
      PLACEMENT_DEMAND_WAKE_TRIGGERS.has(args.trigger)
    ) {
      const steering = await getOwnerSteering(workspaceId, installSlug).catch(() => null);
      if (steering && isPausedNow(steering, Date.now())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, fired: false, skipped: 'steering-paused' }),
            },
          ],
        };
      }
    }

    // Owner cadence-floor (mug-steering-panel P-006): the event-burst debounce
    // honours the owner's raised wake-cadence floor (MAX of system + owner knob).
    const floorSec = await effectivePotWakeFloorSec(workspaceId, installSlug);
    if (await hasRecentOpenMugWake(workspaceId, installSlug)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, fired: false, skipped: 'wake-inflight' }),
          },
        ],
      };
    }

    const admission = await claimPotWakeFire(workspaceId, { floorSec, force: args.force });
    if (!admission.fired) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: true, ...admission }),
          },
        ],
      };
    }

    const kickoff = `Wake (${args.source ?? 'manual'}): ${clampText(args.reason, LIMITS.ANNOTATION) ?? 'no reason given'}. You are the operator in charge; survey the fleet and figure out what to do.`;
    const target = await fireLaunchBlueprint(POT_BLUEPRINT_ID, { installSlug, workspaceId, kickoff });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, fired: true, role: target.role, harness: installSlug }),
        },
      ],
    };
  },
});
