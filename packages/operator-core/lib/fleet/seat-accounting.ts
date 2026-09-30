/**
 * fleet/seat-accounting.ts — launch-from-seats accounting + enforcement
 * (agent-allocation-framework-2026-07-03 P-005).
 *
 * A fleet owner spawns members that CONSUME delegated agent_slot allotments
 * (D-002, mig 486): "5 × opus·xhigh on AUTO". This module is the seat math +
 * the consumption ledger behind that:
 *
 *   • PURE half — parse the slot template ref, fold allotments + consumed
 *     counts into per-slot availability, resolve a launch request against it
 *     (count cap ≤ delegated — the P-006 "N+1th spawn is refused" gate), and
 *     derive the psu launch opts a seat pins (model:effort + gateway account,
 *     D-003: 'AUTO' → the gateway's auto-routing). Unit-tests without PG.
 *
 *   • IO half — the consumption ledger (harness_shared.agent_seat_consumptions,
 *     mig 487): recorded at bootstrap-su boot time keyed to the session's coord
 *     owner id (consumeSeatAtBoot — an atomic conditional insert so a
 *     concurrent boot burst cannot overshoot the cap), counted LIVENESS-JOINED
 *     to coord_presence (a dead member's seat frees itself; a booting member
 *     inside the grace window still counts), lazily purged when old + dead.
 *
 * Composes resource-allotments.ts READ-ONLY (the store stays P-001's surface);
 * mirrors the getOrgPg().sql access pattern of the sibling stores.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  agentSlotRef,
  listResourceAllotments,
  resolveAllotmentWorkspace,
  type AgentSlotAxis,
  type ResourceAllotment,
} from '../p2p/resource-allotments';
import { MODEL_EFFORT_LEVELS, type ModelEffort } from '../agent-config-constants';
import { PRESENCE_STALE_MS } from '../agent-tools/coordination/presence';
import type { OrgSql } from '../work-items';

/**
 * A member that spawned but has not yet written its first presence row still
 * holds its seat for this long (its consumption row exists from bootstrap; the
 * presence row follows once the agent boots far enough). Also the lazy-purge
 * floor: a consumption row is deleted only when OLDER than this AND dead.
 */
export const SEAT_BOOT_GRACE_MS = 10 * 60_000;

/** One delegated slot template, normalized from its allotment row. */
export interface SeatSlot {
  /** The slot template ref '<model>:<effort>:<account>' (agentSlotRef). */
  ref: string;
  model: string;
  effort: ModelEffort;
  /** Gateway account selection (D-003): 'AUTO' or a pool id — never a raw credential. */
  account: string;
  /** Delegated seat count (quantity, D-002). */
  quantity: number;
}

/** Per-slot availability: delegated vs live-consumed. */
export interface SeatAvailability extends SeatSlot {
  consumed: number;
  available: number;
}

export interface SeatRefusal {
  code: 'seats_unavailable' | 'seat_ref_unknown' | 'seat_ref_ambiguous' | 'seats_exhausted';
  detail: string;
}

export type SeatLaunchResolution =
  | {
      ok: true;
      slot: SeatAvailability;
      /** The psu flags the seat pins: `--model=<model>:<effort>` + `--account=<...>`. */
      launch: { model: string; account: string };
    }
  | { ok: false; refusal: SeatRefusal };

function isModelEffort(v: unknown): v is ModelEffort {
  return typeof v === 'string' && (MODEL_EFFORT_LEVELS as readonly string[]).includes(v);
}

/**
 * PURE: parse a slot template ref '<model>:<effort>:<account>' back to its trio
 * (the inverse of agentSlotRef). null on any malformed input — a caller treats
 * that as seat_ref_unknown, never a partial parse.
 */
export function parseAgentSlotRef(ref: string | null | undefined): AgentSlotAxis | null {
  const parts = ref?.trim().split(':');
  if (!parts || parts.length !== 3) return null;
  const [model, effort, account] = parts.map((p) => p.trim());
  if (!model || !account || !isModelEffort(effort)) return null;
  return { model, effort, account };
}

/**
 * PURE: normalize one agent_slot allotment row to a SeatSlot. Prefers the
 * structured axis trio (the store validated it at write time); falls back to
 * parsing the ref so a hand-written row still resolves. null for non-slot /
 * malformed / paused-out rows — the caller's list is pre-filtered to active by
 * listResourceAllotments' default.
 */
