/**
 * member-target — the shared "resolve + authorize a fleet member I lead" step
 * (per-member-declarative-launch-specs P-007/P-008). Both fleet:reconfigure-member (runtime
 * settings) and fleet:respawn-member (boot-baked settings) start the same way: resolve the caller,
 * pick the fleet (explicit, else the single fleet the caller leads), authorize the caller as that
 * fleet's leader/queen/owner, and resolve a `member` handle to an actual member's ownerId + role.
 * Factored here so the two tools cannot drift apart on any of those decisions.
 */
import { classifyAgentPane } from '@papercusp/agent-mcp';
import { getFleet, listFleetsLedBy, fleetSlugFromName, type AgentFleetRecord } from '../../agent-fleets-store';
import { getPresence } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { classifyFleetControlInvoker } from './fleet-auth';
import { resolveFleetCaller } from './_shared';
import { latestFleetMembership } from '../../fleet-membership-store';
import type { AgentIdentity, ResolveIdentityCtx } from '../coordination/identity';

export interface ResolvedFleetMemberTarget {
  callerId: string;
  workspaceId: string;
  identity: AgentIdentity;
  slug: string;
  fleet: AgentFleetRecord;
  memberOwnerId: string;
  /** The member's fleet role ('member' | 'leader'). */
  memberRole: string;
  invokedAs: 'leader' | 'queen' | 'owner';
}

export type FleetMemberTargetResult =
  | ({ ok: true } & ResolvedFleetMemberTarget)
  | { ok: false; error: string; message: string; fleet?: string };

/**
 * Resolve + authorize a fleet member the caller may reconfigure/respawn. `member` is a coord
 * ownerId or a unique prefix/substring; `fleetArg` is optional (defaults to the single fleet the
 * caller leads). Returns a discriminated result: on `ok:false` the tool returns its message.
 */
export async function resolveFleetMemberTarget(
  ctx: ResolveIdentityCtx,
  member: string,
  fleetArg?: string,
): Promise<FleetMemberTargetResult> {
  const { identity, ownerId: callerId, workspaceId } = resolveFleetCaller(ctx);

  // 1. Resolve the fleet — explicit, else the single fleet the caller leads.
  let slug: string;
  let fleet: AgentFleetRecord | null;
  if (fleetArg) {
    slug = fleetSlugFromName(fleetArg);
    fleet = await getFleet(workspaceId, slug);
    if (!fleet) {
      return { ok: false, error: 'fleet_not_found', message: `No fleet '${slug}' in this workspace — see fleet:list.` };
    }
  } else {
    const led = await listFleetsLedBy(workspaceId, callerId);
    if (led.length === 0) {
      return { ok: false, error: 'no_led_fleet', message: 'You lead no fleet — pass `fleet` explicitly (and you must be its leader/queen/owner).' };
    }
    if (led.length > 1) {
      return { ok: false, error: 'ambiguous_fleet', message: `You lead ${led.length} fleets (${led.map((f) => f.fleetSlug).join(', ')}) — pass \`fleet\`.` };
    }
    fleet = led[0];
    slug = fleet.fleetSlug;
  }

  // 2. Auth — leader of THIS fleet, queen, or owner (su). Pane derives from live presence.
  let paneKind = 'unknown';
  try {
    const pres = await getPresence(callerId).catch(() => null);
    paneKind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId: callerId }).kind;
  } catch {
    paneKind = classifyAgentPane({ role: null, ownerId: callerId }).kind;
  }
  const invokedAs = classifyFleetControlInvoker({ callerOwnerId: callerId, leaderOwnerId: fleet.leaderOwnerId, paneKind });
  if (!invokedAs) {
    return {
      ok: false,
      error: 'not_authorized',
      fleet: slug,
      message:
        `This action on '${slug}' is restricted to its recorded leader (${fleet.leaderOwnerId ?? 'none'}), ` +
        `the queen, or the owner (an su session) — you are ${paneKind} (${callerId}).`,
    };
  }

  // 3. Resolve the target member within the fleet.
  const resolved = await resolveMemberInFleet(member, slug, workspaceId);
  if (!resolved.ok) {
    return { ...resolved, fleet: slug };
  }

  return {
    ok: true,
    callerId,
    workspaceId,
    identity,
    slug,
    fleet,
    memberOwnerId: resolved.ownerId,
    memberRole: resolved.role,
    invokedAs,
  };
}

/** Resolve a `member` handle (a full coord ownerId, or a unique prefix/substring) to the ownerId
 *  + fleet-role of an actual member of `slug`. Membership is checked against the authoritative
 *  presence-fleet label (muted-inclusive); prefix resolution enumerates the deliverable set. */
export async function resolveMemberInFleet(
  member: string,
  slug: string,
  workspaceId?: string,
): Promise<{ ok: true; ownerId: string; role: string } | { ok: false; error: string; message: string }> {
  const trimmed = member.trim();
  const directRole = (await fetchPresenceFleet([trimmed]).catch(() => new Map())).get(trimmed);
  if (directRole?.fleetSlug === slug) {
    return { ok: true, ownerId: trimmed, role: directRole.fleetRole ?? 'member' };
  }

  // A claim-backed member can remain in fleet_assignment after its ephemeral
  // coord_presence row is reaped. Resolve an exact ownerId against the durable
  // latest membership fact before consulting the live delivery audience; the
  // latter intentionally excludes recorded/dead members and is not a
  // membership authority (EI-21590236680691215).
  if (workspaceId) {
    const durable = await latestFleetMembership(workspaceId, trimmed).catch(() => null);
    if (durable?.fleetSlug === slug) {
      return { ok: true, ownerId: trimmed, role: durable.fleetRole ?? 'member' };
    }
  }

  const { hostAudienceResolvers } = await import('../coordination/audience-host');
  const members = (await hostAudienceResolvers.listFleetMembers(slug).catch(() => [])) as string[];
  const matches = members.filter((id) => id === trimmed || id.startsWith(trimmed) || id.includes(trimmed));
  if (matches.length === 1) {
    const role = (await fetchPresenceFleet([matches[0]]).catch(() => new Map())).get(matches[0]);
    return { ok: true, ownerId: matches[0], role: role?.fleetRole ?? 'member' };
  }
  if (matches.length === 0) {
    return { ok: false, error: 'member_not_found', message: `No member matching "${member}" in fleet '${slug}' — fleet:status lists its members.` };
  }
  return {
    ok: false,
    error: 'member_ambiguous',
    message: `"${member}" matches ${matches.length} members of '${slug}' (${matches.join(', ')}) — pass a full ownerId.`,
  };
}
