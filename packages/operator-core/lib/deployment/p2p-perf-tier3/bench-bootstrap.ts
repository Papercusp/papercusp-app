/**
 * bench-bootstrap.ts — the MINIMAL frame bootstrap for a Tier-3 p2p-perf peer
 * (p2p-performance-suite-2026-06-07 P-010).
 *
 * A bench frame is NOT a harness frame. `frame-bootstrap.ts` stands up a
 * self-sufficient harness node — agent CLIs + Meridian + the per-frame Claude
 * subscription + its own embedded-pg + its own orchestrator loop. A measurement
 * peer needs NONE of that: it only runs `peer-child.ts` (the same headless
 * substrate peer the Tier-1/2 scenarios spawn) on demand over SSH. Bootstrapping
 * the full harness stack on it would 10× the wall-time and the bill and pollute
 * the numbers with an orchestrator loop sharing the event loop we measure.
 *
 * So this generator emits the smallest script that makes `node --import tsx
 * peer-child.ts` runnable: OS build deps (the substrate has native modules —
 * sodium-native, rocksdb, udx-native — that `npm ci` compiles on the frame's
 * arch), Node, forced clock sync (cross-region replication latency is measured
 * in wall-ms, so NTP must be on — D-007), and the runtime tree (untar the
 * operator-packed tarball, then `npm ci` to resolve deps + build the natives).
 * No services are started; the peer is launched per-scenario over SSH.
 *
 * Pure (script + step list out), unit-testable without a frame — same discipline
 * as frame-bootstrap.ts.
 */

export interface BenchBootstrapOpts {
  /** Node major to install (default 22 — matches the runtime). */
  nodeVersion?: number;
  /** Install root on the frame (default `/opt/papercusp`). The runtime lands at `<root>/runtime`. */
  installRoot?: string;
  /** Path on the frame where the operator-packed runtime tarball was staged before this runs. */
  runtimeTarballRemotePath: string;
  /**
   * NAT/holepunch variant (P-011): install an nftables stateful inbound-drop
   * firewall so this public-IP machine behaves like a NAT'd peer — only
   * established/related and tcp/22 (SSH control) are let in, so an inbound P2P
   * connection MUST be holepunched, not direct. Off by default (direct WAN).
   */
  firewall?: boolean;
}

/** The bench-bootstrap section ids, in run order — the observable contract. */
export const BENCH_BOOTSTRAP_STEPS = [
  'preflight',
  'node',
  'timesync',
  'firewall',
  'runtime',
] as const;
export type BenchBootstrapStep = (typeof BENCH_BOOTSTRAP_STEPS)[number];

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function section(id: BenchBootstrapStep, title: string, lines: string[]): string {
  return [`# ── ${id}: ${title} ──`, `log ${shq(id)}`, ...lines, ''].join('\n');
}

export interface BenchBootstrapResult {
  script: string;
  steps: BenchBootstrapStep[];
}

