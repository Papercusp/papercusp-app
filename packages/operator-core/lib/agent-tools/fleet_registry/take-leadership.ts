/**
 * fleet:take-leadership — THE D-002 handoff (named-su-agent-fleets-2026-06-29 P-004 /
 * P-007). "Hand a plan to an existing fleet" = the handoff agent BECOMES the leader.
 *
 * Delegates to the shared takeFleetLeadership effect (take-leadership-core) so this and
 * fleet:join { as:'leader' } behave identically: (1) registry leader := caller, (2) the
 * caller's presence is labeled this fleet's `leader`, (3) the PRIOR leader is demoted to
 * `member`, and (4) the displaced leader is NOTIFIED (with `notified` returned so the new
 * leader does NOT redundantly message them). ONE leader per fleet; the leader is the
 * per-fleet analog of the Queen — owns monitoring + coordination + driving the plan to
 * completion. This is routing option (2): there is NO separate routing engine.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { json, recolorCallerTerminal, resolveFleetCaller, ROUTING_LADDER } from './_shared';
import { takeFleetLeadership } from './take-leadership-core';
import { getModeSubject } from '../../modes/store';
import { resolveGoalFleetLeadership } from './goal-fleet-leadership';

export default defineTool({
  name: 'fleet:take-leadership',
  description:
    'Take over an existing fleet: you become its leader (the per-fleet analog of the Mug — you own monitoring, coordination, and driving the plan to completion). Sets the registry leader to you, labels your presence the fleet\'s leader, demotes the prior leader to a member, and NOTIFIES the displaced leader — the returned { previousLeader, notified } tells you whom you displaced and that they were already told, so you don\'t double-message them. This IS how you "hand a plan to a fleet" — there is no separate routing tool. (Also the FIRST act when the owner designates you a fleet\'s leader: claim it, don\'t just assume it.)',
  guidance: {
    when: 'Routing option (2): handing a plan to an existing named fleet. Taking the leader role makes you its driver (D-002). Also the FIRST act when the owner designates you a fleet\'s leader — claim it (this is identity-establishing, not a confirm-gated write).',
    notWhen:
      'Just becoming a worker in a fleet → fleet:join. Creating a fresh fleet → fleet:create (you are already its leader). Joining-as-leader in one call → fleet:join { as:\'leader\' }.',
    chaining: ROUTING_LADDER,
  },
  capability: 'fleet:take-leadership',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug to take leadership of (from fleet:list).'),
    compactionLimit: z
      .number()
      .int()
      .min(20_000)
      .max(900_000)
      .optional()
      .describe(
        "P-009: explicit soft compaction limit (tokens) for you as the new leader, clamped to the leader ceiling. OMIT to auto-lift a stuck 300k member-cap seed to the leader default (400k on [1m]) — the fix for a member-promoted-to-leader staying at the member cap. A deliberately-tuned limit is left untouched.",
      ),
    contextSize: z
      .literal('trimmed')
      .optional()
      .describe(
        "P-009: pass 'trimmed' to signal you are shaping this leader session yourself — it SUPPRESSES the auto-lift of the compaction cap (leaves your current limit as-is).",
      ),
    clearAutoArmSuppressions: z
      .boolean()
      .optional()
      .describe(
        'Explicitly re-arm fleet-leader transition watches previously canceled through events:cancel. Defaults to false so an operator cancellation remains sticky; the response reports the exact cleared keys/count.',
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
    const leadership = resolveGoalFleetLeadership({ goalHolderSubject, requested: 'caller', callerOwnerId: ownerId });
    if (!leadership.ok) {
      return json({ ok: false, error: 'goal_plan_fleet_self_leadership', detail: leadership.message,
        recovery: "Keep the delegated leader, or use fleet:launch-on-plan with leader:'spawn' for a new fleet." }, true);
    }
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        { ok: false, error: `no fleet '${args.fleet}' in this workspace — see fleet:list` },
        true,
      );
    }
    const out = await takeFleetLeadership(workspaceId, fleet, identity, ownerId, {
      compactionLimit: args.compactionLimit,
      contextSize: args.contextSize,
      clearAutoArmSuppressions: args.clearAutoArmSuppressions,
    });
    // Recolor the caller's live window to the fleet's bound scheme — becoming a
    // leader must look like it (parity with fleet:create / fleet:join, which all
    // recolor after fleet-tagging presence). Best-effort: a no-op for non-psu-hosted
    // callers, and never throws, so a recolor miss can't fail the leadership transfer.
    await recolorCallerTerminal(ownerId, fleet);
    // P-009: surface a lifted compaction cap prominently so the new leader knows their window grew.
    const reseedNote =
      out.reseed?.reason === 'member-cap-lifted'
        ? `Compaction cap lifted ${out.reseed.from} → ${out.reseed.applied} tokens (you were at the 300k member cap; leaders get the full window). Your per-turn \`context: N/limit\` signal reflects it next turn.`
        : out.reseed?.reason === 'explicit-limit'
          ? `Compaction cap set to ${out.reseed.applied} tokens (explicit).`
          : undefined;
    return json({ ok: true, scheme: fleet.colorScheme, ...out, ...(reseedNote ? { reseedNote } : {}) });
  },
});
