/**
 * account-owner-pins — the DURABLE map of dynamic agent→account pins (account-dynamic-pin-2026-06-29).
 *
 * A runtime pin set via accounts:pin that the inference gateway honors PER-REQUEST (keyed by the
 * `x-papercusp-owner` header), OVERRIDING an agent's static spawn pin; cleared via accounts:unpin. Any
 * agent can pin any agent by its owner/spawn id (its OWN id to self-pin). `hard` ⇒ the gateway never fails
 * over off the account.
 *
 * WORKSPACE-LEVEL single-row JSONB in `harness_shared.operator_owner_pins` (migration 416) — the
 * operator-state idiom, living APART from operator_account_pool so the pool's high-churn rate-projection
 * writes never clobber a pin. payload = { [ownerId]: { account, hard } }. The gateway loads this at startup
 * + on its pool-reload poll so pins SURVIVE a gateway restart (in-memory alone dropped them silently on the
 * wedge-watchdog / deploy / crash restarts).
 */
import { readOperatorState, writeOperatorState } from '../operator-state-pg';

const OWNER_PINS_STATE_TABLE = 'operator_owner_pins' as const;

export interface OwnerPin {
  account: string;
  hard: boolean;
}
export interface OwnerPinEntry extends OwnerPin {
  ownerId: string;
}

type OwnerPinsPayload = Record<string, { account?: unknown; hard?: unknown }>;

function decode(raw: OwnerPinsPayload | null | undefined): Map<string, OwnerPin> {
  const m = new Map<string, OwnerPin>();
  if (!raw || typeof raw !== 'object') return m;
  for (const [ownerId, v] of Object.entries(raw)) {
    if (!ownerId || typeof v !== 'object' || v === null) continue;
    const account = typeof v.account === 'string' && v.account.length > 0 ? v.account : undefined;
    if (!account) continue;
    m.set(ownerId, { account, hard: v.hard === true });
  }
  return m;
}

/** Every pin for a workspace as a Map (gateway-friendly). Missing row ⇒ empty (no pins). */
export async function getOwnerPinsMap(workspaceId: string): Promise<Map<string, OwnerPin>> {
  return decode(await readOperatorState<OwnerPinsPayload>(OWNER_PINS_STATE_TABLE, workspaceId));
}

/** Every pin for a workspace as a list — the shape the gateway.setOwnerPins seeding + a list view want. */
export async function getOwnerPinsList(workspaceId: string): Promise<OwnerPinEntry[]> {
  return [...(await getOwnerPinsMap(workspaceId)).entries()].map(([ownerId, p]) => ({ ownerId, ...p }));
}

/** Set (or replace) one agent's pin (read-modify-write the single row). Returns the resulting pin. */
export async function setOwnerPin(workspaceId: string, ownerId: string, pin: OwnerPin): Promise<OwnerPin> {
  const m = await getOwnerPinsMap(workspaceId);
  const next: OwnerPin = { account: pin.account, hard: pin.hard === true };
  m.set(ownerId, next);
  await writeOperatorState(OWNER_PINS_STATE_TABLE, Object.fromEntries(m), workspaceId);
  return next;
}

/** Clear one agent's pin. Returns whether a pin existed. */
export async function clearOwnerPin(workspaceId: string, ownerId: string): Promise<boolean> {
  const m = await getOwnerPinsMap(workspaceId);
  if (!m.delete(ownerId)) return false;
  await writeOperatorState(OWNER_PINS_STATE_TABLE, Object.fromEntries(m), workspaceId);
  return true;
}
