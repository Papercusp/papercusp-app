/**
 * Substrate sidecar HOST — the RPC method implementations the substrate sidecar
 * process serves, extracted from `apps/operator/bin/substrate-sidecar.ts` so the
 * logic is unit-testable in-process (no `npx tsx` child, no Unix socket) and can
 * import the real operator-core engine.
 *
 * Why this module exists (substrate-sidecar-store-relocation-2026-06-23, P-001):
 * Corestore 7.x holds a PROCESS-LEVEL file lock per storage path, so the harness
 * store can live in EXACTLY ONE process. The relocation moves the store — and
 * therefore the own-log + merge loop + projections + swarm/admission +
 * outbox/presence send-side — into the sidecar; the main process routes every
 * `handle.append()` over IPC and reads PG-only. This host owns the relocated
 * stores and serves:
 *
 *   - the EXISTING replication-offload methods (openStore / prepareSocketHandoff
 *     / attachSocket / getCoreInfo, the Option-B socket-handoff the live swarm
 *     path calls by name — preserved byte-for-byte) AND
 *   - the NEW full-store methods this plan adds: `bootHarness` opens the store +
 *     own-log and returns the own-log key; `substrate:appendOp` HLC-stamps a
 *     `LocalWriteOp` and appends it to the relocated own-log — the IPC twin of
 *     `boot.ts` `handle.append`. `getStoreStatus.ownLogLength` reports the real
 *     own-log length.
 *
 * P-002/P-003 relocate the merge loop, PG projections, swarm join/admission,
 * and outbox/presence send-side into this host by booting the real substrate
 * handle here and delegating the remote-control RPCs (`mergeNow`, `onAnnounce`,
 * `revoke`, `rekey`) to it.
 *
 * Everything here is reached ONLY when the OFF-by-default `papercusp-substrate-
 * sidecar` flag is ON; the OFF path never spawns the sidecar.
 */

/// <reference path="./holepunch.d.ts" />

import { mkdir, unlink } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import Corestore from 'corestore';
import type { HlcClock } from '@papercusp/locks-core';
import { openOwnLog, type OwnLog, type PeerLogOp } from './peer-log';
import { stampOpHlc } from './hlc-stamp';
import { bootHarnessSubstrate, type BootedHarnessHandle, type BootHarnessOpts, type LocalWriteOp } from './boot';
import type { SwarmBinding } from './derive-swarm-topic';
import { refreshOutboxEpochEncryptForHarness, wireOutboxForHarness } from './wire-outbox';
import { wirePresenceAnnounceForHarness } from './wire-presence';
import { listBootHistory, bootHistoryDepth, type ListBootHistoryOpts } from './boot-history';
import { getReplicationLiveness } from './replication-liveness';
import { createPgMergeCursorStore } from './pg-merge-cursor-store';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { openHiveGitDuplexToDevice, type HiveGitDuplexRequest } from '../pot-git/peer-dial-registry';

/**
 * Minimal Hypercore surface used by the observability methods. corestore's
 * `.get()` return type is loosely typed across builds; we pin only the members
 * we touch so tsc stays honest without an `any`.
 */
interface HypercoreLike {
  ready(): Promise<void>;
  update(opts?: { wait?: boolean }): Promise<unknown>;
  get(index: number, opts?: { wait?: boolean }): Promise<Buffer>;
  download(range: { start: number; end: number }): { done(): Promise<void> } | Promise<void>;
  length: number;
  byteLength: number;
  key: Buffer;
}

/** One opened corestore + its own-log + live replication connections. */
interface StoreRecord {
  workspaceId: string;
  harnessSlug: string;
  storagePath: string;
  store: Corestore | null;
  booted: BootedHarnessHandle | null;
  /** The peer's OWN writable log. Opened by `bootHarness` (and lazily by
   *  `appendOp`); null until then. The append seam writes here. */
  ownLog: OwnLog | null;
  connections: Set<string>;
}

/** A pending socket handoff awaiting its out-of-band handle. */
interface HandoffEntry {
  storeId: string;
  peerId?: string;
  handle: Duplex | null;
  used: boolean;
  createdAt: number;
  onHandle: ((handle: Duplex) => void) | null;
}

/** How long attachSocket waits for the out-of-band handle to arrive. */
const HANDOFF_HANDLE_TIMEOUT_MS = 10_000;
/** Idle prepared handoffs expire so a never-completed token can't leak. */
const HANDOFF_TTL_MS = 60_000;
/** A prepared pot-git stream socket is single-use and short-lived. If the main
 * process never connects (crash/race), both the listener and peer Duplex are
 * destroyed instead of leaking in the long-lived sidecar. */
const HIVE_GIT_TUNNEL_TTL_MS = 10_000;

/** JSON-RPC error carrying a specific code (defaults to -32603 otherwise). */
export class RpcMethodError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'RpcMethodError';
  }
}

