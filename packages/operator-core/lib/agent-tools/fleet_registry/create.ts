/**
 * fleet:create — create (or get) a named, DURABLE fleet and make the caller its
 * leader (named-su-agent-fleets-2026-06-29 P-004 / D-002 / D-003).
 *
 * Writes the agent_fleets registry row (idempotent — an existing slug is returned
 * unchanged) with the caller as both owner AND leader, then AUTHORITATIVELY labels the
 * caller's own coord_presence as this fleet's `leader` (the per-agent soft membership
 * label, mig 407). The registry row survives all-members-killed (D-003), so the fleet
 * stays selectable in psu forever. ONE leader per fleet (D-002): if the slug already
 * existed with a DIFFERENT leader, "create" does not seize it — the caller is labeled a
 * `member` and is pointed at fleet:take-leadership.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { createFleetIfAbsent, fleetSlugFromName } from '../../agent-fleets-store';
import { heartbeatPresence, setPresenceFleet } from '../coordination/presence';
import { fleetRoleFor, json, recolorCallerTerminal, resolveFleetCaller, ROUTING_LADDER } from './_shared';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import { buildCapacityReport, buildFleetSizingAdvisory } from '../../fleet/capacity-dispatch';
import { ensureFleetLeaderControl } from './leader-control';
import { getModeSubject } from '../../modes/store';
import { resolveGoalFleetLeadership } from './goal-fleet-leadership';

export default defineTool({
  name: 'fleet:create',
  description:
    "Create a NEW named, persistent fleet (or get an existing one by name) and become its leader. The fleet is a durable registry row that survives all members being killed, so it stays selectable in psu. You are recorded as owner + leader and your presence is labeled this fleet's leader. Use this to stand up a fresh fleet before launching member terminals (capability:terminal). Pass `count` when you want a non-blocking sizing advisory for a planned multi-member launch.",
  guidance: {
    when: 'Standing up a NEW named fleet — e.g. routing option (3), a new desktop fleet: fleet:create then capability:terminal { terminals: [...] } to launch the member windows.',
    notWhen:
      'Joining a fleet that already has members → fleet:join. Taking over an existing fleet to drive a plan → fleet:take-leadership (create does NOT seize an existing fleet from its leader).',
    chaining:
      ROUTING_LADDER +
      ' Donate/spend/debug prose set (D-004): the fleet must EXIST before it can receive seats — ' +
      "'launch on remote seats' with no fleet yet → fleet:create first, then resource:delegate (donate " +
      'seats to it) or fleet:request_remote_spawn (spend a seat-offer already made to it).',
  },
  capability: 'fleet:create',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    name: z.string().min(1).describe('Human name for the fleet (kept as the title; slugified to the durable handle).'),
    description: z.string().optional().describe('Optional one-line description of what this fleet is for.'),
    count: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Optional planned member count for the FOLLOW-ON governed desktop launch. `fleet:create` itself does not open terminals; this only returns a non-blocking sizing advisory when the requested member count exceeds healthy account-pool headroom.',
      ),
    type: z
      .enum(['single', 'paired'])
      .optional()
      .describe(
        "Fleet TYPE (D-008). 'single' (default) is today's fleet, unchanged — N independent members. 'paired' is a directed-pair fleet: N director↔implementer pairs, where the director judges and completes while the implementer edits and cannot self-direct. The type is stored on the durable registry row, so members read it at orient; it also selects which LAUNCH OPTION SHAPE fleet:launch-on-plan accepts (flat for single, per-role groups for paired).",
      ),
  }),
  async handler(args, ctx) {
    const { identity, ownerId, workspaceId } = resolveFleetCaller(ctx);
    const fleetSlug = fleetSlugFromName(args.name);
    let goalHolderSubject: string | null;
    try {
      goalHolderSubject = await getModeSubject(workspaceId, ownerId, 'goal');
    } catch (error) {
      return json({ ok: false, error: 'goal_holder_role_unreadable', detail: String(error) }, true);
    }
    const leadership = resolveGoalFleetLeadership({ goalHolderSubject, requested: 'caller', callerOwnerId: ownerId });
    if (!leadership.ok) {
      return json({ ok: false, error: 'goal_plan_fleet_self_leadership', detail: leadership.message,
        recovery: "Use fleet:launch-on-plan with leader:'spawn' so a separate agent leads." }, true);
    }

    const { record, created } = await createFleetIfAbsent({
      workspaceId,
      fleetSlug,
      title: args.name,
      description: args.description ?? null,
      owner: ownerId,
      leaderOwnerId: ownerId,
      fleetType: args.type,
    });

    // createFleetIfAbsent is idempotent, so a `type` handed to an ALREADY-EXISTING
    // fleet does not apply. Say so out loud rather than returning a record whose
    // type silently contradicts what the caller asked for — the launch surface
    // branches on this value (D-009), so a wrong belief about it is expensive.
    const typeRequestIgnored = !created && args.type != null && args.type !== record.fleetType;

    // Mirror the AUTHORITATIVE registry leader onto the caller's presence label. On a
    // fresh create that's `leader` (record.leaderOwnerId === caller). If the slug already
    // existed under a different leader, the registry is unchanged (idempotent) so the
    // caller is only a `member` — ONE leader per fleet (D-002).
    const role = fleetRoleFor(record.leaderOwnerId, ownerId);
    await heartbeatPresence(identity); // guarantee a presence row to label
    await setPresenceFleet(workspaceId, ownerId, fleetSlug, role);
    const control = role === 'leader' ? await ensureFleetLeaderControl({ workspaceId, ownerId, fleetSlug }) : null;
    // Recolor the caller's live window to the new fleet's bound scheme — no second
    // call (fleet-color-schemes). Best-effort: a no-op for non-psu-hosted callers.
    await recolorCallerTerminal(ownerId, record);

    let sizingAdvisory: ReturnType<typeof buildFleetSizingAdvisory> = null;
    if (args.count != null) {
      try {
        const capacity = buildCapacityReport(await fetchGatewayHeadroom({ timeoutMs: 1200 }), { clampArmed: false });
        sizingAdvisory = buildFleetSizingAdvisory(args.count, capacity);
      } catch {
        sizingAdvisory = null;
      }
    }

    return json({
      ok: true,
      slug: fleetSlug,
      created,
      title: record.title,
      leader: record.leaderOwnerId,
      role,
      control,
      scheme: record.colorScheme,
      type: record.fleetType,
      requested: args.count ?? null,
      sizingAdvisory,
      ...(sizingAdvisory ? { message: sizingAdvisory.message } : {}),
      ...(typeRequestIgnored
        ? {
            typeRequestIgnored: {
              requested: args.type,
              actual: record.fleetType,
              why: 'fleet:create is idempotent — the fleet already existed, so its stored type was left unchanged. Re-type it deliberately (fleet:reconfigure / updateFleetMeta) or launch under a new fleet name.',
            },
          }
        : {}),
      ...(role === 'member'
        ? { note: 'fleet already existed under another leader — call fleet:take-leadership to drive it' }
        : {}),
    });
  },
});