export function slotFromAllotment(a: ResourceAllotment): SeatSlot | null {
  if (a.resourceKind !== 'agent_slot') return null;
  const quantity = a.quantity ?? 0;
  if (!Number.isInteger(quantity) || quantity < 1) return null;
  const axis = a.axis as Partial<AgentSlotAxis>;
  const trio: AgentSlotAxis | null =
    typeof axis?.model === 'string' && axis.model.trim() && isModelEffort(axis.effort) && typeof axis?.account === 'string' && axis.account.trim()
      ? { model: axis.model.trim(), effort: axis.effort, account: axis.account.trim() }
      : parseAgentSlotRef(a.resourceRef);
  if (!trio) return null;
  return { ref: agentSlotRef(trio), ...trio, quantity };
}

/** PURE: fold slots + consumed counts (by ref) into per-slot availability. */
export function computeSeatAvailability(
  slots: readonly SeatSlot[],
  consumedByRef: ReadonlyMap<string, number>,
): SeatAvailability[] {
  return slots.map((s) => {
    const consumed = Math.max(0, consumedByRef.get(s.ref) ?? 0);
    return { ...s, consumed, available: Math.max(0, s.quantity - consumed) };
  });
}

/**
 * PURE: the psu launch opts a seat pins. model = '<model>:<effort>' (the psu
 * `--model` spec); account maps D-003's 'AUTO' (case-insensitive) to psu's
 * `auto` gateway routing, any other value verbatim (a gateway pool id pin).
 */
export function seatLaunchOpts(slot: Pick<SeatSlot, 'model' | 'effort' | 'account'>): {
  model: string;
  account: string;
} {
  return {
    model: `${slot.model}:${slot.effort}`,
    account: slot.account.toUpperCase() === 'AUTO' ? 'auto' : slot.account,
  };
}

/**
 * PURE: resolve a launch-from-seats request against the fleet's availability —
 * the P-005 enforcement gate. Picks the slot (explicit seatRef, or the single
 * delegated template when unambiguous), refuses loudly otherwise:
 *   seats_unavailable — the fleet has no active agent_slot delegation;
 *   seat_ref_unknown  — seatRef matches no delegated template;
 *   seat_ref_ambiguous— no seatRef while >1 template is delegated;
 *   seats_exhausted   — count > available (the N+1th spawn refused, P-006).
 */
export function resolveSeatLaunch(opts: {
  availability: readonly SeatAvailability[];
  count: number;
  seatRef?: string | null;
}): SeatLaunchResolution {
  const { availability, count } = opts;
  const seatRef = opts.seatRef?.trim() || null;
  if (availability.length === 0) {
    return {
      ok: false,
      refusal: {
        code: 'seats_unavailable',
        detail:
          'No active agent_slot delegation for this fleet on this machine — delegate seats first (resource:delegate { kind: "agent_slot", … } / the /res Agent-seats group).',
      },
    };
  }
  let slot: SeatAvailability | undefined;
  if (seatRef) {
    slot = availability.find((s) => s.ref === seatRef);
    if (!slot) {
      return {
        ok: false,
        refusal: {
          code: 'seat_ref_unknown',
          detail: `No delegated slot template \`${seatRef}\` for this fleet — delegated: ${availability.map((s) => s.ref).join(', ')}.`,
        },
      };
    }
  } else if (availability.length === 1) {
    slot = availability[0];
  } else {
    return {
      ok: false,
      refusal: {
        code: 'seat_ref_ambiguous',
        detail: `This fleet has ${availability.length} delegated slot templates — pass \`seat\` to pick one: ${availability.map((s) => `${s.ref} (${s.available}/${s.quantity} free)`).join(', ')}.`,
      },
    };
  }
  if (count > slot.available) {
    return {
      ok: false,
      refusal: {
        code: 'seats_exhausted',
        detail: `Seat cap: ${count} member${count === 1 ? '' : 's'} requested but only ${slot.available} of ${slot.quantity} \`${slot.ref}\` seat${slot.quantity === 1 ? '' : 's'} free (${slot.consumed} consumed by live members). Wait for a seat to free, or delegate more.`,
      },
    };
  }
  return { ok: true, slot, launch: seatLaunchOpts(slot) };
}