export interface SubstrateSidecarHostDeps {
  /** Override the Corestore factory (tests inject an in-memory / temp store).
   *  Default: `new Corestore(storagePath)`. */
  createStore?: (storagePath: string) => Corestore;
  /** Override own-log open (tests). Default: peer-log `openOwnLog`. */
  openOwnLogImpl?: (store: Corestore) => Promise<OwnLog>;
  /** Override the process HLC clock used by the append seam (tests want a
   *  deterministic clock). Default: the sidecar's process-global HLC. */
  hlcClock?: HlcClock;
  /** Override full substrate boot (tests). Default: bootHarnessSubstrate. */
  bootHarnessImpl?: (opts: BootHarnessOpts) => Promise<BootedHarnessHandle>;
  /** Override outbox wiring for the relocated boot. Default: real PG + outbox drain. */
  wireOutbox?: (handle: BootedHarnessHandle) => Promise<void>;
  /** Override presence wiring for the relocated boot. Default: wirePresenceAnnounceForHarness. */
  wirePresence?: (handle: BootedHarnessHandle) => Promise<void>;
  /** Override the sidecar-local pot-git registry dial (tests). */
  openHiveGitDuplex?: (topic: Buffer, devicePubkeyBase64: string, request: HiveGitDuplexRequest) => Promise<Duplex>;
  /** Directory for the bounded one-shot stream sockets (tests). */
  hiveGitTunnelDir?: string;
  /** Prepared-socket lifetime before fail-closed teardown (tests). */
  hiveGitTunnelTtlMs?: number;
}

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface SubstrateSidecarHost {
  /** The JSON-RPC method table the socket server dispatches to. */
  readonly methods: Record<string, RpcHandler>;
  /** Receive a Duplex handle transferred from the main process over the child
   *  IPC channel, correlated to a prepared handoff by token. Called by the bin's
   *  `process.on('message')`. */
  receiveHandle(handoffToken: string, handle: Duplex): void;
  /** Number of opened stores (tests / diagnostics). */
  storeCount(): number;
  /** Close every opened store. Idempotent. */
  closeAll(): Promise<void>;
}

// ─── store path resolution ──────────────────────────────────────────────────

interface OpenStoreRequest {
  workspaceId: string;
  harnessSlug: string;
  workspaceRoot?: string;
  storagePath?: string;
}

/** Mirror corestore.ts: `<workspaceRoot>/.papercusp/<harness>/hyperbee`. */
function resolveStoragePath(p: OpenStoreRequest): string {
  if (p.storagePath) return p.storagePath;
  // WI-2105: NO process.cwd() fallback. A workspaceRoot-less request minted a
  // fresh split-brain store under the service's WorkingDirectory
  // (apps/operator/.papercusp/papercusp/hyperbee, born 2026-07-03 19:42) with
  // its own log key. Fail loud; the caller must say which store it means.
  if (!p.workspaceRoot) {
    throw new RpcMethodError(
      -32602,
      `missing workspaceRoot (and no storagePath) for ${p.workspaceId}/${p.harnessSlug} — refusing to derive a store path from cwd`,
    );
  }
  return path.join(p.workspaceRoot, '.papercusp', p.harnessSlug, 'hyperbee');
}

interface AppendOpRequest {
  storeId: string;
  op: LocalWriteOp | PeerLogOp;
  /**
   * RAW append: skip the HLC SEND stamp and append the op verbatim (the op is a
   * fully-formed `PeerLogOp` carrying its own `author_pubkey`). The append-only
   * claim path (`handle.ownLog.append`) is distinct-key per attempt + never LWW,
   * so it correctly carries no HLC — mirrors `boot.ts` using raw `ownLog.append`
   * for claims while `handle.append` stamps. Default false (the LWW seam).
   */
  raw?: boolean;
}

interface BootHarnessRequest {
  workspaceId: string;
  harnessSlug: string;
  workspaceRoot?: string;
  storagePath?: string;
  swarmBinding?: SwarmBinding | null;
  /**
   * EI-7154 guard (a): default true (unchanged behavior) — set false for a
   * read-only/diagnostic probe. When true a probe against an idle/orphaned
   * sidecar that never booted this (workspaceId, harnessSlug) pair silently
   * MINTS a brand-new store + own-log (a stray-identity trap, same class as
   * WI-1981/WI-2018) instead of erroring — the exact incident this guards.
   * With false, a miss on `findExisting` throws instead of booting fresh, so a
   * probe against the wrong sidecar fails loudly rather than minting state.
   */
  createIfMissing?: boolean;
}

interface OpenHiveGitDuplexRequest extends HiveGitDuplexRequest {
  storeId: string;
  devicePubkeyBase64: string;
}

interface OneShotUnixTunnel {
  socketPath: string;
  close(error?: Error): void;
  closed: Promise<void>;
}

/**
 * Expose one already-open peer Duplex through a single-use Unix socket. The
 * accepted local socket and the peer stream share the same mutual-teardown
 * primitive as the replication-offload path, so a close/error on either side
 * cannot strand the other. The listener is removed after the first accept and
 * expires if no client arrives within `ttlMs`.
 */
async function createOneShotUnixTunnel(peer: Duplex, socketDir: string, ttlMs: number): Promise<OneShotUnixTunnel> {
  await mkdir(socketDir, { recursive: true });
  const socketPath = path.join(socketDir, `pc-hg-${process.pid}-${crypto.randomBytes(8).toString('hex')}.sock`);

  let accepted = false;
  let closed = false;
  let local: Duplex | null = null;
  let timeout: NodeJS.Timeout | null = null;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = net.createServer();

  const removeSocket = (): void => {
    void unlink(socketPath).catch(() => {
      // Best-effort: close/unlink races are normal for Unix sockets.
    });
  };
  const close = (error?: Error): void => {
    if (closed) return;
    closed = true;
    if (timeout) clearTimeout(timeout);
    timeout = null;
    try {
      server.close();
    } catch {
      // The listener may already be closed after its one accepted client.
    }
    removeSocket();
    if (local && !local.destroyed) local.destroy(error);
    if (!peer.destroyed) peer.destroy(error);
    resolveClosed();
  };

  // A timeout/error may destroy the peer before any consumer has installed an
  // error listener. Keep that fail-soft stream contract here at its owner.
  peer.on('error', () => {});
  server.on('connection', (socket) => {
    if (accepted || closed) {
      socket.destroy();
      return;
    }
    accepted = true;
    local = socket;
    if (timeout) clearTimeout(timeout);
    timeout = null;
    server.close(removeSocket);
    pipeWithMutualTeardown(socket, peer);
    socket.once('close', () => close());
    peer.once('close', () => close());
  });

  await new Promise<void>((resolve, reject) => {
    let listening = false;
    server.once('error', (error) => {
      close(error);
      if (!listening) reject(error);
    });
    server.listen(socketPath, () => {
      listening = true;
      timeout = setTimeout(() => close(new Error('substrate hive-git stream tunnel expired before connect')), ttlMs);
      timeout.unref?.();
      resolve();
    });
  });

  return { socketPath, close, closed: closedPromise };
}

