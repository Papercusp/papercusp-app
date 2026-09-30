/**
 * remote-peer.ts — launch a substrate peer-child over a chosen transport, and
 * the clock-offset probe the cross-machine latency math needs
 * (p2p-performance-suite-2026-06-07 P-010/P-011).
 *
 * The Tier-1/2 scenarios spawn `peer-child.ts` as a LOCAL OS process
 * (`child-driver.ts spawnPeerChild`). Tier-3 runs the SAME peer-child over SSH
 * on a real frame — the child's ndjson stdin/stdout line protocol is transport-
 * agnostic, so the only thing that changes is HOW the process is started.
 *
 * A `PeerLauncher` abstracts that: `local` spawns peer-child here on a shared
 * local testnet (the $0 parity path — exercises the entire Tier-3 orchestration,
 * artifact, and report pipeline with no cloud, no SSH); `ssh` runs peer-child on
 * a frame against the PUBLIC DHT (cfg.bootstrap omitted). Both return the SAME
 * `PeerChildHandle`, so `scenarios.ts` never branches on transport.
 *
 * `estimateClockOffset` rides the child's `ping`→`pong` probe to estimate a
 * frame's clock offset vs this orchestrator, so a sentAt(writerClock)→
 * applied(readerClock) latency can be skew-corrected (NTP on the frame is the
 * primary discipline — bench-bootstrap forces it — this is the residual check).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerChildHandle, spawnPeerChild } from '../../sync/hyperbee/perf/child-driver';
import type { PeerChildConfig } from '../../sync/hyperbee/perf/peer-child';
import { buildSshStreamArgs, type SshTarget } from '../remote-exec';
import { remotePeerChildPath, benchRuntimeDir } from './bench-bootstrap';

/** One launch site for a peer — a frame (ssh) or a local slot. */
export interface PeerSlot {
  /** Human label for artifacts/reports (region for frames, `local-N` for parity). */
  label: string;
  /** Provider region, when this slot is a real frame. */
  region?: string;
  /** Spawn a peer-child for this slot. The caller fills role/seed/rate/count/etc. */
  launch(cfg: PeerChildConfig): PeerChildHandle;
}

