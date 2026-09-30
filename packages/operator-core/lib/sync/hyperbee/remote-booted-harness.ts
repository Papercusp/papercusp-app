/**
 * RemoteBootedHarnessHandle — the main-process proxy for a harness substrate
 * RELOCATED into the sidecar (substrate-sidecar-store-relocation-2026-06-23,
 * P-001).
 *
 * After the relocation the corestore + own-log + merge loop + swarm live in the
 * sidecar (Corestore's process-level file lock forbids the store living in two
 * processes). The main operator therefore holds NO corestore: it reads PG
 * projections (written by the sidecar's merge loop) and routes the few WRITE +
 * control calls over IPC. This proxy implements `BootedHarnessHandle` so it is a
 * drop-in for `getBootedHarness` (the P-004 cutover) without touching the 5
 * log-first producers / control callers.
 *
 * Routing:
 *   - `append(op)`          → `substrate:appendOp` (HLC-stamped in the sidecar).
 *   - `ownLog.append(op)`   → `substrate:appendOp { raw:true }` (the append-only
 *                             claim path; no HLC, op is a fully-formed PeerLogOp).
 *   - `ownLog.keyHex`       → the key the sidecar returned at boot (data; used by
 *                             the outbox-drain's clobber attribution + presence).
 *   - `mergeNow()`          → `substrate:triggerMergeNow`.
 *   - `revoke()` / `rekey()`→ `substrate:revoke` / `substrate:rekey`.
 *   - `close()`             → run local close-hooks, then `substrate:closeStore`.
 *
 * Sidecar-internal members (`store`, `swarm`, `admitted`, `onAnnounce`) are NOT
 * consumed by the main process once the swarm relocates (P-003): `store` throws
 * a precise error (surfacing any stray main-process reader to fix in P-004),
 * `swarm` is null, `admitted` is empty, `onAnnounce` throws.
 */

import * as net from 'node:net';
import { Duplex } from 'node:stream';
import type Corestore from 'corestore';
import type { BootedAnnounceIdentity, BootedHarnessHandle, LocalWriteOp, OwnCompactionOutcome } from './boot';
import type { OwnLog, PeerLogOp } from './peer-log';
import type { ProduceSnapshotResult } from './log-snapshot';
import type { AdmittedLog } from './read-merge';
import type { SwarmHandle } from './swarm';
import type { SignedAnnounce } from './announce';
import type { AdmissionResult } from './read-admission';
import type { SwarmBinding } from './derive-swarm-topic';
import type { ScopeId } from '../pot-git/scope-repo';
import type { ScopeFederation } from './scope-federation';
import type { HiveGitDuplexRequest } from '../pot-git/peer-dial-registry';
import { SubstrateIpcClient } from './substrate-ipc-client';
import { gitServingUnavailable, validateGitServingState, type GitServingRequest, type GitServingState } from '../pot-git/serving-capability';

