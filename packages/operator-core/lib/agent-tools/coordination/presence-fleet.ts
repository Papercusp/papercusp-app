/**
 * presence-fleet.ts — the per-agent named-fleet membership read
 * (named-su-agent-fleets-2026-06-29 P-005).
 *
 * fleet_slug / fleet_role are a SOFT membership label on harness_shared.coord_presence
 * (migration 407, the per-agent mirror of hive_slug). hive_slug rides the PresenceRecord
 * the @papercusp/coordination store reads; fleet_slug does NOT (the store's SELECT is
 * unchanged), so the coordination tools join it in HERE — the same per-owner enrichment
 * shape as `fetchPresenceTier1`: ONE batch query keyed by the roster's ownerIds, so
 * enriching N agents is a constant read, not N. Only rows that actually carry a
 * fleet_slug come back; a non-fleet agent is simply absent from the map (its surfaces
 * default to null/omitted).
 */
import { getOrgPg } from '@papercusp/db-org';
import type { FleetMembership } from './identity';

export type { FleetMembership };

/**
 * IO seam: batch-read the fleet membership label for a set of ownerIds from
 * coord_presence. ownerIds should be the LOCAL roster (federated `fed:…` ids never
 * match a local coord_presence row, so passing them just wastes a comparison).
 * Returns one entry per owner that carries a fleet_slug.
 */
export async function fetchPresenceFleet(
  ownerIds: string[],
): Promise<Map<string, FleetMembership>> {
  const out = new Map<string, FleetMembership>();
  if (ownerIds.length === 0) return out;
  const { sql } = getOrgPg();
  const rows = await sql<{ owner_id: string; fleet_slug: string | null; fleet_role: string | null }[]>`
    SELECT owner_id, fleet_slug, fleet_role
      FROM harness_shared.coord_presence
     WHERE owner_id = ANY(${ownerIds}::text[])
       AND fleet_slug IS NOT NULL
  `;
  for (const r of rows) {
    out.set(r.owner_id, { fleetSlug: r.fleet_slug, fleetRole: r.fleet_role });
  }
  return out;
}

/** The two fleet-CONTROL fields a presence row carries beside its membership label. */
export interface FleetControlVisibility {
  fleetControlState: 'active' | 'winding-down';
  canAcquireWork: boolean;
}

/**
 * EI-22072194984361823 — the pure derivation behind `fleetControlState` /
 * `canAcquireWork` on a presence row. Extracted from presence-snapshot's
 * `withFleet` so the rule a router now filters on is directly testable: the
 * bug being fixed is precisely that this capability consequence was invisible,
 * so it must not be provable only through a fully-mocked snapshot build.
 *
 * Two policies are encoded here, and BOTH are deliberate:
 *
 *  - FAIL-OPEN on an unresolved fleet. A slug absent from `controlStates`
 *    (deleted fleet, or a stale hand-set coord_presence.fleet_slug label that
 *    never had a row) reads 'active'. This mirrors `fleetControlWindDownRefusal`,
 *    which refuses only on a POSITIVE winding-down read — so presence never
 *    advertises a gate the claim path would not actually enforce.
 *  - The gate is MEMBER-ONLY. `resolveFleetScopeContext` returns null unless
 *    `fleetRole === 'member'`, so the refusal can never fire for a leader; a
 *    leader of a winding-down fleet therefore reads canAcquireWork:true,
 *    because nothing actually blocks its claims.
 */
export function deriveFleetControlVisibility(
  membership: Pick<FleetMembership, 'fleetSlug' | 'fleetRole'>,
  controlStates: ReadonlyMap<string, { controlState: 'active' | 'winding-down' }>,
): FleetControlVisibility {
  const fleetControlState = membership.fleetSlug
    ? controlStates.get(membership.fleetSlug)?.controlState ?? 'active'
    : 'active';
  return {
    fleetControlState,
    canAcquireWork: !(membership.fleetRole === 'member' && fleetControlState === 'winding-down'),
  };
}

