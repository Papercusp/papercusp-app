/**
 * cue-authority-resolve.ts — resolve the SENDER's cue-authority stamp from live
 * presence + fleet membership (queen-fleet-authority-boundary-2026-07-02 P-003).
 *
 * The IO half of ./cue-authority (kept separate so the pure render/read helpers stay
 * import-free for coord-schema). Reads the sender's `agentRole` + `potSlug` from
 * coord_presence and its fleet slug/role from the fleet-membership join, classifies
 * the pane-kind via the shared taxonomy, and maps to the stamp via the pure
 * resolveCueAuthority. Best-effort: any read hiccup degrades to null (an unstamped
 * cue), never throws — a presence outage must never block a drain/pause cue.
 */
import { classifyAgentPane } from '@papercusp/agent-mcp';
import type { AgentIdentity } from './identity';
import { getPresence } from './presence';
import { fetchPresenceFleet } from './presence-fleet';
import { resolveCueAuthority, type CueAuthorityStamp } from './cue-authority';

/** Resolve the stamp for `identity` (the message SENDER), or null when it holds no
 *  recognized control authority (an ordinary bee / owner-directed session) or the
 *  reads fail. */
export async function resolveSenderCueAuthority(
  identity: AgentIdentity,
): Promise<CueAuthorityStamp | null> {
  try {
    const ownerId = identity.ownerId;
    const [pres, fleetMap] = await Promise.all([
      getPresence(ownerId).catch(() => null),
      fetchPresenceFleet([ownerId]).catch(() => new Map()),
    ]);
    const kind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId }).kind;
    const fleet = fleetMap.get(ownerId);
    return resolveCueAuthority({
      kind,
      potSlug: pres?.potSlug ?? null,
      fleetSlug: fleet?.fleetSlug ?? null,
      fleetRole: fleet?.fleetRole ?? null,
    });
  } catch {
    return null;
  }
}