// ─────────────────────────────────────────────────────────────────────────────
// IO half — the consumption ledger (mig 487)
// ─────────────────────────────────────────────────────────────────────────────

/** The liveness predicate shared by the count + the conditional insert: a
 *  consumption row counts while its owner's presence is FRESH, OR — only until
 *  the owner's FIRST presence write — while the row is still inside the boot-grace
 *  window.
 *
 *  WI-5317: the boot grace exists solely to bridge the gap between "seat consumed
 *  at boot" and "member's first heartbeat" (mig 487: "a booting member has a
 *  consumption row before its first presence write"). Once a presence row EXISTS,
 *  liveness must be judged by heartbeat freshness alone — otherwise a member that
 *  booted, registered presence, and then EXITED still counts against the cap for
 *  the full 10-min grace, leaking its seat (a wound-down member blocked re-spawn
 *  with seats_exhausted on the WI-5211 rig). So the grace clause is now gated on
 *  NOT-yet-having-a-presence-row; a member with a stale presence row frees its
 *  seat immediately, grace or no grace. */
const LIVE_PREDICATE = (sql: OrgSql, graceSecs: number, staleSecs: number) => sql`
  (EXISTS (SELECT 1 FROM harness_shared.coord_presence p
            WHERE p.owner_id = c.owner_id
              AND p.heartbeat_at > now() - ${`${staleSecs} seconds`}::interval)
   OR (c.created_at > now() - ${`${graceSecs} seconds`}::interval
       AND NOT EXISTS (SELECT 1 FROM harness_shared.coord_presence p
                        WHERE p.owner_id = c.owner_id)))`;

function graceStale() {
  return {
    graceSecs: Math.max(1, Math.floor(SEAT_BOOT_GRACE_MS / 1000)),
    staleSecs: Math.max(1, Math.floor(PRESENCE_STALE_MS / 1000)),
  };
}

/**
 * LIVE consumed-seat counts for one fleet, grouped by slot ref. Also lazily
 * purges rows that are BOTH past the boot grace AND dead (no presence row at
 * all — the reaper deletes rows on death), so the ledger cannot saturate a cap
 * with ghosts. Purge is best-effort; the count never depends on it.
 */
export async function countConsumedSeats(
  args: { workspaceId: string | null | undefined; fleetSlug: string },
  sqlOverride?: OrgSql,
): Promise<Map<string, number>> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) return new Map();
  const sql = sqlOverride ?? (getOrgPg().sql as unknown as OrgSql);
  const { graceSecs, staleSecs } = graceStale();
  try {
    await sql`
      DELETE FROM harness_shared.agent_seat_consumptions c
       WHERE c.workspace_id = ${ws} AND c.fleet_slug = ${args.fleetSlug}
         AND c.created_at <= now() - ${`${graceSecs} seconds`}::interval
         AND NOT EXISTS (SELECT 1 FROM harness_shared.coord_presence p WHERE p.owner_id = c.owner_id)`;
  } catch {
    /* purge is hygiene, never load-bearing */
  }
  const rows = (await sql`
    SELECT c.seat_ref, count(*)::int AS n
      FROM harness_shared.agent_seat_consumptions c
     WHERE c.workspace_id = ${ws} AND c.fleet_slug = ${args.fleetSlug}
       AND ${LIVE_PREDICATE(sql, graceSecs, staleSecs)}
     GROUP BY c.seat_ref
  `) as unknown as Array<{ seat_ref: string; n: number }>;
  return new Map(rows.map((r) => [r.seat_ref, Number(r.n)]));
}

/** The composed availability read: active agent_slot allotments × live consumption. */
export async function seatAvailabilityForFleet(
  args: { workspaceId: string | null | undefined; fleetSlug: string },
  sqlOverride?: OrgSql,
): Promise<SeatAvailability[]> {
  const [allotments, consumed] = await Promise.all([
    listResourceAllotments({ workspaceId: args.workspaceId, fleetSlug: args.fleetSlug }, sqlOverride),
    countConsumedSeats(args, sqlOverride),
  ]);
  const slots = allotments.map(slotFromAllotment).filter((s): s is SeatSlot => s != null);
  return computeSeatAvailability(slots, consumed);
}

export type ConsumeSeatResult =
  | { ok: true }
  | { ok: false; refusal: SeatRefusal };

