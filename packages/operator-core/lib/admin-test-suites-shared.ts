export type AdminTestSuiteId =
  | 'desktop-health'
  | 'admin-testing-core'
  | 'admin-testing-extended'
  | 'desktop-performance'
  | 'packaged-readiness'
  | 'memory-core'
  | 'shared-hive-core'
  | 'ai-explore-prompts';

export type AdminTestStatus = 'pass' | 'warn' | 'fail' | 'skip';
export type AdminTestRunStatus = 'running' | 'done' | 'error' | 'cancelled';

/**
 * Unit for a structured desktop-perf measure (desktop-performance-suite P-010).
 *
 * ⚠ ADDING A UNIT IS A CROSS-DEPLOY BREAKING CHANGE — do not widen this without
 * reading why (resource-efficiency-closeout-2026-08-13, WI-38449). The packaged
 * wdio runner POSTs its measures to a RUNNING operator, which on this box is
 * `:3070` — the GREEN release checkout, not your working tree. The ingest route
 * rejects the ENTIRE batch when any one measure fails validation, so emitting a
 * unit the DEPLOYED validator does not know yet does not degrade to "that one
 * measure is dropped": it 400s the whole run and the desktop-perf gate goes back
 * to being starved, which is the exact failure this suite exists to fix.
 * (Measured: a `pct` stamp 400'd a run whose four other measures were valid.)
 *
 * So a new unit may only land AFTER the reader is deployed everywhere the runner
 * can post to. Until then, carry the unit in the metric KEY (e.g.
 * `host:psi-cpu-some-avg10-pct`) and use an existing unit.
 */
export type DesktopPerfMetricUnit = 'ms' | 'kb' | 'count';

/**
 * One structured, cross-run-trendable metric a desktop-performance check emits
 * (e.g. a warm route-settle time, the plan-popup-open interaction, chaos INP,
 * RSS). Persisted per run (desktop_perf_runs) and diffed for the trend panel +
 * the release gate. Lives here in the dependency-free shared module so both the
 * check results and the persistence layer can reference it without a cycle.
 */
export interface DesktopPerfMeasure {
  /** Stable metric key, e.g. 'route:harness-warm', 'interaction:plan-popup-open'. */
  key: string;
  value: number;
  unit: DesktopPerfMetricUnit;
  /** Budget asserted against, or null when recorded-but-unbudgeted. */
  budget: number | null;
  /** Met its budget (true when budget is null). */
  ok: boolean;
  /**
   * This measure is a binary CORRECTNESS INVARIANT, not a tunable perf budget —
   * so a breach BLOCKS the release gate even though block-mode is not armed for
   * ordinary budgets (no-http-anywhere-2026-07-28 P-003c).
   *
   * WHY THE DISTINCTION IS REAL, not a severity dial. The desktop-perf gate is
   * deliberately warn-only "until the budgets are trusted", and that caution is
   * correct FOR BUDGETS: a timing budget is tuned by hand, drifts with machine
   * load, and produces false reds — blocking on one before it has earned trust
   * would wedge the fleet on noise. An invariant has none of those properties.
   * `webview HTTP egress == 0` is not a threshold someone picked; it is exact in
   * both directions (an IPC-routed request leaves no resource-timing entry at
   * all, so any entry IS the defect), it has no load sensitivity, and D-005 of
   * `no-http-anywhere-2026-07-28` rules an escape a loud failure rather than a
   * degradation. "Warn until trusted" answers a question an invariant never asks.
   *
   * Optional by design: every existing measure stays a budget, so no fixture or
   * producer that predates this field changes meaning (an absent flag is falsy).
   */
  invariant?: boolean;
}

/**
 * Key prefixes of CONTEXT STAMPS: measures that describe the circumstances of a
 * run (`host:` — the box it ran on; `build:` — the artifact it measured) rather
 * than a result. A stamp is `budget: null` / `ok: true` and is never evidence that
 * a spec measured anything, so a batch holding ONLY stamps is not a publishable
 * run (the ingest route and the WDIO publisher both refuse one).
 *
 * The WDIO runner (tools/perf-test/wdio/perf-report.ts) cannot import this module
 * and carries the same literals; perf-report.node-test.ts pins that copy to this one.
 */
