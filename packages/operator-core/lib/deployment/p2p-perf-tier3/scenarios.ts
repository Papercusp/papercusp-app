/**
 * scenarios.ts — the Tier-3 real-machine measurements (P-011), transport-agnostic
 * over a `PeerLauncher` so the SAME code runs on real frames (SSH + public DHT)
 * and in the $0 local-parity path (local spawn + testnet).
 *
 * Three measurements only real machines can give (D-001):
 *   - cross-region replication latency — append→visible p50/p95/p99, the SAME
 *     sentAt→first-sight metric Tier-1 uses (so curves overlay), but across real
 *     WAN RTT, with per-reader clock-offset correction (NTP-disciplined frames +
 *     a ping/pong residual estimate).
 *   - real-WAN DHT discovery — launch→first-swarm-connection and launch→admitted,
 *     parent-timed (loopback testnet collapses this to ~0; the WAN number is the point).
 *   - NAT/holepunch success — on firewalled (NAT-like) frames, whether peers still
 *     connect at all, and HOW: hyperdht `stats.punches`/`relaying` deltas carried
 *     back in the peer-child `net` block. Holepunching is the product's namesake;
 *     it is unmeasurable on loopback.
 *
 * Every scenario emits a `PerfArtifact` (tier:3, schema 1) via the shared meter,
 * so the artifact + report parity (P-012) is automatic.
 */

import { ScenarioMeter, summarize } from '../../sync/hyperbee/perf/metrics';
import type { PerfArtifact } from '../../sync/hyperbee/perf/artifact';
import { foldChildResults, type PeerChildHandle } from '../../sync/hyperbee/perf/child-driver';
import type { PeerChildConfig, PeerChildResult, PeerNetStats } from '../../sync/hyperbee/perf/peer-child';
import { estimateClockOffset, type PeerLauncher } from './remote-peer';

const FIXED_CORPUS_AUTHOR = 'a'.repeat(64);

export interface Tier3ScenarioOpts {
  launcher: PeerLauncher;
  /** Unique-per-run harness slug so peers derive a shared topic that no other run collides on. */
  harnessSlug: string;
  workspaceId?: string;
  /** When set, peers federate over the HIVE pubkey topic
   *  (`deriveHiveFederationTopic(hivePubkey)`) instead of the workspace/slug
   *  topic — the P-011 cross-machine Hive E2E. Passed through to every peer-child. */
  hivePubkey?: string;
  /** Writer load. */
  count: number;
  rate: number;
  seed?: number;
  /** Reader merge cadence (production = 1000). */
  mergePollMs?: number;
  /** Bounds. Real WAN provisions are slow — these default generous. */
  meshTimeoutMs?: number;
  catchUpTimeoutMs?: number;
  /** Correct cross-machine latency with a ping/pong clock-offset estimate (default true). */
  estimateClock?: boolean;
  log: (line: string) => void;
}

interface LaunchedReader {
  handle: PeerChildHandle;
  label: string;
  region?: string;
  /** Parent-timed launch→ready and launch→admitted (DHT discovery, ms). */
  readyMs: number | null;
  admittedMs: number | null;
  offsetMs: number | null;
}

/** Aggregate per-reader net stats into flat count metrics + notes. */
function applyNetMetrics(artifact: PerfArtifact, readers: PeerChildResult[]): void {
  const nets = readers.map((r) => r.net).filter((n): n is PeerNetStats => !!n);
  if (!nets.length) return;
  const firstConn = nets.map((n) => n.firstConnectionMs).filter((v): v is number => v !== null);
  if (firstConn.length) artifact.metrics['dhtFirstConnectionMs'] = summarize(firstConn, 'ms');
  artifact.metrics['punchesConsistent'] = summarize(nets.map((n) => n.punches.consistent), 'count');
  artifact.metrics['punchesRandom'] = summarize(nets.map((n) => n.punches.random), 'count');
  artifact.metrics['punchesOpen'] = summarize(nets.map((n) => n.punches.open), 'count');
  artifact.metrics['relaySuccesses'] = summarize(nets.map((n) => n.relaying.successes), 'count');
  const connected = nets.filter((n) => n.firstConnectionMs !== null).length;
  artifact.metrics['connectedPeers'] = summarize([connected], 'count');
  const totalPunches = nets.reduce((a, n) => a + n.punches.consistent + n.punches.random + n.punches.open, 0);
  const totalRelay = nets.reduce((a, n) => a + n.relaying.successes, 0);
  artifact.notes.push(
    `net: ${connected}/${nets.length} readers connected; punches=${totalPunches} relaySuccess=${totalRelay}`,
  );
}

