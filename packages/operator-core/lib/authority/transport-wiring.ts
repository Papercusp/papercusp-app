/**
 * transport-wiring — boot registration of the authority RPC wire-leg (P-006 of
 * coord-system-e2e-testing-2026-06-10; closes step 1 of the README's
 * cross-machine cutover list).
 *
 * Before this module, the chain was wired everywhere EXCEPT the transport:
 * locks:acquire/release route through `routeFileLockOp` (fed-reanchor P-060
 * cutover 2), the authority-side op handlers are registered at boot, and
 * `/api/authority/rpc` serves inbound ops — but `getPeerRpcTransport()` still
 * returned the NULL transport in production, so a remote-authority resolution
 * always failed open before ever touching the wire. The proven
 * `HttpPeerRpcTransport` (35 remote crossings on Hetzner,
 * swarm-claim-dispatch.integration.test.ts) was only ever registered by
 * deployment rigs.
 *
 * This module registers it at boot. The one genuinely-missing piece remains
 * ADDRESSING — mapping a PeerRef to its operator base URL. `shared_presence`
 * carries identity, not a network address, so the resolver is a seam:
 *
 *  1. `configurePeerAddressResolver(fn)` — wired by whatever addressing layer
 *     exists in the environment (mesh/tunnel mapping, deployment topology).
 *  2. `PAPERCUSP_AUTHORITY_PEER_ADDRESSES` — a static JSON env map
 *     `{ "<device_pubkey>": "http://host:3070", … }`, the same shape the
 *     Hetzner rigs inject in code. Lets a multi-box deployment light up
 *     cross-machine locks with zero code.
 *  3. Neither → resolve null → `PeerUnreachableError` → fail-open (D-004),
 *     byte-identical to the pre-wiring behavior.
 *
 * So registering this transport changes nothing on a box with no addressing
 * configured — but it collapses the unwired surface to exactly ONE seam, and
 * the fail-open warning (`routeToAuthority`) stays loud the whole way.
 */

import { setPeerRpcTransport } from './peer-rpc-transport';
import {
  HttpPeerRpcTransport,
  type PeerAddressResolver,
  type EnvelopeSignerConfig,
} from './http-peer-rpc-transport';
import type { PeerRef } from './lock-authority';
import { signWithDeviceKey } from '../identity/sign-with-device-key';
import { resolveDeviceKeychainId } from '../identity/device-keychain-id';
import { loadOrGenerateDeviceKeypair } from '../identity/attest';
import { getAuthenticatedGithubUser } from '../identity/resolve-local-github-identity';

export const PEER_ADDRESSES_ENV = 'PAPERCUSP_AUTHORITY_PEER_ADDRESSES';

let _configuredResolver: PeerAddressResolver | null = null;

/**
 * Register the environment's peer-addressing layer. Takes precedence over the
 * env map. Pass null to unregister (→ env map → null → fail-open).
 */
export function configurePeerAddressResolver(fn: PeerAddressResolver | null): void {
  _configuredResolver = fn;
}

let _envMap: Map<string, string> | null = null;
let _envWarned = false;

/** Parse the env map once; malformed JSON warns once and resolves nothing. */
function envAddressMap(): Map<string, string> {
  if (_envMap) return _envMap;
  const raw = process.env[PEER_ADDRESSES_ENV];
  const map = new Map<string, string>();
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [pubkey, url] of Object.entries(parsed)) {
        if (typeof url === 'string' && url) map.set(pubkey, url);
      }
    } catch (err) {
      if (!_envWarned) {
        _envWarned = true;
        console.warn(
          `[authority] ${PEER_ADDRESSES_ENV} is not valid JSON — peer addressing disabled, ` +
            `remote authority ops will fail open: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  _envMap = map;
  return map;
}

/**
 * The composed resolver the boot transport uses: configured resolver first,
 * then the env map, then null (→ unreachable → fail-open).
 */
export async function resolvePeerAddress(peer: PeerRef): Promise<string | null> {
  if (_configuredResolver) {
    const addr = await _configuredResolver(peer);
    if (addr) return addr;
  }
  return envAddressMap().get(peer.devicePubkey) ?? null;
}

let _wired = false;

/**
 * EI-322: the production envelope signer — resolve the local DEVICE identity
 * (the SAME `<github_user_id>:<machine-fingerprint>` keychain key the announce
 * signer uses) once, and sign each outgoing RPC with it via `signWithDeviceKey`.
 * Deliberately leaner than `resolveLocalAnnounceIdentity` — it needs neither a
 * log-core key nor the attestation gist (no extra GitHub round-trip), only the
 * device keypair. Returns null when identity can't be resolved (no gh-auth /
 * keychain) → the RPC goes unsigned, the same safe degradation as the fail-open
 * transport. The transport memoizes this, so the async resolution runs once.
 */
export async function resolveDeviceEnvelopeSigner(): Promise<EnvelopeSignerConfig | null> {
  try {
    const user = await getAuthenticatedGithubUser();
    if (!user) return null;
    const keychainId = resolveDeviceKeychainId(user.id);
    const { pubkeyBase64 } = await loadOrGenerateDeviceKeypair(keychainId);
    return {
      devicePubkey: pubkeyBase64,
      sign: (bytes: Buffer) => signWithDeviceKey(keychainId, bytes),
    };
  } catch {
    return null;
  }
}

/**
 * Register the HTTP authority transport. Idempotent; called at boot from the
 * file-lock authority wiring (agent-tools barrel side-effect). A deployment rig
 * that calls `setPeerRpcTransport` itself AFTER boot still wins — this guard
 * only stops the boot path from re-registering over it.
 *
 * The transport signs every outgoing RPC with the device key (EI-322); the
 * receiving authority requires that signature when `papercusp-authority-rpc-signed`
 * is on. `signerOverride` lets a rig inject a deterministic signer.
 */
export function wireAuthorityRpcTransport(opts?: { signerOverride?: EnvelopeSignerConfig }): void {
  if (_wired) return;
  _wired = true;
  setPeerRpcTransport(
    new HttpPeerRpcTransport({
      resolveAddress: resolvePeerAddress,
      envelopeSigner: opts?.signerOverride ?? resolveDeviceEnvelopeSigner,
    }),
  );
}

/** Test seam: reset the wiring + resolver + env-map cache. */
export const _testing = {
  reset(): void {
    _configuredResolver = null;
    _envMap = null;
    _envWarned = false;
    _wired = false;
  },
};
