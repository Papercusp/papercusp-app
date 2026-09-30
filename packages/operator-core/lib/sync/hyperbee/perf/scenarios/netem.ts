/**
 * netem.ts — Tier-2 simulated-WAN scenarios (P-008/P-009).
 *
 * Capability-gated the same way Tier-3 is cred-gated: when the host cannot
 * create unprivileged user+net namespaces (`unshare -r -n -m`), the scenarios
 * emit nothing and note the skip — CI on a restricted kernel is unaffected
 * (Ubuntu ≥23.10 may set kernel.apparmor_restrict_unprivileged_userns=1).
 *
 * Each (mode × profile) cell launches one `unshare -r -n -m node --import tsx
 * netem-inner.ts <config>` run; the inner driver builds the netns/veth/netem
 * topology and replays the Tier-1 mesh through the impaired links. Artifacts
 * come back over ndjson and carry tier:2 + the netem profile in params, so
 * Tier-1/2 curves overlay (P-012).
 *
 *   netem.sustained  — replication latency across the RTT matrix (P-008)
 *   netem.cold-join  — cold-join wall time across the RTT matrix (P-008)
 *   netem.loss-curve — flood throughput vs LOSS at fixed RTT: the stack-level
 *     UDX/Noise retransmit/backoff curve (P-009). Measured through the real
 *     replication stack rather than a raw udx socket — the actionable number.
 */

import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PerfArtifact } from '../artifact';
import type { NetemInnerConfig, NetemProfile } from '../netem-types';
import type { PerfScenario, ScenarioRunCtx } from '../scenario-types';

const INNER = fileURLToPath(new URL('../netem-inner.ts', import.meta.url));

export function netemCapable(): { ok: boolean; reason?: string } {
  try {
    execFileSync('unshare', ['-r', '-n', '-m', 'true'], { stdio: 'ignore', timeout: 10_000 });
    execFileSync('which', ['tc'], { stdio: 'ignore' });
    execFileSync('which', ['ip'], { stdio: 'ignore' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The P-008 RTT/loss/jitter matrix (full profile). */
const WAN_PROFILES: NetemProfile[] = [
  { rttMs: 50, jitterMs: 10, lossPct: 0.1 },
  { rttMs: 150, jitterMs: 20, lossPct: 0.5 },
  { rttMs: 300, jitterMs: 40, lossPct: 2 },
];

/** The P-009 loss sweep at a fixed mid-range RTT. */
const LOSS_PROFILES: NetemProfile[] = [
  { rttMs: 150, jitterMs: 10, lossPct: 0 },
  { rttMs: 150, jitterMs: 10, lossPct: 0.5 },
  { rttMs: 150, jitterMs: 10, lossPct: 1 },
  { rttMs: 150, jitterMs: 10, lossPct: 2 },
];

function profilesFor(ctx: ScenarioRunCtx, all: NetemProfile[]): NetemProfile[] {
  if (ctx.profile === 'smoke') return [all[Math.floor(all.length / 2)]];
  if (ctx.profile === 'ci') return all.filter((_, i) => i % 2 === 0);
  return all;
}

async function runInner(cfg: NetemInnerConfig, ctx: ScenarioRunCtx): Promise<PerfArtifact[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'unshare',
      ['-r', '-n', '-m', '--', process.execPath, '--import', 'tsx', INNER, JSON.stringify(cfg)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const artifacts: PerfArtifact[] = [];
    let buf = '';
    let fatal: string | null = null;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line) as { evt: string; artifact?: PerfArtifact; line?: string; message?: string };
          if (e.evt === 'artifact' && e.artifact) artifacts.push(e.artifact);
          else if (e.evt === 'log' && e.line) ctx.log(`[netem] ${e.line}`);
          else if (e.evt === 'fatal') fatal = e.message ?? 'unknown';
        } catch {
          ctx.log(`[netem raw] ${line}`);
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) ctx.log(`[netem stderr] ${line.trim()}`);
    });
    const killTimer = setTimeout(() => proc.kill('SIGKILL'), 20 * 60_000);
    proc.on('exit', (code) => {
      clearTimeout(killTimer);
      if (fatal) reject(new Error(`netem-inner fatal: ${fatal}`));
      else if (code !== 0 && artifacts.length === 0) reject(new Error(`netem-inner exited ${code}`));
      else resolve(artifacts);
    });
    proc.on('error', (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
  });
}

function gated(id: string, describe: string, body: (ctx: ScenarioRunCtx) => Promise<void>): PerfScenario {
  return {
    id,
    tier: 2,
    describe,
    async run(ctx: ScenarioRunCtx): Promise<void> {
      const cap = netemCapable();
      if (!cap.ok) {
        ctx.log(`SKIP ${id}: host cannot create user+net namespaces (${cap.reason}) — Tier 2 needs unshare -r -n -m + iproute2/tc`);
        return;
      }
      await body(ctx);
    },
  };
}

export const netemSustained = gated(
  'netem.sustained',
  'Replication latency across the WAN RTT/loss matrix (P-008).',
  async (ctx) => {
    for (const profile of profilesFor(ctx, WAN_PROFILES)) {
      const readers = ctx.profile === 'smoke' ? 1 : 2;
      ctx.log(`netem.sustained: rtt=${profile.rttMs}ms loss=${profile.lossPct}%`);
      const artifacts = await runInner(
        { profile, mode: 'sustained', readers, rate: 25, count: ctx.profile === 'smoke' ? 100 : 200, seed: ctx.seed },
        ctx,
      );
      for (const a of artifacts) await ctx.emit(a);
    }
  },
);

export const netemColdJoin = gated(
  'netem.cold-join',
  'Cold-join wall time across the WAN RTT/loss matrix (P-008).',
  async (ctx) => {
    for (const profile of profilesFor(ctx, WAN_PROFILES)) {
      const preSeed = ctx.profile === 'smoke' ? 1_000 : 10_000;
      ctx.log(`netem.cold-join: rtt=${profile.rttMs}ms loss=${profile.lossPct}% H=${preSeed}`);
      const artifacts = await runInner(
        { profile, mode: 'cold-join', readers: 1, preSeed, seed: ctx.seed },
        ctx,
      );
      for (const a of artifacts) await ctx.emit(a);
    }
  },
);

export const netemLossCurve = gated(
  'netem.loss-curve',
  'Flood throughput vs packet loss at fixed RTT — the UDX/Noise retransmit/backoff curve (P-009).',
  async (ctx) => {
    for (const profile of profilesFor(ctx, LOSS_PROFILES)) {
      ctx.log(`netem.loss-curve: loss=${profile.lossPct}% @ rtt=${profile.rttMs}ms`);
      const artifacts = await runInner(
        { profile, mode: 'loss-curve', readers: 1, count: ctx.profile === 'smoke' ? 300 : 1000, seed: ctx.seed },
        ctx,
      );
      for (const a of artifacts) await ctx.emit(a);
    }
  },
);

export const netemScenarios: PerfScenario[] = [netemSustained, netemColdJoin, netemLossCurve];