export interface PeerLauncher {
  /** The ordered slots — slot[0] is conventionally the writer. */
  slots: PeerSlot[];
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Local parity launcher: N slots, all spawning peer-child on THIS machine joined
 * to one shared local testnet. Drives the full Tier-3 code path with zero cloud
 * cost — the CI coverage for the orchestration/artifact/report logic.
 */
export function localPeerLauncher(opts: {
  count: number;
  bootstrap: Array<{ host: string; port: number }>;
  log: (line: string) => void;
}): PeerLauncher & { cleanup(): void } {
  const dirs: string[] = [];
  const slots: PeerSlot[] = Array.from({ length: opts.count }, (_, i) => ({
    label: `local-${i}`,
    launch: (cfg: PeerChildConfig) => {
      // Each local peer needs its OWN corestore dir (the scenario passes root='').
      const root = mkdtempSync(join(tmpdir(), `p2p-perf-tier3-local-${i}-`));
      dirs.push(root);
      // Force the shared testnet bootstrap (parity peers must find each other locally).
      return spawnPeerChild({ ...cfg, root, bootstrap: opts.bootstrap }, opts.log);
    },
  }));
  return {
    slots,
    cleanup() {
      for (const d of dirs) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    },
  };
}

export interface SshSlotSpec {
  label: string;
  region?: string;
  /** SSH target for the frame (host/user/identity; sudo:false — run as login user). */
  target: SshTarget;
  /** Install root on the frame (default `/opt/papercusp`). */
  installRoot?: string;
  /** Extra env vars to set on the remote peer-child process. SSH does not forward arbitrary
   *  env, so these are inlined into the remote command (e.g. a `PAPERCUSP_FLAG_*` override to
   *  enable a flag-gated path like substrate-log-snapshot on the frame). */
  extraEnv?: Record<string, string>;
}

/**
 * SSH launcher: one slot per frame. Each slot ssh's in and runs peer-child under
 * `node --import tsx` against the PUBLIC DHT (cfg.bootstrap dropped). The ssh
 * child process IS the peer transport — its stdio is the child's ndjson pipe, so
 * `PeerChildHandle` wraps it unchanged.
 */
/**
 * Build the remote peer-child invocation for one slot (pure — unit-tested).
 * The child config is delivered via an inline env assignment (SSH does not
 * forward arbitrary env), and `exec` replaces the remote shell with node so
 * stdin-EOF / signals land on the child directly (clean stop-and-collect).
 */
export function buildRemotePeerCommand(
  cfg: PeerChildConfig,
  spec: Pick<SshSlotSpec, 'label' | 'installRoot' | 'extraEnv'>,
): { remoteCommand: string; childCfg: PeerChildConfig } {
  // Public DHT on real frames: never pass a local-testnet bootstrap.
  const { bootstrap: _drop, ...rest } = cfg;
  void _drop;
  const remoteRoot = `/tmp/p2p-perf-${spec.label}-${rest.peerIndex}-${rest.role}`;
  const childCfg: PeerChildConfig = { ...rest, root: remoteRoot };
  const peerChild = remotePeerChildPath(spec.installRoot);
  const runtimeDir = benchRuntimeDir(spec.installRoot);
  // SSH doesn't forward arbitrary env — inline any extras before the child invocation.
  const extraEnv = Object.entries(spec.extraEnv ?? {})
    .map(([k, v]) => `${k}=${shq(v)} `)
    .join('');
  const remoteCommand =
    `mkdir -p ${shq(remoteRoot)} && cd ${shq(runtimeDir)} && ` +
    `${extraEnv}P2P_PERF_CHILD=${shq(JSON.stringify(childCfg))} NODE_ENV=test ` +
    `exec node --import tsx ${shq(peerChild)}`;
  return { remoteCommand, childCfg };
}

/**
 * SSH options for the LONG-LIVED peer-launch stream (distinct from the install
 * path's short request/response runs). Two needs the shared sshBaseArgs doesn't
 * cover: (1) connect resilience — a fresh VM right after a CPU-saturating
 * `npm ci` can miss a single 10s connect window (hit live 2026-06-07: install
 * succeeded, the very next peer-launch connect timed out), so retry the TCP
 * connect; (2) keepalive — the connection carries ndjson for the whole scenario
 * (minutes), so probe it so a silent drop is detected rather than hanging.
 * `ConnectionAttempts` isn't set in sshBaseArgs, so this extraArgs value applies
 * (for ssh, the FIRST value of a repeated -o wins; base already pins ConnectTimeout).
 */
const PEER_STREAM_SSH_ARGS = [
  '-o',
  'ConnectionAttempts=6', // ~6 connect tries before giving up (transient-tolerant)
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=8', // ~2 min of silence before the stream is declared dead
  '-o',
  'TCPKeepAlive=yes',
];

export function sshPeerLauncher(opts: { frames: SshSlotSpec[]; log: (line: string) => void }): PeerLauncher {
  const slots: PeerSlot[] = opts.frames.map((f) => ({
    label: f.label,
    region: f.region,
    launch: (cfg: PeerChildConfig) => {
      const { remoteCommand, childCfg } = buildRemotePeerCommand(cfg, f);
      // Run as the login user (no sudo) — runtime files are world-readable; the
      // corestore lives in world-writable /tmp. Avoids sudo's stdin quirks.
      const target: SshTarget = {
        ...f.target,
        sudo: false,
        extraArgs: [...(f.target.extraArgs ?? []), ...PEER_STREAM_SSH_ARGS],
      };
      const { cmd, args } = buildSshStreamArgs(target, remoteCommand);
      const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      return new PeerChildHandle(childCfg, proc, opts.log);
    },
  }));
  return { slots };
}

/**
 * Estimate a launched peer's clock offset vs this orchestrator (ms), via K
 * `ping`→`pong` round-trips. Offset for the min-RTT sample wins (least queuing
 * noise): `offset ≈ tRemote − (tSent + tRecv)/2`. Returns `{ offsetMs, rttMs }`,
 * or null if the peer never ponged.
 */
export async function estimateClockOffset(
  handle: PeerChildHandle,
  opts: { samples?: number; timeoutMs?: number } = {},
): Promise<{ offsetMs: number; rttMs: number } | null> {
  const samples = opts.samples ?? 5;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const pongCount = () => handle.events.filter((e) => e.evt === 'pong').length;
  let best: { offsetMs: number; rttMs: number } | null = null;
  for (let i = 0; i < samples; i++) {
    const seen = pongCount();
    const tSent = Date.now();
    handle.send('ping');
    // Match only a pong that arrived AFTER this ping (past pongs from earlier
    // samples linger in handle.events).
    const got = await handle.waitFor((e) => e.evt === 'pong' && pongCount() > seen, timeoutMs);
    if (!got) continue;
    const tRecv = Date.now();
    const tRemote = Number((got as { tRemote?: number }).tRemote ?? 0);
    const rttMs = tRecv - tSent;
    // Min-RTT sample carries the least one-way queuing noise.
    const offsetMs = tRemote - (tSent + tRecv) / 2;
    if (!best || rttMs < best.rttMs) best = { offsetMs, rttMs };
  }
  return best;
}