/** One agent's fleet membership WITH the timing legs a supervision edge needs (P-007). */
export interface FleetSupervisionRow {
  ownerId: string;
  fleetSlug: string;
  /** 'leader' | 'member' as stored; kept as the raw string so an unrecognised role is
   *  simply not matched rather than being coerced into one of the two we know. */
  fleetRole: string | null;
  /** When this agent's session began — the supervision relationship's `since`. */
  startedAt: Date;
  /** Drives the residue cut below; NOT a liveness verdict (see the warning). */
  heartbeatAt: Date;
}

/**
 * Batch-read fleet membership + timing for a set of ownerIds (P-007).
 *
 * WHY NOT `fetchPresenceFleet`: that returns only {fleetSlug, fleetRole}, and a
 * supervision edge additionally needs `started_at` (the obligation's age) and
 * `heartbeat_at` (the residue cut). Widening `FleetMembership` instead would add
 * required fields to a type shared by unrelated callers, stranding them — so this is a
 * sibling read in the module that already owns the query, not a fork of it.
 *
 * ⚠ `heartbeatAt` IS NOT LIVENESS and must never be rendered as such — a warm-dead
 * session heartbeats with `sessionState: 'ended'`. It is used for exactly one thing here:
 * cutting membership RESIDUE, rows whose fleet label outlived the agent. The liveness a
 * reader sees comes from the shared oracle (D-011), never from this column.
 */
