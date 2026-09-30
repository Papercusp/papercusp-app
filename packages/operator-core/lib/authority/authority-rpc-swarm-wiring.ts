/**
 * authority-rpc-swarm-wiring — boot registration of the option-(c) RPC transport
 * over the Hyperswarm connection (shared-hive-hardening-2026-06-13 P-001 / D-005,
 * owner-ratified). The complement to transport-wiring's HTTP registration.
 *
 * When `papercusp-authority-rpc-protomux` is ON, this composes the swarm transport
 * (reaches NAT'd desktop peers over the existing per-harness Hyperswarm
 * connection) IN FRONT OF the HTTP transport (reaches publicly-addressable peers
 * at their :3070) and registers the composite via setPeerRpcTransport. With the
 * flag OFF (default — the cross-machine path is real-hardware-unverified, P-003)
 * this is a no-op and the HTTP-only registration from `wireAuthorityRpcTransport`
 * stands: byte-identical to today.
 *
 * Called as a boot side-effect from the agent-tools file-lock authority wiring,
 * AFTER `wireAuthorityRpcTransport()` (HTTP) — so the composite overrides the
 * HTTP-only registration exactly as the README's "deployment rig that calls
 * setPeerRpcTransport AFTER boot still wins" path. Async + flag-gated so the
 * (heavy) shared Hyperswarm is only constructed when the flag is on; a flag flip
 * takes effect on the next operator boot (the swarm + transport are boot-scoped).
 *
 * The RECEIVING side dispatches inbound RPCs through the same pure
 * `handleAuthorityRpc` the HTTP route wraps, with the IDENTICAL guards: re-verify
 * we are the authority for the harness (refuse a mis-routed op during a failover
 * gap) and, when `papercusp-authority-rpc-signed` is on, verify the signed caller
 * (EI-322).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getSharedSwarm, type HyperswarmLike } from '../sync/hyperbee/swarm';
import { resolveDeviceEnvelopeSigner, resolvePeerAddress } from './transport-wiring';
import { HttpPeerRpcTransport, type EnvelopeSignerConfig } from './http-peer-rpc-transport';
import {
  makeAuthorityRpcSwarmTransport,
  type AuthorityRpcDispatch,
} from './authority-rpc-swarm-transport';
import { CompositePeerRpcTransport } from './composite-peer-rpc-transport';
import { setPeerRpcTransport, type PeerRpcTransport } from './peer-rpc-transport';
import { handleAuthorityRpc, type AuthorityRpcEnvelope } from './authority-op-registry';
import { lockAuthorityFor } from './lock-authority';
import { buildAuthorityCallerVerifier } from './verify-authority-caller';

/**
 * The default RECEIVING-side dispatch: run the op through the global authority op
 * registry, guarded exactly like POST /api/authority/rpc — caller-auth (EI-322,
 * flag-gated) then authority re-verification. Reads the signed-enforcement flag
 * per call so a flip takes effect without a restart on the receiving side.
 */
async function defaultDispatch(env: AuthorityRpcEnvelope) {
  const requireSigned = await getFlag(FLAGS.AUTHORITY_RPC_SIGNED, 'system');
  return handleAuthorityRpc(env, {
    verifyCaller: requireSigned ? buildAuthorityCallerVerifier() : undefined,
    verifyIsAuthority: async (harnessSlug) => (await lockAuthorityFor(harnessSlug)).isSelf,
  });
}

export interface WireAuthorityRpcSwarmTransportDeps {
  /** Flag reader (default: real getFlag). */
  getFlag?: (key: string, scope: 'system') => Promise<boolean>;
  /** Resolve THIS machine's device signer (default: resolveDeviceEnvelopeSigner). */
  resolveSigner?: () => Promise<EnvelopeSignerConfig | null>;
  /** Get the shared swarm (default: getSharedSwarm). Only called when the flag is on. */
  getSwarm?: () => Promise<HyperswarmLike>;
  /** Receiving-side dispatch (default: defaultDispatch). */
  dispatch?: AuthorityRpcDispatch;
  /** The HTTP fallback transport (default: a fresh HttpPeerRpcTransport). */
  httpTransport?: PeerRpcTransport;
  /** Register the composed transport (default: setPeerRpcTransport). */
  setTransport?: (t: PeerRpcTransport) => void;
}

let _swarmWired = false;

/**
 * Wire the swarm transport when the flag is on. Idempotent (wires at most once
 * per process). Returns true iff it registered the composite transport, false
 * when the flag is off / no device identity is resolvable (→ HTTP-only stands).
 * Never throws: any failure leaves the HTTP-only registration in place
 * (fail-open, D-004).
 */
export async function wireAuthorityRpcSwarmTransport(
  deps: WireAuthorityRpcSwarmTransportDeps = {},
): Promise<boolean> {
  if (_swarmWired) return false;
  try {
    const getFlagFn = deps.getFlag ?? getFlag;
    const enabled = await getFlagFn(FLAGS.AUTHORITY_RPC_PROTOMUX, 'system');
    if (!enabled) return false;

    // No device identity (gh-unauthenticated / no keychain) → we can't sign our
    // HELLO or RPCs → stay HTTP-only (which itself fails open). Same safe
    // degradation as the HTTP transport's unsigned path.
    const signer = await (deps.resolveSigner ?? resolveDeviceEnvelopeSigner)();
    if (!signer) return false;

    const swarm = await (deps.getSwarm ?? getSharedSwarm)();
    const swarmTransport = makeAuthorityRpcSwarmTransport({
      swarm,
      selfDevicePubkey: signer.devicePubkey,
      envelopeSigner: signer,
      dispatch: deps.dispatch ?? defaultDispatch,
    });
    const httpTransport =
      deps.httpTransport ??
      new HttpPeerRpcTransport({
        resolveAddress: resolvePeerAddress,
        envelopeSigner: resolveDeviceEnvelopeSigner,
      });

    // Swarm first (the connection is already open — zero extra round-trips),
    // HTTP second (addressable peers). Either unreachable falls through; both
    // unreachable → fail-open.
    (deps.setTransport ?? setPeerRpcTransport)(
      new CompositePeerRpcTransport([swarmTransport, httpTransport]),
    );
    _swarmWired = true;
    return true;
  } catch {
    // Any wiring failure → leave HTTP-only registered (fail-open). Never break boot.
    return false;
  }
}

/** Test seam: reset the once-guard. */
export const _testing = {
  reset(): void {
    _swarmWired = false;
  },
};
