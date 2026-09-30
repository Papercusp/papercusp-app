/**
 * fleet:join — label the caller a MEMBER (or, with as:'leader', the LEADER) of an existing
 * fleet (named-su-agent-fleets-2026-06-29 P-004 / D-002 / EI-5704).
 *
 * Requires the fleet registry row to exist. The default `as:'member'` sets the caller's
 * coord_presence to (fleet_slug=fleet, fleet_role='member') — UNLESS the caller is already
 * this fleet's recorded leader, in which case re-joining must NOT demote them (D-002: ONE
 * leader). `as:'leader'` takes over the fleet via the SAME shared path as
 * fleet:take-leadership (installs the caller as leader, demotes + notifies the prior leader)
 * — so "join as leader" is one call instead of join-then-take-leadership.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { fleetRoleFor, json, recolorCallerTerminal, resolveFleetCaller, ROUTING_LADDER } from './_shared';
import { takeFleetLeadership } from './take-leadership-core';
import { suggestedWatchesForContext } from '../../interest-profiles';
import { getModeSubject } from '../../modes/store';
import { resolveGoalFleetLeadership } from './goal-fleet-leadership';

export default defineTool({
  name: 'fleet:join',
  description:
    'Join an existing fleet (pick one from fleet:list) — labels your presence with the fleet so you show up in its roster and count toward its availability. `as:\'member\'` (default) joins as a worker; `as:\'leader\'` TAKES OVER as the fleet\'s leader (same effect as fleet:take-leadership — installs you as leader and demotes + notifies the prior leader). If you are already the fleet\'s leader, a member-join does not demote you.',
  guidance: {
    when: 'Becoming a member of an existing fleet (as:\'member\'), or taking it over as leader in one call (as:\'leader\').',
    notWhen: 'Creating a brand-new fleet → fleet:create.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:join',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug to join (from fleet:list).'),
    as: z
      .enum(['member', 'leader'])
      .default('member')
      .describe(
        "Membership role to join as. 'member' (default) = a worker in the fleet. 'leader' = take over as the fleet's leader (owns monitoring + coordination + driving the plan); installs you as leader and demotes + notifies the prior leader. Equivalent to fleet:take-leadership in one call.",
      ),
    compactionLimit: z
      .number()
      .int()
      .min(20_000)
      .max(900_000)
      .optional()
      .describe(
        "P-009 (only with as:'leader'): explicit soft compaction limit (tokens) for you as the new leader, clamped to the leader ceiling. OMIT to auto-lift a stuck 300k member-cap seed to the leader default (400k on [1m]).",
      ),
    contextSize: z
      .literal('trimmed')
      .optional()
      .describe(
        "P-009 (only with as:'leader'): pass 'trimmed' to signal you are shaping this leader session yourself — SUPPRESSES the auto-lift of the compaction cap.",
      ),
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId } = resolveFleetCaller(ctx);
    let goalHolderSubject: string | null;
    try {
      goalHolderSubject = await getModeSubject(workspaceId, ownerId, 'goal');
    } catch (error) {
      return json({ ok: false, error: 'goal_holder_role_unreadable', detail: String(error) }, true);
    }
    if (goalHolderSubject) {
      const leadership = resolveGoalFleetLeadership({ goalHolderSubject, requested: 'caller', callerOwnerId: ownerId });
      return json({
        ok: false,
        error: args.as === 'leader' ? 'goal_plan_fleet_self_leadership' : 'goal_execution_fleet_membership_forbidden',
        detail: args.as === 'leader'
          ? (leadership.ok ? 'GOAL holder cannot lead an execution fleet.' : leadership.message)
          : `GOAL holder ${ownerId} is a portfolio steward and cannot join execution fleet ${args.fleet} as a member.`,
        recovery: "Use fleet:launch-on-plan with leader:'spawn' and couple to the delegated leader.",
      }, true);
    }
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        {
          ok: false,
          error: `no fleet '${args.fleet}' in this workspace — create it with fleet:create or pick one from fleet:list`,
        },
        true,
      );
    }

    // as:'leader' — take over via the SHARED leadership-transfer path (EI-5704), then
    // recolor the caller's window like a normal join.
    if (args.as === 'leader') {
      const out = await takeFleetLeadership(workspaceId, fleet, identity, ownerId, {
        compactionLimit: args.compactionLimit,
        contextSize: args.contextSize,
      });
      await recolorCallerTerminal(ownerId, fleet);
      const reseedNote =
        out.reseed?.reason === 'member-cap-lifted'
          ? `Compaction cap lifted ${out.reseed.from} → ${out.reseed.applied} tokens (leaders get the full window).`
          : undefined;
      const suggestedWatches = suggestedWatchesForContext({
        context: 'fleet-leader',
        subjects: { 'fleet.slug': args.fleet },
        reason: `Suggested after joining fleet ${args.fleet} as leader`,
      });
      return json({
        ok: true,
        role: 'leader',
        scheme: fleet.colorScheme,
        ...out,
        suggestedWatches,
        ...(reseedNote ? { reseedNote } : {}),
      });
    }

    // as:'member' (default). Don't demote a leader who re-joins their own fleet (D-002).
    const role = fleetRoleFor(fleet.leaderOwnerId, ownerId);
    await heartbeatPresence(identity); // guarantee a presence row to label
    await setPresenceFleet(workspaceId, ownerId, args.fleet, role);
    // Recolor the caller's live window to the fleet's bound scheme — no second
    // call (fleet-color-schemes). Best-effort: a no-op for non-psu-hosted callers.
    await recolorCallerTerminal(ownerId, fleet);
    const suggestedWatches = suggestedWatchesForContext({
      context: role === 'leader' ? 'fleet-leader' : 'fleet-member',
      subjects: { 'fleet.slug': args.fleet },
      reason: `Suggested after joining fleet ${args.fleet} as ${role}`,
    });
    return json({ ok: true, slug: args.fleet, role, scheme: fleet.colorScheme, suggestedWatches });
  },
});
