/**
 * peer-child.ts — one substrate peer as a real OS process, for the
 * multi-process Tier-1/2 scenarios (P-005/P-006).
 *
 * The replication + churn benches need peers in SEPARATE processes: a single
 * process hosting N handles shares one event loop, which both serializes the
 * sync work (hiding contention) and makes the D-003 loop-lag SLO meaningless
 * (whose lag is it?). Each child runs ONE peer — boots the substrate against
 * the parent's local testnet DHT, plays a role, and reports a structured
 * result on stdout.
 *
 * Launch: `node --import tsx <this file>` with the JSON config in the
 * P2P_PERF_CHILD env var (spawned by scenarios/replication.ts / churn.ts —
 * never run by hand).
 *
 * Wire protocol (ndjson, child stdout → parent):
 *   {evt:'ready', keyHex}                — substrate booted, swarm joined
 *   {evt:'progress', appliedKeys, t}     — reader catch-up progress (1Hz)
 *   {evt:'caught-up', t, wallMs, appliedKeys} — reader reached expectedWinners
 *                                          (`t` is bootT0-relative; `wallMs` is
 *                                          the absolute host-clock instant)
 *   {evt:'result', …}                    — final per-process measurements
 *   {evt:'error', message}               — fatal; child exits 1
 *   {evt:'snapshot-ready', index, ownLength} — answer to `wait-snapshot`
 * Parent stdin → child: single lines `go` (writer starts load), `wait-snapshot`
 * (block until the own log carries a `__snapshot__`, then answer) and `stop`
 * (finalize + emit result + exit).
 */

import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { closeHarnessStore } from '../corestore';
import { findLatestSnapshotIndex } from '../read-merge';
import type { OpEnvelope } from '../op-envelope-types';
import type { PeerLogOp } from '../peer-log';
import type { SwarmBinding } from '../derive-swarm-topic';
import Hyperswarm from 'hyperswarm';
import { swarmConstructorOpts, type HyperswarmLike } from '../swarm';
import { makePeerIdentity } from './fixture';
import { generateCorpus } from './corpus';
import { ScenarioMeter } from './metrics';
import { summarize } from './metrics';

export interface PeerChildConfig {
  role: 'writer' | 'reader';
  workspaceId: string;
  harnessSlug: string;
  /** When set, this peer joins the HIVE federation topic
   *  (`deriveHiveFederationTopic(hivePubkey)`) instead of the local
   *  workspace/slug topic. Both peers passing the SAME raw-32-byte base64
   *  pubkey share one topic — this is the P-004 re-key (D-003: change only the
   *  key, reuse the transport) and the seam the P-011 cross-machine Hive E2E
   *  rides to prove a Hive federates over its pubkey topic across real machines. */
  hivePubkey?: string;
  /** Workspace root for this peer's corestore. Reused across churn restarts. */
  root: string;
  /** Local-testnet DHT bootstrap (Tier 1/2). ABSENT or empty → the PUBLIC DHT
   *  (Tier-3 real-WAN peers — p2p-performance-suite D-007). */
  bootstrap?: Array<{ host: string; port: number }>;
  peerIndex: number;
  /** Reader merge-poll cadence (production default 1000). */
  mergePollMs?: number;
  /** Writer: corpus seed for measurement ops. */
  seed?: number;
  /** Writer: sustained append rate (ops/sec). 0 = as-fast-as-possible (ceiling mode). */
  rate?: number;
  /** Writer: total measurement ops to append after `go`. */
  count?: number;
  /** Writer: pre-seed this many corpus history ops into the own log BEFORE `ready` (cold-join / churn). */
  preSeed?: number;
  /**
   * Author pubkey used for CORPUS ops (not the peer's real device identity).
   * Fixed + shared with the parent so corpus keys — and therefore the
   * expected-winner count — are computable on both sides. Default 'a'×64.
   */
  corpusAuthor?: string;
  /** Reader: distinct winner keys to consider "caught up". */
  expectedWinners?: number;
  /** Reader: stop waiting after this long even if not caught up. */
  catchUpTimeoutMs?: number;
  /** `wait-snapshot` bound: give up polling the own log for a `__snapshot__`
   *  after this long and answer `index: null` (so the parent gets a definitive
   *  answer instead of hanging to its own deadline). Default 120s. */
  snapshotWaitMs?: number;
}