/** The subset of the IPC client this proxy needs (injectable for tests). */
export interface SubstrateRpcCaller {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

export interface RemoteBootedHarnessOpts {
  workspaceId: string;
  harnessSlug: string;
  /** The sidecar store id returned by `substrate:bootHarness`. */
  storeId: string;
  /** The own-log key the sidecar returned at boot (64-hex). */
  ownLogKey: string;
  /** Own-log length at boot (seeds the locally-tracked length). */
  ownLogLength?: number;
  /**
   * The swarm announce identity the SIDECAR greets peers under, returned by
   * `substrate:bootHarness` (WI-2142873). Undefined when the response carried
   * none — a pre-WI-2142873 sidecar — which is why `announceIdentity` reports
   * `null` rather than inventing one.
   */
  announceIdentity?: BootedAnnounceIdentity | null;
  /** The IPC client (defaults to the process-global substrate IPC client). */
  client: SubstrateRpcCaller;
}

interface AppendOpResponse {
  ok: boolean;
  ownLogLength: number;
  hlc: string | null;
}

interface GetOwnLogOpResponse {
  index: number;
  length: number;
  keyHex: string;
  op: PeerLogOp | null;
}

interface OpenHiveGitDuplexResponse {
  socketPath: string | null;
  topicHex: string | null;
  error?: string;
}

interface ExistingSidecarBootResponse {
  storeId: string;
  ownLogKey: string;
  ownLogLength?: number;
  /** WI-2142873 — absent from a pre-fix sidecar. */
  announceIdentity?: BootedAnnounceIdentity | null;
}

/** Match the in-process peer-dial registry's fail-soft contract: callers get a
 * destroyed Duplex and inspect `.destroyed`/`.errored`, never an IPC exception. */
function destroyedHiveGitDuplex(message: string): Duplex {
  const duplex = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  duplex.on('error', () => {});
  duplex.destroy(new Error(message));
  return duplex;
}

/**
 * Dial pot-git through a sidecar discovered outside this process.
 *
 * The first RPC is intentionally `substrate:bootHarness` with
 * `createIfMissing:false`: the advertised endpoint may be stale or may belong
 * to another local operator instance, and discovery must never mint a new
 * corestore identity as a side effect.  Only an already-booted exact handle can
 * yield the store id needed by `RemoteBootedHarnessHandle`.
 */
export async function openHiveGitDuplexViaExistingSidecar(
  opts: {
    socketPath: string;
    workspaceRoot: string;
    workspaceId: string;
    harnessSlug: string;
    devicePubkeyBase64: string;
    request: HiveGitDuplexRequest;
  },
  deps: {
    client?: SubstrateRpcCaller & { close?: () => void };
  } = {},
): Promise<Duplex> {
  const ownedClient = deps.client ? null : new SubstrateIpcClient(opts.socketPath);
  const client = deps.client ?? ownedClient!;
  try {
    const booted = await client.call<ExistingSidecarBootResponse>('substrate:bootHarness', {
      workspaceRoot: opts.workspaceRoot,
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      createIfMissing: false,
    });
    const handle = new RemoteBootedHarnessHandle({
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      storeId: booted.storeId,
      ownLogKey: booted.ownLogKey,
      ownLogLength: booted.ownLogLength,
      announceIdentity: booted.announceIdentity ?? null,
      client,
    });
    return await handle.openHiveGitDuplexToDevice(opts.devicePubkeyBase64, opts.request);
  } catch (error) {
    return destroyedHiveGitDuplex(
      `pot-git: advertised substrate sidecar discovery failed closed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } finally {
    ownedClient?.close();
  }
}

/** A mutable own-log length, shared by the handle's `append` (LWW seam) and the
 *  own-log shim's `append` (raw claim path) so both report one length. */
interface LengthHolder {
  length: number;
}

/** Own-log shim backed by IPC. Exposes the relocated own-log's key + length,
 *  routes raw appends, and forwards bounded indexed reads to the sidecar. */
class RemoteOwnLog implements OwnLog {
  constructor(
    private readonly storeId: string,
    private readonly client: SubstrateRpcCaller,
    private readonly keyHexValue: string,
    private readonly lengthHolder: LengthHolder,
  ) {}

  async append(op: PeerLogOp): Promise<void> {
    const r = await this.client.call<AppendOpResponse>('substrate:appendOp', {
      storeId: this.storeId,
      op,
      raw: true,
    });
    if (typeof r?.ownLogLength === 'number') this.lengthHolder.length = r.ownLogLength;
  }

  async appendBatch(ops: PeerLogOp[]): Promise<void> {
    for (const op of ops) await this.append(op);
  }

  async get(i: number): Promise<PeerLogOp | null> {
    const r = await this.client.call<GetOwnLogOpResponse>('substrate:getOwnLogOp', {
      storeId: this.storeId,
      index: i,
    });
    if (typeof r?.length === 'number') this.lengthHolder.length = r.length;
    return r?.op ?? null;
  }

  get length(): number {
    return this.lengthHolder.length;
  }

  get keyHex(): string {
    return this.keyHexValue;
  }
}

/**
 * A `BootedHarnessHandle` whose engine lives in the substrate sidecar. Routes
 * writes + control over IPC and reads PG-only.
 */
export class RemoteBootedHarnessHandle implements BootedHarnessHandle {
  readonly workspaceId: string;
  readonly harnessSlug: string;
  private readonly storeId: string;
  private readonly client: SubstrateRpcCaller;
  private readonly _ownLog: RemoteOwnLog;
  private readonly lengthHolder: LengthHolder;
  private readonly closeHooks = new Set<() => void | Promise<void>>();
  private readonly _announceIdentity: BootedAnnounceIdentity | null;
  private closed = false;

  // The main process has no admitted set / swarm — they relocate to the sidecar.
  readonly admitted = new Map<string, AdmittedLog>();

  constructor(opts: RemoteBootedHarnessOpts) {
    this.workspaceId = opts.workspaceId;
    this.harnessSlug = opts.harnessSlug;
    this.storeId = opts.storeId;
    this.client = opts.client;
    this.lengthHolder = { length: opts.ownLogLength ?? 0 };
    this._announceIdentity = opts.announceIdentity ?? null;
    this._ownLog = new RemoteOwnLog(opts.storeId, opts.client, opts.ownLogKey, this.lengthHolder);
  }

  /** The corestore lives in the sidecar — there is no in-process store. A read
   *  here is a relocation bug (a main-process consumer still reaching for the raw
   *  store); the throw names it precisely for the P-004 audit. */
  get store(): Corestore {
    throw new Error(
      `RemoteBootedHarnessHandle.store: the corestore for ${this.harnessSlug} lives in the ` +
        `substrate sidecar (file-lock relocation) — main-process consumers must read PG ` +
        `projections or route over IPC, never the raw store.`,
    );
  }

  get ownLog(): OwnLog {
    return this._ownLog;
  }

  /** The LWW SEND seam — HLC-stamped in the sidecar (its own process clock). */
  async append(op: LocalWriteOp): Promise<void> {
    const r = await this.client.call<AppendOpResponse>('substrate:appendOp', {
      storeId: this.storeId,
      op,
    });
    if (typeof r?.ownLogLength === 'number') this.lengthHolder.length = r.ownLogLength;
  }

  async mergeNow(): Promise<number> {
    const r = await this.client.call<{ mergedOps: number }>('substrate:triggerMergeNow', {
      storeId: this.storeId,
    });
    return r?.mergedOps ?? 0;
  }

  /**
   * P-019 (D-012) — the on-demand head snapshot a no-outage `--sparse` release cut
   * needs. Not implemented over the sidecar transport: `produceLogSnapshot` reads the
   * whole own log and APPENDS to it, and after relocation both the log and the merge
   * gate that must serialize the append live in the sidecar. Doing it from here would
   * mean reading every block over IPC and appending outside that gate — i.e. exactly
   * the race the in-process implementation exists to avoid.
   *
   * Throws with a named cause rather than returning a plausible-looking failure,
   * because the ONE thing this must never do is let a cut believe it has a head
   * snapshot it does not have — the silent 1.9 GB "sparse" seed D-012 traced. The
   * caller (`/api/internal/substrate/head-snapshot`) converts this to `ok:false` and
   * the cut refuses.
   *
   * Wiring a `substrate:produceHeadSnapshot` RPC verb is the real fix and is filed
   * separately; it is not reachable today because the relocation itself
   * (SUBSTRATE_SIDECAR, WI-604) is dark.
   */
  produceHeadSnapshotNow(): Promise<ProduceSnapshotResult> {
    throw new Error(
      `RemoteBootedHarnessHandle.produceHeadSnapshotNow: the own log for ${this.harnessSlug} lives ` +
        'in the substrate sidecar (file-lock relocation), and no substrate:produceHeadSnapshot RPC ' +
        'verb exists yet — so a no-outage sparse cut cannot be taken against a relocated store. ' +
        'Quiesce and cut writable, or drop --sparse. See P-019 / D-012.',
    );
  }

  /**
   * p2p-join-catchup-speed D-023 — a requested own compaction. Not implemented over the
   * sidecar transport for the same reason as `produceHeadSnapshotNow`: the fold and the
   * append belong to whichever process holds the own log.
   */
  compactOwnLogNow(): Promise<OwnCompactionOutcome> {
    throw new Error(
      `RemoteBootedHarnessHandle.compactOwnLogNow: the own log for ${this.harnessSlug} lives in the ` +
        'substrate sidecar (file-lock relocation), and no substrate:compactOwnLog RPC verb exists yet.',
    );
  }

  onAnnounce(_frame: SignedAnnounce): Promise<AdmissionResult> {
    // Announces are accepted + decided inside the sidecar once the swarm
    // relocates (P-003) — the main process never receives them.
    throw new Error(
      'RemoteBootedHarnessHandle.onAnnounce: peer announces are handled inside the ' +
        'substrate sidecar; the main process does not run the swarm after relocation.',
    );
  }

  onAdmitted(_listener: (info: { logKeyHex: string; admittedSize: number }) => void): () => void {
    // Admission events fire in the sidecar; a main-process listener is a no-op
    // until a sidecar→main admission push is wired (P-003). Returns a no-op
    // unsubscribe so callers (audit/perf rigs) don't break.
    return () => {};
  }

  async revoke(devicePubkey: string): Promise<void> {
    await this.client.call('substrate:revoke', { storeId: this.storeId, devicePubkey });
  }

  async reverifyAdmitted(): Promise<void> {
    // Channel-2 re-verification runs inside the sidecar's merge loop. Best-effort
    // no-op on the main side.
  }

  get swarm(): SwarmHandle | null {
    // The swarm lives in the sidecar.
    return null;
  }

  get announceIdentity(): BootedAnnounceIdentity | null {
    // The swarm — and the identity it greets peers under — lives in the
    // sidecar, so this is whatever `substrate:bootHarness` carried back
    // (WI-2142873). It used to be a hardcoded `null`, which sent every
    // git-sync hive leg to the gh-login actor and signed this pot's
    // announcements as a device that does not serve its topic.
    //
    // Still `null` against a pre-WI-2142873 sidecar. That is deliberately NOT
    // repaired by guessing: a caller must distinguish "no identity" from "this
    // handle exists", and `pickHiveGitActor` refuses rather than falling back
    // when the owner reports a booted handle whose identity it cannot read.
    return this._announceIdentity;
  }

  async getGitServingCapability(request: GitServingRequest): Promise<GitServingState> {
    if (this.closed) return gitServingUnavailable('stopped', 'sidecar handle is closed');
    try {
      const status = await this.client.call<{ gitServing?: unknown }>('substrate:getStoreStatus', {
        storeId: this.storeId, gitServingRequest: request,
      });
      return validateGitServingState(status?.gitServing, request);
    } catch (error) {
      return gitServingUnavailable('unknown', `serving owner RPC unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Open a pot-git fetch stream through the relocated sidecar. The control RPC
   * asks the sidecar (which owns both swarm + peer registry) to prepare a
   * bounded one-shot Unix socket; this process connects to it and returns the
   * resulting `net.Socket`, a standard Duplex indistinguishable to git-sync
   * from the in-process registry's stream.
   */
  async openHiveGitDuplexToDevice(
    devicePubkeyBase64: string,
    request: HiveGitDuplexRequest,
  ): Promise<Duplex> {
    try {
      const response = await this.client.call<OpenHiveGitDuplexResponse>(
        'substrate:openHiveGitDuplex',
        {
          storeId: this.storeId,
          devicePubkeyBase64,
          ...request,
        },
      );
      if (!response?.socketPath) {
        return destroyedHiveGitDuplex(
          response?.error ?? `pot-git: sidecar could not dial device ${devicePubkeyBase64.slice(0, 12)}…`,
        );
      }

      const socket = net.createConnection(response.socketPath);
      // Keep the registry's never-unhandled-error contract across the local
      // Unix hop too; downstream may add its own listener after this resolves.
      socket.on('error', () => {});
      return await new Promise<Duplex>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(socket);
        };
        const timeout = setTimeout(() => {
          if (!socket.destroyed) {
            socket.destroy(
              new Error(`pot-git: timed out connecting to substrate stream at ${response.socketPath}`),
            );
          }
          finish();
        }, 5_000);
        timeout.unref?.();
        socket.once('connect', finish);
        socket.once('error', finish);
        socket.once('close', finish);
      });
    } catch (error) {
      return destroyedHiveGitDuplex(
        `pot-git: substrate sidecar dial failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async rekey(binding: SwarmBinding): Promise<void> {
    await this.client.call('substrate:rekey', { storeId: this.storeId, binding });
  }

  /**
   * Scoped-log participation (P-006 §5.1 / P-101 fleet directory) runs where the
   * swarm + scoped store live — the SIDECAR, after the store relocation. Forward
   * to the sidecar's real handle, which unions into the boot's durable declared
   * set and discloses via its live ScopeFederation.
   */
  async ensureScopeParticipation(scopes: readonly ScopeId[]): Promise<void> {
    await this.client.call('substrate:ensureScopeParticipation', {
      storeId: this.storeId,
      scopes,
    });
  }

  /** The immediate redisclosure edge (D-017 n1) also runs in the sidecar's swarm —
   *  forward like `ensureScopeParticipation`. */
  async rediscloseScopes(): Promise<void> {
    await this.client.call('substrate:rediscloseScopes', { storeId: this.storeId });
  }

  /** The scoped-log coordinator lives in the sidecar (like `swarm`). */
  get scopeFederation(): ScopeFederation | null {
    return null;
  }

  registerCloseHook(hook: () => void | Promise<void>): () => void {
    this.closeHooks.add(hook);
    return () => {
      this.closeHooks.delete(hook);
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Run close-hooks first (mirrors boot.ts: hooks before the store tears down).
    for (const hook of this.closeHooks) {
      try {
        await hook();
      } catch (e) {
        // best-effort: a throwing hook never blocks the rest of teardown.
         
        console.warn('[remote-booted-harness] close hook failed:', e instanceof Error ? e.message : String(e));
      }
    }
    this.closeHooks.clear();
    try {
      await this.client.call('substrate:closeStore', { storeId: this.storeId });
    } catch {
      // best-effort: the sidecar may already be gone.
    }
  }
}
