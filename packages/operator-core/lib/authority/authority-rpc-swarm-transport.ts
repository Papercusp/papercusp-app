/**
 * authority-rpc-swarm-transport — a PeerRpcTransport that reaches a remote lock
 * authority over the EXISTING per-harness Hyperswarm connection, by multiplexing
 * a request/response RPC channel onto the same connection the substrate already
 * holds open (shared-hive-hardening-2026-06-13 P-001 / D-005, option c).
 *
 * WHY this and not just the HTTP transport. `HttpPeerRpcTransport` POSTs to the
 * authority peer's `:3070/api/authority/rpc`, which only works when that peer is
 * publicly addressable (servers / the Hetzner rig). The product topology is NAT'd
 * desktops, whose `:3070` is not reachable peer-to-peer — but Hyperswarm already
 * NAT-traverses and the substrate already holds an encrypted connection per
 * harness, with a protomux muxer (`socket.userData`) over which it runs the
 * `papercusp/announce` channel. So the robust addressing answer is to ride that
 * same connection: the connection IS the address. This mirrors
 * `cross-hive-swarm-transport.ts` exactly (its own `papercusp/cross-hive` channel
 * + HELLO-pubkey addressing), so it touches NOTHING in `sync/hyperbee/swarm.ts`.
 *
 * Addressing. On channel pair each side sends a HELLO carrying its own
 * `device_pubkey` (the SAME key the lock authority resolves a peer by — see
 * `lock-authority.ts` PeerRef.devicePubkey / the announce body), so
 * `rpc(peer, req)` routes a request to ONLY the channel whose remote is that
 * device — never a broadcast.
 *
 * Request/response. protomux channels carry fire-and-forget messages, so this
 * layers a tiny req/res correlation on top: each request gets a sender-unique id,
 * the response echoes it, and a pending-map resolves the awaiting promise. The
 * RECEIVING side dispatches an inbound request through the transport-agnostic,
 * pure `handleAuthorityRpc` (injected as `dispatch`) and sends the result back on
 * the same channel — the identical authority-side path the HTTP route wraps.
 *
 * Error mapping — byte-identical to HttpPeerRpcTransport so `routeToAuthority`
 * degrades the same way regardless of which transport carried the op:
 *   - no channel to the peer / channel closed / timeout / `not_authority`
 *       → PeerUnreachableError (FAIL OPEN — git is the backstop, D-004).
 *   - `unknown_kind` / `handler_error` / `unauthenticated`
 *       → a regular Error (a genuine op failure on a reachable authority; NOT
 *         masked by fail-open).
 *
 * Caller auth (EI-322). Outgoing requests are signed with the device key via the
 * same `signAuthorityRpc` the HTTP transport uses; the receiving side's
 * `dispatch` (wired to `handleAuthorityRpc` with a `verifyCaller`) verifies it.
 * Unsigned when no signer is configured (loopback / legacy), same safe
 * degradation as the HTTP transport.
 *
 * Pure over an injected `HyperswarmLike` + `Protomux` (mocked in unit tests, the
 * same seam cross-hive-swarm-transport.test.ts / directory-swarm.test.ts use), so
 * the connect → pair → hello → req → res lifecycle unit-tests with a fake swarm +
 * fake muxer, and a two-instance loopback proves cross-"machine" serialization
 * without the network.
 */
import Protomux from 'protomux';
import c from 'compact-encoding';
import type { HyperswarmLike } from '../sync/hyperbee/swarm';
import type { PeerRpcTransport, AuthorityRpcRequest } from './peer-rpc-transport';
import { PeerUnreachableError } from './peer-rpc-transport';
import type { PeerRef } from './lock-authority';
import type { AuthorityRpcEnvelope, HandleAuthorityRpcResult } from './authority-op-registry';
import { signAuthorityRpc, type AuthorityRpcAuth } from './authority-rpc-envelope';
import type { EnvelopeSignerConfig, EnvelopeSignerProvider } from './http-peer-rpc-transport';

/** Protomux protocol id for the authority RPC exchange. */
export const AUTHORITY_RPC_PROTOCOL = 'papercusp/authority-rpc';

/**
 * A wire frame on the authority-rpc channel: a HELLO (announce my device pubkey
 * so the peer can route addressed requests to me), a REQ (an authority op), or a
 * RES (the authority's reply to a REQ, correlated by `id`).
 */