/**
 * Boot-time seat consumption (bootstrap-su, after the WI-1893 fleet stamp):
 * validate the seat is a delegated template, then take it with ONE atomic
 * conditional INSERT — the insert only lands while the LIVE count is below the
 * delegated quantity, so a concurrent boot burst cannot overshoot the cap
 * (claimFleetLaunchSlot's check-and-set discipline). Re-boot of the same
 * owner upserts (owner_id PK) rather than double-counting.
 */
export async function consumeSeatAtBoot(
  args: { workspaceId: string | null | undefined; fleetSlug: string; seatRef: string; ownerId: string },
  sqlOverride?: OrgSql,
): Promise<ConsumeSeatResult> {
  const ws = resolveAllotmentWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: { code: 'seats_unavailable', detail: `Seat consume refused: unresolvable workspace partition (got ${JSON.stringify(args.workspaceId ?? null)}).` },
    };
  }
  const availability = await seatAvailabilityForFleet({ workspaceId: ws, fleetSlug: args.fleetSlug }, sqlOverride);
  const slot = availability.find((s) => s.ref === args.seatRef.trim());
  if (!slot) {
    return {
      ok: false,
      refusal: {
        code: 'seat_ref_unknown',
        detail: `No delegated slot template \`${args.seatRef}\` for fleet \`${args.fleetSlug}\`${availability.length ? ` — delegated: ${availability.map((s) => s.ref).join(', ')}` : ' (no agent_slot delegation on this machine)'}.`,
      },
    };
  }
  const sql = sqlOverride ?? (getOrgPg().sql as unknown as OrgSql);
  const { graceSecs, staleSecs } = graceStale();
  const rows = (await sql`
    INSERT INTO harness_shared.agent_seat_consumptions (owner_id, workspace_id, fleet_slug, seat_ref)
    SELECT ${args.ownerId}, ${ws}, ${args.fleetSlug}, ${slot.ref}
     WHERE (SELECT count(*) FROM harness_shared.agent_seat_consumptions c
             WHERE c.workspace_id = ${ws} AND c.fleet_slug = ${args.fleetSlug}
               AND c.seat_ref = ${slot.ref} AND c.owner_id <> ${args.ownerId}
               AND ${LIVE_PREDICATE(sql, graceSecs, staleSecs)}) < ${slot.quantity}
    ON CONFLICT (owner_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id,
          fleet_slug = EXCLUDED.fleet_slug,
          seat_ref = EXCLUDED.seat_ref,
          created_at = now()
    RETURNING owner_id
  `) as unknown as Array<{ owner_id: string }>;
  if (rows.length === 0) {
    return {
      ok: false,
      refusal: {
        code: 'seats_exhausted',
        detail: `Seat cap: all ${slot.quantity} \`${slot.ref}\` seat${slot.quantity === 1 ? '' : 's'} of fleet \`${args.fleetSlug}\` are consumed by live members — the spawn is refused (P-006).`,
      },
    };
  }
  return { ok: true };
}

/** Explicit release (session end hygiene). Liveness makes this optional — a
 *  dead member's seat frees itself — but a clean leave should not hold a seat
 *  for the stale window. */
export async function releaseSeatConsumption(ownerId: string, sqlOverride?: OrgSql): Promise<void> {
  const sql = sqlOverride ?? (getOrgPg().sql as unknown as OrgSql);
  await sql`DELETE FROM harness_shared.agent_seat_consumptions WHERE owner_id = ${ownerId}`;
}

/** Bulk explicit release (WI-5317): free the seats of many owners in one DELETE —
 *  the presence reaper calls this for the batch of confirmed-dead owners it reaps,
 *  so their seat rows go the moment they are reaped instead of lingering to the
 *  next lazy purge. No-op on an empty list. Liveness (LIVE_PREDICATE) remains the
 *  load-bearing floor; this is prompt hygiene on top of it. */
export async function releaseSeatConsumptions(ownerIds: string[], sqlOverride?: OrgSql): Promise<void> {
  if (ownerIds.length === 0) return;
  const sql = sqlOverride ?? (getOrgPg().sql as unknown as OrgSql);
  await sql`DELETE FROM harness_shared.agent_seat_consumptions WHERE owner_id = ANY(${ownerIds}::text[])`;
}
