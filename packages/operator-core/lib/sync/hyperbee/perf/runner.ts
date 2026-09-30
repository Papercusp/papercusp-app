/**
 * runner.ts — the p2p-perf bench runner CLI (P-001).
 *
 * The registered `node` runner for the `p2p-perf` testing domain
 * (testing-domains-registry.ts) — surfaced in /admin/testing and the /adv
 * Tests tab. Run from the repo root:
 *
 *   npx tsx packages/operator-core/lib/sync/hyperbee/perf/runner.ts --tier1 --profile ci
 *   npx tsx … --scenario merge.idle-tick --profile full
 *   npx tsx … --list
 *
 * Flags:
 *   --tier1 | --tier2 | --scenario <id[,id…]>   what to run
 *   --profile smoke|ci|full|deep                matrix size (default ci)
 *   --sizes 1000,10000                          explicit history-size sweep
 *   --peers 2,5                                 explicit peer-count sweep
 *   --out <dir>                                 artifact dir (default test-results/p2p-perf)
 *   --baseline <file>                           baseline JSON (default baselines/tier1.json next to this file)
 *   --reference <rolling|frozen>                advisory reference (default rolling: p90 of recent runs;
 *                                               falls back to the frozen baseline when history is thin)
 *   --update-baseline                           REWRITE the baseline from THIS RUN ONLY (destructive —
 *                                               it does not merge). Refused when the run would drop
 *                                               covered cells or was flagged host-oversubscribed;
 *                                               override per-risk with the two flags below.
 *   --allow-baseline-shrink                     accept a promotion that drops covered cells
 *   --allow-contended-baseline                  accept a promotion captured on an oversubscribed host
 *   --gate                                      exit 1 on regressions/SLO violations (OFF by default — D-005)
 *   --slo-only                                  exit 1 only on SLO violations (used by the CI-able invariant path)
 *   --summary-json <file>                       ALSO write a machine-readable run summary (the
 *                                               nightly/weekly routine reads this to auto-file findings — P-014)
 *
 * Output: one JSON artifact per (scenario, params) under
 * `<out>/<runId>/`, a generated `report.md` (P-012), and an advisory
 * comparator summary on stdout (P-003).
 *
 * Tier 3 (real frames) is NOT driven from here — it lives in the cred-gated
 * `tier3-latitude.integration.test.ts` next to the deployment layer (P-010),
 * mirroring `latitude-e2e.integration.test.ts`'s $0-default posture.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '../../../util/cli-entry';
import { loadavg, cpus as osCpus } from 'node:os';
import type { HostLoadEvidence, PerfArtifact } from './artifact';
import {
  captureRunProvenance,
  finalizeArtifactProvenance,
  resolveRepoRoot,
  stampArtifactProvenance,
} from './provenance';
import { renderProvenanceLines } from './report';
import {
  baselineFromArtifacts,
  baselineFromHistory,
  checkBaselinePromotion,
  compareArtifacts,
  formatCompareReport,
  type BaselineFile,
} from './compare';
import type { PerfProfile, PerfScenario, ScenarioRunCtx } from './scenario-types';
import { mergeCostScenarios } from './scenarios/merge-cost';
import { replicationScenarios } from './scenarios/replication';
import { churnScenarios } from './scenarios/churn';
import { netemScenarios } from './scenarios/netem';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * EI-8843: this box is a SHARED interactive dev box (not a dedicated perf
 * host) — 7+ concurrent agent fleets routinely oversubscribe it. A
 * PG-write-heavy scenario (each op awaits a synchronous PG projection commit)
 * measures wall-clock/PG latency, which balloons under contention with ZERO
 * code regression — the 2026-07-09 incident: 2748%-18113% "regressions" at
 * load average 137-167 on a 128-core box (>100% sustained oversubscription),
 * while pure in-memory scenarios in the SAME run improved 58-106%. Sampling
 * `os.loadavg()[0] / cpus` around the run and flagging the comparison
 * uncertain above this ratio lets the nightly routine (p2p-perf-actions.ts)
 * skip auto-filing what would otherwise be a false-positive regression/SLO
 * alarm, without discarding the run's own artifacts/report (still written
 * either way — a human auditing a noisy night still sees the real numbers).
 */
const HOST_OVERSUBSCRIBED_RATIO = 1.0;

function sampleLoadRatio(): number {
  const cpuCount = osCpus().length || 1;
  return loadavg()[0] / cpuCount;
}

/**
 * EI-9145: CPU loadavg (the ratio check above) doesn't catch host MEMORY
 * pressure — a wall-clock-sensitive in-memory scenario (e.g. merge.idle-tick's
 * repeated substrate mergeNow() over a large history) can be dominated by
 * swap-in/out page faults even while loadavg looks "back to normal". Observed
 * 2026-07-10 during EI-9087 triage: three re-runs of the same scenario got
 * progressively WORSE (+187% → +622% → +875%) even as the CPU load ratio fell
 * from 1.62× to 1.13×, because the box was still actively swapping (~150GB
 * used, live `vmstat` si/so in the 100-300k KB/s range) throughout every run.
 * Sample `/proc/vmstat`'s cumulative `pswpin`/`pswpout` counters (Linux-only;
 * `null` elsewhere — best-effort, never throws) at run-start and run-end; a
 * non-trivial page-in/out delta during the run window is an independent
 * "host swapping" signal, orthogonal to the CPU ratio.
 */
const HOST_SWAPPING_PAGES_THRESHOLD = 1000; // ~4MB of swap I/O (4KB pages) over the run