export const DESKTOP_PERF_CONTEXT_STAMP_PREFIXES = ['host:', 'build:'] as const;

/**
 * `build:` stamp: the measured packaged binary's file mtime, epoch ms — WHEN the
 * build under test was produced (WI-10003815).
 *
 * WHY IT EXISTS. The runner measures the newest packaged binary on disk and nothing
 * rebuilds it, so a run's `gitSha` (the checkout HEAD at run time) says nothing
 * about the code actually timed. On 2026-09-29 the desktop-perf gate held a
 * suite-green candidate on a quiet-host breach measured against a 12-day-old
 * binary. This stamp lets the gate tell "the candidate regressed" from "the
 * measured build predates the green pin, so whatever it shows is already on main".
 * Carried as unit `count` because a new unit 400s the whole batch on a
 * not-yet-redeployed validator (see DesktopPerfMetricUnit).
 */
export const DESKTOP_PERF_BINARY_BUILT_AT_KEY = 'build:packaged-binary-mtime-ms';

export function isDesktopPerfContextStamp(key: string): boolean {
  return DESKTOP_PERF_CONTEXT_STAMP_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export type DesktopPerfSource = 'admin-suite' | 'wdio';
/** Worst per-run rollup — 'skip' collapses to 'pass'. */
export type DesktopPerfRunStatus = 'pass' | 'warn' | 'fail';

/** A measure enriched with its delta vs the previous (older) run with the same key. */
export interface DesktopPerfMeasureDelta extends DesktopPerfMeasure {
  /** Previous run's value for this key, or null when there is no prior run with it. */
  prevValue: number | null;
  /** value − prevValue (null when no prior). Positive = slower/larger. */
  deltaValue: number | null;
  /** deltaValue as a fraction of prevValue (null when no prior or prev is 0). */
  deltaPct: number | null;
}

/** One persisted desktop-perf run, enriched for the trend panel + release gate. */
export interface DesktopPerfTrendPoint {
  id: string;
  createdTs: number;
  source: DesktopPerfSource;
  status: DesktopPerfRunStatus;
  gitSha: string | null;
  runId: string | null;
  measures: DesktopPerfMeasureDelta[];
}

export interface AdminTestSuiteSpec {
  id: AdminTestSuiteId;
  label: string;
  hint: string;
  description: string;
  runner: 'tauri' | 'host' | 'mixed';
  estimatedSeconds: number;
  safeDefault: boolean;
  tags: string[];
}

export interface AdminTestCheckResult {
  suiteId: AdminTestSuiteId;
  id: string;
  label: string;
  status: AdminTestStatus;
  expected: string;
  actual: string;
  durationMs: number;
  details?: string[];
  /** Structured metrics for trend/regression persistence (P-010). Populated by
   *  desktop-performance checks; absent on checks that don't measure. */
  measures?: DesktopPerfMeasure[];
}

export interface AdminTestSuiteProgress {
  suiteId: AdminTestSuiteId;
  checkId: string;
  label: string;
  index: number;
  total: number;
}

export interface AdminTestSuiteDone {
  suiteId: AdminTestSuiteId;
  label: string;
  status: AdminTestStatus;
  durationMs: number;
  counts: Record<AdminTestStatus, number>;
}

export interface AdminTestLogEntry {
  id: number;
  suiteId: AdminTestSuiteId | 'system';
  level: 'info' | 'warn' | 'error';
  line: string;
  ts: number;
}

export interface AdminTestRunSnapshot {
  runId: string;
  selection: AdminTestSuiteId | 'all-safe';
  status: AdminTestRunStatus;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  results: AdminTestCheckResult[];
  summaries: Record<string, AdminTestSuiteDone>;
  progressBySuite: Record<string, AdminTestSuiteProgress>;
  logs: AdminTestLogEntry[];
}

export const ADMIN_TEST_SUITES: AdminTestSuiteSpec[] = [
  {
    id: 'desktop-health',
    label: 'Desktop health',
    hint: 'bridge, console, assets',
    description: 'Checks that the Tauri bridge is healthy, the operator is really running inside Tauri, the console stays clean, and required voice-runtime assets resolve.',
    runner: 'tauri',
    estimatedSeconds: 8,
    safeDefault: true,
    tags: ['tauri', 'health', 'console', 'assets'],
  },
  {
    id: 'desktop-performance',
    label: 'Desktop performance snapshot',
    hint: 'routes, INP, RSS',
    description: 'Measures warm route-settle times, current slow-interaction budget, and total desktop memory usage from inside the Tauri desktop shell.',
    runner: 'mixed',
    estimatedSeconds: 18,
    safeDefault: false,
    tags: ['tauri', 'performance', 'memory'],
  },
  {
    id: 'admin-testing-core',
    label: 'Testing tab core smoke',
    hint: 'live, chaos, routes, packaged',
    description: 'Navigates the core Testing subtabs in the Tauri desktop shell and verifies each one renders its expected headline surface.',
    runner: 'tauri',
    estimatedSeconds: 12,
    safeDefault: true,
    tags: ['tauri', 'smoke', 'testing-tab'],
  },
  {
    id: 'admin-testing-extended',
    label: 'Testing tab extended smoke',
    hint: 'AI Explore + LLM',
    description: 'Exercises the heavyweight Testing subtabs that are most likely to regress or restart the shell under memory pressure.',
    runner: 'tauri',
    estimatedSeconds: 12,
    safeDefault: false,
    tags: ['tauri', 'smoke', 'testing-tab', 'heavy'],
  },
  {
    id: 'packaged-readiness',
    label: 'Packaged runner readiness',
    hint: 'tauri-driver + wdio prereqs',
    description: 'Verifies that the packaged-binary performance runner can execute: tauri-driver present, WebKit WebDriver present, wdio deps installed, packaged binary present, and smoke selector still valid.',
    runner: 'host',
    estimatedSeconds: 5,
    safeDefault: false,
    tags: ['packaged', 'wdio', 'tauri-driver'],
  },
  {
    id: 'memory-core',
    label: 'Memory system',
    hint: 'mem0 round-trip, tenancy, TTL',
    description: 'End-to-end check of the mem0 memory system: pgvector + client + embedder, per-user / workspace-shared scoping, CRUD round-trip, TTL cleanup, pre-turn injection, feedback signal, performance budgets. Requires an embedder (OpenAI key OR local transformers).',
    runner: 'host',
    estimatedSeconds: 30,
    safeDefault: false,
    tags: ['memory', 'mem0', 'pgvector'],
  },
  {
    id: 'shared-hive-core',
    label: 'Shared Hive federation',
    hint: 'topic, authority, locks, admission',
    description: 'End-to-end check of the Shared Hive federation core: the Hive-pubkey topic re-key, Ed25519 hive identity, the per-Hive lock-authority election + file-claim routing (P-009), the instant lock-handover event fold (P-015), the work-item claim/replica seams, and the real shared_presence election + per-Hive admission union (P-006) against Postgres. Composes the shipped federation modules — a regression turns a check red. Writes are confined to a synthetic, run-scoped workspace and swept after.',
    runner: 'host',
    estimatedSeconds: 10,
    safeDefault: false,
    tags: ['shared-hive', 'federation', 'authority', 'locks', 'admission'],
  },
  {
    id: 'ai-explore-prompts',
    label: 'AI Explore prompts',
    hint: 'preconfigured LLM workflows',
    description: 'Runs a small opt-in set of preconfigured prompts through the same AI Explore Stagehand backend used by the Testing tab, reporting steps, tokens, cost, and failures.',
    runner: 'mixed',
    estimatedSeconds: 90,
    safeDefault: false,
    tags: ['ai', 'llm', 'stagehand', 'prompts'],
  },
];

export const ADMIN_TEST_SUITE_IDS = ADMIN_TEST_SUITES.map((suite) => suite.id) as AdminTestSuiteId[];
