/**
 * replication.ts — Tier-1 multi-process replication benches (P-005).
 *
 * Real OS processes per peer (see peer-child.ts for why), loopback transport
 * over a local testnet DHT. Two scenarios:
 *
 *   replication.sustained — append→visible latency at a sustained writer rate
 *     across a peer-count sweep. Readers merge at the PRODUCTION cadence
 *     (mergePollMs 1000), so the headline latency includes the 1Hz poll
 *     quantization — that is what a user experiences.
 *
 *   replication.ceiling — writer appends as fast as it can; readers merge at
 *     a tight cadence. The ceiling is ops/sec from `go` to every reader
 *     having applied all measurement ops. This is the EI-79-class stress
 *     case: reader loop lag during catch-up is the SLO metric that matters.
 *
 * The artifact's loop-lag/SLO verdict is the WORST child process (the
 * parent's own loop only orchestrates).
 */

import { ScenarioMeter, summarize } from '../metrics';
import type { PerfScenario, ScenarioRunCtx } from '../scenario-types';
import {
  spawnProcMesh,
  foldChildResults,
  awaitAllChildEvent,
  catchUpElapsedMs,
} from '../child-driver';

export const sustained: PerfScenario = {
  id: 'replication.sustained',
  tier: 1,
  describe: 'Append→visible latency at sustained writer rates across a peer-count sweep (production 1Hz reader merges).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const rates = ctx.profile === 'smoke' ? [10] : ctx.profile === 'ci' ? [10, 100] : [1, 10, 100];
    for (const peers of ctx.peerCounts) {
      for (const rate of rates) {
        // Enough ops for a stable distribution; bounded so a sweep stays sane.
        const count = Math.max(20, Math.min(rate * 20, 400));
        // EI-20581532536662596: ONE budget, used for BOTH the child's own catch-up
        // timeout and the parent's wait. These were previously two separate literals
        // (120_000 here, 30_000 at the wait below) — the parent abandoned at 30s a
        // child its own config gave 120s, and nothing made the drift visible.
        const catchUpBudgetMs = 120_000;
        const mesh = await spawnProcMesh({
          readers: peers - 1,
          log: ctx.log,
          writerCfg: { rate, count, seed: ctx.seed },
          readerCfg: { mergePollMs: 1000, expectedWinners: count, catchUpTimeoutMs: catchUpBudgetMs },
        });
        try {
          const meter = new ScenarioMeter({
            scenario: 'replication.sustained',
            tier: 1,
            params: { peers, rate, count },
          });
          meter.expectReaders(mesh.readers.length);
          ctx.log(`replication.sustained: peers=${peers} rate=${rate}/s count=${count} — go`);
          mesh.writer.send('go');
          const writerDone = await mesh.writer.waitFor(
            'writer-done',
            (count / Math.max(rate, 1)) * 1000 + 60_000,
          );
          if (!writerDone) meter.note('writer never reported done — partial run');
          // Wait for every reader to see all ops (bounded), CONCURRENTLY against a
          // SHARED deadline — every timer starts at the same instant here.
          //
          // EI-20581532536662596: this was a SERIAL loop giving each reader a FRESH
          // 30s budget. Because `waitFor` returns immediately for an already-fired
          // event (child-driver.ts:81-82), the reader polled FIRST got exactly 30s
          // from loop start while the Nth got 30s PLUS all the time already spent
          // waiting on readers 0..N-1 — so the deadline was a function of a reader's
          // POSITION IN THE ITERATION ORDER rather than of the run. The signature was
          // unmistakable once looked for: across 7 runs at 48 peers every failing run
          // missed by EXACTLY ONE reader (46/47, never 45), because the first slow
          // reader burned its budget and thereby widened everyone else's. That made a
          // red `convergencePassed` unable to distinguish "the substrate failed" from
          // "the box was loaded and a fixed timer tripped" — on a shared box running an
          // agent fleet, load alone flipped this verdict (6 repeats at a FIXED 48 peers
          // went FAIL/FAIL/pass/pass/pass/pass, the two failures being the two slowest
          // runs). Do not reintroduce a per-reader budget measured from when the loop
          // happens to reach that reader.
          const settled = await awaitAllChildEvent(mesh.readers, 'caught-up', catchUpBudgetMs);
          // Record the GOALPOST and the observed times, not just the verdict —
          // a bare converged/not binary cannot distinguish "cleared the budget
          // with 110s to spare" from "cleared it by 200ms", which is exactly
          // what makes a green ladder unattributable after a budget change.
          meter.convergenceBudget(catchUpBudgetMs);
          for (const { reader, event, elapsedMs } of settled) {
            if (event) meter.readerConverged(reader.cfg.peerIndex, elapsedMs);
            else meter.readerDidNotConverge(reader.cfg.peerIndex);
          }
          const results = [
            await mesh.writer.stopAndCollect(),
            ...(await Promise.all(mesh.readers.map((r) => r.stopAndCollect()))),
          ];
          const allLat: number[] = [];
          for (const r of results) {
            if (r?.role === 'reader' && r.latenciesRaw) allLat.push(...r.latenciesRaw);
          }
          const artifact = foldChildResults(
            meter,
            (a) => {
              a.metrics['appendToVisibleMs'] = summarize(allLat, 'ms');
              const w = results[0];
              if (w?.appendMs) a.metrics['appendCallMs'] = w.appendMs;

              // D-033 (harden-shared-hive-to-256-peers-2026-06-29): MESH FORMATION TIME.
              //
              // Every peer-child ALREADY timestamped every connection it made
              // (`net.connections[].atMs`, ms since that child's boot) and the parent
              // then DISCARDED all of it: `net` was declared on PeerChildResult and
              // referenced nowhere downstream, so no artifact this rig has ever written
              // carries a formation number. The measurement existed; only the plumbing
              // was missing. This is that plumbing — no new probe, nothing added to the
              // hot path that could perturb what it measures.
              //
              // WHY IT MATTERS: hyperswarm's MAX_PARALLEL = 3 (index.js:14) caps
              // CONCURRENT dials regardless of maxPeers, so mesh formation is
              // ceil((N-1)/3) SERIALIZED rounds — 21 at N=64 but 85 at N=256 — against a
              // FIXED wall-clock convergence budget. That is a scaling limit with no
              // memory component, and it is measurable at SMALL N and extrapolable:
              // fit formation against N over 16/32/64 and the line predicts 256 without
              // ever running 256 peers.
              const lastConnMs: number[] = [];
              const arrivalGapMs: number[] = [];
              for (const r of results) {
                const conns = r?.net?.connections;
                if (!conns?.length) continue;
                const ats = conns.map((c) => c.atMs).sort((x, y) => x - y);
                lastConnMs.push(ats[ats.length - 1]!);
                for (let i = 1; i < ats.length; i++) arrivalGapMs.push(ats[i]! - ats[i - 1]!);
              }
              // Per-peer time from ITS boot to ITS last connection. The mesh is formed
              // when the slowest peer finishes, so read `max`, not `p50`.
              if (lastConnMs.length) a.metrics['meshFormationMs'] = summarize(lastConnMs, 'ms');
              // ⚠ NOT per-ROUND dial latency, and must not be quoted as one. `connections`
              // fires for INBOUND accepts as well as OUTBOUND dials, and MAX_PARALLEL
              // bounds only the outbound half — so this is the arrival-burst SIGNATURE
              // (clustering at ~3) rather than a clean measurement of one dial round.
              // Separating the two needs the direction flag hyperswarm exposes on
              // peerInfo, which this rig does not currently record.
              if (arrivalGapMs.length)
                a.metrics['connArrivalGapMs'] = summarize(arrivalGapMs, 'ms');

              // D-035 ruling 4: the budget this run ACTUALLY resolved, stamped on the
              // artifact so a pinned-cap arm is self-describing. An arm that cannot
              // prove its budget measured NOTHING and is discarded, never recorded.
              const budgets = new Set(
                results
                  .map((r) =>
                    r?.swarmBudget
                      ? `maxPeers=${r.swarmBudget.maxPeers} maxClientConnections=${r.swarmBudget.maxClientConnections} pinnedEnv=${r.swarmBudget.pinnedEnv ?? '<unset>'}`
                      : null,
                  )
                  .filter((s): s is string => s !== null),
              );
              if (budgets.size === 0) {
                a.notes.push(
                  'swarm budget: NOT REPORTED by any child — this run cannot be attributed to a budget (D-035 ruling 4: discard, do not record).',
                );
              } else if (budgets.size > 1) {
                // Children disagreeing means the env did not reach all of them: a split
                // mesh is not an arm of anything, and averaging across it would be a
                // number describing no configuration that ever ran.
                a.notes.push(
                  `swarm budget: INCONSISTENT across children (${budgets.size} distinct) — ${[...budgets].join(' | ')}`,
                );
              } else {
                a.notes.push(`swarm budget: ${[...budgets][0]} (uniform across ${results.length} children)`);
              }
            },
            results,
          );
          await ctx.emit(artifact);
        } finally {
          await mesh.teardown();
        }
      }
    }
  },
};

