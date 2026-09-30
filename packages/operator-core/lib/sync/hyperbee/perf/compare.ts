/**
 * compare.ts — baseline/regression comparator for p2p-perf artifacts (P-003).
 *
 * ADVISORY by design (D-005): the comparator reports, it never gates — exactly
 * like `lint:knip` / `lint:generic-first`. Promotion to a CI gate is a
 * separate owner decision after baselines prove stable across a week of
 * nightlies. (`--gate` exists on the runner for that future, off by default.)
 *
 * Matching: artifacts pair with baseline entries on `scenario` + a stable
 * params key. Comparison is per metric on p95 (latency-shaped, lower-better)
 * or inverted for ops/sec (higher-better), with a relative tolerance AND an
 * absolute floor so sub-noise metrics never flag. The D-003 loop-lag SLO is
 * absolute and always reported, baseline or not.
 *
 * The floor is PER UNIT (WI-2788). It used to be one scalar (`absFloorMs ?? 5`)
 * applied to the raw value of every metric whatever its unit — inert against
 * bytes (RSS baselines ~3.7e8) and ops/sec (~1.4e4), and actively harmful for
 * sub-floor `ms` baselines, where clearing the floor mathematically guarantees
 * exceeding the tolerance. Metrics in that regime are now reported as
 * `notComparable` rather than flagged as regressions: a relative verdict on
 * them cannot carry information, so we say so instead of manufacturing one.
 */

import type { ConvergenceStats, MetricSummary, PerfArtifact } from './artifact';

export interface BaselineEntry {
  scenario: string;
  params: Record<string, string | number | boolean>;
  metrics: Record<string, MetricSummary>;
  loopLagP95Ms: number | null;
  /**
   * The run's convergence verdict, RETAINED — null only when the scenario
   * recorded none (it formed no mesh, or the artifact predates this field).
   *
   * WHY THIS IS HERE, AND WHY IT IS NOT OPTIONAL. Artifacts under
   * `test-results/p2p-perf/` are gitignored (`.gitignore:42`), so a baseline
   * under `baselines/` is the ONLY p2p-perf evidence that survives a sweep of
   * local disk. Until this field existed the retained entry carried
   * `loopLagP95Ms` — the SLO whose own docs (artifact.ts) warn it "must never
   * be quoted alone as a scale or correctness verdict" — and DROPPED
   * `convergence`, the second verdict added (EI-20576392705164447) precisely
   * to stop that misreading. So the surface that outlived the artifacts kept
   * the number nobody may cite and discarded the one they must.
   *
   * That is not hypothetical: on 2026-08-16 the whole 64→128 ladder backing
   * row 14 of `shared-pot-release-testing/RELEASE-READINESS.md` was swept off
   * disk, and because no convergence verdict had ever been promoted here, the
   * signed document's central mesh claim became impossible to re-derive from
   * anything but its own prose.
   *
   * Required-and-nullable on purpose: an OPTIONAL field is exactly what lets
   * the next writer of a `BaselineEntry` omit it again without the typechecker
   * ever objecting, which is how it went missing the first time.
   */
  convergence: ConvergenceStats | null;
}

export interface BaselineFile {
  schema: 1;
  capturedAt: string;
  profile: string;
  host: { hostname: string; platform: string; cpus: number };
  entries: BaselineEntry[];
}

/**
 * Default absolute floors PER UNIT. A single scalar cannot guard metrics whose
 * natural scale spans ~8 orders of magnitude: a 5-"unit" floor is ~30x the
 * baseline of a sub-millisecond timer but ~0.0000013% of an RSS byte count.
 */
export const DEFAULT_ABS_FLOOR: Record<MetricSummary['unit'], number> = {
  ms: 5,
  'ops/sec': 1,
  bytes: 32 * 1024 * 1024,
  count: 1,
};

