/**
 * netem-inner.ts — the Tier-2 WAN-simulation driver (P-008/P-009). Runs INSIDE
 * an unprivileged user namespace (`unshare -r -n -m`) where it is root: builds
 * a netns-per-peer topology bridged through the hub namespace, applies tc
 * netem (delay/jitter/loss) on every link, then drives the SAME peer-child
 * mesh the Tier-1 scenarios use — only the wire differs.
 *
 *   hub netns (this process):  br0 10.77.0.1/16, the testnet DHT binds here
 *   peer i:                    netns p<i>, veth e<i> ↔ v<i> on br0, 10.77.0.<10+i>/16
 *   each veth end:             `tc qdisc … netem delay rtt/2 jitter/2 loss L%`
 *
 * No sudo, no global netns pollution: everything lives and dies with the
 * userns (kernel cleans up namespaces + veths on exit; /run is a private
 * tmpfs mount). Spawned by scenarios/netem.ts — never run by hand.
 *
 * Protocol: ndjson on stdout — {evt:'artifact', artifact} per finished
 * artifact, {evt:'log', line} for progress, {evt:'fatal', message} on error.
 */

import { execFileSync } from 'node:child_process';
import createTestnet from 'hyperdht/testnet.js';
import {
  spawnProcMesh,
  foldChildResults,
  awaitAllChildEvent,
  catchUpElapsedMs,
} from './child-driver';
import { resolveNetemFailure } from './mesh-outcome';
import { ScenarioMeter, summarize } from './metrics';
import { expectedWinnersFor } from './scenarios/churn';
import type { NetemInnerConfig, NetemProfile } from './netem-types';

const HUB_IP = '10.77.0.1';

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function log(line: string): void {
  out({ evt: 'log', line });
}

/** One netem clause per direction: half the RTT/jitter, full per-direction loss. */
function netemArgs(p: NetemProfile): string[] {
  const args = ['delay', `${p.rttMs / 2}ms`];
  if (p.jitterMs > 0) args.push(`${p.jitterMs / 2}ms`);
  if (p.lossPct > 0) args.push('loss', `${p.lossPct}%`);
  return args;
}

function setupTopology(peers: number, profile: NetemProfile): void {
  // Private /run so `ip netns add` has its own bind-mount home.
  sh('mount', ['-t', 'tmpfs', 'tmpfs', '/run']);
  sh('ip', ['link', 'set', 'lo', 'up']);
  sh('ip', ['link', 'add', 'br0', 'type', 'bridge']);
  sh('ip', ['addr', 'add', `${HUB_IP}/16`, 'dev', 'br0']);
  sh('ip', ['link', 'set', 'br0', 'up']);
  for (let i = 0; i < peers; i++) {
    const ns = `p${i}`;
    const hubEnd = `v${i}`;
    const peerEnd = `e${i}`;
    sh('ip', ['netns', 'add', ns]);
    sh('ip', ['link', 'add', hubEnd, 'type', 'veth', 'peer', 'name', peerEnd]);
    sh('ip', ['link', 'set', peerEnd, 'netns', ns]);
    sh('ip', ['link', 'set', hubEnd, 'master', 'br0']);
    sh('ip', ['link', 'set', hubEnd, 'up']);
    sh('ip', ['-n', ns, 'link', 'set', 'lo', 'up']);
    sh('ip', ['-n', ns, 'addr', 'add', `10.77.0.${10 + i}/16`, 'dev', peerEnd]);
    sh('ip', ['-n', ns, 'link', 'set', peerEnd, 'up']);
    // Impair BOTH directions: hub-side veth (toward peer) + peer-side veth.
    sh('tc', ['qdisc', 'add', 'dev', hubEnd, 'root', 'netem', ...netemArgs(profile)]);
    sh('ip', [
      'netns',
      'exec',
      ns,
      'tc',
      'qdisc',
      'add',
      'dev',
      peerEnd,
      'root',
      'netem',
      ...netemArgs(profile),
    ]);
  }
}

