/**
 * claim-authority seam.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 1, D-002).
 *
 * A CLAIM is mutual exclusion, so it is AUTHORITY-MEDIATED, never federated: the
 * per-harness lock authority (the lowest-live-device-pubkey peer) is the single
 * serialization point. That authority is owned + built by
 * distributed-coordination-shared-harness-2026-06-04 Track B (su-584a8). This plan
 * does NOT rebuild it — it ROUTES through it.
 *
 * On a single box there is exactly one peer, so the authority is always self and
 * every claim op runs locally. `LocalClaimAuthority` encodes exactly that. When
 * Track B lands, `setClaimAuthority()` installs the real resolver
 * (`lockAuthorityFor()` + RPC routing) with ZERO changes to the claim store — the
 * store only ever calls `getClaimAuthority().route(harness, op)`.
 *
 * This is the agreed interface (coord with su-584a8 2026-06-04): isSelf() answers
 * "am I the authority for this harness?"; route() runs the op at the authority — a
 * local call when isSelf, else an RPC over the peer channel.
 *
 * The op carried is su-584a8's `AuthorityOp<T>` shape — `{ local, remote? }`. The
 * `local` leg runs the op against THIS peer's store (used when we are the authority
 * or on fail-open); the optional `remote` envelope (`{ kind, payload, decode }`) is
 * what a REMOTE authority re-runs on our behalf over the peer-RPC transport. A
 * closure can't cross the wire, so cross-peer serialization needs the serialisable
 * `remote` envelope — which is why this seam mirrors `AuthorityOp` rather than a
 * bare thunk (Phase-4 legs b/c: two-peer claim contention + authority failover).
 */
import type { AuthorityOp } from '../authority';

export interface ClaimAuthority {
  /** True if this peer is the claim authority for the harness. Single box → always true. */
  isSelf(harnessSlug: string): Promise<boolean>;
  /** Run a claim op AT the authority: `op.local()` when isSelf, else RPC `op.remote` to the authority peer. */
  route<T>(harnessSlug: string, op: AuthorityOp<T>): Promise<T>;
}

/** The single-peer / single-box authority: this peer is always the authority. */
export class LocalClaimAuthority implements ClaimAuthority {
  async isSelf(_harnessSlug: string): Promise<boolean> {
    return true;
  }
  async route<T>(_harnessSlug: string, op: AuthorityOp<T>): Promise<T> {
    return op.local();
  }
}

let current: ClaimAuthority = new LocalClaimAuthority();

/** The active claim authority router. The claim store calls this. */
export function getClaimAuthority(): ClaimAuthority {
  return current;
}

/** Install a real (multi-peer) authority router — su-584a8's Track B swap-in point. */
export function setClaimAuthority(authority: ClaimAuthority): void {
  current = authority;
}

/** Reset to the single-peer local authority (tests / teardown). */
export function resetClaimAuthority(): void {
  current = new LocalClaimAuthority();
}
