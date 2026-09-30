/**
 * Liveness-aware mode reads (goal-mode-drift-guards-2026-08-31 P-007).
 *
 * `agent_modes` is durable control state: rows intentionally survive the
 * process that wrote them so a successor can recover posture, provenance, and
 * subjects. Row presence therefore does NOT answer whether that process is
 * still alive. Deleting rows on session death would fix the display by
 * destroying the recovery record, so user-facing readers fold the shared
 * session-liveness oracle over the durable rows instead.
 *
 * The result is tri-state on purpose:
 *   true  — live / parked / recorded: positive session evidence;
 *   false — ended: positive death evidence;
 *   null  — draining / suspect / unmeasured: do not guess.
 *
 * Raw `getModes*` remains the correct API for control/recovery consumers. New
 * human-facing mode surfaces should use this module.
 */
import type { Sql } from 'postgres';

import {
  resolveSessionStates,
  type LivenessVerdict,
  type LivenessSubject,
} from '../agent-tools/coordination/liveness-oracle';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { getModes, getModesForOwners, type ModeRow } from './store';

export interface LivenessAwareModeSet {
  ownerId: string;
  /** Durable registrations, retained even when `live` is false. */
  modes: ModeRow[];
  /** The shared oracle's full state; null means it could not be measured. */
  sessionState: SessionState | null;
  /** Positive live/dead evidence, or null for an ambiguous/degraded verdict. */
  live: boolean | null;
}

export interface ModeLivenessReadDeps {
  sql?: Sql;
  getModesFn?: typeof getModes;
  getModesForOwnersFn?: typeof getModesForOwners;
  resolveSessionStatesFn?: typeof resolveSessionStates;
}

/** PURE: project the shared oracle onto the mode registry's staffing question. */
export function modeRegistrationLive(sessionState: SessionState | null | undefined): boolean | null {
  if (sessionState === 'live' || sessionState === 'parked' || sessionState === 'recorded') {
    return true;
  }
  if (sessionState === 'ended') return false;
  return null;
}

/**
 * PURE fold used both by the IO helpers and callers that already paid for a
 * roster liveness read. Every requested owner gets a result, including owners
 * with no registered modes.
 */
export function resolveModeSetsFromRows(
  ownerIds: readonly string[],
  rowsByOwner: ReadonlyMap<string, ModeRow[]>,
  verdicts: ReadonlyMap<string, LivenessVerdict>,
): Map<string, LivenessAwareModeSet> {
  const out = new Map<string, LivenessAwareModeSet>();
  for (const ownerId of new Set(ownerIds.filter(Boolean))) {
    const sessionState = verdicts.get(ownerId)?.sessionState ?? null;
    out.set(ownerId, {
      ownerId,
      modes: rowsByOwner.get(ownerId) ?? [],
      sessionState,
      live: modeRegistrationLive(sessionState),
    });
  }
  return out;
}

async function readVerdicts(
  ownerIds: readonly string[],
  fn: typeof resolveSessionStates,
): Promise<Map<string, LivenessVerdict>> {
  const subjects: LivenessSubject[] = [...new Set(ownerIds.filter(Boolean))].map((ownerId) => ({
    ownerId,
  }));
  if (!subjects.length) return new Map();
  try {
    // A point/bounded mode read starts with owner ids, not roster rows. Hydrate
    // the presence legs so it receives the same verdict as coord:presence.
    return await fn(subjects, { hydratePerId: true });
  } catch {
    // A liveness outage must not erase the durable registration or turn it into
    // a death claim. The pure fold represents this explicitly as live:null.
    return new Map();
  }
}

/** Liveness-aware point read for mode:get / mode:list. */
export async function getModesWithLiveness(
  workspaceId: string,
  ownerId: string,
  deps: ModeLivenessReadDeps = {},
): Promise<LivenessAwareModeSet> {
  const readModes = deps.getModesFn ?? getModes;
  const resolve = deps.resolveSessionStatesFn ?? resolveSessionStates;
  const [modes, verdicts] = await Promise.all([
    readModes(workspaceId, ownerId, deps.sql),
    readVerdicts([ownerId], resolve),
  ]);
  return resolveModeSetsFromRows([ownerId], new Map([[ownerId, modes]]), verdicts).get(ownerId)!;
}

/** Liveness-aware bounded batch read for surveys that do not already own a roster verdict. */
export async function getModesForOwnersWithLiveness(
  workspaceId: string,
  ownerIds: readonly string[],
  deps: ModeLivenessReadDeps = {},
): Promise<Map<string, LivenessAwareModeSet>> {
  const owners = [...new Set(ownerIds.filter(Boolean))];
  if (!owners.length) return new Map();
  const readModes = deps.getModesForOwnersFn ?? getModesForOwners;
  const resolve = deps.resolveSessionStatesFn ?? resolveSessionStates;
  const [rowsByOwner, verdicts] = await Promise.all([
    readModes(workspaceId, owners, deps.sql),
    readVerdicts(owners, resolve),
  ]);
  return resolveModeSetsFromRows(owners, rowsByOwner, verdicts);
}