type AuthorityRpcFrame =
  | { t: 'hello'; device_pubkey: string }
  | { t: 'req'; id: string; harnessSlug: string; kind: string; payload: unknown; auth?: AuthorityRpcAuth }
  | { t: 'res'; id: string; ok: boolean; result?: unknown; error?: string; message?: string };

interface OpenRpcChannel {
  send(frame: AuthorityRpcFrame): void;
  /** The remote peer's device pubkey, learned from its HELLO (null until it arrives). */
  remoteDevicePubkey: string | null;
}

/** One outstanding request awaiting its RES (or a timeout / channel-close). */
interface PendingRpc {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  /** The channel the request was sent on — so a channel-close rejects it. */
  channel: OpenRpcChannel;
  /** The peer + op kind, for clean error messages on timeout / failure. */
  peer: PeerRef;
  kind: string;
}

/**
 * Dispatch an inbound authority RPC to the LOCAL authority (the receiving side).
 * Production wires this to `(env) => handleAuthorityRpc(env, { verifyIsAuthority,
 * verifyCaller })`. A transport with no dispatch can still SEND requests but
 * answers every inbound request with `unknown_kind` (it serves nothing).
 */
export type AuthorityRpcDispatch = (
  env: AuthorityRpcEnvelope,
) => Promise<HandleAuthorityRpcResult> | HandleAuthorityRpcResult;

/** The minimal protomux channel surface this transport drives — a message
 *  add (encoding + inbound handler → an outbound send) and `open()`. */
export interface ProtomuxChannelLike {
  addMessage(opts: { encoding?: unknown; onmessage?: (frame: unknown) => void }): { send(value: unknown): void };
  open(): void;
}
/** The minimal muxer surface — `createChannel` returns a channel, or null when a
 *  channel for that protocol already exists on the muxer (duplicate). */
export interface ProtomuxMuxerLike {
  createChannel(spec: { protocol: string; onopen?: () => void; onclose?: () => void }): ProtomuxChannelLike | null;
}
/** The minimal Protomux surface — `from(socket)` → the (possibly shared) muxer.
 *  The real `Protomux` and the test fakes both satisfy this structurally. */
export interface ProtomuxLike {
  from(socket: unknown): ProtomuxMuxerLike;
}

export interface AuthorityRpcSwarmTransportOpts {
  /** The shared process swarm (`getSharedSwarm()`); a fake in tests. */
  swarm: HyperswarmLike;
  /** OUR device pubkey (base64) — sent in the HELLO so peers route requests to us. */
  selfDevicePubkey: string;
  /** Receiving side: dispatch an inbound RPC to the local authority. Default: a
   *  stub that answers `unknown_kind` (send-only transport). */
  dispatch?: AuthorityRpcDispatch;
  /** Per-call timeout ms before a request fails open (default 5000). */
  timeoutMs?: number;
  /** EI-322: sign every outgoing request with the device key (same shape +
   *  memoization as HttpPeerRpcTransport). Default: unsigned. */
  envelopeSigner?: EnvelopeSignerConfig | EnvelopeSignerProvider;
  /** Injected request-id generator (tests). Default: `<self6>-<seq>` — unique
   *  per sender without needing randomness. */
  genId?: () => string;
  /** Injected Protomux (tests pass a controllable fake — the same seam
   *  cross-hive-swarm-transport.test.ts mocks). Default: the real `Protomux`. */
  protomux?: ProtomuxLike;
}

export interface AuthorityRpcSwarmTransport extends PeerRpcTransport {
  /** Detach the connection handler + drop every channel. Idempotent. Rejects any
   *  in-flight requests as unreachable. */
  close(): void;
  /** Connections seen since construction (diagnostics). */
  readonly connectionCount: number;
  /** Currently-open (paired) authority-rpc channels (diagnostics). */
  readonly openChannelCount: number;
}

/**
 * Build a live PeerRpcTransport over the shared swarm. Construction registers a
 * `connection` handler that opens a `papercusp/authority-rpc` channel on each
 * peer connection's muxer, AND attaches to any connections that already exist
 * (the substrate forms harness connections at boot, before this transport is
 * wired — the same retroactive-attach the swarm.ts announce channel does).
 */