async function main(): Promise<void> {
  const cfg = JSON.parse(process.argv[2] ?? '{}') as NetemInnerConfig;
  const peers = cfg.readers + 1;
  log(`netem-inner: topology peers=${peers} rtt=${cfg.profile.rttMs}ms jitter=${cfg.profile.jitterMs}ms loss=${cfg.profile.lossPct}%`);
  setupTopology(peers, cfg.profile);

  // The DHT bootstrap must be reachable from the peer namespaces → bind the hub IP.
  const testnet = await createTestnet(3, { host: HUB_IP });
  const bootstrap = (testnet.bootstrap as Array<{ host: string; port: number }>).map((b) => ({
    host: b.host,
    port: b.port,
  }));

  const profileParams = {
    rttMs: cfg.profile.rttMs,
    jitterMs: cfg.profile.jitterMs,
    lossPct: cfg.profile.lossPct,
  };
  const scenarioId =
    cfg.mode === 'sustained'
      ? 'netem.sustained'
      : cfg.mode === 'cold-join'
        ? 'netem.cold-join'
        : 'netem.loss-curve';
  const execPrefixFor = (i: number) => ['ip', 'netns', 'exec', `p${i}`];
  // Generous budgets: 300ms RTT + 2% loss makes everything slow on purpose.
  const budget = 5 * 60_000;

  try {
    if (cfg.mode === 'sustained') {
      const rate = cfg.rate ?? 25;
      const count = cfg.count ?? 200;
      const mesh = await spawnProcMesh({
        readers: cfg.readers,
        log,
        bootstrap,
        execPrefixFor,
        writerCfg: { rate, count, seed: cfg.seed },
        readerCfg: { mergePollMs: 1000, expectedWinners: count, catchUpTimeoutMs: budget },
        meshTimeoutMs: budget,
      });
      try {
        const meter = new ScenarioMeter({
          scenario: 'netem.sustained',
          tier: 2,
          params: { ...profileParams, peers, rate, count },
        });
        meter.expectReaders(mesh.readers.length);
        mesh.writer.send('go');
        await mesh.writer.waitFor('writer-done', (count / Math.max(rate, 1)) * 1000 + budget);
        // EI-20581532536662596: one SHARED deadline for every reader. This was a
        // serial loop handing each reader a fresh `budget` as it was reached, so
        // the deadline depended on a reader's position in the array rather than on
        // the run — the same defect fixed in replication.sustained, and just as
        // able to turn host load into a false convergence failure.
        meter.convergenceBudget(budget);
        for (const { reader, event, elapsedMs } of await awaitAllChildEvent(
          mesh.readers,
          'caught-up',
          budget,
        )) {
          if (event) meter.readerConverged(reader.cfg.peerIndex, elapsedMs);
          else meter.readerDidNotConverge(reader.cfg.peerIndex);
        }
        const results = [
          await mesh.writer.stopAndCollect(),
          ...(await Promise.all(mesh.readers.map((r) => r.stopAndCollect()))),
        ];
        const allLat: number[] = [];
        for (const r of results) if (r?.role === 'reader' && r.latenciesRaw) allLat.push(...r.latenciesRaw);
        const artifact = foldChildResults(
          meter,
          (a) => {
            a.metrics['appendToVisibleMs'] = summarize(allLat, 'ms');
          },
          results,
        );
        out({ evt: 'artifact', artifact });
      } finally {
        await mesh.teardown();
      }
    } else if (cfg.mode === 'cold-join') {
      const preSeed = cfg.preSeed ?? 10_000;
      const winners = expectedWinnersFor(cfg.seed, preSeed);
      const mesh = await spawnProcMesh({
        readers: 1,
        log,
        bootstrap,
        execPrefixFor,
        writerCfg: { preSeed, seed: cfg.seed, corpusAuthor: 'a'.repeat(64) },
        readerCfg: { mergePollMs: 1000, expectedWinners: winners, catchUpTimeoutMs: budget },
        meshTimeoutMs: budget,
      });
      try {
        const meter = new ScenarioMeter({
          scenario: 'netem.cold-join',
          tier: 2,
          params: { ...profileParams, historySize: preSeed, winners },
        });
        const reader = mesh.readers[0];
        meter.expectReaders(1);
        // EI-20576392705164447: the outcome of this wait used to be discarded
        // entirely (no `if`, not even a note) — a cold-join that never caught up
        // under impairment produced an artifact indistinguishable from one that did.
        if (!(await reader.waitFor('caught-up', budget))) {
          meter.readerDidNotConverge(reader.cfg.peerIndex, 'never caught up under this netem profile');
        }
        const results = [await mesh.writer.stopAndCollect(), await reader.stopAndCollect()];
        const r = results[1];
        const artifact = foldChildResults(
          meter,
          (a) => {
            if (r?.role === 'reader') {
              a.notes.push(`caughtUp=${r.caughtUp ?? false} appliedKeys=${r.appliedKeys}/${winners}`);
              if (typeof r.catchUpMs === 'number') a.metrics['coldJoinMs'] = summarize([r.catchUpMs], 'ms');
            }
          },
          results,
        );
        out({ evt: 'artifact', artifact });
      } finally {
        await mesh.teardown();
      }
    } else {
      // loss-curve (P-009): flood through the impaired link — the stack-level
      // UDX/Noise retransmit/backoff curve. Effective throughput + stall time
      // vs loss is the actionable transport signal.
      const count = cfg.count ?? 1000;
      const mesh = await spawnProcMesh({
        readers: cfg.readers,
        log,
        bootstrap,
        execPrefixFor,
        writerCfg: { rate: 0, count, seed: cfg.seed },
        readerCfg: { mergePollMs: 200, expectedWinners: count, catchUpTimeoutMs: budget },
        meshTimeoutMs: budget,
      });
      try {
        const meter = new ScenarioMeter({
          scenario: 'netem.loss-curve',
          tier: 2,
          params: { ...profileParams, peers, count },
        });
        meter.expectReaders(mesh.readers.length);
        const tGo = Date.now();
        mesh.writer.send('go');
        const ceiling = meter.metric('floodOpsPerSec', 'ops/sec');
        const catchUp = meter.metric('floodCatchUpMs', 'ms');
        // EI-20581532536662596: shared deadline, as above.
        //
        // ⚠ The per-reader elapsed MUST come from `elapsedMs`, not from a
        // `Date.now() - tGo` read after the await. Under the old serial loop that
        // read ran as each reader resolved, so it was genuinely per-reader; once
        // the waits are concurrent every reader resolves before the loop body
        // runs, and the same expression would stamp them all with the time the
        // SLOWEST one finished — collapsing floodCatchUpMs/floodOpsPerSec into a
        // single repeated value that still looks like a distribution.
        meter.convergenceBudget(budget);
        const tAwait = Date.now();
        for (const { reader, event, elapsedMs } of await awaitAllChildEvent(
          mesh.readers,
          'caught-up',
          budget,
        )) {
          // Time from `go` to THIS reader's catch-up. EI-20582417177742601:
          // prefer the child's OWN instant over any parent-side reading — see
          // catchUpElapsedMs, which also owns the concurrent-await trap noted above.
          const elapsed = catchUpElapsedMs(event, { tGo, tAwait, elapsedMs });
          if (elapsed !== null) {
            catchUp.push(elapsed);
            if (elapsed > 0) ceiling.push(count / (elapsed / 1000));
            meter.readerConverged(reader.cfg.peerIndex, elapsed);
          } else {
            meter.readerDidNotConverge(
              reader.cfg.peerIndex,
              'never caught up — transport stalled under loss',
            );
          }
        }
        const results = [
          await mesh.writer.stopAndCollect(),
          ...(await Promise.all(mesh.readers.map((r) => r.stopAndCollect()))),
        ];
        out({ evt: 'artifact', artifact: foldChildResults(meter, () => {}, results) });
      } finally {
        await mesh.teardown();
      }
    }
  } catch (e) {
    // A mesh that never forms under the impaired link is a MEASURED outcome of
    // the netem profile, not a harness fault: record a did-not-form cell and
    // let the sweep continue instead of crashing the whole Tier-2 run (EI-116).
    const resolved = resolveNetemFailure(e, {
      scenario: scenarioId,
      tier: 2,
      params: { ...profileParams, peers, mode: cfg.mode },
    });
    if (resolved.kind === 'artifact') {
      log(`mesh did not form (loss=${cfg.profile.lossPct}% rtt=${cfg.profile.rttMs}ms) — recording did-not-form cell (EI-116)`);
      out({ evt: 'artifact', artifact: resolved.artifact });
    } else {
      out({ evt: 'fatal', message: resolved.message });
      process.exitCode = 1;
    }
  } finally {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  }
  process.exit(process.exitCode ?? 0);
}

void main();