/** Swarm/DHT network observations over the scenario window (Tier-3 P-011:
 *  real-WAN discovery time + NAT/holepunch behavior; harmless zeros on a
 *  loopback testnet). Punch/relay counters are DELTAS off `swarm.dht.stats`
 *  (hyperdht ≥6.32 exposes `punches` + `relaying`). */
export interface PeerNetStats {
  /** ms from substrate-boot start to the first swarm connection (DHT discovery + connect). Null = never connected. */
  firstConnectionMs: number | null;
  /** Per-connection observations (capped at 200). `remoteHost` distinguishes direct vs relay paths. */
  connections: Array<{ atMs: number; remoteHost?: string; remotePort?: number; peerKey?: string }>;
  punches: { consistent: number; random: number; open: number };
  relaying: { attempts: number; successes: number; aborts: number };
}

export interface PeerChildResult {
  evt: 'result';
  role: 'writer' | 'reader';
  peerIndex: number;
  keyHex: string;
  /** Network-path observations (always present; zeros on loopback testnets). */
  net?: PeerNetStats;
  /**
   * The swarm budget this child ACTUALLY resolved (D-035 ruling 4). Recorded on
   * the result — not only logged — so an arm's budget is a durable property of
   * the artifact rather than a line in a run log that has to be found again.
   *
   * `pinnedEnv` is the raw PAPERCUSP_SWARM_MAX_PEERS the child observed, null
   * when unset. It is kept separate from `maxPeers` on purpose: at a pinned 64
   * the two are indistinguishable from hyperswarm's own default of 64, so the
   * pair (`pinnedEnv` present) + (`maxClientConnections` === 56, not Infinity)
   * is what proves the shipped budget path ran at all.
   */
  swarmBudget?: { maxPeers: number; maxClientConnections: number; pinnedEnv: string | null };
  /** Reader: replication latency summary (ms) over measurement ops (sentAt → applied). */
  latency?: ReturnType<typeof summarize>;
  /** Reader: the raw latency samples (capped) so the parent can compute exact cross-reader distributions. */
  latenciesRaw?: number[];
  /** Reader: catch-up wall time from boot to expectedWinners, if it happened. */
  catchUpMs?: number;
  caughtUp?: boolean;
  appliedKeys: number;
  appliedOps: number;
  /** Writer: ops appended + the append-call latency summary. */
  appended?: number;
  appendMs?: ReturnType<typeof summarize>;
  loopLag: { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
  cpu: { userMs: number; systemMs: number };
  rssPeakBytes: number;
  /**
   * P-008 sparse-fetch observability: per ADMITTED REMOTE log (own excluded), whether
   * block 0 / the last block are downloaded locally + the contiguous-downloaded-prefix
   * length. A snapshot-seeded FRESH joiner shows `has0=false` + `contiguousLength=0` for
   * a writer's log it compacted (it skipped the pre-snapshot prefix — the byte-skip the
   * compaction buys); a from-start reader shows `has0=true` + `contiguousLength=length`.
   */
  admittedStats?: Array<{ keyHex: string; length: number; has0: boolean; hasLast: boolean; contiguousLength: number }>;
}

/** `wait-snapshot` backward-scan window over the OWN log. The producer appends
 *  its snapshot set at the tail, so this only has to cover one set. */
const SNAPSHOT_TAIL_LOOKBACK = 512;

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.env.P2P_PERF_CHILD ?? '{}') as PeerChildConfig;
  if (!cfg.role) throw new Error('peer-child: P2P_PERF_CHILD config missing');

  const meter = new ScenarioMeter({
    scenario: `child.${cfg.role}`,
    tier: 1,
    params: { peerIndex: cfg.peerIndex },
  });

  const identity = makePeerIdentity(`peer-${cfg.peerIndex}`, 1000 + cfg.peerIndex);
  // No bootstrap (or empty) = the PUBLIC DHT — the Tier-3 real-WAN posture (D-007).
  //
  // ⚠ The peer BUDGET must come from the product path, never from hyperswarm's
  // own defaults. `new Hyperswarm({ bootstrap })` silently inherits the library
  // constant `MAX_PEERS = 64` (hyperswarm/index.js:13), and hyperswarm stops
  // accepting connections at that ceiling WITHOUT an error — so a flat N-peer
  // mesh above 64 can never fully connect and a handful of readers simply never
  // converge. That made the whole mesh ladder measure hyperswarm's default
  // instead of this substrate: 64 peers (63 connections) passed with ONE slot to
  // spare, and 80 peers failed with 7 readers stranded — a cap artifact read as
  // a substrate ceiling. Same instrument-not-system class as D-014/D-015.
  //
  // swarmConstructorOpts() resolves the SHIPPED budget (PAPERCUSP_SWARM_MAX_PEERS
  // > host-derived maxSwarmPeers, floor 256) plus the WI-6063 inbound reserve via
  // maxClientConnections — so the rig now exercises the configuration production
  // actually runs. The harness keeps its OWN bootstrap (isolated testnet).
  const { maxPeers, maxClientConnections } = swarmConstructorOpts();
  // D-035 ruling 4 (harden-shared-hive-to-256-peers-2026-06-29): an arm of a
  // pinned-cap experiment MUST be able to prove WHICH budget it actually ran.
  //
  // The product path logs this at swarm.ts:4001, but that console.info lives
  // inside the SHARED swarm constructor and this rig deliberately builds its
  // OWN Hyperswarm (below), so the rig path emitted NO budget line at all —
  // ruling 4 was unsatisfiable as written until this line existed.
  //
  // Why it matters more than ordinary logging: pinning PAPERCUSP_SWARM_MAX_PEERS=64
  // COLLIDES with hyperswarm's own library default (MAX_PEERS = 64,
  // hyperswarm/index.js:13). So "the pin was applied" and "swarmConstructorOpts
  // was bypassed entirely" produce the SAME maxPeers, and a clean 63/63 result
  // cannot distinguish them. maxClientConnections is the discriminator that can:
  // hyperswarm defaults it to Infinity (index.js:15) while the shipped budget
  // derives 56 at maxPeers=64. An arm whose children report Infinity — or report
  // nothing — measured NOTHING and must be DISCARDED, never recorded as a null.
  //
  // STDERR, not stdout: stdout is the ndjson event channel `out()` owns, and a
  // stray line there corrupts the parent's parse. child-driver.ts:162-164
  // forwards stderr to the run log prefixed `[child N stderr]`.
  process.stderr.write(
    `[peer-child] peer budget: maxPeers=${maxPeers} maxClientConnections=${maxClientConnections} ` +
      `(${maxPeers - maxClientConnections} reserved for INBOUND; ` +
      `PAPERCUSP_SWARM_MAX_PEERS=${process.env.PAPERCUSP_SWARM_MAX_PEERS ?? '<unset>'})\n`,
  );
  const swarm = new Hyperswarm({
    ...(cfg.bootstrap && cfg.bootstrap.length ? { bootstrap: cfg.bootstrap } : {}),
    maxPeers,
    maxClientConnections,
  }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
    on(ev: 'connection', cb: (socket: unknown, peerInfo: unknown) => void): void;
    dht?: { stats?: { punches?: Record<string, number>; relaying?: Record<string, number> } };
  };

  // Net probe (Tier-3 P-011): first-connection time, per-connection remote
  // addresses, and dht punch/relay counter deltas over the scenario window.
  const dhtStats = () => {
    const s = swarm.dht?.stats;
    return {
      punches: {
        consistent: s?.punches?.consistent ?? 0,
        random: s?.punches?.random ?? 0,
        open: s?.punches?.open ?? 0,
      },
      relaying: {
        attempts: s?.relaying?.attempts ?? 0,
        successes: s?.relaying?.successes ?? 0,
        aborts: s?.relaying?.aborts ?? 0,
      },
    };
  };
  const statsAtBoot = dhtStats();
  const netConnections: PeerNetStats['connections'] = [];
  let firstConnectionAt: number | null = null;

  // Reader measurement state. Measurement ops are table='perf-rep' with
  // value.sentAt; history/corpus ops count toward catch-up via distinct keys.
  const latencies: number[] = [];
  const appliedKeys = new Set<string>();
  let appliedOps = 0;
  const bootT0 = Date.now();
  let caughtUpAt: number | null = null;

  swarm.on('connection', (socket, peerInfo) => {
    const at = Date.now();
    if (firstConnectionAt === null) firstConnectionAt = at;
    if (netConnections.length >= 200) return;
    const raw = (socket as { rawStream?: { remoteHost?: string; remotePort?: number } }).rawStream;
    const key = (peerInfo as { publicKey?: Buffer } | undefined)?.publicKey;
    netConnections.push({
      atMs: at - bootT0,
      ...(raw?.remoteHost ? { remoteHost: raw.remoteHost } : {}),
      ...(typeof raw?.remotePort === 'number' ? { remotePort: raw.remotePort } : {}),
      ...(key ? { peerKey: key.toString('hex') } : {}),
    });
  });

  const apply = async (op: OpEnvelope): Promise<boolean> => {
    appliedOps++;
    if (op.table && op.hbKey) appliedKeys.add(`${op.table}::${op.hbKey}`);
    if (op.table === 'perf-rep' && op.type === 'put') {
      const sentAt = (op.value as { sentAt?: number } | undefined)?.sentAt;
      // Re-applied winners on later passes would double-count: first sight only.
      if (typeof sentAt === 'number' && !seenRep.has(op.hbKey!)) {
        seenRep.add(op.hbKey!);
        latencies.push(Date.now() - sentAt);
      }
    }
    if (
      caughtUpAt === null &&
      cfg.expectedWinners &&
      appliedKeys.size >= cfg.expectedWinners
    ) {
      caughtUpAt = Date.now();
      // `wallMs` is the child's OWN catch-up instant on the shared host wall
      // clock — the parent subtracts its `tGo` from it to get a per-reader time
      // that contains no parent-scheduling lag. `t` stays bootT0-relative for
      // the result payload; the two are DIFFERENT epochs and must never be
      // mixed (EI-20582417177742601).
      out({
        evt: 'caught-up',
        t: caughtUpAt - bootT0,
        wallMs: caughtUpAt,
        appliedKeys: appliedKeys.size,
      });
    }
    return true;
  };
  const seenRep = new Set<string>();

  // The swarm topic comes from this binding. A `hivePubkey` re-keys the peer
  // onto the HIVE federation topic (P-004/D-003) so two peers sharing the pubkey
  // federate over `deriveHiveFederationTopic(pubkey)`; otherwise it's the local
  // workspace/slug topic (the default perf posture). Identical transport either way.
  const binding: SwarmBinding = cfg.hivePubkey
    ? { kind: 'hive', hive_pubkey: cfg.hivePubkey }
    : { kind: 'local', workspace_id: cfg.workspaceId, harness_slug: cfg.harnessSlug };

  let handle: BootedHarnessHandle | null = null;
  try {
    handle = await bootHarnessSubstrate({
      workspaceRoot: cfg.root,
      workspaceId: cfg.workspaceId,
      harnessSlug: cfg.harnessSlug,
      swarmBinding: binding,
      swarmOverride: swarm,
      verifyBindingOverride: async () => 'verified',
      applyOverride: apply,
      // Local perf children run with the no-PG loader above. Explicitly disable
      // the optional boot-time re-key composition too: otherwise the default
      // buildHiveRekeyBootDeps path reaches the stub, fail-opens, and records
      // epoch_gate_skipped on an otherwise usable-looking artifact. Hive-bound
      // peers retain the production composition because they exercise re-key.
      ...(cfg.hivePubkey ? {} : { rekeyDepsOverride: null }),
      mergePollMs: cfg.mergePollMs ?? 1000,
      pendingRetryMs: 1000,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      announceIdentityOverride: identity.override,
    });

    // Writer pre-seed (history for cold-join / churn scenarios).
    if (cfg.role === 'writer' && cfg.preSeed && cfg.preSeed > 0) {
      const BATCH = 2000;
      let batch: PeerLogOp[] = [];
      for (const op of generateCorpus({
        seed: cfg.seed ?? 1,
        count: cfg.preSeed,
        authorPubkey: cfg.corpusAuthor ?? 'a'.repeat(64),
      })) {
        batch.push(op);
        if (batch.length >= BATCH) {
          await handle.ownLog.appendBatch(batch);
          batch = [];
        }
      }
      if (batch.length) await handle.ownLog.appendBatch(batch);
    }

    out({ evt: 'ready', keyHex: handle.ownLog.keyHex });

    // Mesh-readiness: emit `admitted` once this peer has admitted at least one
    // remote log (the parent gates the load phase on every reader reporting it).
    // Event-driven via handle.onAdmitted (audit P-022) — no 100ms polling. The
    // immediate check covers a mesh that formed before this listener registered.
    let admittedReported = false;
    const reportAdmitted = () => {
      if (!admittedReported && handle!.admitted.size >= 2) {
        admittedReported = true;
        out({ evt: 'admitted', size: handle!.admitted.size });
      }
    };
    const offAdmitted = handle.onAdmitted(reportAdmitted);
    reportAdmitted();

    // Reader: 1Hz progress so the parent can watch catch-up.
    const progressTimer =
      cfg.role === 'reader'
        ? setInterval(() => {
            out({ evt: 'progress', appliedKeys: appliedKeys.size, t: Date.now() - bootT0 });
          }, 1000)
        : null;
    progressTimer?.unref();

    // Command loop over stdin.
    let appended = 0;
    const appendDurations: number[] = [];
    const stdinLines = createLineReader();

    for (;;) {
      const line = await stdinLines.next();
      if (line === null || line === 'stop') break;
      if (line === 'ping') {
        // Clock probe (Tier-3): the parent estimates this machine's clock offset
        // over the ALREADY-OPEN channel (min-RTT sample wins), so cross-machine
        // sentAt→applied latencies can be skew-corrected/sanity-checked.
        out({ evt: 'pong', tRemote: Date.now() });
        continue;
      }
      if (line === 'wait-snapshot') {
        // COMPACTION BARRIER (EI-18724820303729937). The producer appends its
        // `__snapshot__` ASYNCHRONOUSLY — inside a merge pass, on the merge-poll
        // cadence — NOT as part of `append()`. So `writer-done` does NOT imply
        // "compacted", and a parent that spawns a fresh joiner right after it is
        // racing that append: a joiner booting first finds no snapshot, seeds its
        // cursor at 0, and replays the WHOLE history (no byte-skip). Whether the
        // writer wins is pure scheduling luck, which is why the race surfaced as a
        // load-sensitive flake. Poll the OWN log (all-local reads) so the parent
        // gets a real happens-before edge instead of a fixed sleep.
        const deadline = Date.now() + (cfg.snapshotWaitMs ?? 120_000);
        let index: number | null = null;
        for (;;) {
          // Small lookback ON PURPOSE: the producer appends its snapshot set at
          // the tail, so a short window finds it — while a full-history scan on
          // every poll would burn CPU and slow the very merge pass being awaited.
          index = await findLatestSnapshotIndex(handle.ownLog, SNAPSHOT_TAIL_LOOKBACK).catch(() => null);
          if (index !== null || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        out({ evt: 'snapshot-ready', index, ownLength: handle.ownLog.length });
        continue;
      }
      if (line === 'go' && cfg.role === 'writer') {
        const count = cfg.count ?? 0;
        const rate = cfg.rate ?? 0;
        const intervalMs = rate > 0 ? 1000 / rate : 0;
        let next = Date.now();
        for (let i = 0; i < count; i++) {
          if (intervalMs > 0) {
            next += intervalMs;
            const wait = next - Date.now();
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          }
          const t0 = Date.now();
          await handle.append({
            type: 'put',
            table: 'perf-rep',
            hbKey: `rep-${cfg.peerIndex}-${i}`,
            value: { sentAt: t0 },
            ts: t0,
            schema_version: 1,
            writerPubkey: identity.devicePubkey,
          });
          appendDurations.push(Date.now() - t0);
          appended++;
        }
        out({ evt: 'writer-done', appended });
      }
    }

    if (progressTimer) clearInterval(progressTimer);
    offAdmitted();

    const artifact = meter.finish();
    const statsAtEnd = dhtStats();
    const net: PeerNetStats = {
      firstConnectionMs: firstConnectionAt === null ? null : firstConnectionAt - bootT0,
      connections: netConnections,
      punches: {
        consistent: statsAtEnd.punches.consistent - statsAtBoot.punches.consistent,
        random: statsAtEnd.punches.random - statsAtBoot.punches.random,
        open: statsAtEnd.punches.open - statsAtBoot.punches.open,
      },
      relaying: {
        attempts: statsAtEnd.relaying.attempts - statsAtBoot.relaying.attempts,
        successes: statsAtEnd.relaying.successes - statsAtBoot.relaying.successes,
        aborts: statsAtEnd.relaying.aborts - statsAtBoot.relaying.aborts,
      },
    };
    // P-008: snapshot the download state of every admitted REMOTE log (own excluded) so the
    // parent can prove a snapshot-seeded joiner skipped the pre-snapshot prefix (sparse fetch).
    const admittedStats = [...handle!.admitted.entries()]
      .filter(([k]) => k !== handle!.ownLog.keyHex)
      .map(([keyHex, log]) => {
        const d = log as { length: number; has?(i: number): boolean; contiguousLength?: number };
        const len = d.length;
        return {
          keyHex,
          length: len,
          has0: len > 0 ? !!d.has?.(0) : false,
          hasLast: len > 0 ? !!d.has?.(len - 1) : false,
          contiguousLength: d.contiguousLength ?? 0,
        };
      });

    const result: PeerChildResult = {
      evt: 'result',
      role: cfg.role,
      peerIndex: cfg.peerIndex,
      keyHex: handle.ownLog.keyHex,
      net,
      swarmBudget: {
        maxPeers,
        maxClientConnections,
        pinnedEnv: process.env.PAPERCUSP_SWARM_MAX_PEERS ?? null,
      },
      admittedStats,
      appliedKeys: appliedKeys.size,
      appliedOps,
      loopLag: artifact.loopLag!,
      cpu: artifact.cpu,
      rssPeakBytes: artifact.rss.peakBytes,
      ...(cfg.role === 'reader'
        ? {
            latency: summarize(latencies, 'ms'),
            latenciesRaw: latencies.slice(0, 50_000),
            caughtUp: caughtUpAt !== null,
            ...(caughtUpAt !== null ? { catchUpMs: caughtUpAt - bootT0 } : {}),
          }
        : { appended, appendMs: summarize(appendDurations, 'ms') }),
    };
    out(result);
  } catch (e) {
    out({ evt: 'error', message: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  } finally {
    try {
      await handle?.close();
      await closeHarnessStore({ workspaceRoot: cfg.root, harnessSlug: cfg.harnessSlug });
    } catch {
      /* ignore */
    }
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  }
  // Timers in hyperswarm/corestore internals can linger; the result is out.
  process.exit(process.exitCode ?? 0);
}

/** Minimal async line reader over stdin. `next()` resolves null on EOF. */
function createLineReader(): { next(): Promise<string | null> } {
  let buf = '';
  const queue: string[] = [];
  let resolveWait: ((v: string | null) => void) | null = null;
  let eof = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      if (resolveWait) {
        resolveWait(line);
        resolveWait = null;
      } else {
        queue.push(line);
      }
    }
  });
  process.stdin.on('end', () => {
    eof = true;
    if (resolveWait) {
      resolveWait(null);
      resolveWait = null;
    }
  });
  return {
    next(): Promise<string | null> {
      if (queue.length) return Promise.resolve(queue.shift()!);
      if (eof) return Promise.resolve(null);
      return new Promise((r) => {
        resolveWait = r;
      });
    },
  };
}

void main();
