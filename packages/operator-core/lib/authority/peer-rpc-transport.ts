/**
 * peer-rpc-transport — the pluggable wire-leg INTERFACE + null default for
 * {@link routeToAuthority}. This file owns the `PeerRpcTransport` contract,
 * `PeerUnreachableError`, and the `setPeerRpcTransport` registration seam — NOT
 * a concrete transport.
 *
 * The real transports register at boot (see `transport-wiring.ts`):
 *   - `HttpPeerRpcTransport` (`http-peer-rpc-transport.ts`) — POST to the
 *     authority peer's operator endpoint; works server↔server (publicly
 *     reachable peers), proven on Hetzner.
 *   - `AuthorityRpcSwarmTransport` (`authority-rpc-swarm-transport.ts`) — the
 *     PRIMARY for the NAT'd desktop fleet: an RPC channel multiplexed over the
 *     existing per-hive Hyperswarm connection (shared-hive-hardening D-007). The
 *     connection is already open + hole-punched, so it needs NO address
 *     discovery — the connection IS the address, keyed by `device_pubkey`.
 *   - `CompositePeerRpcTransport` (`composite-peer-rpc-transport.ts`) combines
 *     the two (swarm transport for the desktop fleet, HTTP fallback for reachable peers).
 *
 * The default {@link NULL_PEER_RPC_TRANSPORT} (tests / before wiring) reports
 * every peer unreachable, so {@link routeToAuthority} fails open — the designed
 * degradation (D-004: git-merge is the data-safety backstop, so a missed
 * serialization only costs extra merge churn, never correctness).
 */

import type { PeerRef } from './lock-authority';

/** The request an authority RPC carries. */
export interface AuthorityRpcRequest {
  harnessSlug: string;
  kind: string;
  payload: unknown;
}

/** A transport that can deliver an authority RPC to a remote peer. */
export interface PeerRpcTransport {
  /**
   * Deliver `req` to `peer` (the resolved authority) and return its raw
   * response. MUST throw {@link PeerUnreachableError} when the peer cannot be
   * reached, so the caller fails open rather than blocking.
   */
  rpc(peer: PeerRef, req: AuthorityRpcRequest): Promise<unknown>;
}

/** Thrown by a transport when the authority peer is unreachable → fail-open. */
export class PeerUnreachableError extends Error {
  constructor(message: string, readonly peer?: PeerRef) {
    super(message);
    this.name = 'PeerUnreachableError';
  }
}

/**
 * The default transport: no peer is reachable. Every call throws
 * {@link PeerUnreachableError}, so {@link routeToAuthority} always fails open
 * until a real transport is injected. This is the correct behavior on a single
 * box (there are no remote peers to route to anyway) and a safe default
 * cross-machine (git is the backstop).
 */
export const NULL_PEER_RPC_TRANSPORT: PeerRpcTransport = {
  async rpc(peer: PeerRef): Promise<never> {
    throw new PeerUnreachableError(
      'no peer RPC transport is registered — lock-authority routing fails open',
      peer,
    );
  },
};

let _transport: PeerRpcTransport | null = null;

/**
 * Register the peer RPC transport. Call once at boot when a real transport is
 * available. Passing `null` resets to the null transport (fail-open).
 */
export function setPeerRpcTransport(transport: PeerRpcTransport | null): void {
  _transport = transport;
}

/** The currently-registered transport, or the null (fail-open) transport. */
export function getPeerRpcTransport(): PeerRpcTransport {
  return _transport ?? NULL_PEER_RPC_TRANSPORT;
}

/** Test-only: reset the registered transport. */
export function __resetPeerRpcTransportForTests(): void {
  _transport = null;
}