export async function fetchFleetSupervisionRows(
  ownerIds: readonly string[],
): Promise<Map<string, FleetSupervisionRow>> {
  const out = new Map<string, FleetSupervisionRow>();
  const ids = [...new Set(ownerIds.map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      owner_id: string;
      fleet_slug: string | null;
      fleet_role: string | null;
      started_at: Date | string;
      heartbeat_at: Date | string;
    }[]
  >`
    SELECT owner_id, fleet_slug, fleet_role, started_at, heartbeat_at
      FROM harness_shared.coord_presence
     WHERE owner_id = ANY(${ids}::text[])
       AND fleet_slug IS NOT NULL
  `;
  for (const r of rows) {
    if (!r.fleet_slug) continue;
    // postgres.js can hand back timestamptz as a string under the org-pool type config;
    // normalize at the read boundary so callers never branch on an invented Date type.
    out.set(r.owner_id, {
      ownerId: r.owner_id,
      fleetSlug: r.fleet_slug,
      fleetRole: r.fleet_role,
      startedAt: r.started_at instanceof Date ? r.started_at : new Date(r.started_at),
      heartbeatAt: r.heartbeat_at instanceof Date ? r.heartbeat_at : new Date(r.heartbeat_at),
    });
  }
  return out;
}

/** One fleet member's presence row, as the respawn/launch verification reads it. */
export interface FleetPresenceRow {
  ownerId: string;
  startedAt: Date;
  heartbeatAt: Date;
  /** Newest completed tool call attributed to this owner after this presence
   * row started. Presence alone is launcher-authored on some desktop paths;
   * this is the proof that the agent actually took a turn (WI-35786).
   *
   * WHY AN MCP-ONLY STORE ANSWERS THIS COMPLETELY (WI-1079034 — read this
   * before "fixing" the source): it is sourced from `tool_invocations`, which
   * records MCP calls only, so it LOOKS blind to a turn spent entirely in a
   * client's native tools (Claude Bash/Read/Grep). It is not. The psu hook
   * layer registers `posttooluse-activity-report.sh` on a PostToolUse matcher
   * of `'*'` (and a PreToolUse sibling), so EVERY native tool call POSTs
   * `activity:report` under the agent's own `coord_owner_id` and writes a row
   * here. One incidental row per turn is all a max() needs.
   *
   * That is why the census/mix conclusion does NOT transfer to this field:
   * `tool_invocations` genuinely cannot COUNT native tool use
   * (EI-21847759967934033), but it does not go STALE on a native turn.
   * Measured 2026-08-30 over a 3h window: of 110 owners with native
   * `agent_activity` rows, 110 also had `tool_invocations` rows, none lagging
   * past 60s (max 0.9s) — and the mean lag was NEGATIVE (~-215s), i.e. this
   * store is fresher than `agent_activity`. Re-sourcing from `agent_activity`
   * would therefore lose both coverage and freshness; EI-21855682261256330
   * proposed exactly that and was dropped as invalid.
   *
   * The coupling is load-bearing: `ensureCcCoordHookEnrollment`
   * (apps/operator/scripts/psu-launcher.mjs) verifies and self-repairs that
   * hook. If it is ever narrowed off `'*'`, what degrades here is visibility
   * of a stretch using NO MCP tools directly — an agent still calling MCP
   * tools goes on looking fresh from its own real calls. */
  lastToolCallAt: Date | null;
}

/**
 * IO seam: the fleet's CURRENT presence roster (every owner labeled into `fleetSlug`),
 * newest-heartbeat first. Backed by the (workspace_id, fleet_slug) partial index.
 *
 * This is the "did a launch actually produce an agent?" oracle: a launcher can only
 * report that it spawned a terminal, and that terminal's wrapper survives the CLI dying
 * instantly — so a launch is verified by a NEW owner appearing here with a live
 * heartbeat, never by the launcher's own return value.
 */
export async function listFleetPresence(
  workspaceId: string,
  fleetSlug: string,
): Promise<FleetPresenceRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{
    owner_id: string;
    started_at: Date | string;
    heartbeat_at: Date | string;
    last_tool_call_at: Date | string | null;
  }[]>`
    SELECT p.owner_id,
           p.started_at,
           p.heartbeat_at,
           (
             SELECT max(ti.invoked_at)
               FROM harness_shared.tool_invocations ti
              WHERE ti.workspace_id = p.workspace_id
                AND ti.coord_owner_id = p.owner_id
                AND ti.invoked_at >= p.started_at
           ) AS last_tool_call_at
      FROM harness_shared.coord_presence p
     WHERE p.workspace_id = ${workspaceId}
       AND p.fleet_slug = ${fleetSlug}
     ORDER BY p.heartbeat_at DESC
  `;
  return rows.map((r) => ({
    ownerId: r.owner_id,
    // postgres.js can return timestamptz as a string under the org-pool type
    // configuration. Normalize at the read boundary so liveness callers never
    // branch on an invented Date type and then crash on `.getTime()` (WI-35786).
    startedAt: r.started_at instanceof Date ? r.started_at : new Date(r.started_at),
    heartbeatAt: r.heartbeat_at instanceof Date ? r.heartbeat_at : new Date(r.heartbeat_at),
    lastToolCallAt:
      r.last_tool_call_at == null
        ? null
        : r.last_tool_call_at instanceof Date
          ? r.last_tool_call_at
          : new Date(r.last_tool_call_at),
  }));
}

/**
 * Resolve one caller's CURRENT fleet membership from coord presence, with the
 * launch environment used only when the authoritative read itself fails.
 *
 * A successful read that returns no row is meaningful: the caller has left its
 * fleet (or was demoted out of it). Falling back to PAPERCUSP_FLEET_* in that
 * case resurrects stale launch-time membership and is the root cause of
 * monitor-orient returning only the caller while fleet:leader-brief, when
 * explicitly scoped, returns the real roster. Dynamic fleet:join /
 * fleet:take-leadership mutations cannot rewrite an already-running process's
 * environment, so every live read surface must prefer coord_presence.
 */
export async function resolvePresenceFleet(
  ownerId: string | undefined,
  launchFallback: FleetMembership,
  fetcher: (ownerIds: string[]) => Promise<Map<string, FleetMembership>> = fetchPresenceFleet,
): Promise<FleetMembership> {
  if (!ownerId) return launchFallback;
  try {
    const memberships = await fetcher([ownerId]);
    return memberships.get(ownerId) ?? { fleetSlug: null, fleetRole: null };
  } catch {
    return launchFallback;
  }
}