export const ceiling: PerfScenario = {
  id: 'replication.ceiling',
  tier: 1,
  describe: 'Max replication throughput: writer floods, readers catch up (tight 200ms merges).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const count = ctx.profile === 'smoke' ? 300 : ctx.profile === 'ci' ? 1500 : 5000;
    for (const peers of ctx.peerCounts) {
      // ONE budget feeding both the child's own timeout and the parent's wait, so
      // the two cannot drift apart the way sustained's 120_000-vs-30_000 pair did.
      const catchUpBudgetMs = 300_000;
      const mesh = await spawnProcMesh({
        readers: peers - 1,
        log: ctx.log,
        writerCfg: { rate: 0, count, seed: ctx.seed },
        readerCfg: {
          mergePollMs: 200,
          expectedWinners: count,
          catchUpTimeoutMs: catchUpBudgetMs,
        },
      });
      try {
        const meter = new ScenarioMeter({
          scenario: 'replication.ceiling',
          tier: 1,
          params: { peers, count },
        });
        meter.expectReaders(mesh.readers.length);
        ctx.log(`replication.ceiling: peers=${peers} count=${count} — go`);
        const tGo = Date.now();
        mesh.writer.send('go');
        const ceilingRate = meter.metric('ceilingOpsPerSec', 'ops/sec');
        const catchUp = meter.metric('floodCatchUpMs', 'ms');
        // EI-20581532536662596 (shared deadline) + EI-20582417177742601 (the time
        // reported must be the CHILD's catch-up instant, not when this loop got
        // around to observing it). `catchUpElapsedMs` owns both concerns — do not
        // open-code `Date.now() - tGo` here: with concurrent waits every reader has
        // resolved before the body runs, so that expression would stamp them all
        // with the SLOWEST reader's time.
        meter.convergenceBudget(catchUpBudgetMs);
        const tAwait = Date.now();
        for (const { reader, event, elapsedMs } of await awaitAllChildEvent(
          mesh.readers,
          'caught-up',
          catchUpBudgetMs,
        )) {
          const elapsed = catchUpElapsedMs(event, { tGo, tAwait, elapsedMs });
          if (elapsed === null) {
            meter.readerDidNotConverge(
              reader.cfg.peerIndex,
              'never caught up — ceiling not reached',
            );
            continue;
          }
          catchUp.push(elapsed);
          // A non-positive elapsed cannot yield a meaningful rate (it would push
          // Infinity into the distribution and silently dominate every summary),
          // so record the catch-up time but omit the derived rate.
          if (elapsed > 0) ceilingRate.push(count / (elapsed / 1000));
          meter.readerConverged(reader.cfg.peerIndex, elapsed);
        }
        const results = [
          await mesh.writer.stopAndCollect(),
          ...(await Promise.all(mesh.readers.map((r) => r.stopAndCollect()))),
        ];
        await ctx.emit(foldChildResults(meter, () => {}, results));
      } finally {
        await mesh.teardown();
      }
    }
  },
};

export const replicationScenarios: PerfScenario[] = [sustained, ceiling];
