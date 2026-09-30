/**
 * p2p/accept-delegated-seats.ts — the PER-HOST "accept delegated seats" trust gate.
 *
 * agent-allocation-framework-2026-07-03 P-008 (decision D-006). Cross-machine
 * agent-slot delegation means a REMOTE fleet owner (A) asks THIS host (B) to spawn
 * bounded agents joined to A's fleet's coord layer. Agent slots are papercusp agents
 * already bounded by B's CAPABILITY ENVELOPE (tiers, tool-clamps, exec-sandbox — all
 * B controls), so B's envelope IS the sandbox (NOT the P-105 foreign-code cgroups
 * sandbox). But letting a remote owner spawn on your box at all is a real privilege
 * step, so B consents TWICE: by delegating the slots AND by flipping this per-host
 * gate ON.
 *
 * This module is the GATE. It is the trust half of P-009's honor path: P-009 (the
 * cross-machine spawn-honor path) MUST call `assertHostAcceptsDelegatedSeats()`
 * before it spawns anything on behalf of a remote owner. The gate is FAIL-CLOSED:
 * the `ACCEPT_DELEGATED_SEATS` flag defaults OFF (owner-authority DarkCase), so a
 * fresh host honors NO delegated-seat spawn requests until its owner opts in via
 * /res (or /admin/features). The flag is read per-host through the stored-override
 * store (getFlag → loadStoredOverrides), so each contributing host decides
 * independently — B flipping it ON never affects A.
 */

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

/** Thrown by {@link assertHostAcceptsDelegatedSeats} when this host has NOT opted in. */
export class DelegatedSeatsDisabledError extends Error {
  /** Stable machine code for the honor path to surface / branch on. */
  readonly code = 'accept_delegated_seats_disabled';
  constructor(message?: string) {
    super(
      message ??
        'This host does not accept delegated seats. The host owner must opt in by enabling ' +
          'the "accept delegated seats" toggle (/res or /admin/features) before a remote fleet ' +
          'owner can spawn agents on this machine.',
    );
    this.name = 'DelegatedSeatsDisabledError';
  }
}

/**
 * Does THIS host currently accept delegated-seat spawns from a remote fleet owner?
 * Reads the owner-authority `ACCEPT_DELEGATED_SEATS` flag (default-OFF / fail-closed),
 * per-host via the stored-override store. Use for a boolean read (status / UI); use
 * {@link assertHostAcceptsDelegatedSeats} on the enforcement path.
 */
export async function hostAcceptsDelegatedSeats(): Promise<boolean> {
  return getFlag(FLAGS.ACCEPT_DELEGATED_SEATS, 'system');
}

/**
 * Enforcement guard for the remote-owner spawn-honor path (P-009). Resolves when
 * this host has opted in; otherwise THROWS {@link DelegatedSeatsDisabledError}
 * (code `accept_delegated_seats_disabled`). Call this BEFORE honoring any
 * delegated-seat spawn requested by a remote owner.
 */
export async function assertHostAcceptsDelegatedSeats(): Promise<void> {
  if (!(await hostAcceptsDelegatedSeats())) {
    throw new DelegatedSeatsDisabledError();
  }
}
