/**
 * set-compaction-limit-core — the shared CROSS-SESSION compaction-limit setter
 * (per-member-declarative-launch-specs P-006, owner directive 2026-07-19). A fleet
 * LEADER (or the queen / owner) sets a MEMBER's soft compaction limit DIRECTLY,
 * instead of dispatching "set your own limit" and hoping the member complies on its
 * next wake. Reused by config:set-compaction-limit (with a target `ownerId`) AND by
 * fleet:reconfigure-member (P-007 — D-003 runtime-adjustable settings).
 *
 * Auth reuses control-core's `classifyFleetControlInvoker` (one auth model, not a
 * fork): the caller must be the recorded leader of the fleet the TARGET belongs to,
 * the queen (mug|kettle pane), or the owner (su pane). The limit is accepted only
 * within the TARGET's model-spec + fleet-role ceiling — NEVER the caller's, since
 * the caller and target can differ in both. Over-ceiling requests are rejected
 * before the write, so a successful response cannot describe a value different
 * from the request.
 */
import { classifyAgentPane } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import { setCompactionLimit, getPresence } from '../coordination/presence';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { estimateContextWindowForOwner, resolveModelSpecForOwner } from '../../compaction-usage';
import { clampCompactionLimit, selfSetCeilingForSpec, selfSetCeilingForWindow } from '../../agent-config-constants';
import { classifyFleetControlInvoker } from '../fleet_registry/fleet-auth';
import { resolveFleetCaller } from '../fleet_registry/_shared';
import { ADMIN_COORD_UI_OWNER, type ResolveIdentityCtx } from '../coordination/identity';

export interface CrossSessionLimitResult {
  ok: boolean;
  /** The session whose limit was (attempted to be) set. */
  targetOwnerId: string;
  /** The limit now stored for the target (null when no presence row persisted it). */
  compactionLimit?: number | null;
  /** The ceiling used to validate the request (the TARGET's spec + role). */
  cap?: number;
  /** Legacy diagnostic field retained for compatibility with older callers; runtime writes no longer emit it. */
  clamped?: boolean;
  requested?: number;
  /** The target's fleet (null when the target is in no fleet). */
  fleet?: string | null;
  /** The target's fleet role, which selects the 300k member vs 400k leader ceiling. */
  targetRole?: string | null;
  /** How the caller was authorized. */
  invokedAs?: 'leader' | 'queen' | 'owner';
  error?: string;
  message?: string;
  note?: string;
}

/**
 * Set `targetOwnerId`'s soft compaction limit to `limit`, authorized as the target's
 * fleet leader / queen / owner. Requests above the target's ceiling are rejected
 * before the write. Best-effort on the read-backs; the setCompactionLimit write is
 * the authoritative effect for accepted requests.
 */
