/**
 * http-peer-rpc-transport — a concrete PeerRpcTransport that reaches a remote
 * lock authority over HTTP (Phase 2 of
 * distributed-coordination-shared-harness-2026-06-04).
 *
 * The remote leg of routeToAuthority: serialize the {harnessSlug, kind, payload}
 * envelope, POST it to the authority peer's operator endpoint
 * (`<peerBaseUrl>/api/authority/rpc`, which wraps handleAuthorityRpc), and return
 * its result. This mirrors how the lock hook already POSTs to a local operator —
 * just aimed at a remote peer over the mesh.
 *
 * The one piece that is environment-specific is ADDRESSING: mapping a PeerRef
 * (device_pubkey / github_user_id / machine_label) to the peer's base URL. There
 * is no device_pubkey→address map in the tree yet (shared_presence carries the
 * identity but not a network address), so the resolver is INJECTED. The default
 * resolver returns null → every peer is unreachable → routeToAuthority fails open
 * (D-004), which is the correct, safe behavior until a real addressing layer (the
 * mesh / tunnel mapping) is wired. Register a resolver + this transport at boot:
 *
 *   setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: meshAddressFor, token }));
 *
 * Error mapping (so routeToAuthority degrades correctly):
 *   - no address / fetch failure / non-2xx / `not_authority` → PeerUnreachableError
 *     (FAIL OPEN — the authority can't be reached or has moved; git is the backstop).
 *   - `handler_error` / `unknown_kind` → a regular Error (the op genuinely failed
 *     on a reachable authority; this is NOT masked by fail-open).
 */

import type { PeerRpcTransport, AuthorityRpcRequest } from './peer-rpc-transport';
import { PeerUnreachableError } from './peer-rpc-transport';
import type { PeerRef } from './lock-authority';
import type { HandleAuthorityRpcResult } from './authority-op-registry';
import { signAuthorityRpc, type AuthorityRpcAuth } from './authority-rpc-envelope';

/** Resolve a peer to its operator base URL (e.g. `https://<mesh-host>:3070`), or
 *  null when no address is known for it. */
export type PeerAddressResolver = (peer: PeerRef) => string | null | Promise<string | null>;

/**
 * EI-322: sign an outgoing RPC with the local device key, producing the
 * `auth` wrapper the authority verifies. Production wires this to the device
 * keychain (`{ devicePubkey, sign: bytes => signWithDeviceKey(id, bytes) }`);
 * when absent, requests go unsigned (loopback / legacy peers) and the receiving
 * route decides whether to require auth.
 */
export interface EnvelopeSignerConfig {
  /** Raw 32-byte Ed25519 device public key, base64 (the announce pubkey). */
  devicePubkey: string;
  /** Sign `bytes` with the device private key → raw 64-byte signature. */
  sign: (bytes: Buffer) => Promise<Buffer>;
}

/**
 * Lazily resolve the signer config. Production resolves the device identity
 * (an async keychain/gh-auth step) once at first send and memoizes; returns null
 * when identity is unavailable (→ send unsigned, the same degradation as the
 * null transport's fail-open). Tests pass `() => ({ devicePubkey, sign })`.
 */
export type EnvelopeSignerProvider = () => EnvelopeSignerConfig | null | Promise<EnvelopeSignerConfig | null>;

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface HttpPeerRpcTransportOpts {
  /** Map a peer to its base URL. Default: () => null (no addressing → fail open). */
  resolveAddress?: PeerAddressResolver;
  /** Bearer token for the remote operator (the mesh is authenticated). */
  token?: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Per-call timeout ms. Default 5000. */
  timeoutMs?: number;
  /** Path on the peer operator that wraps handleAuthorityRpc. Default /api/authority/rpc. */
  path?: string;
  /** EI-322: sign every outgoing RPC with the device key. Default: unsigned. A
   *  config object is wrapped as a constant provider; a provider is resolved +
   *  memoized on first send. */
  envelopeSigner?: EnvelopeSignerConfig | EnvelopeSignerProvider;
}

export class HttpPeerRpcTransport implements PeerRpcTransport {
  private readonly resolveAddress: PeerAddressResolver;
  private readonly token?: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly path: string;
  private readonly signerProvider?: EnvelopeSignerProvider;
  private _signer?: EnvelopeSignerConfig | null;

  constructor(opts: HttpPeerRpcTransportOpts = {}) {
    this.resolveAddress = opts.resolveAddress ?? (() => null);
    this.token = opts.token;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.path = opts.path ?? '/api/authority/rpc';
    const s = opts.envelopeSigner;
    this.signerProvider = typeof s === 'function' ? s : s ? () => s : undefined;
  }

  /** Resolve + memoize the signer config (the provider's async identity step
   *  runs at most once). */
  private async resolveSigner(): Promise<EnvelopeSignerConfig | null> {
    if (this._signer !== undefined) return this._signer;
    if (!this.signerProvider) return (this._signer = null);
    try {
      this._signer = (await this.signerProvider()) ?? null;
    } catch {
      this._signer = null; // identity unavailable → send unsigned
    }
    return this._signer;
  }

  async rpc(peer: PeerRef, req: AuthorityRpcRequest): Promise<unknown> {
    const base = await this.resolveAddress(peer);
    if (!base) {
      throw new PeerUnreachableError(
        `no address known for authority peer ${peer.machineLabel} (${peer.devicePubkey.slice(0, 12)}…)`,
        peer,
      );
    }
    const url = base.replace(/\/$/, '') + this.path;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    // EI-322: sign the op + our device identity so the authority can prove who
    // is calling (and refuse a forged/revoked holder). Unsigned when no signer.
    let auth: AuthorityRpcAuth | undefined;
    const signer = await this.resolveSigner();
    if (signer) {
      auth = await signAuthorityRpc(
        { harnessSlug: req.harnessSlug, kind: req.kind, payload: req.payload, device_pubkey: signer.devicePubkey },
        signer.sign,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: { ok: boolean; status: number; json: () => Promise<unknown> };
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ harnessSlug: req.harnessSlug, kind: req.kind, payload: req.payload, auth }),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure / timeout / connection refused → unreachable → fail open.
      throw new PeerUnreachableError(
        `authority peer ${peer.machineLabel} unreachable: ${err instanceof Error ? err.message : String(err)}`,
        peer,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new PeerUnreachableError(`authority peer ${peer.machineLabel} returned HTTP ${res.status}`, peer);
    }

    const body = (await res.json()) as HandleAuthorityRpcResult;
    if (body.ok) return body.result;

    // The authority was reached but declined / failed the op.
    if (body.error === 'not_authority') {
      // It is no longer the authority (a failover gap) → treat as unreachable so
      // the caller re-resolves / fails open rather than blocking.
      throw new PeerUnreachableError(`peer ${peer.machineLabel} is no longer the authority for ${req.harnessSlug}`, peer);
    }
    // unknown_kind / handler_error → a genuine op failure on a reachable
    // authority. Surface it (NOT fail-open) so a real bug isn't masked.
    throw new Error(`authority RPC '${req.kind}' failed (${body.error ?? 'error'}): ${body.message ?? ''}`);
  }
}