export interface CompareOpts {
  /** Relative regression tolerance (0.35 = +35% on p95). */
  tolerance?: number;
  /** Absolute floor for `ms` metrics under which differences never flag. */
  absFloorMs?: number;
  /** Per-unit absolute floors; overrides `absFloorMs` for `ms`. */
  absFloorByUnit?: Partial<Record<MetricSummary['unit'], number>>;
}

/** A metric whose relative comparison is mathematically uninformative — see `reason`. */
export interface NotComparable {
  scenario: string;
  paramsKey: string;
  metric: string;
  unit: MetricSummary['unit'];
  baseline: number;
  current: number;
  floor: number;
  reason: 'baseline-below-floor';
}

export interface MetricDelta {
  scenario: string;
  paramsKey: string;
  metric: string;
  unit: MetricSummary['unit'];
  baseline: number;
  current: number;
  /** Signed relative change (positive = worse). */
  relChange: number;
}

export interface CompareReport {
  regressions: MetricDelta[];
  improvements: MetricDelta[];
  sloViolations: Array<{ scenario: string; paramsKey: string; p95Ms: number; limitMs: number }>;
  newEntries: string[];
  missingEntries: string[];
  /**
   * Metrics skipped because a relative verdict on them cannot carry information
   * (WI-2788). Reported rather than silently dropped: a metric we cannot judge
   * is a fact the reader needs, not an absence.
   */
  notComparable: NotComparable[];
  /**
   * Metric pairs that actually reached the relative test — the DENOMINATOR of
   * `regressions` (WI-39359). Read the two together: `regressions: 0` means
   * "none of the `metricsCompared` metrics regressed", NOT "nothing regressed".
   * Every metric in `notComparable` was never eligible to regress, so a run
   * reporting a bare zero over a partially-blind metric set is indistinguishable
   * from a run that genuinely cleared everything — the same trap as an aggregate
   * computed over a capped fetch and rendered as a confident total.
   *
   * Measured 2026-08-17 on the tier1 `ci` baseline: 40 judged, 11 blind of 51.
   */
  metricsCompared: number;
}

export function paramsKey(params: Record<string, string | number | boolean>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join(',');
}

export function entryKey(scenario: string, params: Record<string, string | number | boolean>): string {
  return `${scenario}|${paramsKey(params)}`;
}

/**
 * Project a run's artifacts into the committed baseline shape.
 *
 * ⛔ THE FIELD LIST BELOW IS AN ALLOWLIST, AND IT IS A SAFETY BOUNDARY — NEVER
 * REPLACE IT WITH A SPREAD (D-026).
 *
 * Artifacts under `test-results/p2p-perf/` are gitignored; `baselines/` is
 * COMMITTED to tracked source and ships inside the release bundle. So this
 * function is the exact seam where per-RUN data would cross into permanently
 * committed data, and two different guards live on the far side of it:
 * `lint:no-identity-literals` scans every tracked file for build-box identity
 * (a committed baseline carrying a raw hostname red-pinned the
 * green-checkpoint gate on 2026-07-26), and the release cut's box-identity
 * audit fails later and more expensively.
 *
 * `PerfArtifact.provenance` is per-run by construction — a dirty-tree digest,
 * dirty file paths, mtimes, and this box's load at that instant. None of it
 * describes a regression THRESHOLD, all of it changes every run, and it is
 * exactly the shape of data that leaks identity if a path ever resolves
 * absolute. It is therefore deliberately absent below, and
 * `baseline-excludes-run-provenance.test.ts` fails if it (or an absolute path,
 * or a raw hostname) ever appears in a serialized baseline. Adding a field
 * here means asking whether it belongs in tracked source forever.
 */
export function baselineFromArtifacts(
  artifacts: PerfArtifact[],
  profile: string,
): BaselineFile {
  const first = artifacts[0];
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    profile,
    host: {
      hostname: first?.host.hostname ?? 'unknown',
      platform: first?.host.platform ?? 'unknown',
      cpus: first?.host.cpus ?? 0,
    },
    entries: artifacts.map((a) => ({
      scenario: a.scenario,
      params: a.params,
      metrics: a.metrics,
      loopLagP95Ms: a.loopLag?.p95Ms ?? null,
      convergence: a.convergence ?? null,
    })),
  };
}