/** Pure parse of /proc/vmstat text — exported for unit testing without touching the fs. */
export function parseSwapPages(vmstatText: string): { pswpin: number; pswpout: number } | null {
  const pswpin = Number(/^pswpin (\d+)$/m.exec(vmstatText)?.[1] ?? NaN);
  const pswpout = Number(/^pswpout (\d+)$/m.exec(vmstatText)?.[1] ?? NaN);
  if (!Number.isFinite(pswpin) || !Number.isFinite(pswpout)) return null;
  return { pswpin, pswpout };
}

function sampleSwapPages(): { pswpin: number; pswpout: number } | null {
  try {
    return parseSwapPages(readFileSync('/proc/vmstat', 'utf8'));
  } catch {
    return null; // non-Linux host, /proc unavailable, or permission denied — best-effort
  }
}

/**
 * EI-19301664378023382: the CPU-ratio and swap-page-delta confounds above are
 * both *asserted* proxies for contention — neither is the kernel's own stall
 * accounting. Measured live 2026-08-02: on this box the swap-page-delta alone
 * marked BOTH of the two most recent nightly runs "OVERSUBSCRIBED (swap
 * thrashing)" (Δ2,394,052 and Δ259,671 pages, both ≫ the 1000-page/~4MB
 * threshold), while a same-moment PSI check showed memory "some" avg60 at
 * only ~2-5% and avg10 at ~0% — i.e. the kernel's own measure of actual
 * memory-stall time was low, not the sustained thrashing the verdict implies.
 * A page-count threshold has no notion of RATE or of whether anything was
 * actually STALLED waiting on it; PSI does.
 *
 * Fix scope, PHASE 1 (2026-08-02, deliberately narrow — see the item's own
 * "Care" note against over-correcting a guard whose underlying prior, real
 * scale-test flakiness under real load, is genuine): sample PSI "some"
 * (memory + cpu) the same way `sampleSwapPages` samples vmstat — start/end,
 * max of the two — and thread it through to `RunSummary.hostLoad` and the
 * rendered report/log line, WITHOUT changing the verdict, so a human could see
 * whether a given "oversubscribed" call was corroborated by real stall time.
 *
 * ⚠ SUPERSEDED — PHASE 2 (2026-08-17): the evidence phase 1 exposed showed the
 * page-delta threshold is not merely noisy here but UNSATISFIABLE, and that a
 * permanently-true confound silently SUPPRESSES regression findings. PSI is now
 * the authoritative memory-contention input and the page delta is the fallback
 * for hosts without PSI. See `computeHostHealth` and `HOST_PSI_MEM_STALL_PCT`
 * below for the measurements and the threshold's corroboration.
 */
function samplePsiSome(resource: 'memory' | 'cpu'): { avg10: number; avg60: number } | null {
  try {
    return parsePsiSome(readFileSync(`/proc/pressure/${resource}`, 'utf8'));
  } catch {
    return null; // non-Linux host, /proc unavailable, or permission denied — best-effort
  }
}

/** Pure parse of one `/proc/pressure/{memory,cpu}` file's `some` line —
 *  exported for unit testing without touching the fs. Format:
 *  `some avg10=0.00 avg60=0.00 avg300=0.00 total=0`. */
export function parsePsiSome(psiText: string): { avg10: number; avg60: number } | null {
  const line = psiText.split('\n').find((l) => l.startsWith('some '));
  if (!line) return null;
  const avg10 = Number(/\bavg10=([\d.]+)/.exec(line)?.[1] ?? NaN);
  const avg60 = Number(/\bavg60=([\d.]+)/.exec(line)?.[1] ?? NaN);
  if (!Number.isFinite(avg10) || !Number.isFinite(avg60)) return null;
  return { avg10, avg60 };
}

/**
 * EI-19301664378023382 (part 2, measured 2026-08-17): the page-count threshold
 * is NOT SATISFIABLE on this box, so it stopped qualifying runs and started
 * suppressing them. Two measurements on the shared dev box, same hour:
 *   - a genuinely QUIET moment — PSI memory `some avg60` = 0.76%, i.e. the
 *     kernel recorded essentially no memory-stall time — still produced a
 *     run-window delta of 3,364 pages, 3.4× the 1,000-page threshold;
 *   - a 40s sample with NO perf run active moved 909,444 pages (~3.5GB).
 * A ~4MB swap budget for a WHOLE run is background noise here, so `swapping`
 * was pinned true and every run inherited `oversubscribed`.
 *
 * That is NOT a conservative default. `oversubscribed` SUPPRESSES auto-filed
 * regressions and SLO violations (p2p-perf-actions.ts fileFindings), so a
 * permanently-true confound HIDES real regressions — and it simultaneously
 * blocks every baseline promotion, so the committed baseline cannot be
 * refreshed either. It fails in both directions at once.
 *
 * The original note above already named the fix and deliberately deferred it:
 * "A page-count threshold has no notion of RATE or of whether anything was
 * actually STALLED waiting on it; PSI does." So PSI is now the AUTHORITATIVE
 * memory-contention signal wherever the kernel exposes it, and the page delta
 * is demoted to a FALLBACK for hosts without PSI (non-Linux, /proc unreadable).
 * The page delta is still RECORDED as evidence in both cases.
 *
 * PSI also strictly widens what is caught: stall from reclaim/page-cache
 * thrashing shows up in PSI with little or no swap I/O, and the page-delta
 * check missed that case entirely.
 *
 * Threshold — PSI memory `some avg60` > 5%, corroborated twice and
 * independently: the 2026-08-02 audit above called ~2-5% "low, not the
 * sustained thrashing the verdict implies", and this host's own infra watchdog
 * alerts at memory `full avg60 >= 5`. `some` >= `full` always, so 5 on `some`
 * is the stricter of the two readings.
 */
