/**
 * fixture.ts — N-peer / N-log fixtures for the p2p-perf suite (P-002).
 *
 * Extends the proven two-peer test fixtures (`__tests__/two-peer-swarm.test.ts`)
 * to N peers, with the same seams: isolated corestore dirs per peer, a local
 * testnet DHT bootstrap (offline + deterministic), self-generated Ed25519
 * identities (no OS keychain / gh), `verifyBindingOverride` (transport focus —
 * the channel-2 gate is unit-tested elsewhere), and `applyOverride` so no PG
 * is touched unless a scenario opts in.
 *
 * Three granularities, cheapest first:
 *   - `memLog(ops)`          — an in-memory `AdmittedLog`; isolates the LWW
 *                              fold from storage/decode cost.
 *   - `makeStoreLog(...)`    — a real corestore-backed own log in a tmp dir;
 *                              measures the actual hypercore decode path.
 *   - `bootPeerMesh(...)`    — N real `bootHarnessSubstrate` peers on a local
 *                              testnet swarm; measures the full pipeline.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { swarmConstructorOpts, type HyperswarmLike } from '../swarm';
import type { AdmittedLog } from '../read-merge';
import type { PeerLogOp, OwnLog } from '../peer-log';
import { openOwnLog } from '../peer-log';
import type { OpEnvelope } from '../op-envelope-types';
import { getHarnessStore, closeHarnessStore } from '../corestore';
import { generateCorpus, type CorpusOpts } from './corpus';

/** LIFO cleanup stack — every fixture pushes its teardown here. */
export class Cleanups {
  private fns: Array<() => void | Promise<void>> = [];
  push(fn: () => void | Promise<void>): void {
    this.fns.push(fn);
  }
  async run(): Promise<void> {
    while (this.fns.length) {
      try {
        await this.fns.pop()!();
      } catch {
        // best-effort teardown — never mask the scenario result
      }
    }
  }
}