/**
 * Build a substrate sidecar host. Owns the relocated stores + the handoff table;
 * returns the JSON-RPC method map + the out-of-band handle receiver. Pure over
 * its deps so it unit-tests without a process/socket.
 */
export function createSubstrateSidecarHost(deps: SubstrateSidecarHostDeps = {}): SubstrateSidecarHost {
  const createStore = deps.createStore ?? ((storagePath: string) => new Corestore(storagePath));
  const openOwnLogImpl = deps.openOwnLogImpl ?? openOwnLog;
  const hlcClock = deps.hlcClock;
  const bootHarnessImpl = deps.bootHarnessImpl ?? bootHarnessSubstrate;
  const wireOutbox = deps.wireOutbox ?? defaultWireOutbox;
  const wirePresence = deps.wirePresence ?? wirePresenceAnnounceForHarness;
  const openHiveGitDuplex = deps.openHiveGitDuplex ?? openHiveGitDuplexToDevice;
  const hiveGitTunnelDir = deps.hiveGitTunnelDir ?? tmpdir();
  const hiveGitTunnelTtlMs = deps.hiveGitTunnelTtlMs ?? HIVE_GIT_TUNNEL_TTL_MS;

  const storeMap = new Map<string, StoreRecord>();
  const handoffs = new Map<string, HandoffEntry>();
  const hiveGitTunnels = new Set<OneShotUnixTunnel>();
  // Send-side wiring is idempotent + retryable (mirrors boot-all.ts
  // `ensureSendSideWired`): each leg is marked wired ONLY on success and skipped
  // once wired, keyed by `${workspaceId}::${harnessSlug}`. This is what makes it
  // SAFE to wire from BOTH `handleBootHarness` (boot) AND `handleRekey` (the
  // re-key that brings a joined/created harness onto its Hive topic) — a second
  // drain loop would double-append + double-GC the same outbox. Cleared on close
  // so a re-boot re-wires (the close-hook stops the prior drain).
  const outboxWired = new Set<string>();
  const presenceWired = new Set<string>();
  let nextStoreId = 1;
  let nextConnId = 1;
  let nextHandoffId = 1;

  function findExisting(workspaceId: string, harnessSlug: string): string | null {
    const key = `${workspaceId}::${harnessSlug}`;
    for (const [id, rec] of storeMap) {
      if (`${rec.workspaceId}::${rec.harnessSlug}` === key) return id;
    }
    return null;
  }

  /** Open (idempotently) the harness store. Does NOT open the own-log — the
   *  offload path only replicates. `bootHarness`/`appendOp` open the own-log. */
  async function ensureStore(p: OpenStoreRequest): Promise<{ storeId: string; isNew: boolean }> {
    if (!p.workspaceId || !p.harnessSlug) {
      throw new RpcMethodError(-32602, 'Missing workspaceId or harnessSlug');
    }
    const existing = findExisting(p.workspaceId, p.harnessSlug);
    if (existing) return { storeId: existing, isNew: false };

    const storagePath = resolveStoragePath(p);
    await mkdir(storagePath, { recursive: true });
    const store = createStore(storagePath);
    await store.ready();

    const storeId = `store-${nextStoreId++}`;
    storeMap.set(storeId, {
      workspaceId: p.workspaceId,
      harnessSlug: p.harnessSlug,
      storagePath,
      store,
      booted: null,
      ownLog: null,
      connections: new Set(),
    });
    return { storeId, isNew: true };
  }

  /** Open the own-log on a record if not already open. Returns it. */
  async function ensureOwnLog(rec: StoreRecord): Promise<OwnLog> {
    if (rec.booted) return rec.booted.ownLog;
    if (rec.ownLog) return rec.ownLog;
    if (!rec.store) throw new RpcMethodError(-32000, 'Store is closed');
    rec.ownLog = await openOwnLogImpl(rec.store);
    return rec.ownLog;
  }

  function requireRecord(storeId: string): StoreRecord {
    const rec = storeMap.get(storeId);
    if (!rec) throw new RpcMethodError(-32000, 'Store not found');
    return rec;
  }

  // ── methods ────────────────────────────────────────────────────────────────

  function handleHealthz(): unknown {
    return { status: 'ready', uptime_ms: process.uptime() * 1000, timestamp: new Date().toISOString() };
  }

  async function handleOpenStore(params: unknown): Promise<unknown> {
    return ensureStore(params as OpenStoreRequest);
  }

  async function handleCloseStore(params: unknown): Promise<unknown> {
    const p = params as { storeId: string };
    const rec = storeMap.get(p.storeId);
    if (rec?.booted) {
      try {
        await rec.booted.close();
      } catch {
        // best-effort: a booted handle that already closed shouldn't fail the RPC
      }
    }
    if (rec?.store) {
      try {
        await rec.store.close();
      } catch {
        // best-effort: a store that already closed shouldn't fail the RPC
      }
    }
    if (rec) {
      // Forget the send-side-wired flags so a re-boot of the same harness
      // re-wires (the booted handle's close-hook already stopped its drain).
      const k = `${rec.workspaceId}::${rec.harnessSlug}`;
      outboxWired.delete(k);
      presenceWired.delete(k);
    }
    storeMap.delete(p.storeId);
    return { ok: true };
  }

  async function handleGetStoreStatus(params: unknown): Promise<unknown> {
    const rec = requireRecord((params as { storeId: string }).storeId);
    const handle = rec.booted;
    const request = (params as { gitServingRequest?: import('../pot-git/serving-capability').GitServingRequest }).gitServingRequest;
    const gitServing = request
      ? request.workspaceId !== rec.workspaceId
        ? { status: 'absent', retryable: true, reason: 'workspace does not belong to this serving handle' }
        : await handle?.getGitServingCapability?.(request) ??
          { status: 'unknown', retryable: true, reason: 'owner supplies no serving capability' }
      : undefined;
    return {
      isOpen: !!(handle ?? rec.store),
      ownLogLength: handle?.ownLog.length ?? rec.ownLog?.length ?? 0,
      ownLogKey: handle?.ownLog.keyHex ?? rec.ownLog?.keyHex ?? null,
      admittedPeerCount: handle?.admitted.size ?? rec.connections.size,
      lastMergeAt: null,
      swarmJoined: !!handle?.swarm,
      ...(request ? { gitServing } : {}),
    };
  }

  /** Full-store boot: open the store + own-log + merge/admission/swarm engine
   *  and return the own-log key the main-side proxy needs immediately. */
  async function handleBootHarness(params: unknown): Promise<unknown> {
    const p = params as BootHarnessRequest;
    if (!p.workspaceId || !p.harnessSlug) {
      throw new RpcMethodError(-32602, 'Missing workspaceId or harnessSlug');
    }
    // WI-2105: bootHarnessImpl derives the REAL store path from workspaceRoot
    // (corestore.ts storagePath(); the request's storagePath field is only
    // bookkeeping here) — so a cwd fallback mints a split-brain store under the
    // service's WorkingDirectory with its own log key (the 19:42 stray store).
    // Require it; never guess from cwd.
    if (!p.workspaceRoot) {
      throw new RpcMethodError(
        -32602,
        `bootHarness requires workspaceRoot for ${p.workspaceId}/${p.harnessSlug} — refusing to boot a store derived from cwd`,
      );
    }
    const existing = findExisting(p.workspaceId, p.harnessSlug);
    if (existing) {
      const rec = requireRecord(existing);
      if (rec.booted) {
        return {
          storeId: existing,
          ownLogKey: rec.booted.ownLog.keyHex,
          ownLogLength: rec.booted.ownLog.length,
          swarmTopicHex: null,
          // WI-2142873: the swarm — and the identity it greets peers under —
          // lives HERE, in the sidecar. Without carrying it back, the main
          // process's `RemoteBootedHarnessHandle` reports no identity and every
          // git-sync hive leg signs pot announcements as the gh-login device
          // instead: announcements no peer can dial, because peers file our
          // socket under the device in the HELLO, not the one in the signature.
          announceIdentity: rec.booted.announceIdentity ?? null,
          mergeLoopStarted: true,
          admittedPeerCount: rec.booted.admitted.size,
        };
      }
    }

    // EI-7154 guard (a): a probe that explicitly asked for existing-only
    // semantics gets a clear, loud error instead of this (possibly wrong)
    // sidecar silently minting a fresh store + own-log for a harness it never
    // booted — the exact stray-identity incident this guards against.
    if (!existing && p.createIfMissing === false) {
      throw new RpcMethodError(
        -32001,
        `bootHarness: no existing store for ${p.workspaceId}/${p.harnessSlug} on this sidecar and ` +
          `createIfMissing:false was requested — refusing to mint a fresh store. This sidecar is either ` +
          `not the one hosting this harness, or the harness genuinely hasn't booted yet.`,
      );
    }

    const storagePath = resolveStoragePath(p);
    // WI-2105 REV fix (flag-gated, default ON): inject a durable PG-backed merge
    // cursor so a bg-host restart RESUMES each admitted log's fold from PG instead
    // of re-folding from 0 (the fold that starved routinesTick → the bghost-
    // watchdog restart loop → the REV leg never reached tail). Constructed HERE,
    // not inside bootHarnessSubstrate, so the boot function stays PG-free and
    // hermetic for its many merge tests. Lazy — no PG connection until the first
    // seed/persist. OFF ⇒ null ⇒ in-memory cursor only (pre-fix behavior).
    const mergeCursorStore = (await getFlag(FLAGS.SUBSTRATE_MERGE_CURSOR_PG, 'system').catch(() => true))
      ? createPgMergeCursorStore(p.workspaceId, p.harnessSlug)
      : null;
    const handle = await bootHarnessImpl({
      workspaceRoot: p.workspaceRoot,
      workspaceId: p.workspaceId,
      harnessSlug: p.harnessSlug,
      swarmBinding: p.swarmBinding ?? null,
      storagePath,
      hlcClock,
      mergeCursorStore,
    } as BootHarnessOpts & { storagePath?: string });
    await ensureRelocatedSendSideWired(handle);

    const storeId = existing ?? `store-${nextStoreId++}`;
    storeMap.set(storeId, {
      workspaceId: p.workspaceId,
      harnessSlug: p.harnessSlug,
      storagePath,
      store: null,
      booted: handle,
      ownLog: handle.ownLog,
      connections: new Set(),
    });
    return {
      storeId,
      ownLogKey: handle.ownLog.keyHex,
      ownLogLength: handle.ownLog.length,
      swarmTopicHex: null,
      // WI-2142873 — see the existing-record branch above.
      announceIdentity: handle.announceIdentity ?? null,
      mergeLoopStarted: true,
      admittedPeerCount: handle.admitted.size,
    };
  }

  /**
   * The IPC append seam — the twin of `boot.ts` `handle.append`. HLC-stamps the
   * op on the sidecar's own process clock (correct: a real peer is a separate
   * process with an independent clock) and appends it to the relocated own-log.
   */
  async function handleAppendOp(params: unknown): Promise<unknown> {
    const p = params as AppendOpRequest;
    if (!p || !p.storeId || !p.op) {
      throw new RpcMethodError(-32602, 'appendOp requires { storeId, op }');
    }
    const rec = requireRecord(p.storeId);
    if (rec.booted) {
      if (p.raw) {
        await rec.booted.ownLog.append(p.op as PeerLogOp);
        return { ok: true, ownLogLength: rec.booted.ownLog.length, hlc: (p.op as PeerLogOp).hlc ?? null };
      }
      await rec.booted.append(p.op as LocalWriteOp);
      return { ok: true, ownLogLength: rec.booted.ownLog.length, hlc: null };
    }
    const ownLog = await ensureOwnLog(rec);

    if (p.raw) {
      // Raw claim-path append: the op is already a fully-formed PeerLogOp.
      const raw = p.op as PeerLogOp;
      await ownLog.append({
        type: raw.type,
        table: raw.table,
        hbKey: raw.hbKey,
        value: raw.value,
        ts: raw.ts,
        schema_version: raw.schema_version,
        hlc: raw.hlc,
        author_pubkey: raw.author_pubkey ?? '',
        // A raw PeerLogOp is already wire-shaped. Preserve the re-key epoch just
        // like HLC; dropping it leaves ciphertext looking like plaintext on the
        // receiver and makes the merge cursor advance past an unapplied row.
        epoch: raw.epoch,
      });
      return { ok: true, ownLogLength: ownLog.length, hlc: raw.hlc ?? null };
    }

    const stamped = stampOpHlc(p.op as LocalWriteOp, hlcClock ?? undefined);
    const peerOp: PeerLogOp = {
      type: stamped.type,
      table: stamped.table,
      hbKey: stamped.hbKey,
      value: stamped.value,
      ts: stamped.ts,
      schema_version: stamped.schema_version,
      hlc: stamped.hlc,
      // STAGE-5 (mirrors boot.ts): thread the real device pubkey when the claim
      // rewrite lands; until then attribute to the write's clobber pubkey.
      author_pubkey: stamped.writerPubkey ?? '',
      // WI-5333 / P-505: mirror boot.ts's in-process append seam. The outbox
      // encryptor stamps this field alongside the ciphertext; omitting it here
      // made relocated-sidecar writes reach the remote decrypt gate with
      // `epoch == null`, where they were treated as plaintext, rejected by the
      // projection, and then permanently skipped as the merge cursor advanced.
      epoch: stamped.epoch,
    };
    await ownLog.append(peerOp);
    return { ok: true, ownLogLength: ownLog.length, hlc: stamped.hlc };
  }

  /**
   * Bring the relocated harness's send-side loops (outbox drain + presence
   * announce) online — idempotently + retryably (mirrors boot-all.ts
   * `ensureSendSideWired`). Each leg runs only until it SUCCEEDS, then no-ops;
   * a failure is LOGGED (never thrown — it must not break boot/rekey) and retried
   * on the next call. Called from BOTH `handleBootHarness` (boot) and
   * `handleRekey` (the re-key onto the Hive topic), so the idempotence guard is
   * what stops a re-key from starting a SECOND drain loop on an already-wired
   * harness while still wiring one whose boot-time wiring never took.
   */
  async function ensureRelocatedSendSideWired(handle: BootedHarnessHandle): Promise<void> {
    const k = `${handle.workspaceId}::${handle.harnessSlug}`;
    if (!outboxWired.has(k)) {
      try {
        await wireOutbox(handle);
        outboxWired.add(k);
      } catch (e) {
        console.error(
          `[substrate-sidecar-host] outbox wiring failed for ${k}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (!presenceWired.has(k)) {
      try {
        await wirePresence(handle);
        presenceWired.add(k);
      } catch (e) {
        console.error(
          `[substrate-sidecar-host] presence wiring failed for ${k}:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  async function defaultWireOutbox(handle: BootedHarnessHandle): Promise<void> {
    const { sql } = (await import('@papercusp/db-org')).getOrgPg();
    await wireOutboxForHarness(handle, sql);
  }

  async function handleOnAnnounce(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; announce: unknown };
    const rec = requireRecord(p.storeId);
    if (!rec.booted) throw new RpcMethodError(-32000, 'Harness is not booted in the sidecar');
    return rec.booted.onAnnounce(p.announce as never);
  }
  async function handleTriggerMergeNow(params: unknown): Promise<unknown> {
    const p = params as { storeId: string };
    const rec = requireRecord(p.storeId);
    if (!rec.booted) return { mergedOps: 0, durationMs: 0 };
    const started = Date.now();
    const mergedOps = await rec.booted.mergeNow();
    return { mergedOps, durationMs: Date.now() - started };
  }
  function handleGetMergeStatus(params: unknown): unknown {
    const p = params as { storeId: string };
    const rec = requireRecord(p.storeId);
    return {
      lastMergeAt: null,
      lastMergeDurationMs: 0,
      totalOpsProcessed: null,
      admittedPeerCount: rec.booted?.admitted.size ?? 0,
      nextMergeIn: 1000,
    };
  }
  function handleGetAdmittedLogs(params: unknown): unknown {
    const p = params as { storeId: string };
    const rec = requireRecord(p.storeId);
    return {
      logs: [...(rec.booted?.admitted.keys() ?? [])],
    };
  }

  /**
   * Read the sidecar's OWN boot-history ring. In SUBSTRATE_SIDECAR mode the real
   * boot/merge/admission/epoch_* events are recorded HERE (bootHarnessSubstrate +
   * the merge loop run in this process), so the main operator's ring is empty —
   * the admin route proxies to this method to surface the real timeline.
   */
  function handleGetBootHistory(params: unknown): unknown {
    const opts = (params ?? {}) as ListBootHistoryOpts;
    return { entries: listBootHistory(opts), depth: bootHistoryDepth() };
  }
  // P-004 (WI-1840, WI-183 class): the replication-liveness registry is fed by
  // the merge loop, which runs HERE under the sidecar flag — so this process
  // holds the authoritative per-log liveness verdicts. Additive read-only RPC;
  // same params shape as getReplicationLiveness's filter.
  function handleGetReplicationLiveness(params: unknown): unknown {
    const p = (params ?? {}) as { workspaceId?: string; harnessSlug?: string };
    return {
      harnesses: getReplicationLiveness({
        workspaceId: p.workspaceId,
        harnessSlug: p.harnessSlug,
      }),
    };
  }
  async function handleRevoke(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; devicePubkey: string };
    const rec = requireRecord(p.storeId);
    if (!rec.booted) throw new RpcMethodError(-32000, 'Harness is not booted in the sidecar');
    await rec.booted.revoke(p.devicePubkey);
    return { ok: true, revoked: true };
  }
  // P-101 (fleet directory) over the relocated substrate: scoped-log participation
  // runs where the swarm + scoped store live — HERE. The main-process
  // RemoteBootedHarnessHandle forwards these two verbs; the real handle's
  // ensureScopeParticipation unions into the boot's durable declared set and
  // discloses via the live ScopeFederation (no-op until the scoped layer is up).
  async function handleEnsureScopeParticipation(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; scopes: unknown };
    const rec = requireRecord(p.storeId);
    if (!rec.booted) throw new RpcMethodError(-32000, 'Harness is not booted in the sidecar');
    await rec.booted.ensureScopeParticipation((Array.isArray(p.scopes) ? p.scopes : []) as never);
    return { ok: true };
  }
  async function handleRediscloseScopes(params: unknown): Promise<unknown> {
    const p = params as { storeId: string };
    const rec = requireRecord(p.storeId);
    if (!rec.booted) throw new RpcMethodError(-32000, 'Harness is not booted in the sidecar');
    await rec.booted.rediscloseScopes();
    return { ok: true };
  }
  async function handleRekey(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; binding: SwarmBinding };
    const rec = requireRecord(p.storeId);
    if (!rec.booted) throw new RpcMethodError(-32000, 'Harness is not booted in the sidecar');
    await rec.booted.rekey(p.binding);
    // WI-40905: the drain may already be marked wired from a PRE-Hive boot,
    // where its epoch-encrypt dependency was correctly absent. Refresh that
    // running drain's capability after the registry/topic transition and before
    // the idempotence guard below no-ops. No second drain is started.
    await refreshOutboxEpochEncryptForHarness(rec.booted);
    // EI-521 (WI-971, D-034/D-037): a re-key joins the harness's Hive-pubkey
    // federation topic IN PLACE (so it peer_connects), and rekeyHarness is the
    // SOLE production route bringing a JOINED (joinHiveAsView) / from-repo-CREATED
    // (publishCreatedHive) hive harness onto the Hive topic. In SUBSTRATE_SIDECAR
    // mode the main-process rekeyHarness SKIPS its own send-side wiring for a
    // RemoteBootedHarnessHandle (boot-all.ts: `!(handle instanceof
    // RemoteBootedHarnessHandle)`), delegating to US — but until now the sidecar
    // only wired the outbox DRAIN in handleBootHarness (boot), NOT here. So the
    // drain loop never started for those harnesses → substrate_outbox stayed
    // UNDRAINED forever → content captured but never federated despite
    // peer_connected (the live cross-machine blocker). Wire it now;
    // ensureRelocatedSendSideWired is idempotent, so this is a no-op when boot
    // already wired it (never a second drain loop) and best-effort (it never
    // throws into the rekey).
    await ensureRelocatedSendSideWired(rec.booted);
    return { ok: true, rekeyed: true };
  }

  /**
   * Relocation-aware pot-git dial. The swarm and its verified device→socket
   * registry live in this process, so resolve the peer HERE and expose the
   * resulting fetch Duplex through one bounded, single-use Unix socket. JSON
   * RPC remains control-only; raw git protocol bytes never enter its framing.
   */
  async function handleOpenHiveGitDuplex(params: unknown): Promise<unknown> {
    const p = params as OpenHiveGitDuplexRequest;
    if (
      !p?.storeId ||
      typeof p.devicePubkeyBase64 !== 'string' ||
      !p.devicePubkeyBase64 ||
      typeof p.repoKey !== 'string' ||
      !p.repoKey
    ) {
      throw new RpcMethodError(-32602, 'openHiveGitDuplex requires { storeId, devicePubkeyBase64, repoKey }');
    }
    const rec = requireRecord(p.storeId);
    if (!rec.booted) throw new RpcMethodError(-32000, 'Harness is not booted in the sidecar');
    const topicHex = rec.booted.swarm?.topicHex;
    if (!topicHex) {
      return { socketPath: null, topicHex: null, error: 'hive-git: no live swarm join for this harness yet' };
    }
    if (!/^(?:[0-9a-f]{2})+$/i.test(topicHex)) {
      throw new RpcMethodError(-32000, 'Harness swarm returned an invalid topicHex');
    }

    const request: HiveGitDuplexRequest = {
      repoKey: p.repoKey,
      ...(typeof p.peerGithubUserId === 'number' ? { peerGithubUserId: p.peerGithubUserId } : {}),
      ...(typeof p.waitForRegistrationMs === 'number' ? { waitForRegistrationMs: p.waitForRegistrationMs } : {}),
    };
    const peer = await openHiveGitDuplex(Buffer.from(topicHex, 'hex'), p.devicePubkeyBase64, request);
    if (peer.destroyed) {
      const error = (peer as Duplex & { errored?: Error | null }).errored;
      return {
        socketPath: null,
        topicHex,
        error: error?.message ?? `pot-git: no live connection to device ${p.devicePubkeyBase64.slice(0, 12)}…`,
      };
    }

    const tunnel = await createOneShotUnixTunnel(peer, hiveGitTunnelDir, hiveGitTunnelTtlMs);
    hiveGitTunnels.add(tunnel);
    void tunnel.closed.then(() => hiveGitTunnels.delete(tunnel));
    return { socketPath: tunnel.socketPath, topicHex };
  }

  // ── socket handoff (Option B replication-offload, preserved) ────────────────

  function handlePrepareSocketHandoff(params: unknown): unknown {
    const p = params as { storeId: string; peerId?: string };
    requireRecord(p.storeId);
    sweepExpiredHandoffs();
    const handoffToken = `hoff-${nextHandoffId++}-${crypto.randomBytes(8).toString('hex')}`;
    handoffs.set(handoffToken, {
      storeId: p.storeId,
      peerId: p.peerId,
      handle: null,
      used: false,
      createdAt: Date.now(),
      onHandle: null,
    });
    return { handoffToken };
  }

  async function handleAttachSocket(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; handoffToken: string; initiator?: boolean };
    const entry = handoffs.get(p.handoffToken);
    if (!entry || entry.used) {
      throw new RpcMethodError(-32002, 'Socket handoff failed: unknown or already-used token');
    }
    if (entry.storeId !== p.storeId) {
      throw new RpcMethodError(-32002, 'Socket handoff failed: storeId mismatch for token');
    }
    const rec = storeMap.get(p.storeId);
    if (!rec || !rec.store) throw new RpcMethodError(-32000, 'Store not found');

    const handle = entry.handle ?? (await waitForHandle(entry, HANDOFF_HANDLE_TIMEOUT_MS));
    if (!handle) {
      throw new RpcMethodError(-32002, 'Socket handoff failed: handle did not arrive over IPC');
    }

    entry.used = true;
    handoffs.delete(p.handoffToken);

    const connectionId = `conn-${nextConnId++}`;
    replicateOverTransport(rec.store, handle, Boolean(p.initiator));
    rec.connections.add(connectionId);
    handle.on('close', () => rec.connections.delete(connectionId));
    return { ok: true, connectionId };
  }

  function waitForHandle(entry: HandoffEntry, timeoutMs: number): Promise<Duplex | null> {
    if (entry.handle) return Promise.resolve(entry.handle);
    return new Promise<Duplex | null>((resolve) => {
      const t = setTimeout(() => {
        entry.onHandle = null;
        resolve(null);
      }, timeoutMs);
      entry.onHandle = (handle: Duplex) => {
        clearTimeout(t);
        resolve(handle);
      };
    });
  }

  function sweepExpiredHandoffs(): void {
    const now = Date.now();
    for (const [token, entry] of handoffs) {
      if (!entry.used && now - entry.createdAt > HANDOFF_TTL_MS) {
        try {
          entry.handle?.destroy?.();
        } catch {
          // best-effort
        }
        handoffs.delete(token);
      }
    }
  }

  async function handleGetCoreInfo(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; coreKeyHex: string; fetchBlock?: number; download?: boolean };
    const rec = storeMap.get(p.storeId);
    if (!rec || !rec.store) throw new RpcMethodError(-32000, 'Store not found');

    const core = rec.store.get({ key: Buffer.from(p.coreKeyHex, 'hex') }) as unknown as HypercoreLike;
    await core.ready();
    try {
      await core.update({ wait: true });
    } catch {
      // no peer / nothing to learn yet — return whatever length we have
    }
    if (p.download && core.length > 0) await downloadAll(core);

    let blockBase64: string | undefined;
    if (typeof p.fetchBlock === 'number' && core.length > p.fetchBlock) {
      try {
        const block = await core.get(p.fetchBlock, { wait: true });
        blockBase64 = Buffer.from(block).toString('base64');
      } catch {
        // block not retrievable (peer gone) — omit it
      }
    }
    return { length: core.length, byteLength: core.byteLength, blockBase64 };
  }

  async function handleGetOwnLogOp(params: unknown): Promise<unknown> {
    const p = params as { storeId: string; index: number };
    if (!p?.storeId || !Number.isInteger(p.index) || p.index < 0) {
      throw new RpcMethodError(-32602, 'getOwnLogOp requires { storeId, index >= 0 }');
    }
    const rec = requireRecord(p.storeId);
    const ownLog = await ensureOwnLog(rec);
    const op = await ownLog.get(p.index);
    return {
      index: p.index,
      length: ownLog.length,
      keyHex: ownLog.keyHex,
      op,
    };
  }

  const methods: Record<string, RpcHandler> = {
    'sidecar:healthz': () => handleHealthz(),
    'substrate:openStore': handleOpenStore,
    'substrate:closeStore': handleCloseStore,
    'substrate:getStoreStatus': handleGetStoreStatus,
    'substrate:bootHarness': handleBootHarness,
    'substrate:appendOp': handleAppendOp,
    'substrate:onAnnounce': handleOnAnnounce,
    'substrate:triggerMergeNow': handleTriggerMergeNow,
    'substrate:getMergeStatus': handleGetMergeStatus,
    'substrate:getAdmittedLogs': handleGetAdmittedLogs,
    'substrate:getBootHistory': handleGetBootHistory,
    'substrate:getReplicationLiveness': handleGetReplicationLiveness,
    'substrate:revoke': handleRevoke,
    'substrate:rekey': handleRekey,
    'substrate:ensureScopeParticipation': handleEnsureScopeParticipation,
    'substrate:rediscloseScopes': handleRediscloseScopes,
    'substrate:openHiveGitDuplex': handleOpenHiveGitDuplex,
    'substrate:prepareSocketHandoff': handlePrepareSocketHandoff,
    'substrate:attachSocket': handleAttachSocket,
    'substrate:getCoreInfo': handleGetCoreInfo,
    'substrate:getOwnLogOp': handleGetOwnLogOp,
  };

  function receiveHandle(handoffToken: string, handle: Duplex): void {
    const entry = handoffs.get(handoffToken);
    if (!entry) {
      try {
        (handle as { destroy?: () => void } | null)?.destroy?.();
      } catch {
        // best-effort
      }
      return;
    }
    entry.handle = handle;
    if (entry.onHandle) {
      const cb = entry.onHandle;
      entry.onHandle = null;
      cb(handle);
    }
  }

  async function closeAll(): Promise<void> {
    for (const tunnel of [...hiveGitTunnels]) tunnel.close();
    hiveGitTunnels.clear();
    for (const [, rec] of storeMap) {
      if (rec.booted) {
        try {
          await rec.booted.close();
        } catch {
          // best-effort
        }
      }
      if (rec.store) {
        try {
          await rec.store.close();
        } catch {
          // best-effort
        }
      }
    }
    storeMap.clear();
    handoffs.clear();
    outboxWired.clear();
    presenceWired.clear();
  }

  return {
    methods,
    receiveHandle,
    storeCount: () => storeMap.size,
    closeAll,
  };
}