const HOST_PSI_MEM_STALL_PCT = 5.0;

/**
 * Combine the CPU-ratio and memory-contention signals into one host-health
 * verdict. Pure + exported for unit testing (EI-9145) — the two confounds are
 * independent: either alone should mark the comparison UNCERTAIN.
 */
export function computeHostHealth(input: {
  ratio1m: number;
  swapPagesDelta: number | null;
  /**
   * PSI memory `some avg60` over the run window; `null` only when
   * /proc/pressure/memory could not be read. REQUIRED (deliberately not
   * optional): a new call site must state what it knows about memory stall
   * rather than silently inheriting the unsatisfiable page-count fallback,
   * which is exactly how this confound went unnoticed for two weeks.
   */
  psiMemSome60: number | null;
}): {
  oversubscribed: boolean;
  memoryContended: boolean;
  memoryContendedReason: 'psi-stall' | 'swap-pages-fallback' | null;
} {
  const memoryContendedReason: 'psi-stall' | 'swap-pages-fallback' | null =
    input.psiMemSome60 !== null
      ? input.psiMemSome60 > HOST_PSI_MEM_STALL_PCT
        ? 'psi-stall'
        : null // PSI readable and low ⇒ authoritative NOT-contended; do NOT consult the page delta
      : input.swapPagesDelta !== null && input.swapPagesDelta > HOST_SWAPPING_PAGES_THRESHOLD
        ? 'swap-pages-fallback'
        : null;
  const memoryContended = memoryContendedReason !== null;
  const oversubscribed = input.ratio1m > HOST_OVERSUBSCRIBED_RATIO || memoryContended;
  return { oversubscribed, memoryContended, memoryContendedReason };
}

const TIER1: PerfScenario[] = [...mergeCostScenarios, ...replicationScenarios, ...churnScenarios];
const TIER2: PerfScenario[] = [...netemScenarios];
const ALL: PerfScenario[] = [...TIER1, ...TIER2];

const PROFILES: Record<PerfProfile, { sizes: number[]; peerCounts: number[] }> = {
  smoke: { sizes: [1_000], peerCounts: [2] },
  ci: { sizes: [1_000, 10_000], peerCounts: [2, 5] },
  full: { sizes: [1_000, 10_000, 100_000], peerCounts: [2, 5, 10] },
  deep: { sizes: [1_000, 10_000, 100_000, 1_000_000], peerCounts: [2, 5, 10, 25] },
};

interface Args {
  scenarios: PerfScenario[];
  profile: PerfProfile;
  sizes: number[] | null;
  peers: number[] | null;
  out: string;
  baseline: string;
  updateBaseline: boolean;
  /** Accept a `--update-baseline` promotion that DROPS covered cells. */
  allowBaselineShrink: boolean;
  /** Accept a `--update-baseline` promotion captured on an oversubscribed host. */
  allowContendedBaseline: boolean;
  /** Which reference the advisory compares against (WI-2788). Default rolling. */
  reference: 'rolling' | 'frozen';
  gate: boolean;
  sloOnly: boolean;
  summaryJson: string | null;
}

/**
 * Load the artifacts of previous runs from the output dir, oldest-first, so a
 * rolling reference can be derived from them (WI-2788). Skips the current run
 * and tolerates partial/aborted run dirs — an unparseable artifact is a missing
 * observation, never a reason to fail the run that is trying to report.
 */