export interface BaselinePromotionRefusal {
  reason: 'coverage-shrink' | 'contended-host';
  /** Human-readable refusal, already naming the override that would accept it. */
  message: string;
  /** The `entryKey`s the promotion would have dropped (coverage-shrink only). */
  droppedKeys: string[];
  /** The exact CLI flag that accepts this specific risk. */
  overrideFlag: string;
}

/**
 * Decide whether a `--update-baseline` promotion may overwrite the committed
 * baseline. Returns the refusals that apply; an empty array means promote.
 *
 * WHY THIS EXISTS. `--update-baseline` rewrites the baseline from THE CURRENT
 * RUN ONLY, and its name does not say so. The committed `baselines/tier1.json`
 * is the fleet's regression threshold, so two ordinary mistakes silently
 * destroy it:
 *
 *  1. COVERAGE SHRINK — a partial run (`--scenario x --profile smoke`) produces
 *     one entry and collapses a 17-entry reference to that one entry. Nothing
 *     errors; the file just quietly stops guarding 16 cells. Measured on
 *     2026-08-16: a 3-peer smoke run would have replaced all 17 committed
 *     entries had it been pointed at the real path.
 *  2. CONTENDED HOST — a run the runner ITSELF flagged `oversubscribed` bakes
 *     shared-box contention in as the threshold every future run is judged
 *     against, which is strictly worse than having no baseline: it moves the
 *     bar in the direction that hides real regressions.
 *
 * Both are fail-closed with a SEPARATE override each, deliberately: a single
 * blanket `--force` would let someone who meant to accept a shrink also
 * silently accept a contended capture. A legitimate rebaseline — full profile,
 * quiet box — trips neither and needs no flag.
 *
 * This is a pure decision over two `BaselineFile`s so it is provable without
 * driving the runner's `main()` or writing to the shared tree.
 */
export function checkBaselinePromotion(opts: {
  /** The baseline currently on disk, or null when there is none yet. */
  existing: BaselineFile | null;
  /** The baseline this run would write. */
  next: BaselineFile;
  /** The runner's own host verdict for this run (`hostLoad.oversubscribed`). */
  hostOversubscribed: boolean;
  allowShrink: boolean;
  allowContended: boolean;
}): BaselinePromotionRefusal[] {
  const refusals: BaselinePromotionRefusal[] = [];

  // Creating a baseline where none exists drops no coverage — only an
  // OVERWRITE can shrink one.
  if (opts.existing && !opts.allowShrink) {
    const nextKeys = new Set(opts.next.entries.map((e) => entryKey(e.scenario, e.params)));
    const droppedKeys = opts.existing.entries
      .map((e) => entryKey(e.scenario, e.params))
      .filter((k) => !nextKeys.has(k));
    if (droppedKeys.length) {
      refusals.push({
        reason: 'coverage-shrink',
        droppedKeys,
        overrideFlag: '--allow-baseline-shrink',
        message:
          `REFUSING to overwrite the baseline: this run covers ${opts.next.entries.length} ` +
          `entr${opts.next.entries.length === 1 ? 'y' : 'ies'} but the existing baseline covers ` +
          `${opts.existing.entries.length}, so promoting it would DROP ${droppedKeys.length} ` +
          `cell(s) the fleet currently regression-guards:\n` +
          droppedKeys.map((k) => `    - ${k}`).join('\n') +
          `\n  A baseline is only meant to be re-captured by a run that covers at least what it ` +
          `replaces — re-run the FULL profile, or pass --allow-baseline-shrink to accept the loss.`,
      });
    }
  }

  if (opts.hostOversubscribed && !opts.allowContended) {
    refusals.push({
      reason: 'contended-host',
      droppedKeys: [],
      overrideFlag: '--allow-contended-baseline',
      message:
        `REFUSING to overwrite the baseline: this run was flagged HOST OVERSUBSCRIBED, so its ` +
        `numbers measure shared-box contention as much as this code. Promoting them makes the ` +
        `fleet's regression threshold permanently lenient, which HIDES future regressions. ` +
        `Re-capture on a quiet host, or pass --allow-contended-baseline to accept it.`,
    });
  }

  return refusals;
}

