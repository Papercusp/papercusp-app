/**
 * seat-slots.ts — pure client helpers for the /res "Agent seats" group
 * (agent-allocation-framework-2026-07-03 P-003).
 *
 * A SEAT (agent_slot allotment) is a counted, launchable su-agent template a
 * host delegates to a fleet: (model, effort, gateway account) × quantity
 * (D-002/D-003). The trio lives in the row's `axis`; the row ref is DERIVED
 * server-side as `${model}:${effort}:${account}` (the store's agentSlotRef —
 * mirrored here for client-side keying/merging; the server derivation always
 * wins on write). Accounts/GPUs cap by share-%; seats cap by COUNT.
 *
 * Pure module — no React, no sync imports — so the merge/step/parse logic is
 * unit-testable without the board harness.
 */
import {
  MODEL_EFFORT_LEVELS,
  type ModelEffort,
} from '@papercusp/operator-core/lib/agent-config-constants';

/** The slot trio (D-002). `account` is a gateway account id or 'AUTO' (D-003). */
export interface SlotAxis {
  model: string;
  effort: ModelEffort;
  account: string;
}

/** D-003 gateway-auto account sentinel — the gateway picks from the fleet's pool. */
export const AUTO_ACCOUNT = 'AUTO';

/** Mirror of the store's AGENT_SLOT_MAX_QUANTITY (resource-allotments.ts, mig 486).
    Client-side clamp only — the store refuses out-of-range regardless. */
export const AGENT_SLOT_MAX_QUANTITY = 1000;

/** Effort a seat template uses when the source tier spec carries no `:<effort>`
    suffix (a bare spec inherits the session default at spawn time; a slot must
    pin one — the store requires effort ∈ MODEL_EFFORT_LEVELS). */
export const DEFAULT_SEAT_EFFORT: ModelEffort = 'high';

function isEffort(v: string): v is ModelEffort {
  return (MODEL_EFFORT_LEVELS as readonly string[]).includes(v);
}

/** Client mirror of the store's derived row ref (`agentSlotRef`). */
export function agentSlotRef(axis: SlotAxis): string {
  return `${axis.model}:${axis.effort}:${axis.account}`;
}

/**
 * Parse a tier menu `spec` (`<modelId>[:<effort>]`, e.g. 'opus[1m]:high',
 * 'haiku') into a slot (model, effort) pair, using the same last-colon rule as
 * applyRoleModel/isValidModelSpec: a colon suffix that is NOT an effort level
 * belongs to the model id. Returns null when the resulting model can't be a
 * slot axis (empty, or still contains ':' — colons are the ref separators and
 * the store refuses them with invalid_model).
 *
 * The `[1m]` window marker is kept ON the model deliberately — stripping it
 * would launch 200k-auto-compact sessions (the sonnet fleet-killer; see
 * agent-config-constants DEFAULT_MODEL_TIERS).
 */
export function parseTierSpecToSlot(
  spec: string,
): { model: string; effort: ModelEffort } | null {
  const s = spec?.trim();
  if (!s || /\s/.test(s)) return null;
  const lastColon = s.lastIndexOf(':');
  let model = s;
  let effort: ModelEffort = DEFAULT_SEAT_EFFORT;
  if (lastColon > 0) {
    const suffix = s.slice(lastColon + 1);
    if (isEffort(suffix)) {
      model = s.slice(0, lastColon);
      effort = suffix;
    }
  }
  if (!model || model.includes(':')) return null; // un-representable as a slot axis
  return { model, effort };
}

/** One rendered slot chip row (client projection of an agent_slot allotment). */
export interface SlotRow {
  ref: string;
  quantity: number;
  axis: SlotAxis;
}

/** Clamp a seat count into the store's accepted 1..AGENT_SLOT_MAX_QUANTITY band. */
export function clampSeatQuantity(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(AGENT_SLOT_MAX_QUANTITY, Math.max(1, Math.round(n)));
}

/**
 * Plan the write(s) for dropping/re-targeting seats onto a fleet so the board
 * never holds two rows for one derived ref:
 *  - `set`   — the upsert to issue ({ axis, quantity }).
 *  - `removeRef` — an old row to delete AFTER the set lands (an account/model
 *    retarget changes the derived ref, so the old key must go); absent when
 *    the target ref equals the source ref (pure count/upsert).
 *
 * `existing` is the fleet's current slot rows; when the target ref already
 * exists the quantities MERGE (drop-on-existing = +add, retarget-onto-existing
 * = sum), clamped to the store band.
 */
export function planSlotWrite(
  existing: readonly SlotRow[],
  target: SlotAxis,
  addQuantity: number,
  fromRef?: string,
): { set: { axis: SlotAxis; quantity: number }; removeRef?: string } {
  const targetRef = agentSlotRef(target);
  const hit = existing.find((r) => r.ref === targetRef);
  const quantity = clampSeatQuantity((hit && hit.ref !== fromRef ? hit.quantity : 0) + addQuantity);
  const removeRef = fromRef && fromRef !== targetRef ? fromRef : undefined;
  return { set: { axis: target, quantity }, ...(removeRef ? { removeRef } : {}) };
}

/** Chip label body: '5 × opus[1m]·xhigh' (the account renders as the select). */
export function slotChipLabel(row: SlotRow): string {
  return `${row.quantity} × ${row.axis.model}·${row.axis.effort}`;
}

/**
 * Project a raw p2p.allotments row into a SlotRow — tolerant of a pre-mig-486
 * row shape (missing quantity/axis ⇒ not renderable ⇒ null) so the board
 * degrades instead of crashing while P-001 rolls out.
 */
export function toSlotRow(r: {
  resourceKind: string;
  resourceRef: string;
  quantity?: number | null;
  axis?: Record<string, unknown> | null;
}): SlotRow | null {
  if (r.resourceKind !== 'agent_slot') return null;
  const axis = r.axis ?? {};
  const model = typeof axis.model === 'string' ? axis.model : '';
  const effortRaw = typeof axis.effort === 'string' ? axis.effort : '';
  const account = typeof axis.account === 'string' ? axis.account : '';
  if (!model || !account || !isEffort(effortRaw)) return null;
  const quantity = typeof r.quantity === 'number' && Number.isFinite(r.quantity) ? r.quantity : null;
  if (quantity == null || quantity < 1) return null;
  return { ref: r.resourceRef, quantity, axis: { model, effort: effortRaw, account } };
}
