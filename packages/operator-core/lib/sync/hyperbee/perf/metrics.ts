/**
 * metrics.ts — measurement plumbing for the p2p-perf suite (P-001).
 *
 * Three concerns, deliberately tiny:
 *   - `summarize(samples)` — percentile/mean math for a measured series.
 *   - `Series` — an append-only sample collector with a `summarize()` view.
 *   - `ScenarioMeter` — the per-scenario envelope every scenario runs inside:
 *     starts the EI-79 event-loop-lag gauge (D-003's SLO instrument), tracks
 *     CPU + peak-RSS, and assembles the final `PerfArtifact`.
 *
 * The lag gauge is the SHIPPED `startEventLoopLagMonitor` — the suite must
 * measure with the same instrument production runs (P-007), not a parallel
 * implementation that could drift.
 */

import {
  startEventLoopLagMonitor,
  type LagMonitorHandle,
} from '../../../event-loop-lag-monitor';
import {
  currentHostInfo,
  type ConvergenceStats,
  type LoopLagStats,
  type MetricSummary,
  type PerfArtifact,
} from './artifact';

/** Default D-003 SLO: host event-loop lag p95 must stay under this while sync runs. */
export const DEFAULT_SLO_LIMIT_MS = 100;

/**
 * The convergence verdict, pure (EI-20576392705164447).
 *
 * A reader that never applied all ops is a FAILED cell, full stop — that is the
 * case the harness used to record in `notes` and then discard. The p95 ceiling
 * is only applied when one was explicitly set; an unset ceiling means "latency
 * recorded, not judged", never "latency fine".
 */
export function convergenceVerdict(c: ConvergenceStats): boolean {
  if (c.convergedReaders < c.expectedReaders) return false;
  if (c.p95LimitMs !== null && c.observedP95Ms !== null && c.observedP95Ms > c.p95LimitMs) return false;
  return true;
}

/**
 * Re-evaluate the convergence verdict after post-`finish()` metrics land.
 *
 * `appendToVisibleMs` is attached by `foldChildResults`'s patch callback, i.e.
 * AFTER the meter has produced the artifact — so the latency half of the
 * verdict cannot be decided inside `finish()`. No-ops when the scenario
 * declared no readers (`convergence === null`).
 */
export function recomputeConvergenceVerdict(a: PerfArtifact): void {
  const c = a.convergence;
  if (!c) return;
  c.observedP95Ms = a.metrics['appendToVisibleMs']?.p95 ?? null;
  a.convergencePassed = convergenceVerdict(c);
}

/** Nearest-rank percentile over a sorted copy. Empty input → all zeros. */
export function summarize(samples: number[], unit: MetricSummary['unit'] = 'ms'): MetricSummary {
  if (samples.length === 0) {
    return { unit, count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    unit,
    count: sorted.length,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length),
  };
}

/** Append-only sample series. */
export class Series {
  private samples: number[] = [];
  constructor(readonly unit: MetricSummary['unit'] = 'ms') {}
  push(v: number): void {
    this.samples.push(v);
  }
  get count(): number {
    return this.samples.length;
  }
  summarize(): MetricSummary {
    return summarize(this.samples, this.unit);
  }
}

/** Await-able high-res timer: `const done = startTimer(); …; series.push(done())`. */
export function startTimer(): () => number {
  const t0 = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - t0) / 1e6;
}

export interface ScenarioMeterOpts {
  scenario: string;
  tier: 1 | 2 | 3;
  params: Record<string, string | number | boolean>;
  /** D-003 SLO limit override (ms). Default 100. */
  sloLimitMs?: number;
  /**
   * appendToVisible p95 ceiling (ms) for the convergence verdict. Deliberately
   * has NO default: a defensible ceiling is a per-scenario product call, and
   * inventing one here would just be a second unjustified verdict. Unset ⇒
   * latency is recorded but not judged; the reader-caught-up half of the
   * verdict applies either way.
   */
  convergenceP95LimitMs?: number;
  /**
   * Lag-gauge sampling interval. The scenario window IS the histogram window
   * (we never reset mid-scenario), so this only controls the gauge's internal
   * warn cadence — keep it long to stay silent.
   */
  lagIntervalMs?: number;
}

/**
 * The per-scenario measurement envelope. Construct at scenario start, call
 * `metric(name)` for each series, then `finish()` for the artifact.
 */
export class ScenarioMeter {
  private readonly lag: LagMonitorHandle;
  private readonly cpu0 = process.cpuUsage();
  private readonly startedAtMs = Date.now();
  private readonly t0 = process.hrtime.bigint();
  private readonly series = new Map<string, Series>();
  private peakRss = process.memoryUsage().rss;
  private rssTimer: ReturnType<typeof setInterval>;
  readonly notes: string[] = [];
  opsDecoded = 0;
  private expectedReaders: number | null = null;
  private readonly laggingReaders: string[] = [];
  private readonly convergedMsSamples: number[] = [];
  private budgetMs: number | null = null;

