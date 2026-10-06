/**
 * Worker event-loop lateness around a timed PTY sample (WI-10004333).
 *
 * A latency sample timed inside the vitest worker is the product's latency
 * PLUS however long the worker's own event loop was blocked before it could
 * run the PTY data callback. Under fleet load that lateness alone measured
 * 194-354ms on a binary whose startup was 14-26ms from a quiet process
 * (WI-10004247 run 6), so a budget assertion over a late sample can judge the
 * harness instead of the product.
 *
 * Lateness can only INFLATE a sample, never shrink it, so a sample is judged in
 * three ways instead of being thrown away:
 *  - `within`: the measured value meets the budget. The product meets it too.
 *  - `over`: the value minus ALL lateness in its window still misses the
 *    budget. The product misses it whatever the worker did.
 *  - `inconclusive`: over budget only by an amount the worker's lateness could
 *    explain. That is a harness stall, never a product verdict either way.
 * `within` depends on the measured value alone, so lateness can never turn a
 * miss into a pass.
 *
 * `LatenessMonitor` measures the lateness. `monitorEventLoopDelay` records a
 * block only between two of its own ticks, so a block that begins before the
 * first tick after `reset()`, or ends after the last tick before the read,
 * reads as ~1ms (measured with standalone probes for WI-10004333; the
 * edge cases are pinned in worker-lateness.test.ts). `begin()` therefore waits
 * for a baseline tick and `end()` lets the overdue tick run before reading. The
 * total is Σ(delay − resolution), i.e. every millisecond the loop could not run
 * a callback, which bounds how far any one callback in the window was delayed.
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

const RESOLUTION_MS = 1;
const TICK_WAIT_MS = 2;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LatenessMonitor {
  private readonly histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });

  constructor() {
    this.histogram.enable();
  }

  /** Start a window: clear the histogram and wait for one baseline tick. */
  async begin(): Promise<void> {
    this.histogram.reset();
    await wait(TICK_WAIT_MS);
  }

  /** End a window: let the overdue tick record, then return the total
   *  milliseconds the worker's event loop was blocked inside the window. */
  async end(): Promise<number> {
    await wait(TICK_WAIT_MS);
    const { count, mean } = this.histogram;
    return count === 0 ? 0 : Math.max(0, count * (mean / 1e6 - RESOLUTION_MS));
  }

  dispose(): void {
    this.histogram.disable();
  }
}

/** One timed sample and the worker lateness inside its window, both in ms. */
export interface TimedSample {
  ms: number;
  workerLateMs: number;
}

export type BudgetVerdict = 'within' | 'over' | 'inconclusive';

export interface BudgetJudgement {
  verdict: BudgetVerdict;
  /** The quantile of the measured values: an upper bound on the product's. */
  observedMs: number;
  /** The quantile of measured − lateness: a lower bound on the product's. */
  lowerBoundMs: number;
  budgetMs: number;
  samples: number;
  maxWorkerLateMs: number;
}

/** The `q` quantile (0 < q ≤ 1) by the nearest-rank method; `q = 1` is the max. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) throw new Error('quantile of no samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
}

/**
 * Judge the `q` quantile of `samples` against `budgetMs`. Each sample bounds
 * the product's latency between `ms − workerLateMs` and `ms`. Since the
 * quantile is monotone in every sample, it bounds the product's quantile the
 * same way.
 */
export function judgeBudget(samples: TimedSample[], budgetMs: number, q = 1): BudgetJudgement {
  const observedMs = quantile(samples.map((s) => s.ms), q);
  const lowerBoundMs = quantile(samples.map((s) => Math.max(0, s.ms - s.workerLateMs)), q);
  const verdict: BudgetVerdict = observedMs <= budgetMs ? 'within' : lowerBoundMs > budgetMs ? 'over' : 'inconclusive';
  return {
    verdict,
    observedMs,
    lowerBoundMs,
    budgetMs,
    samples: samples.length,
    maxWorkerLateMs: Math.max(...samples.map((s) => s.workerLateMs)),
  };
}

/** The message for an `inconclusive` judgement: a harness verdict, not a product one. */
export function describeHarnessStall(what: string, judgement: BudgetJudgement): string {
  const round = (n: number) => Math.round(n);
  return `HARNESS STALL, not a product verdict: ${what} measured ${round(judgement.observedMs)}ms against a `
    + `${judgement.budgetMs}ms budget, but the test worker's event loop was blocked for up to `
    + `${round(judgement.maxWorkerLateMs)}ms inside the measurement, so the product's own latency is somewhere `
    + `between ${round(judgement.lowerBoundMs)}ms and ${round(judgement.observedMs)}ms `
    + `(${judgement.samples} sample(s)). Re-run on a quieter worker; do not read this as a regression.`;
}