/**
 * Core: launch a writer + N readers over the launcher, run a replication load,
 * and fold the result into a tier-3 PerfArtifact — the same shape Tier-1's
 * replication.sustained emits, plus the net/discovery metrics.
 */
async function runReplicationCore(opts: Tier3ScenarioOpts, scenario: string): Promise<PerfArtifact> {
  const slots = opts.launcher.slots;
  if (slots.length < 2) throw new Error(`${scenario}: need ≥2 peer slots, have ${slots.length}`);
  const workspaceId = opts.workspaceId ?? 'p2p-perf';
  const meshTimeoutMs = opts.meshTimeoutMs ?? 120_000;
  const catchUpTimeoutMs = opts.catchUpTimeoutMs ?? 180_000;
  const seed = opts.seed ?? 1234;
  const peers = slots.length;

  const baseCfg = (role: 'writer' | 'reader', peerIndex: number): PeerChildConfig => ({
    role,
    workspaceId,
    harnessSlug: opts.harnessSlug,
    // root is overwritten by each launcher (remote /tmp vs local mkdtemp).
    root: '',
    peerIndex,
    corpusAuthor: FIXED_CORPUS_AUTHOR,
    // Re-key onto the Hive federation topic when running the Hive E2E (P-004/D-003).
    ...(opts.hivePubkey ? { hivePubkey: opts.hivePubkey } : {}),
  });

  // 1. Writer (slot 0).
  const writerSlot = slots[0];
  const tWriterLaunch = Date.now();
  const writer = writerSlot.launch({ ...baseCfg('writer', 0), rate: opts.rate, count: opts.count, seed });
  const writerReady = await writer.waitFor('ready', meshTimeoutMs);
  if (!writerReady) {
    writer.kill('SIGKILL');
    throw new Error(`${scenario}: writer (${writerSlot.label}) never became ready`);
  }

  // 2. Readers (slots 1..). Parent-time discovery (launch→ready, launch→admitted).
  const readers: LaunchedReader[] = [];
  for (let i = 1; i < slots.length; i++) {
    const slot = slots[i];
    const tLaunch = Date.now();
    const handle = slot.launch({
      ...baseCfg('reader', i),
      mergePollMs: opts.mergePollMs ?? 1000,
      expectedWinners: opts.count,
      catchUpTimeoutMs,
    });
    const ready = await handle.waitFor('ready', meshTimeoutMs);
    const readyMs = ready ? Date.now() - tLaunch : null;
    const admitted = await handle.waitFor('admitted', meshTimeoutMs);
    const admittedMs = admitted ? Date.now() - tLaunch : null;
    if (!admitted) opts.log(`${scenario}: reader ${slot.label} never admitted the writer`);
    readers.push({ handle, label: slot.label, region: slot.region, readyMs, admittedMs, offsetMs: null });
  }

  // 3. Clock-offset estimate (cross-machine latency correction).
  let writerOffset = 0;
  if (opts.estimateClock !== false) {
    const w = await estimateClockOffset(writer);
    writerOffset = w?.offsetMs ?? 0;
    for (const r of readers) {
      const est = await estimateClockOffset(r.handle);
      r.offsetMs = est?.offsetMs ?? null;
    }
  }

  // 4. Run the load.
  const meter = new ScenarioMeter({ scenario, tier: 3, params: { peers, rate: opts.rate, count: opts.count } });
  opts.log(`${scenario}: peers=${peers} rate=${opts.rate}/s count=${opts.count} — go`);
  writer.send('go');
  const writerDone = await writer.waitFor('writer-done', (opts.count / Math.max(opts.rate, 1)) * 1000 + 120_000);
  if (!writerDone) meter.note('writer never reported done — partial run');
  meter.expectReaders(readers.length);
  for (const r of readers) {
    const ok = await r.handle.waitFor('caught-up', catchUpTimeoutMs);
    if (!ok) meter.readerDidNotConverge(r.label);
  }

  // 5. Collect + fold.
  const writerResult = await writer.stopAndCollect();
  const readerResults = await Promise.all(readers.map((r) => r.handle.stopAndCollect()));
  const allResults = [writerResult, ...readerResults];

  // Clock-corrected append→visible: per reader, raw − (readerOffset − writerOffset).
  const correctedLat: number[] = [];
  const rawLat: number[] = [];
  readerResults.forEach((res, idx) => {
    if (res?.role !== 'reader' || !res.latenciesRaw) return;
    const off = readers[idx]?.offsetMs;
    const skew = off === null || off === undefined ? 0 : off - writerOffset;
    for (const v of res.latenciesRaw) {
      rawLat.push(v);
      correctedLat.push(v - skew);
    }
  });

  const discoveryReadyMs = readers.map((r) => r.readyMs).filter((v): v is number => v !== null);
  const discoveryAdmittedMs = readers.map((r) => r.admittedMs).filter((v): v is number => v !== null);

  const artifact = foldChildResults(
    meter,
    (a) => {
      if (correctedLat.length) a.metrics['appendToVisibleMs'] = summarize(correctedLat, 'ms');
      if (rawLat.length) a.metrics['appendToVisibleRawMs'] = summarize(rawLat, 'ms');
      if (discoveryReadyMs.length) a.metrics['peerReadyMs'] = summarize(discoveryReadyMs, 'ms');
      if (discoveryAdmittedMs.length) a.metrics['peerAdmittedMs'] = summarize(discoveryAdmittedMs, 'ms');
      const w = writerResult;
      if (w?.appendMs) a.metrics['appendCallMs'] = w.appendMs;
      applyNetMetrics(a, readerResults.filter((r): r is PeerChildResult => !!r));
      a.params['regions'] = opts.launcher.slots.map((s) => s.region ?? s.label).join('+');
      if (opts.estimateClock !== false) {
        a.notes.push(`clock-offset corrected (writerOffset=${Math.round(writerOffset)}ms vs orchestrator)`);
      }
    },
    allResults,
  );
  return artifact;
}

/** Cross-region replication latency + DHT discovery (the headline real-WAN numbers). */
export function crossRegionReplication(opts: Tier3ScenarioOpts): Promise<PerfArtifact> {
  return runReplicationCore(opts, 'tier3.cross-region-replication');
}

/**
 * DHT discovery: a near-zero-load run whose headline is launch→connection +
 * launch→admitted across real WAN. Just a thin param tweak over the core.
 */
export function dhtDiscovery(opts: Tier3ScenarioOpts): Promise<PerfArtifact> {
  return runReplicationCore({ ...opts, count: Math.min(opts.count, 10), rate: 0 }, 'tier3.dht-discovery');
}

/**
 * NAT/holepunch success: the launcher's frames are firewalled (NAT-like inbound
 * drop) so an inbound P2P flow must be holepunched. The metric is whether peers
 * connect at all (connectedPeers) and the punch/relay breakdown in `net`.
 */
export function natHolepunch(opts: Tier3ScenarioOpts): Promise<PerfArtifact> {
  return runReplicationCore(opts, 'tier3.nat-holepunch');
}