  constructor(private readonly opts: ScenarioMeterOpts) {
    this.lag = startEventLoopLagMonitor({
      intervalMs: opts.lagIntervalMs ?? 60 * 60 * 1000, // window = whole scenario; warn timer effectively off
      warnP95Ms: Number.POSITIVE_INFINITY, // scenarios judge the SLO themselves
      log: () => {},
    });
    this.rssTimer = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > this.peakRss) this.peakRss = rss;
    }, 250);
    this.rssTimer.unref();
  }

  metric(name: string, unit: MetricSummary['unit'] = 'ms'): Series {
    let s = this.series.get(name);
    if (!s) {
      s = new Series(unit);
      this.series.set(name, s);
    }
    return s;
  }

  note(line: string): void {
    this.notes.push(line);
  }

  /**
   * Declare how many reader-convergence checks this scenario waits on. REQUIRED
   * for a convergence verdict to exist at all — without it `artifact.convergence`
   * stays null and `convergencePassed` is null ("not measured"), never a silent
   * pass.
   *
   * ADDITIVE, so a multi-phase scenario calls it once per phase (churn's
   * reconnect-storm waits on every reader twice: initial catch-up, then rejoin
   * after the storm — that is 2N checks, and each failed one should count).
   */
  expectReaders(count: number): void {
    this.expectedReaders = (this.expectedReaders ?? 0) + count;
  }

  /**
   * Record that a reader never applied every op inside its catch-up budget.
   *
   * Use this INSTEAD of a bare `note()` for the did-not-converge case: the note
   * text is unchanged (anything grepping artifacts still matches), but the
   * observation now also reaches the verdict. Dropping it into `notes` alone is
   * exactly how a 64-peer run whose readers never converged stamped itself
   * PASSED (EI-20576392705164447).
   *
   * `why` replaces the default note text when the scenario has a more specific
   * reading (a flood ceiling never reached, a transport stalled under loss).
   */
  readerDidNotConverge(label: string | number, why?: string): void {
    const l = String(label);
    if (!this.laggingReaders.includes(l)) this.laggingReaders.push(l);
    this.note(why ? `reader ${l} ${why}` : `reader ${l} did not apply all ops in time`);
  }

  /**
   * Declare the catch-up budget every reader is judged against, so the artifact
   * records the GOALPOST next to the observed times (EI-20581532536662596).
   *
   * Without it a pass/fail flip cannot be attributed: a ladder that goes green
   * looks the same whether the substrate got faster or the budget got looser.
   * Idempotent, and last write wins — a multi-phase scenario judging phases
   * against different budgets should record the one its verdict turns on.
   */
  convergenceBudget(ms: number): void {
    this.budgetMs = ms;
  }

  /**
   * Record that a reader converged, and HOW LONG it took (ms from the start of
   * the shared deadline).
   *
   * The counterpart to `readerDidNotConverge`. Convergence used to be recorded
   * only as an absence — a reader that converged simply never called anything,
   * so the artifact carried a bare count and could not say whether the run
   * cleared its budget by 110s or by 200ms. Call this for every reader that DID
   * converge; the elapsed samples become `convergence.convergedMs`.
   */
  readerConverged(_label: string | number, elapsedMs: number): void {
    this.convergedMsSamples.push(elapsedMs);
  }

  /** Read the lag gauge without finishing (children report mid-run). */
  sampleLag(): LoopLagStats {
    const s = this.lag.sample();
    return { p50Ms: s.p50Ms, p95Ms: s.p95Ms, p99Ms: s.p99Ms, maxMs: s.maxMs };
  }

  finish(): PerfArtifact {
    clearInterval(this.rssTimer);
    const lag = this.sampleLag();
    this.lag.stop();
    const cpu = process.cpuUsage(this.cpu0);
    const rss = process.memoryUsage().rss;
    if (rss > this.peakRss) this.peakRss = rss;
    const sloLimitMs = this.opts.sloLimitMs ?? DEFAULT_SLO_LIMIT_MS;
    const metrics: Record<string, MetricSummary> = {};
    for (const [name, s] of this.series) metrics[name] = s.summarize();
    // Convergence exists only when the scenario declared readers to wait on.
    // `foldChildResults` re-judges the latency half once appendToVisibleMs is
    // attached (recomputeConvergenceVerdict) — this is the readers half.
    const convergence: ConvergenceStats | null =
      this.expectedReaders === null
        ? null
        : {
            expectedReaders: this.expectedReaders,
            convergedReaders: Math.max(0, this.expectedReaders - this.laggingReaders.length),
            laggingReaders: [...this.laggingReaders],
            p95LimitMs: this.opts.convergenceP95LimitMs ?? null,
            observedP95Ms: metrics['appendToVisibleMs']?.p95 ?? null,
            budgetMs: this.budgetMs,
            // Only the readers that converged have a time; a censored sample
            // stamped at the budget would drag the percentiles toward it and
            // make a degrading run look like a slow-but-fine one.
            convergedMs:
              this.convergedMsSamples.length > 0 ? summarize(this.convergedMsSamples, 'ms') : null,
          };
    return {
      schema: 2,
      // Null here is CORRECT and not a gap: the meter runs in-process (often
      // in a spawned peer child) and cannot know the run's provenance. The
      // runner stamps it at `ctx.emit`, the single funnel every artifact —
      // including child-produced ones — passes through (D-026). An artifact
      // that reaches disk still carrying null was emitted outside that funnel,
      // and says so honestly rather than inventing an attribution.
      provenance: null,
      scenario: this.opts.scenario,
      tier: this.opts.tier,
      params: this.opts.params,
      startedAt: new Date(this.startedAtMs).toISOString(),
      durationMs: Number(process.hrtime.bigint() - this.t0) / 1e6,
      host: currentHostInfo(),
      metrics,
      loopLag: lag,
      sloPassed: lag.p95Ms < sloLimitMs,
      sloLimitMs,
      convergence,
      convergencePassed: convergence ? convergenceVerdict(convergence) : null,
      cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
      rss: { peakBytes: this.peakRss },
      opsDecoded: this.opsDecoded || undefined,
      notes: this.notes,
    };
  }
}
