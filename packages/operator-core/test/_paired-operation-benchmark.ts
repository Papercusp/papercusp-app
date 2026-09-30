/** P-013's fixed, paired measurement protocol (plan D-016).
 *
 * Workload fixtures supply the real public calls and monotonic phase marks.
 * This runner owns sample counts, arm order, concurrency and statistics so a
 * fast fixture cannot quietly receive a smaller or differently ordered trial.
 */
import { performance } from 'node:perf_hooks';

export const P013_PROTOCOL = Object.freeze({
  warmups: 20,
  repetitions: 5,
  warmSamples: 200,
  coldSamples: 50,
  concurrencies: [1, 8] as const,
});

export type StartMode = 'warm' | 'cold';
export type ArmName = 'control' | 'candidate';
export interface PhaseMarks {
  ingress: number;
  accepted: number;
  dispatched: number;
  terminal: number;
  businessEvent: number;
  /** Leave a counter absent when the fixture cannot measure it. */
  dbRoundTrips?: number;
  dbBytes?: number;
  durableSteps?: number;
}
export interface Distribution {
  count: number;
  p50: number;
  p95: number;
  p99: number;
}
export interface Trial {
  arm: ArmName;
  mode: StartMode;
  concurrency: 1 | 8;
  repetition: number;
  samples: number;
  wallMs: number;
  throughputPerSec: number;
  phasesMs: {
    ingressToAccepted: Distribution;
    acceptedToDispatch: Distribution;
    dispatchToTerminal: Distribution;
    terminalToBusinessEvent: Distribution;
    total: Distribution;
  };
  /** null means unmeasured, never zero. Values are totals for this trial. */
  persistence: { dbRoundTrips: number | null; dbBytes: number | null; durableSteps: number | null };
}
export interface BenchmarkArm {
  warmup(): Promise<void>;
  run(mode: StartMode): Promise<PhaseMarks>;
  /** Build a fresh, isolated runtime for exactly one cold request. */
  coldStart?(): Promise<{
    run(): Promise<PhaseMarks>;
    close(): Promise<void>;
  }>;
}

export interface BenchmarkProtocol {
  warmups: number;
  repetitions: number;
  warmSamples: number;
  coldSamples: number;
  concurrencies: readonly (1 | 8)[];
  /** Instrumentation pilots may omit cold until the fixture has a real cold-start boundary. */
  modes?: readonly StartMode[];
  /** First repetition index. A D-016 matrix run as separate single-repetition
   * processes (so one lost connection costs one rep) passes rep N here, so the
   * arm order still alternates across the five repetitions and each trial row
   * carries its true repetition number. */
  repetitionOffset?: number;
}

export type WorkloadClass = 'A' | 'B' | 'C' | 'D';
export interface BudgetCheck {
  metric: 'warmP50' | 'warmP95' | 'warmP99' | 'throughput8' | 'coldP95';
  concurrency: 1 | 8;
  control: number;
  candidate: number;
  limit: number;
  passed: boolean;
}

const BUDGETS = {
  A: { warm: [[1.15, 15], [1.25, 25], [1.50, 50]], throughput: 0.80, cold: [1.75, 500] },
  B: { warm: [[1.20, 25], [1.25, 50], [1.50, 100]], throughput: 0.80, cold: [1.75, 500] },
  C: { warm: [[1.20, 25], [1.25, 50], [1.50, 100]], throughput: 0.80, cold: [1.75, 500] },
  D: { warm: [[1.50, 50], [1.75, 100], [2.25, 200]], throughput: 0.65, cold: [2.50, 1000] },
} as const;

function quantile(sorted: number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

export function distribution(values: number[]): Distribution {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('P-013 measurements require nonempty, finite, nonnegative samples');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99) };
}

function phaseDurations(marks: PhaseMarks) {
  const times = [marks.ingress, marks.accepted, marks.dispatched, marks.terminal, marks.businessEvent];
  if (times.some((time) => !Number.isFinite(time)) || times.some((time, index) => index > 0 && time < times[index - 1]!)) {
    throw new Error('P-013 phase marks must be finite and monotonic');
  }
  for (const value of [marks.dbRoundTrips, marks.dbBytes, marks.durableSteps]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('P-013 persistence counters must be nonnegative integers');
    }
  }
  return {
    ingressToAccepted: marks.accepted - marks.ingress,
    acceptedToDispatch: marks.dispatched - marks.accepted,
    dispatchToTerminal: marks.terminal - marks.dispatched,
    terminalToBusinessEvent: marks.businessEvent - marks.terminal,
    total: marks.businessEvent - marks.ingress,
  };
}

