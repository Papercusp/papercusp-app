/**
 * fleet_registry shared helpers (named-su-agent-fleets-2026-06-29 P-004).
 *
 * The six `fleet:*` registry tools all (a) resolve the CALLER's coord owner-id +
 * the workspace to scope the agent_fleets registry / coord_presence to, and (b)
 * return a small JSON envelope. This module factors out both, plus the two PURE
 * membership-role decisions D-002 turns on (leader-vs-member, and whether a handoff
 * demotes a prior leader) so they unit-test without PG.
 */
import { resolveAgentIdentity, type AgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveFleetScheme, type AgentFleetRecord } from '../../agent-fleets-store';
import { oscRecolorSequence, oscResetSequence } from '../../console-color-schemes';
import { recolorViaPty } from '../../events/await/psu-pty-discovery';

export interface FleetCaller {
  /** The full coordination identity (needed to seed a presence row via heartbeatPresence). */
  identity: AgentIdentity;
  /** The caller's stable coord owner-id — the presence-row + leader key. */
  ownerId: string;
  /** The workspace the fleet registry + presence are scoped to. */
  workspaceId: string;
}

/**
 * Resolve the caller exactly like the coordination layer does: `resolveAgentIdentity`
 * (the SAME primitive coord:declare-intent / coord:whoami use — never a new scheme) for
 * the owner-id, and the capability:terminal workspace pattern (the ctx workspace, else
 * the process-active one) for the scope. A real su/bee agent always carries a workspace
 * on ctx, so the resolved workspace matches the one its presence row was written under.
 */
export function resolveFleetCaller(ctx: ResolveIdentityCtx): FleetCaller {
  const identity = resolveAgentIdentity(ctx);
  const workspaceId =
    ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
  return { identity, ownerId: identity.ownerId, workspaceId };
}

/** PURE: the caller's membership role in a fleet — ONE leader per fleet (D-002), so the
 *  caller is `leader` iff they are the registry's recorded leader, else `member`. */
export function fleetRoleFor(
  leaderOwnerId: string | null,
  callerOwnerId: string,
): 'leader' | 'member' {
  return leaderOwnerId === callerOwnerId ? 'leader' : 'member';
}

/** PURE: should a take-leadership handoff demote the PRIOR leader's presence to `member`?
 *  ONE leader per fleet (D-002): a distinct prior leader is recorded as a `member` after
 *  losing leadership — when they are STILL (presence-)labeled in this fleet, OR carry no
 *  fleet label at all (a leader-of-record who never presence-joined, or an ended session).
 *  setPresenceFleet is UPDATE-only, so the no-label case safely updates an existing row and
 *  no-ops a truly-gone one. The ONLY skip is a prior leader who has since MOVED to a
 *  DIFFERENT fleet — never yank them out of the fleet they are now in. (owner spec
 *  2026-06-30 / EI-5705: the prior leader becomes a member even when they had no member row.) */
export function shouldDemotePriorLeader(
  previousLeader: string | null,
  callerOwnerId: string,
  priorPresenceFleetSlug: string | null,
  targetFleetSlug: string,
): boolean {
  return (
    !!previousLeader &&
    previousLeader !== callerOwnerId &&
    (priorPresenceFleetSlug === targetFleetSlug || priorPresenceFleetSlug === null)
  );
}

/** Small JSON envelope helper — the registry tools all return `{ ok, ... }`. */
export function json(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  };
}

/**
 * The routing-ladder pointer every registry tool's `guidance` carries (P-007). "Send a
 * plan to a fleet" is NOT a separate engine — it is `fleet:take-leadership` (the handoff
 * agent becomes the leader, D-002); the other rungs reuse existing tools.
 */
/**
 * ⚠ BUDGETED TEXT. This constant is inlined into EVERY registry tool's
 * `guidance.chaining`, so a character added here is a character added to ~8 tools
 * at once and the P-011 prompt-weight ratchet (1500-char budget / 1600 hard cap,
 * `tools-md-sync.test.ts`) reds on the growth. Measured 2026-08-31: a +155-char
 * rewrite put fleet:create over the HARD CAP and three siblings over budget.
 * Keep any edit length-neutral or shorter, and re-run
 * `testing:run packages/operator-core/lib/__tests__/tools-md-sync.test.ts`.
 */
export const ROUTING_LADDER =
  'Routing ladder: (0) SELF — drive it via plans:launch / plans:set-status. ' +
  '(1) BACKLOG — work_items:create → the pot intake. (2) FLEET — hand the plan to ' +
  'an existing named fleet: fleet:take-leadership (you BECOME its leader, D-002) then ' +
  'drive it. (3) NEW DESKTOP FLEET — fleet:launch-on-plan { name, plan, count }, ' +
  'NOT capability:terminal (it refuses agent launches).';

/**
 * Best-effort: recolor the CALLER's live terminal to a fleet's bound scheme right
 * after a join/create, so the window reflects the fleet WITHOUT a second call
 * (fleet-color-schemes). Only a psu-pty-hosted session has a reachable window —
 * recolorViaPty returns false for headless / no-pty / non-psu callers, and the
 * bound scheme then applies the next time the fleet opens a window. Never throws,
 * so a recolor miss can never fail the join/create itself.
 */
export async function recolorCallerTerminal(
  ownerId: string,
  fleet: AgentFleetRecord,
): Promise<void> {
  try {
    await recolorViaPty(ownerId, oscRecolorSequence(resolveFleetScheme(fleet)));
  } catch {
    /* best-effort — a recolor must never break fleet membership */
  }
}

/**
 * Best-effort: reset the CALLER's live terminal to its profile default after
 * LEAVING a fleet — the inverse of {@link recolorCallerTerminal}, so the window
 * drops the ex-fleet color (back to e.g. the user's purple) rather than keeping a
 * stale one. No-op for non-psu-hosted callers; never throws.
 */
export async function resetCallerTerminal(ownerId: string): Promise<void> {
  try {
    await recolorViaPty(ownerId, oscResetSequence());
  } catch {
    /* best-effort — a reset must never break leaving a fleet */
  }
}
