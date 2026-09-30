/**
 * peer-probe-op — the RELAY side of the SWIM eviction probe (P-016 of
 * shared-hive-hardening-2026-06-13).
 *
 * When a peer suspects the authority is dead (high φ), it asks k relays — via a
 * `peer.probe` authority RPC over the registered transport — "is this device
 * alive from YOUR vantage?". This module is the receiving handler: it answers
 * from the relay's OWN federated presence view. Cross-machine each peer holds its
 * own replicated `shared_presence` copy, so a relay can see a peer the suspecting
 * peer can't — exactly the single-link false-positive SWIM corrects.
 *
 * `peer.probe` is a PEER-TO-PEER liveness query, NOT an authority-only op: ANY
 * peer answers it, regardless of who the elected authority is. So it is listed in
 * {@link AUTHORITY_EXEMPT_OP_KINDS} (./authority-op-registry) and skips the
 * `verifyIsAuthority` gate — otherwise a relay that isn't the authority would
 * reply `not_authority` and the prober would (wrongly) read it as unreachable.
 * The EI-322 caller-signature gate still applies (the payload carries no holder /
 * workspace, so only the signature+freshness check runs — see verify-authority-caller).
 */

import { getOrgPg } from '@papercusp/db-org';
import { registerAuthorityOp } from './authority-op-registry';
import { DEFAULT_AUTHORITY_STALE_MS } from './lock-authority';
import { PEER_PROBE_OP_KIND } from './peer-eviction';

/** The relay's answer to a `peer.probe`. */
export interface PeerProbeResult {
  alive: boolean;
}

/** Is `targetPubkey` alive from THIS relay's vantage? Default: the durable
 *  presence freshness query (./default below). Tests inject a deterministic one. */
export type PeerLivenessCheck = (targetPubkey: string, scope: string) => Promise<boolean> | boolean;

export interface PeerProbeDeps {
  /** Override the liveness check (tests / a richer ping). */
  isPeerLive?: PeerLivenessCheck;
  /** Staleness window for the default presence-based check. Default
   *  {@link DEFAULT_AUTHORITY_STALE_MS}. */
  staleMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

/**
 * The default relay liveness check: is `targetPubkey` present in this machine's
 * `shared_presence` with a `last_seen_at` within the staleness window? Liveness
 * is a property of the DEVICE (a device alive in any harness is alive), so this
 * queries by `device_pubkey` across scopes — scope-agnostic + robust whether the
 * probe's scope key is a harness or a Hive slug. Never throws: a query error
 * answers `false` (no proof of life → no veto on eviction), the safe default.
 */
export async function defaultPeerLiveness(
  targetPubkey: string,
  staleMs: number,
  nowMs: number,
): Promise<boolean> {
  try {
    const { sql } = getOrgPg();
    const rows = (await sql`
      SELECT (extract(epoch FROM max(last_seen_at)) * 1000)::bigint AS last_seen_ms
      FROM harness_shared.shared_presence
      WHERE device_pubkey = ${targetPubkey}
        AND device_pubkey <> ''
    `) as Array<{ last_seen_ms: string | number | null }>;
    const lastSeen = rows[0]?.last_seen_ms;
    if (lastSeen == null) return false;
    return nowMs - Number(lastSeen) < staleMs;
  } catch {
    return false; // unknowable → not a confirmation of life
  }
}

/** Build the `peer.probe` handler bound to a liveness check. */
export function buildPeerProbeHandler(
  deps: PeerProbeDeps = {},
): (payload: unknown, scope: string) => Promise<PeerProbeResult> {
  const staleMs = deps.staleMs ?? DEFAULT_AUTHORITY_STALE_MS;
  const now = deps.now ?? Date.now;
  const isPeerLive: PeerLivenessCheck =
    deps.isPeerLive ?? ((targetPubkey) => defaultPeerLiveness(targetPubkey, staleMs, now()));

  return async (payload: unknown, scope: string): Promise<PeerProbeResult> => {
    const p = payload as { targetPubkey?: unknown };
    if (!p || typeof p.targetPubkey !== 'string' || !p.targetPubkey) {
      throw new Error('peer.probe: invalid payload (targetPubkey required)');
    }
    return { alive: !!(await isPeerLive(p.targetPubkey, scope)) };
  };
}

/** Register the `peer.probe` op at boot, marked authority-EXEMPT so any peer
 *  answers it (a relay need not be the elected authority). Idempotent-safe only
 *  once (the registry throws on a duplicate kind — guard at the caller). */
export function registerPeerProbeOp(deps: PeerProbeDeps = {}): void {
  registerAuthorityOp(PEER_PROBE_OP_KIND, buildPeerProbeHandler(deps), { authorityExempt: true });
}