/**
 * Pipe a raw transport into a corestore replication protocol stream, with MUTUAL
 * TEARDOWN so neither side dangles when the peer goes away.
 *
 * WI-1089 (bg-host leak hunt): `store.replicate(initiator)` returns a NEW protocol
 * stream that we manually pipe — unlike `store.replicate(socket)` (the in-process
 * swarm path, swarm.ts), NOTHING tears THIS stream down when the transport dies. On
 * the COMMON unclean disconnect (peer reset / timeout → the transport emits
 * 'error'/'close' WITHOUT a graceful 'end'), Node's `.pipe()` does NOT destroy the
 * destination — so the corestore replication stream (its Protomux muxer, per-core
 * channels, and send/recv buffers, all still referenced by the corestore) would
 * dangle FOREVER. Across churning peers in the long-lived sidecar that is an
 * unbounded per-connection heap + handle leak — a candidate driver of the +1GB/min
 * RSS climb. Destroying either side when the other ends frees the corestore stream
 * (corestore removes it on the replication stream's 'close'). See
 * {@link pipeWithMutualTeardown}.
 */
function replicateOverTransport(store: Corestore, transport: Duplex, initiator: boolean): void {
  const repl = store.replicate(initiator) as unknown as Duplex;
  pipeWithMutualTeardown(transport, repl);
}