export async function setCompactionLimitForOwner(
  ctx: ResolveIdentityCtx,
  targetOwnerId: string,
  limit: number,
): Promise<CrossSessionLimitResult> {
  const { ownerId: callerId, workspaceId } = resolveFleetCaller(ctx);

  // 1. Resolve the TARGET's fleet membership (slug + role) — a separate read from
  //    the presence row (mirrors take-leadership-core / control-core).
  const targetFleet = (await fetchPresenceFleet([targetOwnerId]).catch(() => new Map())).get(
    targetOwnerId,
  );
  const fleetSlug: string | null = targetFleet?.fleetSlug ?? null;
  const targetRole: string | null = targetFleet?.fleetRole ?? null;

  // 2. GUARD — reuse the fleet-control auth classifier: leader of the TARGET's fleet,
  //    or queen (mug|kettle), or owner (su). A fleetless target has no leader, so only
  //    queen/owner can set it. Caller pane derives from live presence, never self-asserted.
  const fleet = fleetSlug ? await getFleet(workspaceId, fleetSlug).catch(() => null) : null;
  let paneKind = 'unknown';
  try {
    const pres = await getPresence(callerId).catch(() => null);
    paneKind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId: callerId }).kind;
  } catch {
    paneKind = classifyAgentPane({ role: null, ownerId: callerId }).kind;
  }
  // The admin chat UI is OWNER authority, exactly as it already is for mode:set
  // (hud-chat-owner-controls-2026-08-11 P-003). Without this the CTX control in
  // the chat footer could never write: the route synthesizes the identity
  // `pc-admin-coord-ui`, which carries no presence row and no `su-` prefix, so
  // classifyAgentPane lands it on `cup` and classifyFleetControlInvoker returns
  // null — every set refused as not_authorized, from the owner's own local UI.
  //
  // Granting it here rather than widening classifyAgentPane is deliberate: this
  // is the SAME allowance mode:set makes at its own tool layer
  // (`ident.ownerId === ADMIN_COORD_UI_OWNER` → callerIsOwnerAuthority, pinned by
  // mode/set.test.ts), and it is not a client-suppliable flag — it is reachable
  // only through the CSRF-gated, loopback-trusted /api/admin/* routes. Widening
  // the shared pane classifier instead would hand this authority to every caller
  // of every fleet-control verb, which is a much larger claim than the one the
  // chat footer needs.
  const invokedAs =
    callerId === ADMIN_COORD_UI_OWNER
      ? ('owner' as const)
      : classifyFleetControlInvoker({
          callerOwnerId: callerId,
          leaderOwnerId: fleet?.leaderOwnerId ?? null,
          paneKind,
        });
  if (!invokedAs) {
    return {
      ok: false,
      targetOwnerId,
      fleet: fleetSlug,
      targetRole,
      error: 'not_authorized',
      message:
        `Setting ${targetOwnerId}'s compaction limit is restricted to the leader of its fleet ` +
        `(${fleet?.leaderOwnerId ?? (fleetSlug ? 'none recorded' : 'target is in no fleet')}), the ` +
        `Overwatch (system-authority) pane, or the owner (an su session) — you are ${paneKind} (${callerId}). Ask that fleet's ` +
        `leader, or have the member run config:set-compaction-limit itself.`,
    };
  }

  // 3. Validate against the TARGET's model-spec + role ceiling (a member's leaner
  //    [1m] cap when the target is a non-leader fleet member) before persisting.
  const fleetMember = targetRole != null && targetRole !== 'leader';
  // Prefer the target's measured effective window when available. A Codex
  // rollout can expose a smaller window than its launch spec implies; accepting
  // the spec-derived ceiling would report success and leave the watchdog to
  // rewrite the target later.
  const measuredWindow = await estimateContextWindowForOwner(targetOwnerId).catch(() => null);
  const spec = measuredWindow == null ? await resolveModelSpecForOwner(targetOwnerId).catch(() => null) : null;
  // This verb IS the deliberate self-set path, so it validates against the self-set ceiling
  // (825k on a [1m] window) rather than the SEEDED default (400k) — the two were one
  // number until 2026-08-08, which made "raise it for wide-context work" impossible to
  // actually do. Seeding is untouched; a fleet member still gets its role cap.
  const cap =
    measuredWindow != null
      ? selfSetCeilingForWindow(measuredWindow, { fleetMember })
      : selfSetCeilingForSpec(spec, { fleetMember });
  if (limit > cap) {
    return {
      ok: false,
      targetOwnerId,
      cap,
      fleet: fleetSlug,
      targetRole,
      invokedAs,
      requested: limit,
      error: 'limit_exceeds_cap',
      message: `requested compaction limit ${limit} exceeds the target's model-derived ceiling ${cap}; no change was made`,
      note: 'The requested limit was not written because it exceeds the target session\'s current model-derived ceiling.',
    };
  }
  // The measured-cap check above already proves this exact value is safe; do
  // not run it back through the potentially wider/narrower spec-derived clamp.
  const applied =
    measuredWindow != null
      ? limit
      : clampCompactionLimit(limit, spec, { fleetMember, selfSet: true });
  if (applied !== limit) {
    return {
      ok: false,
      targetOwnerId,
      cap,
      fleet: fleetSlug,
      targetRole,
      invokedAs,
      requested: limit,
      error: 'limit_out_of_range',
      message: `requested compaction limit ${limit} is outside the allowed range; no change was made`,
      note: 'The requested limit was not written because it would require clamping.',
    };
  }
  await setCompactionLimit(targetOwnerId, applied, { explicit: true });
  const after = await getPresence(targetOwnerId).catch(() => null);
  const persisted = after?.compactionLimit ?? null;

  return {
    ok: persisted != null,
    targetOwnerId,
    compactionLimit: persisted,
    cap,
    fleet: fleetSlug,
    targetRole,
    invokedAs,
    ...(persisted == null
      ? { note: `no live presence row for ${targetOwnerId} — limit not persisted (it may have ended)` }
      : {}),
  };
}