function loadRunHistory(outRoot: string, currentRunId: string, limit = 15): PerfArtifact[][] {
  if (!existsSync(outRoot)) return [];
  let dirs: string[];
  try {
    dirs = readdirSync(outRoot)
      .filter((d) => d !== currentRunId)
      .filter((d) => {
        try {
          return statSync(join(outRoot, d)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }

  const runs: PerfArtifact[][] = [];
  for (const d of dirs.slice(-limit)) {
    const artifacts: PerfArtifact[] = [];
    let files: string[];
    try {
      files = readdirSync(join(outRoot, d));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json') || f === 'summary.json') continue;
      try {
        const a = JSON.parse(readFileSync(join(outRoot, d, f), 'utf8')) as PerfArtifact;
        if (a?.scenario && a?.metrics) artifacts.push(a);
      } catch {
        // partial/aborted artifact — skip
      }
    }
    if (artifacts.length) runs.push(artifacts);
  }
  return runs;
}

/** Machine-readable run summary (consumed by the P-014 routine handler). */
export interface RunSummary {
  runId: string;
  profile: string;
  outDir: string;
  reference?: 'rolling' | 'frozen';
  reportPath: string;
  artifacts: number;
  scenarioFailures: string[];
  sloViolations: Array<{ scenario: string; paramsKey: string; p95Ms: number; limitMs: number }>;
  /**
   * Cells where the mesh did not converge (EI-20576392705164447). SEPARATE from
   * `sloViolations` — that list is host responsiveness only, and on 2026-08-16 a
   * 64-peer run had an empty `sloViolations` while most readers never caught up.
   * Fails `--gate` and `--slo-only` exactly like an SLO violation does.
   */
  convergenceViolations: Array<{
    scenario: string;
    paramsKey: string;
    expectedReaders: number;
    convergedReaders: number;
    laggingReaders: string[];
    observedP95Ms: number | null;
    p95LimitMs: number | null;
    /** Catch-up budget the readers were judged against, when declared. */
    budgetMs: number | null;
    /** Slowest SUCCESSFUL convergence (ms). Read WITH `budgetMs`: close to it
     *  means the cell was budget-bound (the deadline is the finding), far below
     *  it means a specific reader was genuinely stuck (the substrate is). */
    slowestConvergedMs: number | null;
  }>;
  /**
   * Present only when `--update-baseline` was asked for. `written: false` means
   * the promotion was REFUSED and the committed baseline is unchanged — recorded
   * because an explicitly-requested promotion that silently does nothing is the
   * same class of trap the refusal exists to prevent.
   */
  baselinePromotion?: {
    requested: true;
    written: boolean;
    refusals: Array<{ reason: string; overrideFlag: string; droppedKeys: string[] }>;
  };
  regressions: Array<{ scenario: string; paramsKey: string; metric: string; baseline: number; current: number; relChange: number }>;
  improvements: number;
  /**
   * Metrics that were never ELIGIBLE to regress — their baseline sits under the
   * absolute floor, so a relative verdict on them carries no information
   * (compare.ts `notComparable`). The comparator has always computed this; it
   * used to die here, so every downstream consumer — the release-facing log
   * line and p2p-perf-actions' auto-filed findings — reported a regression
   * count as if coverage were complete (WI-39359).
   *
   * MUST be read beside `regressions`: measured 2026-08-17 on the tier1 `ci`
   * baseline, 11 of 51 metrics (22%) are blind, including the whole hot path —
   * idleTickMs, decodeMs, deltaTick1Ms, appendCallMs. A 10x regression on
   * idleTickMs (0.01→0.1ms) cannot be seen by the fleet gate at all.
   */
  notComparable: Array<{
    scenario: string;
    paramsKey: string;
    metric: string;
    unit: string;
    baseline: number;
    current: number;
    floor: number;
  }>;
  /**
   * The denominator for `regressions` — `judged` metrics actually compared vs
   * `blind` ones skipped as uninformative. `null` when no baseline comparison
   * ran (there is no coverage to report, which is NOT the same as full
   * coverage). Never render a regression count without it.
   */
  regressionCoverage: { judged: number; blind: number; total: number } | null;
  baselineCompared: boolean;
  /** EI-8843/EI-9145: host contention sampled around the run (max of a
   *  start/end os.loadavg() sample, /cpus; plus a start/end /proc/vmstat
   *  swap-page delta). `oversubscribed` ⇒ the baseline comparison above is
   *  UNCERTAIN — a wall-clock/PG-latency-sensitive scenario could be
   *  measuring shared-box CPU contention OR swap thrashing, not a code
   *  regression. `memoryContended` isolates which confound fired, and
   *  `memoryContendedReason` names WHICH memory signal produced it.
   *
   *  `psiMemSome60`/`psiCpuSome60` (EI-19301664378023382): the kernel's own
   *  PSI "some" stall-time evidence (max of a start/end sample). `psiMemSome60`
   *  is the AUTHORITATIVE memory-contention input as of 2026-08-17 (see
   *  computeHostHealth) — the swap-page delta is only the fallback for hosts
   *  where it reads `null` (non-Linux, permission denied). `swapPagesDelta` is
   *  still recorded as evidence regardless of which branch decided. */
  hostLoad: HostLoadEvidence;
}

function parseArgs(argv: string[]): Args | 'list' {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  if (argv.includes('--list')) return 'list';
  const profile = (get('--profile') ?? 'ci') as PerfProfile;
  if (!PROFILES[profile]) throw new Error(`unknown --profile ${profile}`);

  let scenarios: PerfScenario[];
  const named = get('--scenario');
  if (named) {
    const ids = named.split(',').map((s) => s.trim());
    scenarios = ids.map((id) => {
      const s = ALL.find((x) => x.id === id);
      if (!s) throw new Error(`unknown scenario '${id}' — try --list`);
      return s;
    });
  } else if (argv.includes('--tier2')) {
    scenarios = TIER2;
  } else {
    scenarios = TIER1; // --tier1 is also the default
  }

  const nums = (v: string | null): number[] | null =>
    v ? v.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0) : null;

  return {
    scenarios,
    profile,
    sizes: nums(get('--sizes')),
    peers: nums(get('--peers')),
    out: get('--out') ?? join(process.cwd(), 'test-results', 'p2p-perf'),
    reference: (get('--reference') as 'rolling' | 'frozen' | undefined) ?? 'rolling',
    baseline: get('--baseline') ?? join(HERE, 'baselines', 'tier1.json'),
    updateBaseline: argv.includes('--update-baseline'),
    allowBaselineShrink: argv.includes('--allow-baseline-shrink'),
    allowContendedBaseline: argv.includes('--allow-contended-baseline'),
    gate: argv.includes('--gate'),
    sloOnly: argv.includes('--slo-only'),
    summaryJson: get('--summary-json'),
  };
}

function shortSummary(a: PerfArtifact): string {
  const keys = Object.entries(a.metrics)
    .filter(([, m]) => m.count > 0)
    .slice(0, 3)
    .map(([n, m]) => `${n} p95=${m.p95}${m.unit === 'ops/sec' ? ' ops/s' : m.unit}`)
    .join(' · ');
  const slo =
    a.sloPassed === null ? 'slo=n/a' : a.sloPassed ? `slo✓(${a.loopLag?.p95Ms}ms)` : `slo✖(${a.loopLag?.p95Ms}ms)`;
  return `${a.scenario} [${Object.entries(a.params).map(([k, v]) => `${k}=${v}`).join(' ')}] ${keys} ${slo} ${convergenceCell(a)}`;
}

/** One-glance convergence readout, printed BESIDE the SLO so a green `slo✓`
 *  can never be mistaken for "the mesh kept up" (EI-20576392705164447). */
function convergenceCell(a: PerfArtifact): string {
  const c = a.convergence;
  if (!c) return 'conv=n/a';
  const ratio = `${c.convergedReaders}/${c.expectedReaders}`;
  // Headroom, not just the verdict: a green cell that cleared its budget by 200ms
  // is a different report from one that cleared it by 110s, and the bare ratio
  // renders them identically (EI-20581532536662596).
  const headroom =
    c.budgetMs !== null && c.convergedMs !== null
      ? ` ${Math.round(c.convergedMs.max / 1000)}s/${Math.round(c.budgetMs / 1000)}s`
      : '';
  return a.convergencePassed ? `conv✓(${ratio}${headroom})` : `conv✖(${ratio}${headroom})`;
}

/**
 * Cells whose readers did not converge (or blew a set appendToVisible p95
 * ceiling) — the gate input the harness was missing.
 *
 * Pure + exported so the recurrence guard can feed it the exact artifact shape
 * that shipped green on 2026-08-16: healthy loop lag, readers ten minutes
 * behind, `sloPassed: true`.
 */
export function collectConvergenceViolations(artifacts: PerfArtifact[]): Array<{
  scenario: string;
  paramsKey: string;
  expectedReaders: number;
  convergedReaders: number;
  laggingReaders: string[];
  observedP95Ms: number | null;
  p95LimitMs: number | null;
  budgetMs: number | null;
  slowestConvergedMs: number | null;
}> {
  return artifacts
    .filter((a) => a.convergencePassed === false)
    .map((a) => ({
      scenario: a.scenario,
      paramsKey: paramsKeyOf(a),
      expectedReaders: a.convergence?.expectedReaders ?? 0,
      convergedReaders: a.convergence?.convergedReaders ?? 0,
      laggingReaders: a.convergence?.laggingReaders ?? [],
      observedP95Ms: a.convergence?.observedP95Ms ?? null,
      p95LimitMs: a.convergence?.p95LimitMs ?? null,
      budgetMs: a.convergence?.budgetMs ?? null,
      slowestConvergedMs: a.convergence?.convergedMs?.max ?? null,
    }));
}

function paramsKeyOf(a: PerfArtifact): string {
  return Object.entries(a.params)
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

function renderReport(
  runId: string,
  profile: string,
  artifacts: PerfArtifact[],
  compareText: string | null,
): string {
  const lines: string[] = [
    `# p2p-perf run \`${runId}\``,
    '',
    `- profile: **${profile}**`,
    `- host: ${artifacts[0]?.host.hostname} (${artifacts[0]?.host.platform}, ${artifacts[0]?.host.cpus} cpus, node ${artifacts[0]?.host.node})`,
    `- artifacts: ${artifacts.length}`,
    // D-026: the same "what code produced this" block report.ts renders, from
    // the SAME helper — the two renderers already diverge (this one is inline,
    // pre-dating report.ts's extraction) and a second hand-written copy of the
    // provenance block would be the next thing to drift out of agreement.
    ...renderProvenanceLines(artifacts),
    '',
    // SLO and convergence are SEPARATE columns on purpose: the former is host
    // responsiveness, the latter is whether replication kept up, and a run can
    // be ✓ on one and ✖ on the other (EI-20576392705164447).
    '| scenario | params | key metric (p95) | loop-lag p95 | SLO (host) | converged (readers) | notes |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const a of artifacts) {
    const params = Object.entries(a.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const main = Object.entries(a.metrics).find(([, m]) => m.count > 0);
    const metricCell = main ? `${main[0]}: ${main[1].p95} ${main[1].unit}` : '—';
    const slo = a.sloPassed === null ? 'n/a' : a.sloPassed ? '✓' : '**✖**';
    const conv =
      a.convergencePassed === null || a.convergencePassed === undefined
        ? 'n/a'
        : a.convergencePassed
          ? `✓ ${a.convergence?.convergedReaders}/${a.convergence?.expectedReaders}`
          : `**✖ ${a.convergence?.convergedReaders}/${a.convergence?.expectedReaders}**`;
    const notes = a.notes.length ? a.notes.join('; ').slice(0, 200) : '';
    lines.push(
      `| ${a.scenario} | ${params} | ${metricCell} | ${a.loopLag?.p95Ms ?? '—'} ms | ${slo} | ${conv} | ${notes} |`,
    );
  }
  if (compareText) {
    lines.push('', '## Baseline comparison (advisory — D-005)', '', '```', compareText, '```');
  }
  lines.push('', `_Generated by perf/runner.ts (p2p-performance-suite-2026-06-07)._`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'list') {
    for (const s of ALL) {
      console.log(`${s.id}  [tier ${s.tier}]  ${s.describe}`);
    }
    return;
  }
  const args = parsed;
  const prof = PROFILES[args.profile];
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(args.out, runId);
  mkdirSync(outDir, { recursive: true });

  // EI-8843: sample at start too — a run that STARTS oversubscribed but drains
  // by the time it finishes is still a run whose early scenarios' numbers are
  // suspect; the max of the two samples is the conservative call.
  const startLoadRatio = sampleLoadRatio();
  const startSwap = sampleSwapPages();
  // EI-19301664378023382: same start/end/max shape, for the PSI evidence
  // recorded alongside the verdict (see samplePsiSome's doc comment).
  const startPsiMem = samplePsiSome('memory');
  const startPsiCpu = samplePsiSome('cpu');

  // D-026: capture WHAT CODE IS RUNNING, once, at run start — the tree moves
  // during a run, so a per-artifact re-capture would record the state at emit
  // rather than at execution. The staleness that introduces is not assumed
  // away: `stampArtifactProvenance` re-stats the subject trees at every emit
  // and records any that moved (`subjectDriftSinceCapture`).
  const repoRoot = resolveRepoRoot(HERE);
  const runProvenance = captureRunProvenance({
    from: HERE,
    hostAtStart: {
      loadavg1m: loadavg()[0],
      cpus: osCpus().length,
      ratio1m: startLoadRatio,
      psiMemSome60: startPsiMem?.avg60 ?? null,
      psiCpuSome60: startPsiCpu?.avg60 ?? null,
      swapPagesAtStart: startSwap ? startSwap.pswpin + startSwap.pswpout : null,
    },
  });
  if (runProvenance.unavailable.length) {
    console.log(
      `  ⚠ run provenance incomplete: ${runProvenance.unavailable.join('; ')}` +
        ` — artifacts from this run are attributable only as far as the legs that answered.`,
    );
  }
  if (runProvenance.submodulesDivergedFromGitlink?.length) {
    // Loud on purpose: this is the condition under which the recorded
    // last-commit sha does NOT describe all the code that ran, and it is
    // invisible from the superproject sha alone.
    console.log(
      `  ⚠ ${runProvenance.submodulesDivergedFromGitlink.length} submodule(s) diverge from the recorded gitlink ` +
        `(${runProvenance.submodulesDivergedFromGitlink.slice(0, 5).join(', ')}) — ` +
        `lastCommitSha ${runProvenance.lastCommitSha?.slice(0, 12) ?? '(unknown)'} is an INCOMPLETE description of this run.`,
    );
  }

  const artifacts: PerfArtifact[] = [];
  const artifactFiles: string[] = [];
  const ctx: ScenarioRunCtx = {
    profile: args.profile,
    sizes: args.sizes ?? prof.sizes,
    peerCounts: args.peers ?? prof.peerCounts,
    seed: 1234,
    log: (line) => console.log(`  ${line}`),
    async emit(incoming) {
      // Stamp HERE, not in the meter: this is the one funnel every artifact
      // passes through, including ones produced in child processes (netem's
      // inner runner, mesh peer children) that have no access to the parent's
      // provenance capture.
      const artifact = stampArtifactProvenance(incoming, runProvenance, repoRoot);
      artifacts.push(artifact);
      const n = artifacts.length;
      const file = join(outDir, `${String(n).padStart(3, '0')}-${artifact.scenario.replace(/[^a-z0-9.-]/gi, '_')}.json`);
      writeFileSync(file, JSON.stringify(artifact, null, 2));
      artifactFiles.push(file);
      const drift = artifact.provenance?.subjectDriftSinceCapture ?? [];
      if (drift.length) {
        console.log(
          `  ⚠ subject tree moved since run start (${drift.join(', ')}) — this artifact and the ` +
            `run-start provenance may describe different code.`,
        );
      }
      console.log(`  ✔ ${shortSummary(artifact)}`);
    },
  };

  console.log(
    `p2p-perf runner — ${args.scenarios.length} scenario(s), profile=${args.profile} sizes=[${ctx.sizes}] peers=[${ctx.peerCounts}]`,
  );
  let failed = false;
  const scenarioFailures: string[] = [];
  for (const s of args.scenarios) {
    console.log(`\n▶ ${s.id} — ${s.describe}`);
    try {
      await s.run(ctx);
    } catch (e) {
      failed = true;
      scenarioFailures.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`  ✖ ${s.id} FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    }
  }

  // Baseline comparison (advisory — D-005).
  //
  // Reference selection (WI-2788): prefer a ROLLING reference derived from the
  // recent run history over the frozen capture. Measured over 51 nightlies, the
  // frozen capture encodes the box tenancy of the minute it was taken and made
  // the advisory fire on 61% of runs; a rolling p90 holds every metric at <=14%
  // at the same tolerance. Falls back to the committed file when there is not
  // enough history (fresh checkout, new scenario) or when forced with
  // `--reference frozen`.
  let compareText: string | null = null;
  let compared = false;
  let compareReport: ReturnType<typeof compareArtifacts> | null = null;
  let referenceKind: 'rolling' | 'frozen' | 'none' = 'none';
  // `--update-baseline` re-captures the frozen file and deliberately reports no
  // comparison; it must not silently start comparing against the rolling one.
  const rolling =
    args.reference === 'frozen' || args.updateBaseline
      ? null
      : baselineFromHistory(loadRunHistory(args.out, runId), { profile: args.profile });
  if (rolling) {
    referenceKind = 'rolling';
    compareReport = compareArtifacts(rolling, artifacts);
    compared = true;
    compareText = formatCompareReport(compareReport);
    console.log(
      `\n— comparison vs ROLLING reference (advisory; p90 of recent runs, ${rolling.entries.length} entries) —`,
    );
    console.log(compareText);
  } else if (existsSync(args.baseline) && !args.updateBaseline) {
    try {
      referenceKind = 'frozen';
      const baseline = JSON.parse(readFileSync(args.baseline, 'utf8')) as BaselineFile;
      compareReport = compareArtifacts(baseline, artifacts);
      compared = true;
      compareText = formatCompareReport(compareReport);
      console.log('\n— baseline comparison (advisory) —');
      console.log(compareText);
    } catch (e) {
      console.warn(`baseline comparison failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (!args.updateBaseline) {
    console.log(`\n(no baseline at ${args.baseline} — run with --update-baseline to create one)`);
  }
  const sloViolations =
    compareReport?.sloViolations ??
    artifacts
      .filter((a) => a.sloPassed === false)
      .map((a) => ({
        scenario: a.scenario,
        paramsKey: Object.entries(a.params)
          .sort(([x], [y]) => (x < y ? -1 : 1))
          .map(([k, v]) => `${k}=${v}`)
          .join(','),
        p95Ms: a.loopLag?.p95Ms ?? -1,
        limitMs: a.sloLimitMs,
      }));
  const convergenceViolations = collectConvergenceViolations(artifacts);
  if (convergenceViolations.length) {
    console.warn(
      `\n⚠ CONVERGENCE FAILURES (${convergenceViolations.length} cell(s)) — the mesh did not keep up. ` +
        `This is SEPARATE from the host-responsiveness SLO above, which can be green in the same run ` +
        `(EI-20576392705164447):`,
    );
    for (const v of convergenceViolations) {
      console.warn(
        `  ✖ ${v.scenario} [${v.paramsKey}] — ${v.convergedReaders}/${v.expectedReaders} readers converged` +
          (v.laggingReaders.length ? `, lagging: ${v.laggingReaders.slice(0, 12).join(',')}${v.laggingReaders.length > 12 ? '…' : ''}` : '') +
          (v.observedP95Ms !== null ? `, appendToVisible p95 ${v.observedP95Ms}ms` : '') +
          (v.p95LimitMs !== null ? ` (limit ${v.p95LimitMs}ms)` : '') +
          // Says WHICH KIND of failure this is: slowest-converged near the budget
          // means the deadline is the finding; far below it means a stuck reader.
          (v.budgetMs !== null
            ? `, budget ${v.budgetMs}ms${v.slowestConvergedMs !== null ? ` (slowest converged ${v.slowestConvergedMs}ms)` : ''}`
            : ''),
      );
    }
  }
  const regressionCount = compareReport?.regressions.length ?? 0;

  // EI-8843: max(start, end) load sample — conservative call on whether the
  // comparison above is trustworthy or shared-box CPU contention.
  const endLoadRatio = sampleLoadRatio();
  const ratio1m = Math.max(startLoadRatio, endLoadRatio);
  // EI-9145: swap-page delta over the SAME run window — an independent
  // memory-pressure confound loadavg alone can miss (see computeHostHealth).
  const endSwap = sampleSwapPages();
  const swapPagesDelta =
    startSwap && endSwap ? endSwap.pswpin - startSwap.pswpin + (endSwap.pswpout - startSwap.pswpout) : null;
  // EI-19301664378023382: max(start, end) PSI "some" — same conservative shape
  // as the load/swap samples above. Sampled BEFORE computeHostHealth because it
  // is now the authoritative memory-contention input, not just report evidence.
  const endPsiMem = samplePsiSome('memory');
  const endPsiCpu = samplePsiSome('cpu');
  const psiMemSome60 =
    startPsiMem || endPsiMem ? Math.max(startPsiMem?.avg60 ?? 0, endPsiMem?.avg60 ?? 0) : null;
  const psiCpuSome60 =
    startPsiCpu || endPsiCpu ? Math.max(startPsiCpu?.avg60 ?? 0, endPsiCpu?.avg60 ?? 0) : null;
  const { oversubscribed, memoryContended, memoryContendedReason } = computeHostHealth({
    ratio1m,
    swapPagesDelta,
    psiMemSome60,
  });
  const hostLoad: HostLoadEvidence = {
    loadavg1m: loadavg()[0],
    cpus: osCpus().length,
    ratio1m,
    oversubscribed,
    swapPagesDelta,
    memoryContended,
    memoryContendedReason,
    psiMemSome60,
    psiCpuSome60,
  };

  // D-026: the final/max host evidence and swap delta do not exist when each
  // scenario emits. Preserve the crash-safe emit-time write above, then
  // finalize and rewrite those SAME files once the end sample exists. A crash
  // before here leaves an explicit `hostLoad: null` rather than inventing a
  // quiet-host/zero-delta observation.
  for (let i = 0; i < artifacts.length; i += 1) {
    const finalized = finalizeArtifactProvenance(artifacts[i], hostLoad);
    artifacts[i] = finalized;
    writeFileSync(artifactFiles[i], JSON.stringify(finalized, null, 2));
  }
  if (oversubscribed) {
    const reasons = [
      ratio1m > HOST_OVERSUBSCRIBED_RATIO ? `CPU load ratio ${ratio1m.toFixed(2)}× cpus (limit ${HOST_OVERSUBSCRIBED_RATIO}×, EI-8843)` : null,
      // Name the branch that ACTUALLY fired — a reader of this line must never
      // have to guess whether PSI or the fallback produced the verdict.
      memoryContendedReason === 'psi-stall'
        ? `memory stall (PSI some avg60 ${psiMemSome60?.toFixed(1)}% > ${HOST_PSI_MEM_STALL_PCT}%, EI-19301664378023382)`
        : memoryContendedReason === 'swap-pages-fallback'
          ? `host swapping (Δ${swapPagesDelta} pages over the run — PSI UNAVAILABLE, page-delta fallback, EI-9145)`
          : null,
    ].filter(Boolean);
    console.warn(
      `\n⚠ host oversubscribed during this run (${reasons.join(' AND ')}) — the baseline comparison ` +
        `above is UNCERTAIN: a wall-clock/PG-latency-sensitive scenario may be measuring shared-box ` +
        `contention, not a code regression. The nightly routine will skip auto-filing findings from this run. ` +
        `Evidence: PSI some avg60 mem=${psiMemSome60 !== null ? `${psiMemSome60.toFixed(1)}%` : 'n/a'} ` +
        `cpu=${psiCpuSome60 !== null ? `${psiCpuSome60.toFixed(1)}%` : 'n/a'}, swap Δ${swapPagesDelta ?? 'n/a'} pages.`,
    );
  }

  // `--update-baseline` REWRITES the committed regression threshold from this
  // run alone. Two ordinary mistakes destroy it silently — a partial run that
  // collapses the covered cells, and a contended run that bakes shared-box
  // contention in as the bar. Both are refused here unless explicitly accepted;
  // see checkBaselinePromotion for why each override is separate.
  let baselinePromotion: RunSummary['baselinePromotion'];
  if (args.updateBaseline && artifacts.length) {
    const baseline = baselineFromArtifacts(artifacts, args.profile);
    let existing: BaselineFile | null = null;
    if (existsSync(args.baseline)) {
      try {
        existing = JSON.parse(readFileSync(args.baseline, 'utf8')) as BaselineFile;
      } catch (e) {
        // An unreadable existing baseline cannot be shown to be covered by this
        // run, so it is treated as "cannot prove this is safe" — not as absent.
        console.warn(
          `\n⚠ existing baseline at ${args.baseline} is unreadable ` +
            `(${e instanceof Error ? e.message : String(e)}) — refusing to overwrite what cannot be read.`,
        );
        existing = { schema: 1, capturedAt: '', profile: '', host: { hostname: '', platform: '', cpus: 0 }, entries: [] };
      }
    }
    const refusals = checkBaselinePromotion({
      existing,
      next: baseline,
      hostOversubscribed: oversubscribed,
      allowShrink: args.allowBaselineShrink,
      allowContended: args.allowContendedBaseline,
    });
    if (refusals.length) {
      console.error(`\n⛔ BASELINE NOT UPDATED — ${refusals.length} refusal(s):`);
      for (const r of refusals) console.error(`\n  [${r.reason}] ${r.message}`);
      console.error(`\n  Baseline left unchanged: ${args.baseline}`);
      baselinePromotion = {
        requested: true,
        written: false,
        refusals: refusals.map((r) => ({ reason: r.reason, overrideFlag: r.overrideFlag, droppedKeys: r.droppedKeys })),
      };
    } else {
      mkdirSync(dirname(args.baseline), { recursive: true });
      writeFileSync(args.baseline, JSON.stringify(baseline, null, 2));
      console.log(`\nbaseline updated: ${args.baseline} (${baseline.entries.length} entries)`);
      baselinePromotion = { requested: true, written: true, refusals: [] };
    }
  }

  const reportPath = join(outDir, 'report.md');
  writeFileSync(reportPath, renderReport(runId, args.profile, artifacts, compareText));
  console.log(`\nartifacts: ${outDir}`);
  console.log(`report:    ${reportPath}`);

  const summary: RunSummary = {
    runId,
    profile: args.profile,
    outDir,
    reference: referenceKind === 'none' ? undefined : referenceKind,
    reportPath,
    artifacts: artifacts.length,
    scenarioFailures,
    sloViolations,
    convergenceViolations,
    regressions: (compareReport?.regressions ?? []).map((d) => ({
      scenario: d.scenario,
      paramsKey: d.paramsKey,
      metric: d.metric,
      baseline: d.baseline,
      current: d.current,
      relChange: d.relChange,
    })),
    improvements: compareReport?.improvements.length ?? 0,
    notComparable: (compareReport?.notComparable ?? []).map((n) => ({
      scenario: n.scenario,
      paramsKey: n.paramsKey,
      metric: n.metric,
      unit: n.unit,
      baseline: n.baseline,
      current: n.current,
      floor: n.floor,
    })),
    regressionCoverage: compareReport
      ? {
          judged: compareReport.metricsCompared,
          blind: compareReport.notComparable.length,
          total: compareReport.metricsCompared + compareReport.notComparable.length,
        }
      : null,
    baselinePromotion,
    baselineCompared: compared,
    hostLoad,
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (args.summaryJson) {
    mkdirSync(dirname(args.summaryJson), { recursive: true });
    writeFileSync(args.summaryJson, JSON.stringify(summary, null, 2));
  }

  // A REFUSED promotion is a failure of what the caller explicitly asked for,
  // so it must not exit 0 — a script that runs `--update-baseline` and reads
  // only the status would otherwise record "baseline updated" for a run that
  // deliberately left it untouched. Checked first: it is a fact about THIS
  // invocation's request, independent of the run's own gate verdicts.
  if (baselinePromotion && !baselinePromotion.written) process.exitCode = 1;
  else if (failed) process.exitCode = 1;
  // A non-converged mesh fails BOTH gated paths. `--slo-only` narrows the gate
  // to "is this run acceptable", not "is the host responsive" — and a run whose
  // readers are ten minutes behind is not acceptable under any reading of that
  // (EI-20576392705164447: the 2026-08-16 64-peer run would have gone green here).
  else if (args.gate && (regressionCount > 0 || sloViolations.length > 0 || convergenceViolations.length > 0))
    process.exitCode = 1;
  else if (args.sloOnly && (sloViolations.length > 0 || convergenceViolations.length > 0)) process.exitCode = 1;

  // Scenarios can leave hyperswarm/corestore internals (DHT sockets, gc
  // timers) open even after every peer/handle we own has been closed — the
  // report + artifacts are already on disk at this point (EI-7253), so force
  // the exit rather than hang waiting for those to drain. Same idiom as
  // peer-child.ts's spawned-child main().
  process.exit(process.exitCode ?? 0);
}

// EI-9145: only auto-run the CLI when this file is executed directly (`tsx
// runner.ts ...`) — NOT when imported as a module (e.g. a unit test pulling
// in the pure `parseSwapPages`/`computeHostHealth` helpers above). Before
// this guard, importing this file for its exports had the side effect of
// kicking off a live perf run (writing real artifacts, eventually calling
// `process.exit()`) racing against the importer's own code.
if (isCliEntry(import.meta.url)) {
  void main();
}
