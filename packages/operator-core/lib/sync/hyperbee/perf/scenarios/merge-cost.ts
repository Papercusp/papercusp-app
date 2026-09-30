/**
 * merge-cost.ts — Tier-1 merge/decode benches (P-004): the EI-79 axis.
 *
 * Three scenarios over the read-merge pipeline, cheapest isolation first:
 *
 *   merge.decode-throughput — sequential `log.get(i)` over a corestore-backed
 *     log: the raw hypercore/compact-encoding decode path that profiled at
 *     ~16% CPU during EI-79. Metric: ops/sec.
 *
 *   merge.full-merge — `mergeAdmittedLogs` over K corestore-backed logs vs
 *     total history size: the O(history) full fold (decode + LWW + apply).
 *     This is the curve the EI-79 residual (P-013, incremental cursor) must
 *     flatten to O(delta).
 *
 *   merge.idle-tick — a booted (swarm-less) substrate handle with history H:
 *     after the initial backfill merge, repeated `mergeNow()` calls with no
 *     growth MUST be O(#logs), not O(history) — the EI-79 steady-state skip.
 *     The bench sweeps H and reports the per-size idle-tick distribution; the
 *     complexity-class INVARIANT is locked in CI by `merge-scaling.test.ts`
 *     (a fast vitest test, not this bench).
 *
 * Every scenario runs inside a ScenarioMeter, so each artifact carries the
 * D-003 loop-lag SLO verdict (P-007).
 */

import { mergeAdmittedLogs } from '../../read-merge';
import { bootHarnessSubstrate } from '../../boot';
import { closeHarnessStore } from '../../corestore';
import type { PeerLogOp } from '../../peer-log';
import { generateCorpus } from '../corpus';
import { Cleanups, makeStoreLog, makeTmpDir } from '../fixture';
import { ScenarioMeter, startTimer } from '../metrics';
import type { PerfScenario, ScenarioRunCtx } from '../scenario-types';

const AUTHOR = 'a'.repeat(64);

export const decodeThroughput: PerfScenario = {
  id: 'merge.decode-throughput',
  tier: 1,
  describe: 'Sequential hypercore decode over a corestore-backed log (ops/sec vs history size).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    for (const size of ctx.sizes) {
      const cleanups = new Cleanups();
      try {
        ctx.log(`decode-throughput: seeding ${size} ops…`);
        const { log } = await makeStoreLog(cleanups, {
          corpus: { seed: ctx.seed, count: size, authorPubkey: AUTHOR },
        });
        const meter = new ScenarioMeter({
          scenario: 'merge.decode-throughput',
          tier: 1,
          params: { historySize: size, seed: ctx.seed },
        });
        const perOp = meter.metric('decodeMs', 'ms');
        const total = startTimer();
        for (let i = 0; i < log.length; i++) {
          const done = startTimer();
          const op = await log.get(i);
          perOp.push(done());
          if (op) meter.opsDecoded++;
        }
        const totalMs = total();
        const rate = meter.metric('decodeRate', 'ops/sec');
        rate.push(size / (totalMs / 1000));
        await ctx.emit(meter.finish());
      } finally {
        await cleanups.run();
      }
    }
  },
};

export const fullMerge: PerfScenario = {
  id: 'merge.full-merge',
  tier: 1,
  describe: 'mergeAdmittedLogs full fold (decode + LWW + apply) vs history size, 3 logs.',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const LOGS = 3;
    const REPEATS = 5;
    for (const size of ctx.sizes) {
      const cleanups = new Cleanups();
      try {
        const perLog = Math.ceil(size / LOGS);
        ctx.log(`full-merge: seeding ${LOGS}×${perLog} ops…`);
        const logs = [];
        for (let k = 0; k < LOGS; k++) {
          const { log } = await makeStoreLog(cleanups, {
            corpus: {
              seed: ctx.seed + k,
              count: perLog,
              authorPubkey: String(k).repeat(64),
              baseTs: 1_700_000_000_000 + k, // interleave authors' ts
            },
          });
          logs.push(log);
        }
        const meter = new ScenarioMeter({
          scenario: 'merge.full-merge',
          tier: 1,
          params: { historySize: size, logs: LOGS, repeats: REPEATS, seed: ctx.seed },
        });
        const fullMergeMs = meter.metric('fullMergeMs', 'ms');
        let appliedTotal = 0;
        for (let r = 0; r < REPEATS; r++) {
          const done = startTimer();
          const applied = await mergeAdmittedLogs(logs, {
            applyImpl: async () => true,
            maxOpsPerAuthor: 0, // measure the TRUE full fold, uncapped
          });
          fullMergeMs.push(done());
          appliedTotal += applied;
          meter.opsDecoded += size;
        }
        meter.note(`winners applied per pass ≈ ${Math.round(appliedTotal / REPEATS)}`);
        await ctx.emit(meter.finish());
      } finally {
        await cleanups.run();
      }
    }
  },
};