export function makeAuthorityRpcSwarmTransport(
  opts: AuthorityRpcSwarmTransportOpts,
): AuthorityRpcSwarmTransport {
  if (!opts.swarm) throw new Error('makeAuthorityRpcSwarmTransport: swarm required');
  if (!opts.selfDevicePubkey) throw new Error('makeAuthorityRpcSwarmTransport: selfDevicePubkey required');

  const mux: ProtomuxLike = opts.protomux ?? (Protomux as unknown as ProtomuxLike);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const dispatch: AuthorityRpcDispatch =
    opts.dispatch ?? (() => ({ ok: false, error: 'unknown_kind', message: 'no authority RPC dispatch wired' }));

  let seq = 0;
  const selfTag = opts.selfDevicePubkey.slice(0, 6);
  const genId = opts.genId ?? (() => `${selfTag}-${++seq}`);

  const channels = new Set<OpenRpcChannel>();
  const pending = new Map<string, PendingRpc>();
  let connectionCount = 0;

  // ── outgoing signer (EI-322), resolved + memoized on first send ──
  const signerProvider: EnvelopeSignerProvider | undefined =
    typeof opts.envelopeSigner === 'function'
      ? opts.envelopeSigner
      : opts.envelopeSigner
        ? () => opts.envelopeSigner as EnvelopeSignerConfig
        : undefined;
  let resolvedSigner: EnvelopeSignerConfig | null | undefined;
  async function resolveSigner(): Promise<EnvelopeSignerConfig | null> {
    if (resolvedSigner !== undefined) return resolvedSigner;
    if (!signerProvider) return (resolvedSigner = null);
    try {
      resolvedSigner = (await signerProvider()) ?? null;
    } catch {
      resolvedSigner = null; // identity unavailable → send unsigned
    }
    return resolvedSigner;
  }

  /** Settle + remove a pending request. */
  function settle(id: string, settleFn: (p: PendingRpc) => void): void {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    settleFn(p);
  }

  /** Reject every in-flight request routed on a (now-closed) channel. */
  function rejectPendingForChannel(channel: OpenRpcChannel): void {
    for (const [id, p] of [...pending]) {
      if (p.channel !== channel) continue;
      settle(id, (entry) =>
        entry.reject(
          new PeerUnreachableError(
            `authority-rpc channel to ${entry.peer.machineLabel} closed before reply`,
            entry.peer,
          ),
        ),
      );
    }
  }

  /** Handle an inbound RES: correlate by id + apply the HTTP-parity error map. */
  function onResponse(frame: Extract<AuthorityRpcFrame, { t: 'res' }>): void {
    settle(frame.id, (p) => {
      if (frame.ok) {
        p.resolve(frame.result);
        return;
      }
      if (frame.error === 'not_authority') {
        // No longer the authority (failover gap) → unreachable so the caller
        // re-resolves / fails open rather than blocking (HTTP parity).
        p.reject(
          new PeerUnreachableError(
            `peer ${p.peer.machineLabel} is no longer the authority for this op`,
            p.peer,
          ),
        );
        return;
      }
      // unknown_kind / handler_error / unauthenticated → a genuine op failure on a
      // reachable authority. Surface it (NOT fail-open) so a real bug isn't masked.
      p.reject(new Error(`authority RPC '${p.kind}' failed (${frame.error ?? 'error'}): ${frame.message ?? ''}`));
    });
  }

  /** Handle an inbound REQ: dispatch to the local authority + reply on the same channel. */
  function onRequest(oc: OpenRpcChannel, frame: Extract<AuthorityRpcFrame, { t: 'req' }>): void {
    const env: AuthorityRpcEnvelope = {
      harnessSlug: frame.harnessSlug,
      kind: frame.kind,
      payload: frame.payload,
      auth: frame.auth,
    };
    void Promise.resolve()
      .then(() => dispatch(env))
      .then((result) => {
        oc.send({ t: 'res', id: frame.id, ok: result.ok, result: result.result, error: result.error, message: result.message });
      })
      .catch((err) => {
        // A throwing dispatch is still a reachable-authority failure → handler_error.
        oc.send({
          t: 'res',
          id: frame.id,
          ok: false,
          error: 'handler_error',
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Open the authority-rpc channel on one connection's muxer (best-effort). */
  function openChannel(socket: unknown): void {
    try {
      const muxer = mux.from(socket);
      const oc: OpenRpcChannel = { send: () => {}, remoteDevicePubkey: null };
      let message: { send(v: AuthorityRpcFrame): void } | null = null;
      const channel = muxer.createChannel({
        protocol: AUTHORITY_RPC_PROTOCOL,
        onopen: () => {
          channels.add(oc);
          try {
            message?.send({ t: 'hello', device_pubkey: opts.selfDevicePubkey });
          } catch {
            /* best-effort */
          }
        },
        onclose: () => {
          channels.delete(oc);
          rejectPendingForChannel(oc);
        },
      });
      if (!channel) return; // already open on this muxer (duplicate) — nothing to do
      message = channel.addMessage({
        encoding: c.json,
        onmessage: (raw: unknown) => {
          if (!raw || typeof raw !== 'object') return;
          const frame = raw as AuthorityRpcFrame;
          if (frame.t === 'hello' && typeof frame.device_pubkey === 'string') {
            oc.remoteDevicePubkey = frame.device_pubkey;
            return;
          }
          if (frame.t === 'req' && typeof frame.id === 'string') {
            onRequest(oc, frame);
            return;
          }
          if (frame.t === 'res' && typeof frame.id === 'string') {
            onResponse(frame);
            return;
          }
        },
      });
      oc.send = (frame: AuthorityRpcFrame) => {
        try {
          message!.send(frame);
        } catch {
          /* best-effort */
        }
      };
      channel.open();
    } catch {
      // The channel is best-effort; a peer that can't speak it just isn't routable.
    }
  }

  const handler = (socket: unknown): void => {
    connectionCount++;
    openChannel(socket);
  };

  opts.swarm.on('connection', handler);
  // Attach to connections that already exist: the substrate joins harness topics +
  // forms peer connections at boot, BEFORE this transport is wired, so those
  // sockets never re-emit 'connection' for us (swarm.ts does the same retroactive
  // attach for its announce channel).
  try {
    for (const socket of opts.swarm.connections ?? []) {
      try {
        handler(socket);
      } catch {
        // per-socket best-effort
      }
    }
  } catch {
    // connections iteration is best-effort (absent on minimal fakes)
  }

  return {
    get connectionCount() {
      return connectionCount;
    },
    get openChannelCount() {
      return channels.size;
    },

    async rpc(peer: PeerRef, req: AuthorityRpcRequest): Promise<unknown> {
      const target = [...channels].find((ch) => ch.remoteDevicePubkey === peer.devicePubkey);
      if (!target) {
        throw new PeerUnreachableError(
          `no authority-rpc channel to peer ${peer.machineLabel} (${peer.devicePubkey.slice(0, 12)}…)`,
          peer,
        );
      }

      // EI-322: sign the op + our device identity so the authority can prove who
      // is calling (and refuse a forged/revoked holder). Unsigned when no signer.
      let auth: AuthorityRpcAuth | undefined;
      const signer = await resolveSigner();
      if (signer) {
        auth = await signAuthorityRpc(
          { harnessSlug: req.harnessSlug, kind: req.kind, payload: req.payload, device_pubkey: signer.devicePubkey },
          signer.sign,
        );
      }

      const id = genId();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle(id, (p) =>
            p.reject(new PeerUnreachableError(`authority peer ${peer.machineLabel} timed out after ${timeoutMs}ms`, peer)),
          );
        }, timeoutMs);
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
        pending.set(id, { resolve, reject, timer, channel: target, peer, kind: req.kind });
        try {
          target.send({ t: 'req', id, harnessSlug: req.harnessSlug, kind: req.kind, payload: req.payload, auth });
        } catch (err) {
          settle(id, (p) =>
            p.reject(
              new PeerUnreachableError(
                `authority-rpc send to ${peer.machineLabel} failed: ${err instanceof Error ? err.message : String(err)}`,
                peer,
              ),
            ),
          );
        }
      });
    },

    close(): void {
      if (opts.swarm.off) opts.swarm.off('connection', handler);
      // Reject anything still in flight as unreachable (fail-open at the caller).
      for (const [id, p] of [...pending]) {
        settle(id, (entry) =>
          entry.reject(new PeerUnreachableError(`authority-rpc transport closing`, entry.peer)),
        );
      }
      channels.clear();
    },
  };
}