async function runTrial(
  arm: ArmName, fixture: BenchmarkArm, mode: StartMode, concurrency: 1 | 8,
  repetition: number, samples: number,
): Promise<Trial> {
  const measurements: PhaseMarks[] = new Array(samples);
  let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next++;
      if (index >= samples) return;
      if (mode === 'cold' && !fixture.coldStart) {
        throw new Error('P-013 cold samples require an explicit fresh-runtime boundary');
      }
      if (mode === 'cold') {
        const runtime = await fixture.coldStart!();
        try {
          const marks = await runtime.run();
          phaseDurations(marks);
          measurements[index] = marks;
        } finally {
          await runtime.close();
        }
      } else {
        const marks = await fixture.run('warm');
        phaseDurations(marks);
        measurements[index] = marks;
      }
    }
  }));
  const wallMs = performance.now() - start;
  const phases = measurements.map(phaseDurations);
  const sumKnown = (key: 'dbRoundTrips' | 'dbBytes' | 'durableSteps'): number | null =>
    measurements.every((row) => row[key] !== undefined)
      ? measurements.reduce((sum, row) => sum + row[key]!, 0)
      : null;
  return {
    arm, mode, concurrency, repetition, samples, wallMs,
    throughputPerSec: samples * 1000 / wallMs,
    phasesMs: {
      ingressToAccepted: distribution(phases.map((row) => row.ingressToAccepted)),
      acceptedToDispatch: distribution(phases.map((row) => row.acceptedToDispatch)),
      dispatchToTerminal: distribution(phases.map((row) => row.dispatchToTerminal)),
      terminalToBusinessEvent: distribution(phases.map((row) => row.terminalToBusinessEvent)),
      total: distribution(phases.map((row) => row.total)),
    },
    persistence: {
      dbRoundTrips: sumKnown('dbRoundTrips'),
      dbBytes: sumKnown('dbBytes'),
      durableSteps: sumKnown('durableSteps'),
    },
  };
}

/** Run one fixed workload. Small count overrides exist only for runner tests. */
export async function runPairedBenchmark(
  arms: Record<ArmName, BenchmarkArm>,
  protocol: Readonly<BenchmarkProtocol> = P013_PROTOCOL,
): Promise<Trial[]> {
  const modes = protocol.modes ?? ['warm', 'cold'];
  if (modes.length === 0 || new Set(modes).size !== modes.length) {
    throw new Error('P-013 benchmark modes must be nonempty and unique');
  }
  const offset = protocol.repetitionOffset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('P-013 benchmark repetitionOffset must be a nonnegative integer');
  }
  const trials: Trial[] = [];
  for (const concurrency of protocol.concurrencies) {
    for (let i = 0; i < protocol.warmups; i++) {
      await arms.control.warmup();
      await arms.candidate.warmup();
    }
    for (let repetition = offset; repetition < offset + protocol.repetitions; repetition++) {
      for (const mode of modes) {
        const order: ArmName[] = repetition % 2 === 0 ? ['control', 'candidate'] : ['candidate', 'control'];
        for (const arm of order) {
          trials.push(await runTrial(arm, arms[arm], mode, concurrency, repetition,
            mode === 'warm' ? protocol.warmSamples : protocol.coldSamples));
        }
      }
    }
  }
  return trials;
}

/** Grade the median of five matched repetitions against D-016's frozen limits.
 * Cold p50/p99 are reported by the trials, but intentionally have no grade. */
export function gradePairedBenchmark(workload: WorkloadClass, trials: Trial[]): BudgetCheck[] {
  const budget = BUDGETS[workload];
  const checks: BudgetCheck[] = [];
  const median = (values: number[]): number => distribution(values).p50;
  for (const concurrency of P013_PROTOCOL.concurrencies) {
    const cohorts = (arm: ArmName, mode: StartMode): Trial[] => {
      const rows = trials.filter((row) => row.arm === arm && row.mode === mode && row.concurrency === concurrency);
      const expectedSamples = mode === 'warm' ? P013_PROTOCOL.warmSamples : P013_PROTOCOL.coldSamples;
      if (rows.length !== P013_PROTOCOL.repetitions ||
          rows.some((row, index) => row.repetition !== index || row.samples !== expectedSamples ||
            !Number.isFinite(row.throughputPerSec) || row.throughputPerSec <= 0)) {
        throw new Error(`P-013 ${workload} ${arm}/${mode}/${concurrency} has an incomplete or invalid cohort`);
      }
      return rows;
    };
    const controlWarm = cohorts('control', 'warm');
    const candidateWarm = cohorts('candidate', 'warm');
    const controlCold = cohorts('control', 'cold');
    const candidateCold = cohorts('candidate', 'cold');
    for (const [index, metric] of (['warmP50', 'warmP95', 'warmP99'] as const).entries()) {
      const field = (['p50', 'p95', 'p99'] as const)[index];
      const [ratio, offset] = budget.warm[index];
      const control = median(controlWarm.map((row) => row.phasesMs.total[field]));
      const candidate = median(candidateWarm.map((row) => row.phasesMs.total[field]));
      const limit = control * ratio + offset;
      checks.push({ metric, concurrency, control, candidate, limit, passed: candidate <= limit });
    }
    const coldControl = median(controlCold.map((row) => row.phasesMs.total.p95));
    const coldCandidate = median(candidateCold.map((row) => row.phasesMs.total.p95));
    const coldLimit = coldControl * budget.cold[0] + budget.cold[1];
    checks.push({ metric: 'coldP95', concurrency, control: coldControl,
      candidate: coldCandidate, limit: coldLimit, passed: coldCandidate <= coldLimit });
    if (concurrency === 8) {
      const control = median(controlWarm.map((row) => row.throughputPerSec));
      const candidate = median(candidateWarm.map((row) => row.throughputPerSec));
      const limit = control * budget.throughput;
      checks.push({ metric: 'throughput8', concurrency, control, candidate, limit, passed: candidate >= limit });
    }
  }
  return checks;
}
