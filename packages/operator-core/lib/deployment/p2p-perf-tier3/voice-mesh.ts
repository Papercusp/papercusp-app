/**
 * voice-mesh.ts — the P-014 voice-mesh measurement suite
 * (holepunch-voice-channels-2026-06-05; brief12 §4; WI-101).
 *
 * Launches N SYMMETRIC voice-mesh-child peers (no writer/reader roles — every
 * peer pushes a tone cadence and records arrivals from every other peer) over
 * the same two transports the Tier-3 substrate scenarios use: `local` (shared
 * testnet, the $0 parity/CI path) and `ssh` (real frames on the public DHT).
 *
 * Folded metrics per mesh size:
 *   - mouthToEarMs       — pushMic(sender)→onPeerFrame(receiver), all ordered
 *                          pairs pooled, clock-offset corrected per peer
 *                          (encode+wire+decode, pre-playout-mix; the mixer
 *                          adds ≤ frameMs on top).
 *   - frameLossPct       — per ordered pair, 1 − received/sent (reliable
 *                          streams: loss = frames still in flight at stop or
 *                          a dropped connection — 0 is the expectation).
 *   - egress/ingressBytesPerSec — per-peer raw connection bytes over the send
 *                          window: the N×(N−1) mesh-bandwidth scaling number.
 *   - meshReadyMs        — boot→all-peers-visible per peer.
 *
 * Artifacts ride the SHARED PerfArtifact meter/report pipeline, so a voice run
 * sits next to the replication runs (P-012 artifact parity).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScenarioMeter, summarize } from '../../sync/hyperbee/perf/metrics';
import type { PerfArtifact } from '../../sync/hyperbee/perf/artifact';
import { renderPerfReport } from '../../sync/hyperbee/perf/report';
import { PeerChildHandle } from '../../sync/hyperbee/perf/child-driver';
import type { PeerChildConfig } from '../../sync/hyperbee/perf/peer-child';
import { buildSshStreamArgs, type SshTarget } from '../remote-exec';
import { benchRuntimeDir } from './bench-bootstrap';
import { estimateClockOffset } from './remote-peer';
import type { VoiceMeshChildConfig, VoiceMeshChildResult } from './voice-mesh-child';

const CHILD_PATH = fileURLToPath(new URL('./voice-mesh-child.ts', import.meta.url));

/** Path to voice-mesh-child.ts inside an unpacked frame runtime (ships with the
 *  source tarball like claim-agent.ts — no allowlist). */