export interface RollingBaselineOpts {
  /**
   * Quantile of the historical p95 series used as the reference. Defaults to
   * p90 — see the note below on why a MEDIAN is the wrong choice here.
   */
  quantile?: number;
  /** How many most-recent runs to draw the reference from. */
  window?: number;
  /** Minimum runs required before a rolling reference is trustworthy. */
  minRuns?: number;
  profile?: string;
}

/**
 * Build a reference from the RECENT RUN HISTORY instead of one frozen capture
 * (WI-2788). Returns a `BaselineFile`, so `compareArtifacts` is unchanged — only
 * the derivation of the reference differs.
 *
 * Why this exists: a point-in-time capture encodes the box tenancy of the
 * minute it was taken. Measured over 51 nightlies, the committed capture sat so
 * far below typical load that `deltaTick1000Ms` ran +86% above it at the MEDIAN,
 * and the advisory fired on 61% of runs. Re-capturing does not fix that — the
 * next capture is just a different quiet minute.
 *
 * Why a high quantile and NOT a median: a median reference is exceeded by ~50%
 * of future samples BY CONSTRUCTION, so unless a metric's spread is tighter than
 * the tolerance it fires about half the time. Measured, a rolling median made
 * four metrics WORSE than the frozen baseline (fullMergeMs 14%->51%). The frozen
 * baseline only worked as well as it did because it captures p95 — a high
 * quantile. Rolling p90 over 15 runs holds every metric at <=14% (most <=8%) at
 * an unchanged 0.35 tolerance.
 *
 * Why a quantile and not the MAX: with a small window the top-quantile lands on
 * the window maximum, and a rolling max lets one tenancy spike raise the bar and
 * mask a genuine regression for the whole window. Keep `window` comfortably
 * larger than `1/(1-quantile)` so the two stay distinct.
 */
export function baselineFromHistory(
  history: PerfArtifact[][],
  opts: RollingBaselineOpts = {},
): BaselineFile | null {
  const quantile = opts.quantile ?? 0.9;
  const window = opts.window ?? 15;
  const minRuns = opts.minRuns ?? 8;

  const recent = history.slice(-window);
  if (recent.length < minRuns) return null;

  // key -> { scenario, params, metric -> observed p95 series }
  const byKey = new Map<
    string,
    { scenario: string; params: Record<string, string | number | boolean>; series: Map<string, { unit: MetricSummary['unit']; vals: number[] }>; lags: number[]; latestConvergence: ConvergenceStats | null }
  >();

  for (const run of recent) {
    for (const a of run) {
      const key = entryKey(a.scenario, a.params);
      let e = byKey.get(key);
      if (!e) {
        e = { scenario: a.scenario, params: a.params, series: new Map(), lags: [], latestConvergence: null };
        byKey.set(key, e);
      }
      if (a.loopLag) e.lags.push(a.loopLag.p95Ms);
      // `history` is chronological, so the last write wins: this ends as the
      // NEWEST convergence observation for the key, not a windowed aggregate.
      // Quantiling a pass/fail verdict would manufacture a number no run ever
      // produced, so the alternatives here were "carry the latest, labelled"
      // or "carry nothing" — and carrying nothing is the defect this field
      // exists to close.
      if (a.convergence) e.latestConvergence = a.convergence;
      for (const [name, m] of Object.entries(a.metrics)) {
        if (!m || m.count === 0) continue;
        let s = e.series.get(name);
        if (!s) {
          s = { unit: m.unit, vals: [] };
          e.series.set(name, s);
        }
        s.vals.push(m.p95);
      }
    }
  }

  const quantileOf = (vals: number[], q: number): number => {
    const sorted = [...vals].sort((x, y) => x - y);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
    return sorted[idx];
  };

  const entries: BaselineEntry[] = [];
  for (const e of byKey.values()) {
    const metrics: Record<string, MetricSummary> = {};
    for (const [name, s] of e.series) {
      if (s.vals.length < minRuns) continue;
      // For higher-is-better metrics the conservative reference is the LOW tail.
      const q = s.unit === 'ops/sec' ? 1 - quantile : quantile;
      const ref = quantileOf(s.vals, q);
      metrics[name] = {
        unit: s.unit,
        count: s.vals.length,
        p50: ref,
        p95: ref,
        p99: ref,
        max: ref,
        mean: ref,
      };
    }
    if (!Object.keys(metrics).length) continue;
    entries.push({
      scenario: e.scenario,
      params: e.params,
      metrics,
      loopLagP95Ms: e.lags.length ? quantileOf(e.lags, quantile) : null,
      convergence: e.latestConvergence,
    });
  }

  if (!entries.length) return null;

  const last = recent[recent.length - 1]?.[0];
  return {
    schema: 1,
    capturedAt: new Date().toISOString(),
    profile: opts.profile ?? 'rolling',
    host: {
      hostname: last?.host.hostname ?? 'unknown',
      platform: last?.host.platform ?? 'unknown',
      cpus: last?.host.cpus ?? 0,
    },
    entries,
  };
}