export const idleTick: PerfScenario = {
  id: 'merge.idle-tick',
  tier: 1,
  describe:
    'Booted substrate handle, no growth: repeated mergeNow() cost — must be O(#logs), not O(history) (EI-79 skip).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const TICKS = 100;
    for (const size of ctx.sizes) {
      const cleanups = new Cleanups();
      try {
        ctx.log(`idle-tick: booting substrate with ${size}-op own log…`);
        const workspaceRoot = makeTmpDir(cleanups, 'p2p-perf-idle-');
        const harnessSlug = 'perf-idle';
        const handle = await bootHarnessSubstrate({
          workspaceRoot,
          workspaceId: 'ws-p2p-perf',
          harnessSlug,
          mergePollMs: 0,
          pendingRetryMs: 0,
          reverifyIntervalMs: 0,
          applyOverride: async () => true,
          loadRevokedOverride: async () => new Set(),
        });
        cleanups.push(async () => {
          await handle.close();
          await closeHarnessStore({ workspaceRoot, harnessSlug });
        });

        // Seed history through the OWN log (batched), then run the backfill merge.
        const BATCH = 2000;
        let batch: PeerLogOp[] = [];
        for (const op of generateCorpus({ seed: ctx.seed, count: size, authorPubkey: AUTHOR })) {
          batch.push(op);
          if (batch.length >= BATCH) {
            await handle.ownLog.appendBatch(batch);
            batch = [];
          }
        }
        if (batch.length) await handle.ownLog.appendBatch(batch);

        const meter = new ScenarioMeter({
          scenario: 'merge.idle-tick',
          tier: 1,
          params: { historySize: size, ticks: TICKS, seed: ctx.seed },
        });
        if (size > 50_000) {
          meter.note(
            'historySize exceeds the 50k per-pass budget — backfillMergeMs measures the FIRST ' +
              'pass only; the incremental cursor (P-013) drains the rest across subsequent ticks.',
          );
        }
        const backfill = meter.metric('backfillMergeMs', 'ms');
        const doneBackfill = startTimer();
        await handle.mergeNow();
        backfill.push(doneBackfill());
        meter.opsDecoded += size;

        // Idle ticks: no growth → the EI-79 skip path.
        const idle = meter.metric('idleTickMs', 'ms');
        for (let t = 0; t < TICKS; t++) {
          const done = startTimer();
          await handle.mergeNow();
          idle.push(done());
        }
        await ctx.emit(meter.finish());
      } finally {
        await cleanups.run();
      }
    }
  },
};

export const deltaTick: PerfScenario = {
  id: 'merge.delta-tick',
  tier: 1,
  describe:
    'Tick cost when k NEW ops arrive on an H-op history: must be O(k), independent of H (the P-013 incremental cursor — the EI-79 residual validation).',
  async run(ctx: ScenarioRunCtx): Promise<void> {
    const DELTAS = [1, 100, 1000];
    const TICKS_PER_DELTA = 20;
    for (const size of ctx.sizes) {
      const cleanups = new Cleanups();
      try {
        ctx.log(`delta-tick: booting substrate with ${size}-op own log…`);
        const workspaceRoot = makeTmpDir(cleanups, 'p2p-perf-delta-');
        const harnessSlug = 'perf-delta';
        const handle = await bootHarnessSubstrate({
          workspaceRoot,
          workspaceId: 'ws-p2p-perf',
          harnessSlug,
          mergePollMs: 0,
          pendingRetryMs: 0,
          reverifyIntervalMs: 0,
          applyOverride: async () => true,
          loadRevokedOverride: async () => new Set(),
        });
        cleanups.push(async () => {
          await handle.close();
          await closeHarnessStore({ workspaceRoot, harnessSlug });
        });

        const BATCH = 2000;
        let batch: PeerLogOp[] = [];
        for (const op of generateCorpus({ seed: ctx.seed, count: size, authorPubkey: AUTHOR })) {
          batch.push(op);
          if (batch.length >= BATCH) {
            await handle.ownLog.appendBatch(batch);
            batch = [];
          }
        }
        if (batch.length) await handle.ownLog.appendBatch(batch);

        const meter = new ScenarioMeter({
          scenario: 'merge.delta-tick',
          tier: 1,
          params: { historySize: size, seed: ctx.seed },
        });
        // Backfill: with the incremental cursor this is the one full-history
        // fold (chunked at 50k/pass — loop until caught up).
        const backfill = meter.metric('backfillMergeMs', 'ms');
        const doneBackfill = startTimer();
        for (;;) {
          await handle.mergeNow();
          // caught up when an immediate re-tick merges nothing
          if ((await handle.mergeNow()) === 0) break;
        }
        backfill.push(doneBackfill());
        meter.opsDecoded += size;

        // Delta ticks: append k ops, tick once, measure. O(k) regardless of H
        // is the P-013 contract (pre-cursor this was O(H) per changed tick).
        let seq = 0;
        for (const k of DELTAS) {
          const series = meter.metric(`deltaTick${k}Ms`, 'ms');
          for (let t = 0; t < TICKS_PER_DELTA; t++) {
            const ops: PeerLogOp[] = Array.from({ length: k }, (_, j) => ({
              type: 'put' as const,
              table: 'features-by-id',
              hbKey: `F-delta-${seq}-${j}`,
              value: { i: j },
              ts: 1_800_000_000_000 + seq * 10_000 + j,
              schema_version: 1,
              author_pubkey: AUTHOR,
            }));
            seq++;
            await handle.ownLog.appendBatch(ops);
            const done = startTimer();
            await handle.mergeNow();
            series.push(done());
            meter.opsDecoded += k;
          }
        }
        await ctx.emit(meter.finish());
      } finally {
        await cleanups.run();
      }
    }
  },
};

export const mergeCostScenarios: PerfScenario[] = [decodeThroughput, fullMerge, idleTick, deltaTick];