export function remoteVoiceMeshChildPath(installRoot = '/opt/papercusp'): string {
  return `${benchRuntimeDir(installRoot)}/packages/operator-core/lib/deployment/p2p-perf-tier3/voice-mesh-child.ts`;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export interface VoiceMeshSlot {
  label: string;
  region?: string;
  /** Physical host identity, when slots fan multiple peers onto one frame
   *  (quota-capped accounts). Pairs sharing a defined host are folded into
   *  `mouthToEarSameHostMs` (loopback-biased) instead of the headline metric. */
  host?: string;
  launch(cfg: VoiceMeshChildConfig): PeerChildHandle;
}

export interface VoiceMeshLauncher {
  slots: VoiceMeshSlot[];
}

/** Local parity launcher: N voice children on THIS machine over a shared testnet. */
export function localVoiceMeshLauncher(opts: {
  count: number;
  bootstrap: Array<{ host: string; port: number }>;
  log: (line: string) => void;
}): VoiceMeshLauncher {
  const slots: VoiceMeshSlot[] = Array.from({ length: opts.count }, (_, i) => ({
    label: `local-${i}`,
    launch: (cfg: VoiceMeshChildConfig) => {
      const proc = spawn(process.execPath, ['--import', 'tsx', CHILD_PATH], {
        env: {
          ...process.env,
          VOICE_MESH_CHILD: JSON.stringify({ ...cfg, bootstrap: opts.bootstrap }),
          NODE_ENV: 'test',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return new PeerChildHandle(cfg as unknown as PeerChildConfig, proc, opts.log);
    },
  }));
  return { slots };
}

export interface VoiceMeshSshSlotSpec {
  label: string;
  region?: string;
  /** Physical frame identity for same-host pair classification (fan-out). */
  host?: string;
  target: SshTarget;
  installRoot?: string;
}

/** Real-frame launcher: one voice child per frame over SSH, public DHT. */
export function sshVoiceMeshLauncher(opts: {
  frames: VoiceMeshSshSlotSpec[];
  log: (line: string) => void;
}): VoiceMeshLauncher {
  const STREAM_ARGS = [
    '-o',
    'ConnectionAttempts=6',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=8',
    '-o',
    'TCPKeepAlive=yes',
  ];
  const slots: VoiceMeshSlot[] = opts.frames.map((f) => ({
    label: f.label,
    region: f.region,
    host: f.host,
    launch: (cfg: VoiceMeshChildConfig) => {
      // Public DHT on real frames — never ship a local-testnet bootstrap.
      const { bootstrap: _drop, ...childCfg } = cfg;
      void _drop;
      const runtimeDir = benchRuntimeDir(f.installRoot);
      const remoteCommand =
        `cd ${shq(runtimeDir)} && ` +
        `VOICE_MESH_CHILD=${shq(JSON.stringify(childCfg))} NODE_ENV=test ` +
        `exec node --import tsx ${shq(remoteVoiceMeshChildPath(f.installRoot))}`;
      const target: SshTarget = {
        ...f.target,
        sudo: false,
        extraArgs: [...(f.target.extraArgs ?? []), ...STREAM_ARGS],
      };
      const { cmd, args } = buildSshStreamArgs(target, remoteCommand);
      const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      return new PeerChildHandle(cfg as unknown as PeerChildConfig, proc, opts.log);
    },
  }));
  return { slots };
}

export interface VoiceMeshScenarioOpts {
  launcher: VoiceMeshLauncher;
  /** Unique-per-run slug → the shared channel topic (sha256). */
  harnessSlug: string;
  /** Frames each peer sends (default 750 = 15s of 20ms audio). */
  frames?: number;
  frameMs?: number;
  meshTimeoutMs?: number;
  estimateClock?: boolean;
  log: (line: string) => void;
}

/** Run one voice mesh at `launcher.slots.length` peers → a tier-3 PerfArtifact. */
export async function voiceMesh(opts: VoiceMeshScenarioOpts): Promise<PerfArtifact> {
  const scenario = 'tier3.voice-mesh';
  const slots = opts.launcher.slots;
  const peers = slots.length;
  if (peers < 2) throw new Error(`${scenario}: need ≥2 peer slots, have ${peers}`);
  const frames = opts.frames ?? 750;
  const frameMs = opts.frameMs ?? 20;
  const meshTimeoutMs = opts.meshTimeoutMs ?? 120_000;
  const topicHex = createHash('sha256').update(`voice-mesh:${opts.harnessSlug}`).digest('hex');

  const meter = new ScenarioMeter({ scenario, tier: 3, params: { peers, frames, frameMs } });

  // 1. Launch all peers; wait ready, then full-mesh visibility on every peer.
  const handles = slots.map((slot, i) =>
    slot.launch({ peerIndex: i, peers, topicHex, frames, frameMs }),
  );
  try {
    for (let i = 0; i < handles.length; i++) {
      const ready = await handles[i].waitFor('ready', meshTimeoutMs);
      if (!ready) throw new Error(`${scenario}: peer ${slots[i].label} never became ready`);
    }
    for (let i = 0; i < handles.length; i++) {
      const ok = await handles[i].waitFor('mesh-ready', meshTimeoutMs);
      if (!ok) throw new Error(`${scenario}: peer ${slots[i].label} never saw the full mesh`);
    }

    // 2. Clock offsets (cross-machine latency correction).
    const offsets: number[] = [];
    for (const h of handles) {
      const est = opts.estimateClock !== false ? await estimateClockOffset(h) : null;
      offsets.push(est?.offsetMs ?? 0);
    }

    // 3. Everyone sends simultaneously.
    opts.log(`${scenario}: peers=${peers} frames=${frames}@${frameMs}ms — go`);
    const sendT0 = Date.now();
    for (const h of handles) h.send('go');
    const sendBudgetMs = frames * frameMs + 60_000;
    for (let i = 0; i < handles.length; i++) {
      const done = await handles[i].waitFor('send-done', sendBudgetMs);
      if (!done) meter.note(`peer ${slots[i].label} never finished its send schedule`);
    }
    // Drain window: let the tail frames land before stopping.
    await new Promise((r) => setTimeout(r, Math.max(1_000, frameMs * 25)));
    const sendDurationS = (Date.now() - sendT0) / 1000;

    // 4. Collect + fold.
    const results = (await Promise.all(handles.map((h) => h.stopAndCollect()))).map(
      (r) => r as unknown as VoiceMeshChildResult | null,
    );

    const m2e: number[] = [];
    const m2eSameHost: number[] = [];
    const lossPct: number[] = [];
    const egressBps: number[] = [];
    const ingressBps: number[] = [];
    const meshReady: number[] = [];
    for (let r = 0; r < results.length; r++) {
      const recvRes = results[r];
      if (!recvRes) {
        meter.note(`peer ${slots[r].label} died without a result`);
        continue;
      }
      if (recvRes.meshReadyMs !== null) meshReady.push(recvRes.meshReadyMs);
      egressBps.push(recvRes.bytesOut / sendDurationS);
      ingressBps.push(recvRes.bytesIn / sendDurationS);
      for (let s = 0; s < results.length; s++) {
        if (s === r) continue;
        const sendRes = results[s];
        if (!sendRes) continue;
        // Fan-out classification: a pair sharing a DEFINED physical host rides
        // an intra-machine path (loopback-biased) — keep it out of the headline.
        const sameHost = !!slots[r].host && slots[r].host === slots[s].host;
        const times = recvRes.recv[sendRes.id] ?? [];
        const n = Math.min(times.length, sendRes.sendTimes.length);
        if (sendRes.sendTimes.length > 0) {
          lossPct.push((1 - n / sendRes.sendTimes.length) * 100);
        }
        const skew = offsets[r] - offsets[s];
        const pool = sameHost ? m2eSameHost : m2e;
        for (let k = 0; k < n; k++) {
          pool.push(times[k] - sendRes.sendTimes[k] - skew);
        }
      }
    }

    const artifact = meter.finish();
    if (m2e.length) artifact.metrics['mouthToEarMs'] = summarize(m2e, 'ms');
    if (m2eSameHost.length) {
      artifact.metrics['mouthToEarSameHostMs'] = summarize(m2eSameHost, 'ms');
      artifact.notes.push(
        'fan-out run: mouthToEarMs = CROSS-HOST pairs only; same-host pairs (intra-machine, loopback-biased) are mouthToEarSameHostMs',
      );
    }
    if (lossPct.length) artifact.metrics['frameLossPct'] = summarize(lossPct, 'count');
    if (egressBps.length) artifact.metrics['egressBytesPerSec'] = summarize(egressBps, 'bytes');
    if (ingressBps.length) artifact.metrics['ingressBytesPerSec'] = summarize(ingressBps, 'bytes');
    if (meshReady.length) artifact.metrics['meshReadyMs'] = summarize(meshReady, 'ms');
    artifact.params['regions'] = slots.map((s) => s.region ?? s.label).join('+');
    artifact.notes.push(
      'mouthToEarMs = pushMic→onPeerFrame (Opus encode + wire + decode, pre-playout-mix; ' +
        `the ${frameMs}ms mixer cadence adds up to one frame on top)`,
    );
    if (opts.estimateClock !== false) {
      artifact.notes.push(`clock-offset corrected per peer (offsets ms: ${offsets.map((o) => Math.round(o)).join(', ')})`);
    }
    return artifact;
  } finally {
    for (const h of handles) {
      if (!h.exited) h.kill('SIGKILL');
    }
  }
}

export interface VoiceMeshSuiteOpts {
  /** Mesh sizes to run (each uses the first N launcher slots). */
  meshSizes: number[];
  launcher: VoiceMeshLauncher;
  harnessSlug: string;
  frames?: number;
  frameMs?: number;
  meshTimeoutMs?: number;
  estimateClock?: boolean;
  outDir?: string;
  log?: (line: string) => void;
}

export interface VoiceMeshSuiteResult {
  runId: string;
  outDir: string;
  reportPath: string;
  artifacts: PerfArtifact[];
}

/**
 * The P-014 rung: one voiceMesh run per mesh size (2/5/10), persisted under the
 * same artifact/report pipeline as runTier3Suite.
 */
export async function runVoiceMeshSuite(opts: VoiceMeshSuiteOpts): Promise<VoiceMeshSuiteResult> {
  const log = opts.log ?? (() => {});
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = opts.outDir ?? join(process.cwd(), 'test-results', 'p2p-perf', runId);
  mkdirSync(outDir, { recursive: true });

  const artifacts: PerfArtifact[] = [];
  for (const size of opts.meshSizes) {
    if (size > opts.launcher.slots.length) {
      throw new Error(`runVoiceMeshSuite: mesh size ${size} > ${opts.launcher.slots.length} slots`);
    }
    log(`\n▶ tier3.voice-mesh @ ${size} peers`);
    const artifact = await voiceMesh({
      launcher: { slots: opts.launcher.slots.slice(0, size) },
      harnessSlug: `${opts.harnessSlug}-n${size}`,
      frames: opts.frames,
      frameMs: opts.frameMs,
      meshTimeoutMs: opts.meshTimeoutMs,
      estimateClock: opts.estimateClock,
      log,
    });
    artifact.params['peers'] = size;
    artifacts.push(artifact);
    const file = join(outDir, `${String(artifacts.length).padStart(3, '0')}-voice-mesh-${size}p.json`);
    writeFileSync(file, JSON.stringify(artifact, null, 2));
    const m = artifact.metrics['mouthToEarMs'];
    log(`  ✔ ${size} peers — mouthToEar p50=${m && 'p50' in m ? (m as { p50: number }).p50 : 'n/a'}ms`);
  }

  const reportPath = join(outDir, 'report.md');
  writeFileSync(
    reportPath,
    renderPerfReport({ runId, profile: 'tier3-voice', artifacts, titleSuffix: 'Tier 3 — voice mesh (P-014)' }),
  );
  log(`\nartifacts: ${outDir}`);
  log(`report:    ${reportPath}`);
  return { runId, outDir, reportPath, artifacts };
}