export function compareArtifacts(
  baseline: BaselineFile,
  artifacts: PerfArtifact[],
  opts: CompareOpts = {},
): CompareReport {
  const tolerance = opts.tolerance ?? 0.35;
  const msFloor = opts.absFloorMs ?? DEFAULT_ABS_FLOOR.ms;
  const floorFor = (unit: MetricSummary['unit']): number =>
    opts.absFloorByUnit?.[unit] ?? (unit === 'ms' ? msFloor : DEFAULT_ABS_FLOOR[unit] ?? 0);

  const baseByKey = new Map<string, BaselineEntry>();
  for (const e of baseline.entries) baseByKey.set(entryKey(e.scenario, e.params), e);
  const curByKey = new Map<string, PerfArtifact>();
  for (const a of artifacts) curByKey.set(entryKey(a.scenario, a.params), a);

  const report: CompareReport = {
    regressions: [],
    improvements: [],
    sloViolations: [],
    newEntries: [],
    missingEntries: [],
    notComparable: [],
    metricsCompared: 0,
  };

  for (const a of artifacts) {
    if (a.sloPassed === false && a.loopLag) {
      report.sloViolations.push({
        scenario: a.scenario,
        paramsKey: paramsKey(a.params),
        p95Ms: a.loopLag.p95Ms,
        limitMs: a.sloLimitMs,
      });
    }
    const key = entryKey(a.scenario, a.params);
    const base = baseByKey.get(key);
    if (!base) {
      report.newEntries.push(key);
      continue;
    }
    for (const [name, cur] of Object.entries(a.metrics)) {
      const b = base.metrics[name];
      if (!b || b.count === 0 || cur.count === 0) continue;
      const lowerIsBetter = cur.unit !== 'ops/sec';
      const baseVal = b.p95;
      const curVal = cur.p95;
      const absFloor = floorFor(cur.unit);
      // The floor gate and the relative test must each carry information. When
      // `absFloor > tolerance * baseVal` they cannot: clearing the gate ALREADY
      // implies relChange >= absFloor/baseVal > tolerance, so every sample that
      // survives the floor is a guaranteed "regression" and every sample that
      // would show the metric healthy is filtered out first. That inverts the
      // floor's stated purpose — it selects FOR outliers instead of suppressing
      // noise. Measured on 54 nightlies (WI-2788): deltaTick1Ms (baseline p95
      // 0.170ms), appendCallMs (2.000ms) and deltaTick100Ms (5.233ms) each fired
      // on 100% of their comparisons, by construction rather than by regression.
      // Such a metric is not comparable in RELATIVE terms at all; say so.
      if (absFloor > tolerance * baseVal) {
        report.notComparable.push({
          scenario: a.scenario,
          paramsKey: paramsKey(a.params),
          metric: name,
          unit: cur.unit,
          baseline: baseVal,
          current: curVal,
          floor: absFloor,
          reason: 'baseline-below-floor',
        });
        continue;
      }
      // Past the uninformative-floor gate, so this pair IS judged — count it
      // before the below-floor `continue` below, which is itself a verdict
      // ("unchanged"), not a skip. This is the denominator `regressions` is
      // read against (WI-39359).
      report.metricsCompared++;
      if (Math.abs(curVal - baseVal) < absFloor) continue;
      const relChange = lowerIsBetter
        ? (curVal - baseVal) / Math.max(baseVal, 0.001)
        : (baseVal - curVal) / Math.max(baseVal, 0.001);
      const delta: MetricDelta = {
        scenario: a.scenario,
        paramsKey: paramsKey(a.params),
        metric: name,
        unit: cur.unit,
        baseline: baseVal,
        current: curVal,
        relChange: Math.round(relChange * 1000) / 1000,
      };
      if (relChange > tolerance) report.regressions.push(delta);
      else if (relChange < -tolerance) report.improvements.push(delta);
    }
  }

  for (const key of baseByKey.keys()) {
    if (!curByKey.has(key)) report.missingEntries.push(key);
  }

  return report;
}

