/**
 * composite-peer-rpc-transport — try several PeerRpcTransports in order, falling
 * through on unreachability (shared-hive-hardening-2026-06-13 D-005).
 *
 * `routeToAuthority` registers exactly ONE transport via `setPeerRpcTransport`,
 * but the two real transports are complementary, not competing:
 *   - `makeAuthorityRpcSwarmTransport` (option c) reaches a NAT'd desktop peer
 *     over the Hyperswarm connection the substrate already holds open — no
 *     addressing needed, the connection IS the address.
 *   - `HttpPeerRpcTransport` reaches a publicly-addressable peer (server / the
 *     Hetzner rig) at its `:3070` via the env map / presence URL.
 *
 * This composite tries each in turn: a `PeerUnreachableError` from one (no open
 * channel / no address / timeout / failover gap) falls THROUGH to the next, so a
 * peer reachable by EITHER path is served; only when every transport reports it
 * unreachable does the composite throw `PeerUnreachableError` (→ fail-open,
 * D-004). A NON-unreachable error (a genuine op failure on a reachable authority
 * — `handler_error` / `unauthenticated` / `unknown_kind`) is rethrown IMMEDIATELY
 * and never masked by trying another transport: the authority WAS reached and the
 * op genuinely failed.
 *
 * Order matters: put the cheaper / more-likely-reachable transport first. The
 * boot wiring puts the swarm transport first (the connection is already open;
 * zero extra round-trips) and HTTP second.
 */
import type { PeerRpcTransport, AuthorityRpcRequest } from './peer-rpc-transport';
import { PeerUnreachableError } from './peer-rpc-transport';
import type { PeerRef } from './lock-authority';

export class CompositePeerRpcTransport implements PeerRpcTransport {
  private readonly transports: PeerRpcTransport[];

  constructor(transports: PeerRpcTransport[]) {
    // Drop nullish entries so a caller can compose conditionally
    // (`new CompositePeerRpcTransport([swarmTransport, httpTransport])` where one
    // may be undefined when its prerequisite — a swarm / an env map — is absent).
    this.transports = transports.filter((t): t is PeerRpcTransport => Boolean(t));
  }

  async rpc(peer: PeerRef, req: AuthorityRpcRequest): Promise<unknown> {
    if (this.transports.length === 0) {
      throw new PeerUnreachableError('composite transport has no underlying transports', peer);
    }
    let lastUnreachable: PeerUnreachableError | undefined;
    for (const transport of this.transports) {
      try {
        return await transport.rpc(peer, req);
      } catch (err) {
        if (err instanceof PeerUnreachableError) {
          // This transport can't reach the peer — try the next one.
          lastUnreachable = err;
          continue;
        }
        // A genuine op failure on a reachable authority — do NOT mask it by
        // trying another transport. Surface immediately.
        throw err;
      }
    }
    // Every transport reported the peer unreachable → fail open at the caller.
    throw lastUnreachable ?? new PeerUnreachableError('no transport could reach the authority peer', peer);
  }
}