export function buildBenchBootstrap(opts: BenchBootstrapOpts): BenchBootstrapResult {
  const node = opts.nodeVersion ?? 22;
  const root = (opts.installRoot ?? '/opt/papercusp').replace(/\/$/, '');
  const runtimeDir = `${root}/runtime`;

  const emitted: BenchBootstrapStep[] = [];
  const blocks: string[] = [];
  const add = (id: BenchBootstrapStep, title: string, lines: string[]) => {
    emitted.push(id);
    blocks.push(section(id, title, lines));
  };

  add('preflight', 'OS + native-build packages', [
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -y',
    // build-essential + python3: the substrate's native deps (sodium-native,
    // rocksdb-native, udx-native) are compiled by `npm ci` on the frame's arch.
    'apt-get install -y --no-install-recommends git curl ca-certificates build-essential python3 jq',
  ]);

  add('node', `Node.js ${node}`, [
    `if ! node -v 2>/dev/null | grep -q "^v${node}"; then`,
    `  curl -fsSL https://deb.nodesource.com/setup_${node}.x | bash -`,
    '  apt-get install -y nodejs',
    'fi',
    'npm i -g tsx',
  ]);

  add('timesync', 'force clock sync (NTP)', [
    // Cross-region replication latency is sentAt(writer)→applied(reader) in
    // wall-ms across two machines, so their clocks MUST be disciplined. The
    // scenario ALSO ping/pong-estimates the residual offset, but NTP is the
    // primary mechanism — a free-running clock would swamp a 50-300ms WAN signal.
    'apt-get install -y --no-install-recommends systemd-timesyncd || apt-get install -y --no-install-recommends chrony || true',
    'timedatectl set-ntp true 2>/dev/null || true',
    'systemctl restart systemd-timesyncd 2>/dev/null || systemctl restart chrony 2>/dev/null || true',
    // Best-effort one-shot step so a freshly-booted clock is close before benches run.
    'sleep 2',
  ]);

  if (opts.firewall) {
    // P-011 NAT/holepunch variant: make a public-IP box NAT-like. Stateful
    // inbound DROP (allow loopback + established/related + tcp/22 for the SSH
    // control channel); all other NEW inbound is dropped, so an inbound P2P
    // flow can only land via a holepunch the DHT coordinates — exactly the
    // measurement (success rate + dht.stats.punches deltas).
    add('firewall', 'NAT-like inbound-drop (nftables)', [
      'apt-get install -y --no-install-recommends nftables',
      'nft flush ruleset',
      'nft add table inet bench',
      "nft add chain inet bench input '{ type filter hook input priority 0 ; policy drop ; }'",
      'nft add rule inet bench input iif lo accept',
      'nft add rule inet bench input ct state established,related accept',
      'nft add rule inet bench input tcp dport 22 accept',
      "echo '[bench] NAT-like inbound-drop firewall armed (SSH + established only)'",
    ]);
  }

  add('runtime', 'unpack papercusp runtime (no build — tsx runs TS directly)', [
    `mkdir -p ${shq(runtimeDir)}`,
    // The runtime repo is private; deliver the operator-packed tarball (sources
    // only) and resolve deps on the frame. --legacy-peer-deps fallback: a
    // fast-moving monorepo lockfile can carry transient peer skew that must not
    // fail a bench install (same survival rule as frame-bootstrap.ts).
    `tar xzf ${shq(opts.runtimeTarballRemotePath)} -C ${shq(runtimeDir)}`,
    `rm -f ${shq(opts.runtimeTarballRemotePath)} # free ~200MB once extracted`,
    // --ignore-scripts: the bench peer only imports the hyperbee substrate, whose
    // native deps (sodium-native, udx-native, rocksdb-native) ALL ship prebuilds
    // that node-gyp-build resolves at require-time — no compile needed (the same
    // way the desktop bundles them). Skipping install scripts ALSO skips building
    // deps the bench never imports — notably @rocicorp/zero-sqlite3, whose
    // from-source sqlite3 amalgamation compile fails on a stock cloud image
    // (Hetzner cpx31, 2026-06-08) and would otherwise abort the whole install. A
    // measurement peer needs no Zero; building it was incidental dep-tree fallout.
    `cd ${shq(runtimeDir)} && (npm ci --no-audit --no-fund --ignore-scripts || npm install --no-audit --no-fund --legacy-peer-deps --ignore-scripts)`,
    // No `npm run build`: peer-child.ts runs under `node --import tsx` directly,
    // exactly as the Tier-1 child-driver spawns it locally.
    `echo ${shq('bench runtime ready at ' + runtimeDir)}`,
  ]);

  const header = [
    '#!/usr/bin/env bash',
    '# Generated by bench-bootstrap.ts — p2p-performance-suite P-010 (Tier-3 bench peer).',
    'set -euo pipefail',
    'log() { echo "[bench-bootstrap] $1"; }',
    '',
  ].join('\n');

  return { script: header + blocks.join('\n'), steps: emitted };
}

/** Remote path where the bench runtime lands — the dir the peer-child path is relative to. */
export function benchRuntimeDir(installRoot = '/opt/papercusp'): string {
  return `${installRoot.replace(/\/$/, '')}/runtime`;
}

/** Path to peer-child.ts inside the unpacked runtime (the SSH launch target). */
export function remotePeerChildPath(installRoot = '/opt/papercusp'): string {
  return `${benchRuntimeDir(installRoot)}/packages/operator-core/lib/sync/hyperbee/perf/peer-child.ts`;
}

/** Path to claim-agent.ts inside the unpacked runtime (the ≥3-Swarm claim E2E launch
 *  target — decentralized-dispatch-scaling P-013). Shipped automatically: runtime-pack
 *  tars the whole source tree, so a new file under deployment/ lands here with no allowlist. */
export function remoteClaimAgentPath(installRoot = '/opt/papercusp'): string {
  return `${benchRuntimeDir(installRoot)}/packages/operator-core/lib/deployment/p2p-perf-tier3/claim-agent.ts`;
}

/** Path to loop-agent.ts inside the unpacked runtime (the real-metal FULL-LOOP E2E launch
 *  target — shared-hive-loop-e2e-testing P-008/P-009/P-011). Ships like claim-agent.ts. */
export function remoteLoopAgentPath(installRoot = '/opt/papercusp'): string {
  return `${benchRuntimeDir(installRoot)}/packages/operator-core/lib/deployment/p2p-perf-tier3/loop-agent.ts`;
}

/** Path to eviction-agent.ts inside the unpacked runtime (the ≥3-machine LOCK-AUTHORITY
 *  φ+SWIM EVICTION proof launch target — shared-hive-hardening P-016 / D-010). Ships like
 *  claim-agent.ts (runtime-pack tars the whole source tree). */
export function remoteEvictionAgentPath(installRoot = '/opt/papercusp'): string {
  return `${benchRuntimeDir(installRoot)}/packages/operator-core/lib/deployment/p2p-perf-tier3/eviction-agent.ts`;
}