/**
 * Bidirectionally pipe two duplex streams and DESTROY both when EITHER errors or
 * closes — the teardown the bare `transport.pipe(repl).pipe(transport)` lacked
 * (WI-1089). Exported for unit testing. Idempotent + best-effort: the `tearing`
 * guard collapses the error→close cascade into a single teardown, and a throwing
 * `destroy()` is swallowed (a teardown must never crash the host it cleans up after).
 *
 * The per-side `'error'` listener also prevents an unclean-disconnect 'error' from
 * escalating to an uncaught exception (it replaces the prior bare `() => {}` swallow
 * with a swallow-AND-teardown).
 */
export function pipeWithMutualTeardown(transport: Duplex, repl: Duplex): void {
  let tearing = false;
  const teardown = (err?: Error): void => {
    if (tearing) return;
    tearing = true;
    if (!repl.destroyed) {
      try {
        repl.destroy(err);
      } catch {
        // best-effort — freeing the corestore stream must not throw
      }
    }
    if (!transport.destroyed) {
      try {
        transport.destroy(err);
      } catch {
        // best-effort
      }
    }
  };
  transport.on('error', (e: unknown) => teardown(e instanceof Error ? e : undefined));
  repl.on('error', (e: unknown) => teardown(e instanceof Error ? e : undefined));
  transport.on('close', () => teardown());
  repl.on('close', () => teardown());
  transport.pipe(repl).pipe(transport);
}

/** Download every block of a core (the merkle-verify CPU + I/O of a catch-up). */
async function downloadAll(core: HypercoreLike): Promise<void> {
  try {
    const range = core.download({ start: 0, end: core.length });
    if (range && typeof (range as { done?: unknown }).done === 'function') {
      await (range as { done(): Promise<void> }).done();
      return;
    }
    await (range as Promise<void>);
    return;
  } catch {
    // fall through to a sequential fetch
  }
  for (let i = 0; i < core.length; i++) {
    try {
      await core.get(i, { wait: true });
    } catch {
      // best-effort per block
    }
  }
}