export function formatCompareReport(report: CompareReport): string {
  const lines: string[] = [];
  const pct = (r: number) => `${r > 0 ? '+' : ''}${Math.round(r * 100)}%`;
  if (report.sloViolations.length) {
    lines.push(`✖ SLO VIOLATIONS (loop-lag p95 over limit) — ${report.sloViolations.length}:`);
    for (const v of report.sloViolations) {
      lines.push(`  ${v.scenario} [${v.paramsKey}] p95=${v.p95Ms}ms (limit ${v.limitMs}ms)`);
    }
  } else {
    lines.push('✓ loop-lag SLO held on every scenario');
  }
  // The regression verdict ALWAYS carries its denominator (WI-39359). A bare
  // "no metric regressed" over a partially-blind metric set reads as full
  // coverage; `metricsCompared` is what makes 0-of-40 distinguishable from
  // 0-of-51.
  const blind = report.notComparable.length;
  const coverage =
    `${report.metricsCompared} metric(s) judged` +
    (blind ? `, ${blind} NOT COMPARABLE — see below` : '');
  if (report.regressions.length) {
    lines.push(`▲ regressions vs baseline — ${report.regressions.length} of ${coverage} (advisory):`);
    for (const d of report.regressions) {
      lines.push(
        `  ${d.scenario} [${d.paramsKey}] ${d.metric}: ${d.baseline} → ${d.current} ${d.unit} (${pct(d.relChange)} worse)`,
      );
    }
  } else {
    lines.push(`✓ no metric regressed past tolerance — ${coverage}`);
  }
  if (report.improvements.length) {
    lines.push(`▼ improvements — ${report.improvements.length}:`);
    for (const d of report.improvements) {
      lines.push(
        `  ${d.scenario} [${d.paramsKey}] ${d.metric}: ${d.baseline} → ${d.current} ${d.unit} (${pct(-d.relChange)} better)`,
      );
    }
  }
  if (report.notComparable.length) {
    lines.push(
      `· not comparable — ${report.notComparable.length} metric(s) whose baseline sits under the absolute floor, so a relative verdict would be meaningless:`,
    );
    for (const n of report.notComparable) {
      lines.push(
        `  ${n.scenario} [${n.paramsKey}] ${n.metric}: baseline ${n.baseline}${n.unit} < floor ${n.floor}${n.unit} (current ${n.current}${n.unit}) — needs an absolute budget, not a % tolerance`,
      );
    }
  }
  if (report.newEntries.length) lines.push(`new (no baseline): ${report.newEntries.join('; ')}`);
  if (report.missingEntries.length) lines.push(`in baseline but not run: ${report.missingEntries.join('; ')}`);
  return lines.join('\n');
}