export function makeTmpDir(cleanups: Cleanups, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

/** In-memory AdmittedLog over an op array — zero storage/decode cost. */
export function memLog(keyHex: string, ops: PeerLogOp[]): AdmittedLog {
  return {
    keyHex,
    get length() {
      return ops.length;
    },
    async get(i: number) {
      return ops[i] ?? null;
    },
  };
}

/**
 * A corestore-backed own log in an isolated tmp dir, pre-seeded with a
 * deterministic corpus (batched appends). Returns the log + its store opts so
 * callers can close it.
 */
export async function makeStoreLog(
  cleanups: Cleanups,
  opts: { harnessSlug?: string; corpus?: CorpusOpts },
): Promise<{ log: OwnLog; workspaceRoot: string; harnessSlug: string }> {
  const workspaceRoot = makeTmpDir(cleanups, 'p2p-perf-log-');
  const harnessSlug = opts.harnessSlug ?? 'perf';
  const store = await getHarnessStore({ workspaceRoot, harnessSlug });
  cleanups.push(() => closeHarnessStore({ workspaceRoot, harnessSlug }));
  void store; // store lifecycle is owned by the corestore cache + the cleanup above
  const log = await openOwnLog(store);
  if (opts.corpus) {
    const BATCH = 2000;
    let batch: PeerLogOp[] = [];
    for (const op of generateCorpus(opts.corpus)) {
      batch.push(op);
      if (batch.length >= BATCH) {
        await log.appendBatch(batch);
        batch = [];
      }
    }
    if (batch.length) await log.appendBatch(batch);
  }
  return { log, workspaceRoot, harnessSlug };
}

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's `device_pubkey` convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

export interface PeerIdentity {
  login: string;
  userId: number;
  devicePubkey: string;
  override: NonNullable<Parameters<typeof bootHarnessSubstrate>[0]['announceIdentityOverride']>;
}

/** Self-generated Ed25519 identity + announce override for one simulated peer. */
export function makePeerIdentity(login: string, userId: number): PeerIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    login,
    userId,
    devicePubkey,
    override: {
      resolveOpts: {
        keychainId: `p2p-perf-${login}`,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

export interface MeshPeer {
  index: number;
  identity: PeerIdentity;
  handle: BootedHarnessHandle;
  workspaceRoot: string;
  /** Ops captured by this peer's apply sink (when the default capture sink is used). */
  applied: OpEnvelope[];
  /** hbKey → arrival epoch-ms, for replication-latency measurement. */
  appliedAt: Map<string, number>;
}

export interface BootPeerMeshOpts {
  n: number;
  cleanups: Cleanups;
  workspaceId?: string;
  harnessSlug?: string;
  /** Bootstrap node list. Omit to create a fresh local testnet (returned for reuse). */
  bootstrap?: unknown;
  /** Per-peer merge poll. Default 0 (scenarios drive mergeNow by hand). */
  mergePollMs?: number;
  /** Override the per-peer apply sink. Default: capture into `applied`/`appliedAt`. */
  applyOverride?: (peerIndex: number) => (op: OpEnvelope) => Promise<boolean>;
}

export interface PeerMesh {
  peers: MeshPeer[];
  bootstrap: unknown;
  workspaceId: string;
  harnessSlug: string;
  /** Poll until `fn` is truthy or timeout. Returns the value or undefined. */
  pollUntil<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs?: number): Promise<T | undefined>;
}

/**
 * Boot N real substrate peers joined to the same local-testnet swarm topic.
 * Peer i is `peer-i` with userId 1000+i. All channel-2 gates are bypassed
 * (transport/perf focus). Caller drives merges (`mergePollMs` defaults to 0).
 */
export async function bootPeerMesh(opts: BootPeerMeshOpts): Promise<PeerMesh> {
  const { n, cleanups } = opts;
  const workspaceId = opts.workspaceId ?? 'ws-p2p-perf';
  const harnessSlug = opts.harnessSlug ?? 'perf-mesh';

  let bootstrap = opts.bootstrap;
  if (!bootstrap) {
    const testnet = await createTestnet(3);
    cleanups.push(async () => {
      try {
        await testnet.destroy();
      } catch {
        /* ignore */
      }
    });
    bootstrap = testnet.bootstrap;
  }

  const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };

  // Resolved ONCE: every peer in the mesh gets the same shipped peer budget.
  const meshSwarmOpts = swarmConstructorOpts();

  const peers: MeshPeer[] = [];
  for (let i = 0; i < n; i++) {
    const identity = makePeerIdentity(`peer-${i}`, 1000 + i);
    const workspaceRoot = makeTmpDir(cleanups, `p2p-perf-mesh-${i}-`);
    // ⚠ maxPeers/maxClientConnections MUST come from the product path — see the
    // long note in peer-child.ts. A bare `new Hyperswarm({ bootstrap })` inherits
    // hyperswarm's own `MAX_PEERS = 64` and then refuses further connections
    // SILENTLY, so any mesh wider than 64 strands peers for a reason that has
    // nothing to do with this substrate.
    const swarm = new Hyperswarm({
      bootstrap,
      maxPeers: meshSwarmOpts.maxPeers,
      maxClientConnections: meshSwarmOpts.maxClientConnections,
    }) as unknown as HyperswarmLike & {
      destroy(): Promise<void>;
    };
    cleanups.push(async () => {
      try {
        await swarm.destroy();
      } catch {
        /* ignore */
      }
    });

    const applied: OpEnvelope[] = [];
    const appliedAt = new Map<string, number>();
    const apply =
      opts.applyOverride?.(i) ??
      (async (op: OpEnvelope) => {
        applied.push(op);
        if (op.hbKey && !appliedAt.has(op.hbKey)) appliedAt.set(op.hbKey, Date.now());
        return true;
      });

    const handle = await bootHarnessSubstrate({
      workspaceRoot,
      workspaceId,
      harnessSlug,
      swarmBinding: binding,
      swarmOverride: swarm,
      verifyBindingOverride: async () => 'verified',
      applyOverride: apply,
      mergePollMs: opts.mergePollMs ?? 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: identity.override,
    });
    cleanups.push(async () => {
      await handle.close();
      await closeHarnessStore({ workspaceRoot, harnessSlug });
    });

    peers.push({ index: i, identity, handle, workspaceRoot, applied, appliedAt });
  }

  return {
    peers,
    bootstrap,
    workspaceId,
    harnessSlug,
    async pollUntil<T>(fn: () => T | Promise<T>, timeoutMs: number, intervalMs = 100) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() >= deadline) return undefined;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
  };
}
