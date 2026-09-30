/**
 * AdvEvalsTab — the /adv "Evaluation" tab (impartial-benchmark-suite-2026-06-15
 * D-007, BRIEF 9 / P-020).
 *
 * The dedicated home for the IMPARTIAL benchmark suite — the public, third-party
 * benchmark runs that prove the Papercusp harness contribution fairly (NOT the
 * self-referential internal evals: iq-battery / hive-eval / gym; those live in
 * the Learning tab). A skeptic discounts anything we author or grade, so this
 * surface reports runs on public tasks, graded by each benchmark's OFFICIAL
 * external grader, across four arms held to the same model / task / cost axis:
 *
 *   - `papercusp`           — the full multi-agent spine (the treatment).
 *   - `baseline-a-ablation` — the spine collapsed to a single worker (causal isolation).
 *   - `baseline-b-native`   — the same model in its native harness, best-elicited (headline, D-002).
 *   - `baseline-c-bestofn`  — single-agent best-of-N + verifier at matched budget.
 *
 * Sub-views (nuqs `?evalView=`) — the L1 per-task floor + the L2–L4 HIVE layer
 * (impartial-benchmark-suite D-010, the hive reframe):
 *   - **External benchmarks** (default, L1): per-suite results + the cost/accuracy
 *     Pareto across the per-task arms (the `Frontier` viz).
 *   - **Throughput** (L2): fleet wall-clock speedup vs the serial floor, tasks/$,
 *     backlog-drain time, autonomy — Hive vs Queen-ablated fleet (`ThroughputBars`).
 *   - **Value** (L3): $ captured under a fixed budget (UpBench/SWE-Lancer) — the
 *     Queen's placement vs the naive scheduler (`ValueCaptureCurve`).
 *   - **Coordination** (L4): the MAST failure-taxonomy rates (duplication /
 *     breakdown / misalignment / redundant) vs the published 41–86% MAS baseline
 *     and competitor orchestrators (`MastBreakdown`) — the most differentiated claim.
 *   - **Internal trends**: the longitudinal view — how the score moves
 *     generation-over-generation (reuses `BenchmarkTrend`).
 *   - **Report**: the headline — pass@1 + CIs by arm and the system-delta vs
 *     each baseline (the `Compare` viz). Headline baseline = the Queen-ablated fleet.
 *
 * State is URL-backed (nuqs, CLAUDE.md): `?evalView=` (subtab) · `?evalSuite=`
 * (selected benchmark suite) · `?evalRun=` (drill-in run id) — so deep links and
 * the agent `ui:dispatch` surface can drive it.
 *
 * Data: read-only via `@papercusp/sync`. The resolver entries are owned by the
 * schema co-owners, NOT this UI — `evals.suites` + `evals.runs` by P-010,
 * `evals.report` by P-011 (`@papercusp/bench-metrics` `buildSuiteReport`). This
 * tab is a pure CONSUMER. Schema locked v1 (`impartial-bench:run-result-schema:locked`):
 * canonical row type `TaskRunResult` + scoring `buildSuiteReport` live in
 * `@papercusp/bench-metrics`; PG is `benchmark_run_result` (migration 291).
 *
 * Sync-arg discipline (the invalidation-match gotcha): `emitRollout` fires
 * `notifySyncInvalidate('evals.runs', { run_id })`, so the runs/report queries
 * are keyed by `run_id` (NOT suite) or live invalidation silently won't refresh.
 * The suite picker resolves suite → latest `run_id` via `evals.suites`.
 *
 * Until those resolvers register + the first run lands, every query resolves to
 * `[]` and each subtab renders a clean empty state — this is the BRIEF 9 scaffold.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useQueryState, parseAsStringEnum, parseAsString } from 'nuqs';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import { Trophy, Beaker, TrendingUp, FileText, RefreshCw, Gauge, Scale, Zap, DollarSign, Network, Archive, Play, CheckCircle2, Download, RotateCcw, Trash2 } from 'lucide-react';
import { Select } from '@/app/harness/Select';
import { Checkbox } from '@/app/harness/Checkbox';
import { StatusPill } from '../ui';
// Shared, purely-presentational benchmark viz (P-021 / BRIEF 10). This tab owns
// the @papercusp/sync read and feeds these props; the components read no data.
import {
  Frontier,
  Compare,
  ThroughputBars,
  MastBreakdown,
  ValueCaptureCurve,
  armLabel,
  armColor,
  computeValiditySignals,
  isRunValid,
  validityCaveats,
  type FrontierPoint,
  type ComparePerTaskRow,
  type ThroughputArm,
  type MastArmRates,
  type ValueSeries,
  type ValiditySignal,
  type ValidityLiveFleet,
} from '@/app/eval-viz';

// ── Arm vocabulary (LOCKED by P-011, su-4ac61) ───────────────────────────────
// These exact strings key the schema, the Pareto/delta math, and the viz series.
// Do NOT invent new labels — every arm-runner emits one of these.
const ARMS = ['papercusp', 'baseline-a-ablation', 'baseline-b-native', 'baseline-c-bestofn'] as const;
type ArmId = (typeof ARMS)[number];

const ARM_LABEL: Record<ArmId, string> = {
  papercusp: 'Papercusp',
  'baseline-a-ablation': 'A · ablation',
  'baseline-b-native': 'B · native',
  'baseline-c-bestofn': 'C · best-of-N',
};
const ARM_HINT: Record<ArmId, string> = {
  papercusp: 'The full multi-agent spine — the treatment under test.',
  'baseline-a-ablation': 'The spine collapsed to a single worker, identical tools/model/budget — the causal-isolation control.',
  'baseline-b-native': 'The same model in its native harness (e.g. Claude Code), best-elicited — the headline baseline.',
  'baseline-c-bestofn': 'A single agent sampled N times + a test-verifier, at matched token budget.',
};
const ARM_COLOR: Record<ArmId, string> = {
  papercusp: '#eab308',
  'baseline-a-ablation': '#a78bfa',
  'baseline-b-native': 'var(--accent, #38bdf8)',
  'baseline-c-bestofn': '#34d399',
};

// ── Fleet arm vocabulary (L2–L4 hive layer, D-010) ───────────────────────────
// The fleet-level arms: `hive` is the treatment; `queen-ablated` (naive FIFO) is
// the NEW HEADLINE baseline (supersedes the headline half of D-002); `native-serial`
// is the serial-throughput floor. The Coordination subtab also compares against
// competitor orchestrators (P-028: openhands-async/crewai/langgraph). Labels +
// colors come from the shared eval-viz `arms.ts` (armLabel/armColor) so the
// scoreboard tiles match the chart series exactly; only the per-arm tooltip copy
// is local. FLEET_ARMS drives the Throughput scoreboard's fixed arm order.
const FLEET_ARMS = ['hive', 'queen-ablated', 'native-serial'] as const;
const FLEET_ARM_HINT: Record<string, string> = {
  hive: 'The full Pot — Mug autonomous placement/ranking/eviction over the cup fleet. The treatment.',
  'queen-ablated': 'The SAME fleet with the Mug replaced by a naive FIFO scheduler — the headline baseline. Pot − this = the Mug’s value.',
  'native-serial': 'One native-harness session draining the whole backlog sequentially — the serial-throughput floor (1× reference).',
};
/** Published MAS coordination-failure baseline band (MAST taxonomy, NeurIPS 2025). */
const MAS_BASELINE_BAND = { lo: 0.41, hi: 0.86 } as const;

// ── Consumer-side shapes (placeholder) ───────────────────────────────────────
// TODO(P-010/P-011): replace these locals with the canonical `TaskRunResult` +
// report types imported from `@papercusp/bench-metrics/schema` once the schema is
// broadcast (`impartial-bench:run-result-schema:locked`). Kept minimal + lenient
// so additive column changes don't break the scaffold.
interface EvalSuiteSummary {
  suite: string;
  runId: string | null;
  taskCount: number;
  armCount: number;
  /** pass@1 (0–1) per arm for the latest run, if computed. */
  passAt1ByArm?: Partial<Record<ArmId, number>>;
  updatedAt?: string | null;
}
interface EvalArmAggregate {
  arm: ArmId;
  passAt1: number;
  ci?: [number, number];
  // null (not just absent) is a real value: an ablation arm can report "no cost
  // measured". The frontier filter already guards `costUsd != null` (line ~311),
  // and the sibling aggregate types below allow null — align this one.
  costUsd?: number | null;
  isoBudgetTokens?: number | null;
}
export interface EvalReport {
  suite: string;
  byArm: EvalArmAggregate[];
  /** System-delta vs each baseline (papercusp − baseline). */
  deltas?: Array<{ baseline: ArmId; deltaPassAt1: number; costRatio: number | null }>;
}

// One per-(task × arm × seed) row from `evals.runs`. camelCase mirror of the
// `benchmark_run_result` PG row. TODO(P-011): replace with the canonical
// `TaskRunResult` from `@papercusp/bench-metrics/schema` once it is importable.
export interface EvalRunRow {
  taskId: string;
  arm: ArmId | string;
  seed: number;
  /** null = infra error (excluded from accuracy), per the locked scoring rules. */
  resolved: boolean | null;
  costUsd?: number | null;
  tokensTotal?: number | null;
}

// Fleet-layer (L2–L4) read shapes ARE the shared eval-viz prop item types —
// `ThroughputArm` / `ValueSeries` / `MastArmRates` (imported above). The sync
// resolvers (evals.throughput/value/coordination, owned by P-025/P-010) return
// these directly, so the UI reads them straight into the charts (no mapper, no
// recompute). The canonical metric source remains @papercusp/bench-metrics.

export const EVAL_VIEWS = ['launch', 'external', 'throughput', 'value', 'coordination', 'internal', 'report', 'preserved', 'compare'] as const;
type EvalView = (typeof EVAL_VIEWS)[number];

// ── Bench runs (live, via @papercusp/sync) ───────────────────────────────────
// The "Runs" subtab reads the operational bench-run store (bench_runs /
// bench_run_tasks / bench_run_events, migration 296) via the @papercusp/sync
// resolvers `evals.benchRuns` (list) + `evals.benchRun` (detail) — SSE-primary on
// desktop, so an in-flight run updates LIVE with no polling
// (benchmark-evaluation-ui-2026-06-16 P-003 / D-001). Preserved file-dir runs are
// imported one-way into the same store, so the m3 real-Queen pass (6/11 resolved)
// shows up here alongside any live run. Detail rows carry the PreservedArmRun shape
// (packages/operator-core/lib/external-bench/run-store.ts → getBenchRunDetail), so
// the per-task / throughput / coordination renders below are unchanged.
interface BenchRunListEntry {
  id: string;
  arm: string;
  taskSetId: string;
  status: string;
  source: string;
  resolvedPct: number | null;
  costUsd: number | null;
  createdAt: string;
}
interface PreservedResolvedTask {
  instanceId: string;
  cupId?: string;
  disposition?: string;
  stopReason?: string;
  costUsd?: number;
  turns?: number;
  wallClockMs?: number;
  diffBytes?: number;
  resolved: boolean | null;
}
interface PreservedRunSummary {
  arm: string;
  gradedCount: number;
  resolvedCount: number;
  taskCount: number;
  resolvedPct: number | null;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  wallMs: number;
  peakConcurrentBees: number;
  nonEmptyDiffs: number;
  coordEventCount: number;
  recovered: boolean;
}
interface PreservedCoordRates {
  duplicationRate: number;
  coordinationBreakdownRate: number;
  misalignmentRate: number;
  redundantWorkRate: number;
  counts: { duplicate: number; breakdown: number; misalignment: number; redundant: number };
  coordinationActions: number;
}
interface PreservedRunDetail {
  id: string;
  // Lifecycle + launch config (present on store-backed BenchRunDetail; optional so
  // an imported run without them still renders).
  status?: string;
  arm?: string;
  taskSetId?: string;
  source?: string;
  config?: { cap?: number | null } | null;
  run: { arm: string; startedAt?: string; coordEvents?: Array<{ kind: string; agent?: string; taskId?: string | null; detail?: string }> };
  perTask: PreservedResolvedTask[];
  summary: PreservedRunSummary;
  coordRates: PreservedCoordRates;
}

// Live fleet state (evals.benchRunLive) — mirrors live-state.ts BenchRunLiveState.
interface BenchRunLive {
  runId: string;
  status: string;
  potSlug: string | null;
  isLive: boolean;
  queen: { alive: boolean | null; ageSec: number | null; reclaims: number | null; status: string | null };
  bees: { total: number; placed: number; working: number; done: number; evicted: number; failed: number };
  models: { opusOnly: boolean | null; nonOpusSamples: number | null; totalSamples: number | null; distinctModels: string[] };
  spendUsd: number | null;
  wallSec: number | null;
  taskProgress: { todo: number; in_progress: number; collected: number; graded: number; error: number; total: number };
}

interface LaunchRunArgs {
  arm: string;
  taskSetId: string;
  taskIds?: string[];
  model?: string;
  cap?: number;
  maxUsdPerTask?: number;
  maxTokensPerTask?: number;
  maxUsdPerRun?: number;
}
interface LaunchRunResult {
  ok: boolean;
  runId?: string;
  error?: string;
}
async function readJsonResponse<T extends { ok?: boolean; error?: string }>(res: Response, fallback: string): Promise<T> {
  const text = await res.text();
  let data: T = {} as T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    // Some error paths return an empty/non-JSON body; surface the HTTP status.
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `${fallback} (${res.status})`);
  }
  return data;
}
async function launchRunRest(args: LaunchRunArgs): Promise<LaunchRunResult> {
  const res = await fetch('/api/external-bench/runs/launch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  return readJsonResponse<LaunchRunResult>(res, 'launch failed');
}
async function gradeRunRest(args: { runId: string }): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/external-bench/runs/${encodeURIComponent(args.runId)}/grade`, { method: 'POST' });
  return readJsonResponse<{ ok: boolean; error?: string }>(res, 'grade failed');
}
async function deleteRunRest(args: { runId: string }): Promise<{ ok: boolean; deleted?: boolean; error?: string }> {
  const res = await fetch(`/api/external-bench/runs/${encodeURIComponent(args.runId)}`, { method: 'DELETE' });
  return readJsonResponse<{ ok: boolean; deleted?: boolean; error?: string }>(res, 'delete failed');
}

const pctLabel = (v: number | null | undefined): string => (v == null ? '—' : `${Math.round(v * 100)}%`);

// ── Mappers: sync data → viz props (presentation only; stats stay in P-011) ───

/** Per-arm cost/accuracy points for the Frontier — one point per arm, from the
 *  report's per-arm aggregate (pass@1 + derived cost). Exported for tests. */
export function toFrontierPoints(report: EvalReport | undefined): FrontierPoint[] {
  if (!report) return [];
  return report.byArm
    .filter((a) => a.costUsd != null)
    .map((a) => ({ label: armLabel(a.arm), cost: a.costUsd as number, score: a.passAt1, arm: a.arm }));
}

/** Per-task pass@1 pivot for the A/B table: mean(resolved over seeds) per (task,
 *  arm). Presentation-level grouping only — the cross-task pass@k statistics
 *  stay in P-011's `buildSuiteReport`; this just lays raw rows side by side.
 *  Exported for tests. */
export function toComparePerTask(rows: EvalRunRow[], baseline: string, treatment: string): ComparePerTaskRow[] {
  const byTask = new Map<string, { b: number[]; t: number[] }>();
  for (const r of rows) {
    if (r.resolved == null) continue; // infra error — excluded from accuracy
    const bucket = byTask.get(r.taskId) ?? { b: [], t: [] };
    if (r.arm === baseline) bucket.b.push(r.resolved ? 1 : 0);
    else if (r.arm === treatment) bucket.t.push(r.resolved ? 1 : 0);
    byTask.set(r.taskId, bucket);
  }
  const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, c) => a + c, 0) / xs.length : null);
  return [...byTask.entries()]
    .map(([label, v]) => ({ label, baseline: mean(v.b), treatment: mean(v.t) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The three baselines, headline-first (B native is the headline, D-002). */
const BASELINE_ARMS: ArmId[] = ['baseline-b-native', 'baseline-a-ablation', 'baseline-c-bestofn'];
const fmtPct = (n: number | null | undefined): string => (n == null ? '—' : `${Math.round(n * 100)}%`);
const fmtUsd = (n: number): string => `$${n >= 100 ? Math.round(n) : Math.round(n * 100) / 100}`;

export default function AdvEvalsTab() {
  const [evalView, setEvalView] = useQueryState(
    'evalView',
    parseAsStringEnum<EvalView>([...EVAL_VIEWS]).withDefault('launch'),
  );
  const [evalSuite, setEvalSuite] = useQueryState('evalSuite', parseAsString);
  const [evalRun, setEvalRun] = useQueryState('evalRun', parseAsString);
  const view: EvalView = (EVAL_VIEWS as readonly string[]).includes(evalView) ? evalView : 'external';

  // The suite picker is shared across all three views — fetched once.
  const suitesSync = useSyncQuery<EvalSuiteSummary>({
    queryName: 'evals.suites',
    args: {},
    staleTime: 30_000,
  });
  const suites = suitesSync.data ?? [];
  // Default-select the first suite once the list loads (a fresh tab lands on a
  // real suite without writing the URL until the user picks).
  const activeSuite = evalSuite || suites[0]?.suite || '';
  const activeSummary = useMemo(() => suites.find((s) => s.suite === activeSuite), [suites, activeSuite]);
  // The runs/report queries key on run_id (matches emitRollout's invalidate). A
  // `?evalRun=` drill-in wins; else the suite's latest run.
  const runId = evalRun || activeSummary?.runId || '';

  return (
    <div className="pc-evals">
      <header className="pc-evals__header">
        <div className="pc-evals__copy">
          <h1>
            <Trophy size={18} aria-hidden /> Evaluation
          </h1>
          <p>
            The <strong>impartial</strong> benchmark suite — public third-party tasks, graded by each benchmark’s
            <em> official external grader</em>, run across four arms held to the same model, task set, and cost axis.
            This is the honest systems claim: holding the model constant, how much does the Papercusp harness add, and
            at what cost? (The self-referential internal evals — gym, IQ-battery, pot-eval — live under{' '}
            <a className="pc-evals__link" href="/adv?tab=learning">Learning</a>.)
          </p>
        </div>
        <ArmLegend />
      </header>

      <div className="pc-evals__controls">
        <div className="pc-evals__subnav" role="tablist" aria-label="Evaluation view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'launch'}
            className={`pc-evals__subtab${view === 'launch' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('launch')}
          >
            <Play size={13} aria-hidden />
            <span>Launch<em>run a benchmark</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'external'}
            className={`pc-evals__subtab${view === 'external' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('external')}
          >
            <Beaker size={13} aria-hidden />
            <span>External benchmarks<em>public · graded fairly</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'throughput'}
            className={`pc-evals__subtab${view === 'throughput' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('throughput')}
          >
            <Zap size={13} aria-hidden />
            <span>Throughput<em>fleet speedup · $/task</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'value'}
            className={`pc-evals__subtab${view === 'value' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('value')}
          >
            <DollarSign size={13} aria-hidden />
            <span>Value<em>$ captured / budget</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'coordination'}
            className={`pc-evals__subtab${view === 'coordination' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('coordination')}
          >
            <Network size={13} aria-hidden />
            <span>Coordination<em>MAST failure rates</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'internal'}
            className={`pc-evals__subtab${view === 'internal' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('internal')}
          >
            <TrendingUp size={13} aria-hidden />
            <span>Internal trends<em>score over time</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'report'}
            className={`pc-evals__subtab${view === 'report' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('report')}
          >
            <FileText size={13} aria-hidden />
            <span>Report<em>headline + deltas</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'preserved'}
            className={`pc-evals__subtab${view === 'preserved' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('preserved')}
          >
            <Archive size={13} aria-hidden />
            <span>Preserved runs<em>real graded runs</em></span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'compare'}
            className={`pc-evals__subtab${view === 'compare' ? ' is-active' : ''}`}
            onClick={() => void setEvalView('compare')}
          >
            <Scale size={13} aria-hidden />
            <span>Compare<em>arm vs arm</em></span>
          </button>
        </div>
        <div className="pc-evals__controlsright">
          {/* Suite picker — shared across views; hidden until suites exist. */}
          {suites.length > 0 ? (
            <label className="pc-evals__suitepick">
              <Gauge size={12} aria-hidden />
              <span className="pc-evals__suitelabel">suite</span>
              <Select
                ariaLabel="Benchmark suite"
                value={activeSuite}
                onChange={(v: string) => {
                  void setEvalSuite(v);
                  // A suite switch invalidates the drill-in run selection.
                  void setEvalRun(null);
                }}
                triggerStyle={{ maxWidth: 220 }}
                options={suites.map((s) => ({
                  value: s.suite,
                  label: `${s.suite}${s.taskCount ? ` · ${s.taskCount} tasks` : ''}`,
                }))}
              />
            </label>
          ) : null}
          <button
            type="button"
            className="pc-evals__refresh"
            aria-label="Reload the evaluation data"
            disabled={suitesSync.fetching}
            onClick={() => suitesSync.invalidate()}
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        </div>
      </div>

      {view === 'throughput' ? (
        <ThroughputView runId={runId} suites={suites} suitesLoading={suitesSync.loading && !suitesSync.data} />
      ) : view === 'value' ? (
        <ValueView runId={runId} suites={suites} suitesLoading={suitesSync.loading && !suitesSync.data} />
      ) : view === 'coordination' ? (
        <CoordinationView runId={runId} suites={suites} suitesLoading={suitesSync.loading && !suitesSync.data} />
      ) : view === 'internal' ? (
        <InternalTrendsView suite={activeSuite} suites={suites} suitesLoading={suitesSync.loading && !suitesSync.data} />
      ) : view === 'report' ? (
        <ReportView suite={activeSuite} runId={runId} />
      ) : view === 'preserved' ? (
        <PreservedRunsView />
      ) : view === 'launch' ? (
        <LaunchRunView />
      ) : view === 'compare' ? (
        <CompareRunsView />
      ) : (
        <ExternalBenchmarksView
          suite={activeSuite}
          runId={runId}
          summary={activeSummary}
          suites={suites}
          suitesLoading={suitesSync.loading && !suitesSync.data}
        />
      )}

      <EvalsStyles />
    </div>
  );
}

// ── Arm legend (the four arms + what each isolates) ──────────────────────────

function ArmLegend() {
  return (
    <div className="pc-evals__legend" aria-label="Benchmark arms">
      {ARMS.map((arm) => (
        <span key={arm} className="pc-evals__legenditem" aria-label={`${ARM_LABEL[arm]}: ${ARM_HINT[arm]}`}>
          <span className="pc-evals__legenddot" style={{ background: ARM_COLOR[arm] }} aria-hidden />
          {ARM_LABEL[arm]}
        </span>
      ))}
    </div>
  );
}

// ── External benchmarks view (per-suite results + cost/accuracy Pareto) ───────

function ExternalBenchmarksView({
  suite,
  runId,
  summary,
  suites,
  suitesLoading,
}: {
  suite: string;
  runId: string;
  summary: EvalSuiteSummary | undefined;
  suites: EvalSuiteSummary[];
  suitesLoading: boolean;
}) {
  // The per-arm aggregate for the selected run (pass@1 + derived cost), keyed by
  // run_id to match emitRollout's notifySyncInvalidate('evals.report', { run_id }).
  // Feeds the cost/accuracy Pareto (P-021 Frontier).
  const reportSync = useSyncQuery<EvalReport>({
    queryName: 'evals.report',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  const report = reportSync.data?.[0];
  const frontierPoints = useMemo(() => toFrontierPoints(report), [report]);

  if (suitesLoading) {
    return <p className="pc-evals__empty">Loading benchmark suites…</p>;
  }

  if (suites.length === 0) {
    return (
      <EmptyCard
        icon={<Trophy size={20} aria-hidden />}
        title="No benchmark runs yet"
        body="Once the external-bench adapter runs a suite (SWE-bench Pro, Terminal-Bench, …) across the four arms, each suite’s results appear here — per-arm pass@1, the cost/accuracy Pareto, and the headline system-delta. Runs are graded by the benchmark’s official external grader, never by us."
      />
    );
  }

  return (
    <section className="pc-evals__section">
      {/* Per-arm pass@1 scoreboard for the latest run of this suite. */}
      <div className="pc-evals__scoreboard" aria-label={`${suite} — pass@1 by arm`}>
        {ARMS.map((arm) => (
          <ArmStat
            key={arm}
            arm={arm}
            value={pctLabel(summary?.passAt1ByArm?.[arm])}
            hint={`pass@1 for ${ARM_LABEL[arm]} on ${suite || 'this suite'}. ${ARM_HINT[arm]}`}
          />
        ))}
      </div>

      {/* Cost/accuracy Pareto (P-021 Frontier) — fed by the per-arm aggregate.
          Frontier renders its own empty state until a run lands. */}
      <div className="pc-evals__sectionhead">
        <h2>Cost / accuracy frontier</h2>
        <button
          type="button"
          className="pc-evals__refresh"
          aria-label="Reload the report"
          disabled={reportSync.fetching}
          onClick={() => reportSync.invalidate()}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      <Frontier
        points={frontierPoints}
        xLabel="cost ($)"
        yLabel="pass@1"
        formatX={fmtUsd}
        formatY={fmtPct}
        highlightArm="papercusp"
        caption={suite ? `${suite} — accuracy vs cost across arms (lower-left dominated, upper-left wins)` : undefined}
        emptyHint="No runs for this suite yet — each arm plots once it has been run across the task set."
      />
    </section>
  );
}

// ── Fleet-layer shared pieces ────────────────────────────────────────────────

interface FleetViewProps {
  runId: string;
  suites: EvalSuiteSummary[];
  suitesLoading: boolean;
}

/** A per-fleet-arm stat tile (the fleet analog of ArmStat). Color/label come from
 *  the shared eval-viz `arms.ts` so the tile matches the chart series. */
function FleetStat({ arm, value, sub, hint }: { arm: string; value: string; sub?: string; hint?: string }) {
  return (
    <div className="pc-evals__stat" aria-label={hint} style={{ ['--arm-accent' as string]: armColor(arm) }}>
      <span className="pc-evals__statlabel">
        <span className="pc-evals__statdot" aria-hidden />
        {armLabel(arm)}
      </span>
      <span className="pc-evals__statvalue">{value}</span>
      {sub ? <span className="pc-evals__statsub">{sub}</span> : null}
    </div>
  );
}

// ── Throughput view (L2 — fleet speedup, tasks/$, backlog-drain) ──────────────

function ThroughputView({ runId, suites, suitesLoading }: FleetViewProps) {
  const sync = useSyncQuery<ThroughputArm>({
    queryName: 'evals.throughput',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  const rows = sync.data ?? [];

  if (suitesLoading) return <p className="pc-evals__empty">Loading…</p>;
  if (suites.length === 0) {
    return (
      <EmptyCard
        icon={<Zap size={20} aria-hidden />}
        title="No fleet runs yet"
        body="L2 throughput. When a whole backlog is handed to the Pot vs the Mug-ablated fleet vs the serial floor, the fleet’s wall-clock speedup, tasks/$ and backlog-drain time land here. Speedup is measured against the native-serial floor (1×)."
      />
    );
  }

  const byArm = new Map(rows.map((r) => [r.arm, r]));
  return (
    <section className="pc-evals__section">
      <div className="pc-evals__scoreboard" aria-label="Fleet throughput by arm">
        {FLEET_ARMS.map((arm) => {
          const r = byArm.get(arm);
          return (
            <FleetStat
              key={arm}
              arm={arm}
              value={r?.speedupVsSerial != null ? `${r.speedupVsSerial.toFixed(1)}×` : r ? `${Math.round(r.tasksPerHour)}/hr` : '—'}
              sub={r ? `${fmtUsd(r.costPerTask)}/task` : undefined}
              hint={`Wall-clock speedup vs the serial floor for ${armLabel(arm)}. ${FLEET_ARM_HINT[arm] ?? ''}`}
            />
          );
        })}
      </div>
      <div className="pc-evals__sectionhead">
        <h2>Throughput vs serial floor</h2>
        <button type="button" className="pc-evals__refresh" aria-label="Reload throughput" disabled={sync.fetching} onClick={() => sync.invalidate()}>
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      <ThroughputBars
        arms={rows}
        highlightArm="hive"
        caption="Fleet wall-clock speedup + $/task vs the native-serial floor (1×)"
        emptyHint="When the fleet drains a backlog, each arm’s speedup and $/task plot here — the Pot bar against the serial floor and the Mug-ablated fleet."
      />
    </section>
  );
}

// ── Value view (L3 — $ captured under a fixed budget) ─────────────────────────

function ValueView({ runId, suites, suitesLoading }: FleetViewProps) {
  const sync = useSyncQuery<ValueSeries>({
    queryName: 'evals.value',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  const series = sync.data ?? [];

  if (suitesLoading) return <p className="pc-evals__empty">Loading…</p>;
  if (suites.length === 0) {
    return (
      <EmptyCard
        icon={<DollarSign size={20} aria-hidden />}
        title="No value runs yet"
        body="L3 value-capture. On $-weighted backlogs (UpBench / SWE-Lancer) under a FIXED budget, this shows how much $ each arm captures as it spends — the Mug’s placement vs the naive scheduler. The arm that captures more $ per budget dollar wins."
      />
    );
  }

  return (
    <section className="pc-evals__section">
      <div className="pc-evals__scoreboard" aria-label="Value captured by arm">
        {series.map((s) => {
          const last = s.points[s.points.length - 1];
          return (
            <FleetStat
              key={s.arm}
              arm={s.arm}
              value={last ? fmtUsd(last.valueCaptured) : '—'}
              sub={last ? `of ${fmtUsd(last.budget)} budget` : undefined}
              hint={`Total $ captured by ${armLabel(s.arm)} at the budget cap.`}
            />
          );
        })}
      </div>
      <div className="pc-evals__sectionhead">
        <h2>Value captured / budget spent</h2>
        <button type="button" className="pc-evals__refresh" aria-label="Reload value" disabled={sync.fetching} onClick={() => sync.invalidate()}>
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      <ValueCaptureCurve
        series={series}
        highlightArm="hive"
        caption="$ captured as budget is spent — a higher, steeper curve places budget on higher-value work first"
        emptyHint="Each arm draws a curve of $ captured against budget spent once a $-weighted backlog (UpBench / SWE-Lancer) is run under a fixed budget."
      />
    </section>
  );
}

// ── Coordination view (L4 — MAST failure-taxonomy rates) ──────────────────────

function CoordinationView({ runId, suites, suitesLoading }: FleetViewProps) {
  const sync = useSyncQuery<MastArmRates>({
    queryName: 'evals.coordination',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  const rows = sync.data ?? [];

  if (suitesLoading) return <p className="pc-evals__empty">Loading…</p>;
  if (suites.length === 0) {
    return (
      <EmptyCard
        icon={<Network size={20} aria-hidden />}
        title="No coordination data yet"
        body={`L4 coordination quality — the most differentiated claim. From the rollout + coordination traces, this scores the MAST failure taxonomy (duplication, coordination-breakdown, misalignment, redundant work) per arm against the published ${Math.round(MAS_BASELINE_BAND.lo * 100)}–${Math.round(MAS_BASELINE_BAND.hi * 100)}% multi-agent-system baseline and competitor orchestrators. Lower is better.`}
      />
    );
  }

  return (
    <section className="pc-evals__section">
      <div className="pc-evals__scoreboard" aria-label="MAST coordination-failure rate by arm">
        {rows.map((r) => {
          const total = (r.duplication + r.coordinationBreakdown + r.misalignment + r.redundant) / 4;
          return (
            <FleetStat
              key={r.arm}
              arm={r.arm}
              value={fmtPct(total)}
              sub="mean MAST rate"
              hint={`Mean MAST failure rate for ${armLabel(r.arm)} (dup ${fmtPct(r.duplication)} · breakdown ${fmtPct(r.coordinationBreakdown)} · misalign ${fmtPct(r.misalignment)} · redundant ${fmtPct(r.redundant)}). Lower is better; published MAS baseline ${Math.round(MAS_BASELINE_BAND.lo * 100)}–${Math.round(MAS_BASELINE_BAND.hi * 100)}%.`}
            />
          );
        })}
      </div>
      <div className="pc-evals__sectionhead">
        <h2>MAST failure rates <em>vs {Math.round(MAS_BASELINE_BAND.lo * 100)}–{Math.round(MAS_BASELINE_BAND.hi * 100)}% MAS baseline</em></h2>
        <button type="button" className="pc-evals__refresh" aria-label="Reload coordination" disabled={sync.fetching} onClick={() => sync.invalidate()}>
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>
      <MastBreakdown
        arms={rows}
        baselineBand={MAS_BASELINE_BAND}
        caption="Coordination-failure rates by mode (lower is better) vs the published MAS-failure band"
        emptyHint="Each arm’s coordination-failure modes stack into a bar, shown against the shaded 41–86% published MAS baseline band — the Pot’s substrate (locks, work-item dedup, durable hand-offs) should sit well below it."
      />
    </section>
  );
}

// ── Internal trends view (longitudinal score over generations) ───────────────

function InternalTrendsView({
  suite,
  suites,
  suitesLoading,
}: {
  suite: string;
  suites: EvalSuiteSummary[];
  suitesLoading: boolean;
}) {
  // The longitudinal trend (suite score per code generation) is derived from the
  // suite history. The parent already fetches `evals.suites` via sync, so this
  // view consumes that rather than firing a second query. A dedicated longitudinal
  // query (e.g. `evals.suites` carrying run history, or a future `evals.trend`)
  // is a P-010/P-011 follow-on; once it carries ≥2 generations, reuse the existing
  // BenchmarkTrend surface here (as the Learning tab does).
  const generations = suites.filter((s) => s.suite === suite);

  if (suitesLoading) {
    return <p className="pc-evals__empty">Loading…</p>;
  }

  return (
    <section className="pc-evals__section">
      <div className="pc-evals__sectionhead">
        <h2>Score over time {suite ? <em>{suite}</em> : null}</h2>
      </div>
      {generations.length < 2 ? (
        <EmptyCard
          icon={<TrendingUp size={20} aria-hidden />}
          title="No trend yet"
          body="Each time this suite is re-run against a new code generation, its per-arm pass@1 becomes one point on the trend — the proof that the harness (and the gym tuning it) is actually getting better over time. Two or more generations are needed before a line appears."
        />
      ) : (
        <p className="pc-evals__empty">{generations.length} generations — trend viz (BenchmarkTrend) wires in here.</p>
      )}
    </section>
  );
}

// ── Report view (headline pass@1 + CIs + system-delta vs each baseline) ───────

function ReportView({ suite, runId }: { suite: string; runId: string }) {
  // The headline aggregate for this run — pass@1 + Wilson CI by arm + the
  // system-delta vs each baseline (P-011 `buildSuiteReport`). Keyed by run_id to
  // match emitRollout's invalidation.
  const reportSync = useSyncQuery<EvalReport>({
    queryName: 'evals.report',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  // Raw per-(task × arm × seed) rows — pivoted into the per-task A/B Compare
  // tables. Keyed by run_id to match emitRollout's invalidation of evals.runs.
  const runsSync = useSyncQuery<EvalRunRow>({
    queryName: 'evals.runs',
    args: { run_id: runId },
    staleTime: 30_000,
    enabled: !!runId,
  });
  const report = reportSync.data?.[0];
  const runs = runsSync.data ?? [];

  return (
    <section className="pc-evals__section">
      <div className="pc-evals__sectionhead">
        <h2>Headline report {suite ? <em>{suite}</em> : null}</h2>
        <button
          type="button"
          className="pc-evals__refresh"
          aria-label="Reload the report"
          disabled={reportSync.fetching || runsSync.fetching}
          onClick={() => {
            reportSync.invalidate();
            runsSync.invalidate();
          }}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </div>

      {reportSync.loading && !reportSync.data ? (
        <p className="pc-evals__empty">Loading the report…</p>
      ) : !report ? (
        <EmptyCard
          icon={<Scale size={20} aria-hidden />}
          title="No report yet"
          body="Once a suite has been run across all four arms with ≥3 seeds, the headline lands here: pass@1 with a 95% confidence interval per arm, the iso-budget cost, and the system-delta — “holding the model constant, the Papercusp harness resolves X% more at Z% of the native-harness cost.” The per-baseline A/B/C deltas plot below as Papercusp-vs-baseline tables."
        />
      ) : (
        <>
          <div className="pc-evals__scoreboard" aria-label={`${suite} — headline pass@1 by arm`}>
            {report.byArm.map((a) => (
              <ArmStat
                key={a.arm}
                arm={a.arm}
                value={pctLabel(a.passAt1)}
                sub={a.ci ? `${pctLabel(a.ci[0])}–${pctLabel(a.ci[1])}` : undefined}
                hint={`pass@1 (95% CI) for ${ARM_LABEL[a.arm]}. ${ARM_HINT[a.arm]}`}
              />
            ))}
          </div>

          {/* Papercusp vs each baseline — per-task score deltas (P-021 Compare),
              B native first (the headline baseline, D-002). Each Compare renders
              its own empty state until per-task rows arrive. */}
          {BASELINE_ARMS.map((baseline) => (
            <div key={baseline} className="pc-evals__compareblock">
              <h3 className="pc-evals__h3">Papercusp vs {ARM_LABEL[baseline]}</h3>
              <Compare
                baseline={baseline}
                treatment="papercusp"
                perTask={toComparePerTask(runs, baseline, 'papercusp')}
                format={fmtPct}
                emptyHint={`No comparable tasks yet for Papercusp vs ${ARM_LABEL[baseline]}.`}
              />
            </div>
          ))}
        </>
      )}
    </section>
  );
}

// ── Launch view (P-006) — trigger a real benchmark run from the UI ───────────
// Posts to /api/external-bench/runs/launch (the managed engine launcher, D-002).
// Selectors in nuqs; shows a cost+time ESTIMATE before launch + an owner-confirm
// above a spend threshold (D-004); disabled while a run is in flight. opus is
// pinned (fail-closed). The launch is gated server-side on papercusp-external-bench
// (default OFF) — a 403 surfaces the "enable the flag" message honestly.
const LAUNCH_ARMS = ['hive-realqueen', 'fifo-noqueen', 'mini-swe-agent'] as const;
const LAUNCH_TASK_SETS = [
  { id: '11-task-pilot', label: '11-task pilot (public SWE-bench Pro)' },
  { id: 'swe-bench-pro-full', label: 'Full SWE-bench Pro (~731)' },
  { id: 'custom', label: 'Custom instance ids' },
] as const;
const OWNER_CONFIRM_USD = 20;
const fieldStyle: CSSProperties = {
  background: 'var(--bg-2)', border: '1px solid var(--border)', color: 'var(--fg)',
  borderRadius: 6, padding: '5px 8px', fontSize: 13, width: 90,
};

interface LaunchEstimate {
  taskCount: number;
  estCostUsd: number;
  estWallMin: number;
  perTaskUsd: number;
  basis: string;
}

function LaunchRunView() {
  const [armRaw, setArm] = useQueryState('launchArm', parseAsStringEnum([...LAUNCH_ARMS]).withDefault('hive-realqueen'));
  const [taskSetRaw, setTaskSet] = useQueryState('launchTaskSet', parseAsStringEnum(LAUNCH_TASK_SETS.map((t) => t.id)).withDefault('11-task-pilot'));
  const [capRaw, setCap] = useQueryState('launchCap', parseAsString);
  const arm = armRaw ?? 'hive-realqueen';
  const taskSet = taskSetRaw ?? '11-task-pilot';
  const capNum = Math.max(1, Number(capRaw) || 5);

  const [maxUsd, setMaxUsd] = useState('10');
  const [customIds, setCustomIds] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [, setEvalView] = useQueryState('evalView', parseAsString);
  const [, setEvalRun] = useQueryState('evalRun', parseAsString);
  const launchRun = useSyncMutate<LaunchRunArgs, LaunchRunResult>('externalBench.launchRun', launchRunRest);

  // A run already in flight blocks a new launch (single-active-run, spend-safety).
  const runsSync = useSyncQuery<{ id: string; status: string }>({ queryName: 'evals.benchRuns', args: {} });
  const activeRun = useMemo(
    () => (Array.isArray(runsSync.data) ? runsSync.data : []).find((r) => ['pending', 'running', 'grading'].includes(r.status)),
    [runsSync.data],
  );

  // Cost+time estimate (D-004) — shared sync read so the launch form stays on the audited data path.
  const estimateSync = useSyncQuery<LaunchEstimate>({
    queryName: 'evals.benchEstimate',
    args: { taskSetId: taskSet, cap: capNum },
  });
  const estimate = estimateSync.data?.[0] ?? null;

  const needsConfirm = (estimate?.estCostUsd ?? 0) >= OWNER_CONFIRM_USD;
  const customMissing = taskSet === 'custom' && customIds.trim().length === 0;
  const canLaunch = !activeRun && !submitting && (!needsConfirm || confirmed) && !customMissing;

  async function launch() {
    setSubmitting(true);
    setError(null);
    try {
      const body: LaunchRunArgs = {
        arm,
        taskSetId: taskSet,
        cap: capNum,
        model: 'opus',
        maxUsdPerTask: Number(maxUsd) || undefined,
      };
      if (taskSet === 'custom') body.taskIds = customIds.split(',').map((s) => s.trim()).filter(Boolean);
      const json = await launchRun(body);
      if (!json.ok || !json.runId) {
        setError(json.error || 'launch failed');
        return;
      }
      await setEvalRun(json.runId);
      await setEvalView('preserved');
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="pc-evals__section">
      <p className="pc-evals__lede">
        Launch a managed SWE-bench Pro run with the selected arm, task set, and spend ceiling.
      </p>

      {activeRun ? (
        <div className="pc-evals__caveat" role="status">
          A run is already in flight (<code>{activeRun.id}</code>, {activeRun.status}). Cancel or let it finish
          before launching another — one run at a time keeps spend bounded.
        </div>
      ) : null}

      <div className="pc-launch__layout">
        <div className="pc-launch__panel">
          <div className="pc-evals__sectionhead"><h2>Run setup</h2></div>
          <div className="pc-launch__fields">
            <label className="pc-evals__suitepick">
              <span className="pc-evals__suitelabel">arm</span>
              <Select
                ariaLabel="Benchmark arm"
                value={arm}
                onChange={(v: string) => void setArm(v as (typeof LAUNCH_ARMS)[number])}
                options={LAUNCH_ARMS.map((a) => ({ value: a, label: armLabel(a) }))}
              />
            </label>

            <label className="pc-evals__suitepick">
              <span className="pc-evals__suitelabel">task set</span>
              <Select
                ariaLabel="Task set"
                value={taskSet}
                onChange={(v: string) => void setTaskSet(v as (typeof LAUNCH_TASK_SETS)[number]['id'])}
                options={LAUNCH_TASK_SETS.map((t) => ({ value: t.id, label: t.label }))}
              />
            </label>

            {taskSet === 'custom' ? (
              <label className="pc-evals__suitepick pc-launch__wide">
                <span className="pc-evals__suitelabel">ids</span>
                <input
                  aria-label="Custom instance ids (comma-separated)"
                  value={customIds}
                  onChange={(e) => setCustomIds(e.target.value)}
                  placeholder="instance_a, instance_b"
                  style={{ ...fieldStyle, width: '100%' }}
                />
              </label>
            ) : null}

            <div className="pc-launch__model" aria-label="Model policy">
              <span className="pc-evals__suitelabel">model</span>
              <strong>opus</strong>
              <span>fail-closed</span>
            </div>

            <label className="pc-evals__suitepick">
              <span className="pc-evals__suitelabel">fleet cap</span>
              <input
                aria-label="Fleet concurrency cap"
                type="number"
                min={1}
                value={capRaw ?? '5'}
                onChange={(e) => void setCap(e.target.value)}
                style={fieldStyle}
              />
            </label>

            <label className="pc-evals__suitepick">
              <span className="pc-evals__suitelabel">$/task cap</span>
              <input
                aria-label="Per-task budget cap (USD)"
                type="number"
                min={0}
                step={0.5}
                value={maxUsd}
                onChange={(e) => setMaxUsd(e.target.value)}
                style={fieldStyle}
              />
            </label>
          </div>
        </div>

        <div className="pc-launch__panel pc-launch__panel--estimate">
          <div className="pc-evals__sectionhead"><h2>Estimate</h2></div>
          {estimate ? (
            <div className="pc-evals__scoreboard pc-launch__estimate" aria-label="Run cost estimate">
              <div className="pc-evals__stat">
                <span className="pc-evals__statlabel"><DollarSign size={12} aria-hidden /> est. cost</span>
                <span className="pc-evals__statvalue">≈ ${estimate.estCostUsd.toFixed(2)}</span>
                <span className="pc-evals__statsub">{estimate.basis}</span>
              </div>
              <div className="pc-evals__stat">
                <span className="pc-evals__statlabel"><Gauge size={12} aria-hidden /> wall</span>
                <span className="pc-evals__statvalue">~{estimate.estWallMin} min</span>
                <span className="pc-evals__statsub">rough projection</span>
              </div>
              <div className="pc-evals__stat">
                <span className="pc-evals__statlabel">tasks</span>
                <span className="pc-evals__statvalue">{estimate.taskCount}</span>
                <span className="pc-evals__statsub">{fmtUsd(estimate.perTaskUsd)} / task</span>
              </div>
            </div>
          ) : (
            <p className="pc-evals__empty">Estimate unavailable.</p>
          )}

          {needsConfirm ? (
            <label className="pc-evals__confirm">
              <Checkbox checked={confirmed} onChange={setConfirmed} ariaLabel="Approve this spend" />
              <span>
                Estimated at <strong>≈ ${estimate?.estCostUsd.toFixed(2)}</strong> of opus. Confirm to unlock launch.
              </span>
            </label>
          ) : null}

          {error ? (
            <div className="pc-evals__caveat" role="alert">
              {error}
            </div>
          ) : null}

          <button
            type="button"
            className="pc-launch__primary"
            onClick={() => void launch()}
            disabled={!canLaunch}
            aria-label="Launch benchmark run"
          >
            <Play size={13} aria-hidden />
            {submitting ? 'Launching…' : activeRun ? 'Run in flight' : 'Launch run'}
          </button>
        </div>
      </div>
    </section>
  );
}

function runStatusTone(status: string | undefined): 'good' | 'warn' | 'bad' | 'neutral' {
  const normalized = (status ?? '').toLowerCase();
  if (['done', 'complete', 'completed', 'graded', 'succeeded', 'success'].includes(normalized)) return 'good';
  if (['pending', 'running', 'grading'].includes(normalized)) return 'neutral';
  if (['cancelled', 'canceled', 'failed', 'error', 'errored', 'deleted'].includes(normalized)) return 'bad';
  if (['blocked', 'paused'].includes(normalized)) return 'warn';
  return 'neutral';
}

function RunStatusPill({ status }: { status: string | undefined }) {
  const label = status || 'unknown';
  return <StatusPill tone={runStatusTone(status)} label={label} />;
}

function fmtShortDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

const PRESERVED_TASK_COLUMNS: ColumnDef<PreservedResolvedTask>[] = [
  {
    key: 'task',
    header: 'task',
    width: 'minmax(190px, 2fr)',
    toCopyText: (row) => row.instanceId,
    render: ({ row }) => (
      <span className="pc-preserved__task" title={row.instanceId}>
        {shortInstance(row.instanceId)}
      </span>
    ),
  },
  {
    key: 'resolved',
    header: 'resolved',
    width: 0.8,
    align: 'right',
    toCopyText: (row) => (row.resolved == null ? '' : row.resolved ? 'resolved' : 'unresolved'),
    render: ({ row }) => (
      <span className={`pc-preserved__num ${row.resolved ? 'pc-preserved__ok' : row.resolved === false ? 'pc-preserved__bad' : ''}`}>
        {row.resolved == null ? '—' : row.resolved ? '✓' : '✗'}
      </span>
    ),
  },
  {
    key: 'cost',
    header: 'cost',
    width: 0.75,
    align: 'right',
    toCopyText: (row) => fmtUsd(row.costUsd ?? 0),
    render: ({ row }) => <span className="pc-preserved__num">{fmtUsd(row.costUsd ?? 0)}</span>,
  },
  {
    key: 'turns',
    header: 'turns',
    width: 0.6,
    align: 'right',
    toCopyText: (row) => String(row.turns ?? ''),
    render: ({ row }) => <span className="pc-preserved__num">{row.turns ?? '—'}</span>,
  },
  {
    key: 'diffBytes',
    header: 'diff bytes',
    width: 0.8,
    align: 'right',
    toCopyText: (row) => String(row.diffBytes ?? 0),
    render: ({ row }) => <span className="pc-preserved__num">{row.diffBytes ?? 0}</span>,
  },
  {
    key: 'stop',
    header: 'stop',
    width: 'minmax(150px, 1.2fr)',
    toCopyText: (row) => row.stopReason ?? '',
    render: ({ row }) => <span className="pc-preserved__stop">{row.stopReason ?? '—'}</span>,
  },
];

function downloadFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Validity badges (P-009 / D-003) — the integrity guarantee, surfaced ───────
const VALIDITY_COLOR: Record<string, string> = { pass: '#34d399', warn: '#fbbf24', fail: '#fb7185', unknown: '#7f9bb4' };
function ValidityBadges({ signals }: { signals: ValiditySignal[] }) {
  if (signals.length === 0) return null;
  return (
    <div className="pc-evals__badges" role="list" aria-label="Run validity" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '10px 0' }}>
      {signals.map((sg) => {
        const c = VALIDITY_COLOR[sg.status] ?? '#7f9bb4';
        return (
          <span
            key={sg.key}
            role="listitem"
            aria-label={`${sg.label}: ${sg.detail}`}
            style={{ display: 'inline-flex', gap: 6, alignItems: 'center', border: `1px solid ${c}`, color: c, borderRadius: 999, padding: '2px 10px', fontSize: 12 }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 999, background: c }} aria-hidden />
            {sg.label}
          </span>
        );
      })}
    </div>
  );
}

// ── Live fleet panel (P-007) — the manual PG checks made visual ──────────────
function LiveFleetPanel({ live }: { live: BenchRunLive }) {
  const q = live.queen;
  const tp = live.taskProgress;
  return (
    <div className="pc-evals__live" aria-label="Live run state" style={{ margin: '8px 0 4px' }}>
      <div className="pc-evals__sectionhead" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: '#34d399' }} aria-hidden />
        <h2>Live · {live.status}</h2>
      </div>
      <div className="pc-evals__scoreboard" aria-label="Live fleet stats">
        <FleetStat
          arm="hive-realqueen"
          value={q.alive == null ? '—' : q.alive ? 'alive' : 'down'}
          sub={q.ageSec == null ? 'mug' : `mug · ${q.ageSec}s · ${q.reclaims ?? 0} reclaim(s)`}
          hint="The Mug's survival — a reclaimed/dead Mug is not a real-Mug run."
        />
        <FleetStat arm="hive-realqueen" value={`${live.bees.working}`} sub={`working · ${live.bees.done} done · ${live.bees.placed} placed`} hint={`Cups: ${live.bees.evicted} evicted, ${live.bees.failed} failed of ${live.bees.total}.`} />
        <FleetStat arm="hive-realqueen" value={`${tp.graded + tp.collected}/${tp.total}`} sub={`progress · ${tp.in_progress} in-flight`} hint={`Per-task: ${tp.todo} todo, ${tp.in_progress} in-progress, ${tp.collected} collected, ${tp.graded} graded.`} />
        <FleetStat arm="hive-realqueen" value={live.spendUsd == null ? '—' : fmtUsd(live.spendUsd)} sub={live.wallSec == null ? 'spend' : `spend · ${Math.round(live.wallSec / 60)}m wall`} hint={`Models: ${live.models.distinctModels.join(', ') || 'none yet'}.`} />
      </div>
    </div>
  );
}

// ── Coordination timeline (P-008) — the Queen's orchestration, event by event ─
const COORD_COLOR: Record<string, string> = {
  placement: 'var(--accent)', complete: 'var(--good)', rework: 'var(--warn)', stranded_item: 'var(--bad)',
  evicted: 'var(--bad)', spawn: 'var(--accent-strong)', handoff: 'var(--accent-strong)', claim: 'var(--accent)', wake: 'var(--warn)',
};
function CoordTimeline({ events }: { events: Array<{ kind: string; agent?: string; taskId?: string | null; detail?: string }> }) {
  if (events.length === 0) return null;
  return (
    <div className="pc-evals__timeline" aria-label="Coordination timeline" style={{ marginTop: 10 }}>
      <div className="pc-evals__sectionhead"><h2>Coordination timeline<span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}> · {events.length} events</span></h2></div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 320, overflowY: 'auto' }}>
        {events.map((e, i) => {
          const c = COORD_COLOR[e.kind] ?? '#7f9bb4';
          return (
            <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: 2, background: c, flex: '0 0 auto', alignSelf: 'center' }} aria-hidden />
              <span style={{ color: c, minWidth: 90 }}>{e.kind}</span>
              {e.taskId ? <span style={{ color: 'var(--fg-dim)' }}>{shortInstance(e.taskId)}</span> : null}
              {e.detail ? <span style={{ color: 'var(--fg-mute, #7f9bb4)' }}>{e.detail}</span> : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── Compare view (P-011 / P-012) — arm vs arm, with the validity gate + caveats ──
// Pick two runs over the SAME task set → resolved% delta + Frontier + per-task
// Compare, fed from the operational store. D-003: if EITHER arm fails a validity
// check, REFUSE to render a delta as a number — show "no valid delta" + why. The
// honest-caveats panel auto-surfaces every per-arm + cross-arm caveat (P-012).
function validitySignalsFor(d: PreservedRunDetail | null): ValiditySignal[] {
  if (!d) return [];
  return computeValiditySignals({
    taskCount: d.summary.taskCount,
    nonEmptyDiffs: d.summary.nonEmptyDiffs,
    capValue: d.config?.cap ?? null,
    recovered: d.summary.recovered,
    seedCount: 1,
  });
}

function crossArmCaveats(a: PreservedRunDetail, b: PreservedRunDetail): string[] {
  const out: string[] = [];
  if (a.taskSetId && b.taskSetId && a.taskSetId !== b.taskSetId) {
    out.push(`Task sets differ (${a.taskSetId} vs ${b.taskSetId}) — this is NOT a same-task comparison; the delta is not apples-to-apples.`);
  }
  if (a.summary.taskCount !== b.summary.taskCount) {
    out.push(`Task counts differ (${a.summary.taskCount} vs ${b.summary.taskCount}) — the arms ran over different-sized sets.`);
  }
  const capA = a.config?.cap ?? null;
  const capB = b.config?.cap ?? null;
  if (capA != null && capB != null && capA !== capB) {
    out.push(`Fleet caps differ (${capA} vs ${capB}) — cap asymmetry favors the higher-cap arm on throughput.`);
  }
  if (a.source && b.source && a.source !== b.source) {
    out.push(`Spawn paths differ (${a.source} vs ${b.source}) — spawn-path parity not held.`);
  }
  return out;
}

function CompareRunsView() {
  const [aId, setAId] = useQueryState('compareA', parseAsString);
  const [bId, setBId] = useQueryState('compareB', parseAsString);

  const runsSync = useSyncQuery<BenchRunListEntry>({ queryName: 'evals.benchRuns', args: {} });
  const runs = useMemo(() => (Array.isArray(runsSync.data) ? runsSync.data : []), [runsSync.data]);

  const aSync = useSyncQuery<PreservedRunDetail>({ queryName: 'evals.benchRun', args: { runId: aId ?? '' }, enabled: Boolean(aId) });
  const bSync = useSyncQuery<PreservedRunDetail>({ queryName: 'evals.benchRun', args: { runId: bId ?? '' }, enabled: Boolean(bId) });
  const a = aSync.data?.[0] ?? null;
  const b = bSync.data?.[0] ?? null;

  if (runs.length < 2) {
    return (
      <EmptyCard
        icon={<Scale size={20} aria-hidden />}
        title="Need at least two runs to compare"
        body="Run (or import) a second arm over the same task set — e.g. the SWE-bench Pro reference harness (mini-SWE-agent) on the same 11 tasks + opus — then compare it against the Pot arm here."
      />
    );
  }

  const options = runs.map((r) => ({ value: r.id, label: `${r.id} · ${armLabel(r.arm)}` }));
  const aSignals = validitySignalsFor(a);
  const bSignals = validitySignalsFor(b);
  const aValid = a ? isRunValid(aSignals) : true;
  const bValid = b ? isRunValid(bSignals) : true;
  const bothPicked = Boolean(a && b);
  const validDelta = bothPicked && aValid && bValid;

  const frontierPoints: FrontierPoint[] = [a, b]
    .filter((d): d is PreservedRunDetail => Boolean(d))
    .filter((d) => d.summary.resolvedPct != null)
    .map((d) => ({ label: armLabel(d.arm ?? d.summary.arm), cost: d.summary.costUsd, score: d.summary.resolvedPct as number, arm: d.arm ?? d.summary.arm }));

  // Per-task A-vs-B delta rows (baseline = A, treatment = B).
  const perTaskRows: ComparePerTaskRow[] = bothPicked
    ? (() => {
        const am = new Map(a!.perTask.map((t) => [t.instanceId, t.resolved]));
        const bm = new Map(b!.perTask.map((t) => [t.instanceId, t.resolved]));
        const ids = [...new Set([...am.keys(), ...bm.keys()])].sort();
        return ids.map((id) => ({
          label: shortInstance(id),
          baseline: am.get(id) == null ? null : am.get(id) ? 1 : 0,
          treatment: bm.get(id) == null ? null : bm.get(id) ? 1 : 0,
        }));
      })()
    : [];

  const deltaPct = validDelta && a!.summary.resolvedPct != null && b!.summary.resolvedPct != null
    ? (b!.summary.resolvedPct - a!.summary.resolvedPct) * 100
    : null;

  const caveats: string[] = [
    ...(bothPicked ? crossArmCaveats(a!, b!) : []),
    ...validityCaveats(aSignals).map((s: ValiditySignal) => `${armLabel(a!.arm ?? a!.summary.arm)} — ${s.label}: ${s.detail}`),
    ...validityCaveats(bSignals).map((s: ValiditySignal) => `${armLabel(b!.arm ?? b!.summary.arm)} — ${s.label}: ${s.detail}`),
  ];

  return (
    <section className="pc-evals__section">
      <div className="pc-evals__controlsright" style={{ gap: 12 }}>
        <label className="pc-evals__suitepick">
          <span className="pc-evals__suitelabel">baseline (A)</span>
          <Select ariaLabel="Baseline run (A)" value={aId || ''} onChange={(v: string) => void setAId(v)} triggerStyle={{ maxWidth: 260 }} options={options} />
        </label>
        <label className="pc-evals__suitepick">
          <span className="pc-evals__suitelabel">treatment (B)</span>
          <Select ariaLabel="Treatment run (B)" value={bId || ''} onChange={(v: string) => void setBId(v)} triggerStyle={{ maxWidth: 260 }} options={options} />
        </label>
      </div>

      {!bothPicked ? (
        <p className="pc-evals__empty">Pick a baseline (A) and a treatment (B) run to compare.</p>
      ) : (
        <>
          {/* D-003 gate — a degenerate arm can never be shown as a clean delta. */}
          {!validDelta ? (
            <div className="pc-evals__caveat" role="alert" aria-label="no valid delta" style={{ marginBottom: 12 }}>
              <strong>No valid delta.</strong> {!aValid ? `${armLabel(a!.arm ?? a!.summary.arm)} (A) fails a validity check. ` : ''}
              {!bValid ? `${armLabel(b!.arm ?? b!.summary.arm)} (B) fails a validity check. ` : ''}
              A delta is not shown as a number because at least one arm is degenerate — see the failing badges + caveats below.
            </div>
          ) : (
            <div className="pc-evals__scoreboard" aria-label="resolved delta">
              <FleetStat
                arm={b!.arm ?? b!.summary.arm}
                value={deltaPct == null ? '—' : `${deltaPct >= 0 ? '+' : ''}${Math.round(deltaPct * 10) / 10} pts`}
                sub={`${armLabel(b!.arm ?? b!.summary.arm)} − ${armLabel(a!.arm ?? a!.summary.arm)}`}
                hint="Resolved% delta (treatment − baseline) over the compared task set."
              />
              <FleetStat arm={a!.arm ?? a!.summary.arm} value={pctLabel(a!.summary.resolvedPct)} sub={`A · ${armLabel(a!.arm ?? a!.summary.arm)}`} hint="Baseline resolved%." />
              <FleetStat arm={b!.arm ?? b!.summary.arm} value={pctLabel(b!.summary.resolvedPct)} sub={`B · ${armLabel(b!.arm ?? b!.summary.arm)}`} hint="Treatment resolved%." />
            </div>
          )}

          {/* Validity badges for both arms. */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div><div className="pc-evals__suitelabel">{armLabel(a!.arm ?? a!.summary.arm)} (A)</div><ValidityBadges signals={aSignals} /></div>
            <div><div className="pc-evals__suitelabel">{armLabel(b!.arm ?? b!.summary.arm)} (B)</div><ValidityBadges signals={bSignals} /></div>
          </div>

          <div className="pc-evals__sectionhead"><h2>Cost / accuracy frontier</h2></div>
          <Frontier points={frontierPoints} highlightArm={b!.arm ?? b!.summary.arm} caption="Each arm as a cost/accuracy point — up-and-left is better." emptyHint="No graded arms to plot." />

          <div className="pc-evals__sectionhead"><h2>Per-task A vs B</h2></div>
          <Compare baseline={armLabel(a!.arm ?? a!.summary.arm)} treatment={armLabel(b!.arm ?? b!.summary.arm)} perTask={perTaskRows} format={(n: number | null | undefined) => (n == null ? '—' : n ? '✓' : '✗')} emptyHint="No shared tasks." />

          {/* Honest-caveats panel (P-012 / D-003) — a delta is never cleaner than its caveats. */}
          <div className="pc-evals__sectionhead"><h2>Honest caveats<span style={{ color: 'var(--fg-dim)', fontWeight: 400 }}> · {caveats.length}</span></h2></div>
          {caveats.length === 0 ? (
            <p className="pc-evals__empty">No caveats — the arms are comparable on the surfaced dimensions.</p>
          ) : (
            <ul className="pc-evals__caveatlist" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {caveats.map((c, i) => (
                <li key={i} style={{ fontSize: 12, color: 'var(--fg-dim)' }}>{c}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

// ── Preserved / live runs view — the real graded snapshots, now via @papercusp/sync ──

function PreservedRunsView() {
  // ?evalRun= is the selected run id (shared with the sync views).
  const [selId, setSelId] = useQueryState('evalRun', parseAsString);

  // Live run list (SSE-primary on desktop). Newest-first from the resolver.
  const runsSync = useSyncQuery<BenchRunListEntry>({ queryName: 'evals.benchRuns', args: {} });
  const runs = useMemo(() => (Array.isArray(runsSync.data) ? runsSync.data : []), [runsSync.data]);
  const loading = runsSync.loading && runs.length === 0;
  const listErr = runsSync.error ? String(runsSync.error) : null;

  // Default-select the newest run once the list arrives.
  useEffect(() => {
    if (!selId && runs[0]) void setSelId(runs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.length]);

  // Live detail for the selected run (updates incrementally during a run).
  const detailSync = useSyncQuery<PreservedRunDetail>({
    queryName: 'evals.benchRun',
    args: { runId: selId ?? '' },
    enabled: Boolean(selId),
  });
  const detail = detailSync.data?.[0] ?? null;
  const detailErr = detailSync.error ? String(detailSync.error) : null;

  // Live fleet state. Spawn/sample writes are bridged onto the sync bus, so
  // active runs update by push instead of a fixed four-second refetch loop.
  const selRun = runs.find((r) => r.id === selId);
  const liveSync = useSyncQuery<BenchRunLive>({
    queryName: 'evals.benchRunLive',
    args: { runId: selId ?? '' },
    enabled: Boolean(selId),
  });
  const live = liveSync.data?.[0] ?? null;

  // Run management (P-010 grade / P-013 export / P-014 delete + re-run).
  const [grading, setGrading] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Setters to pre-fill the launch form for re-run-with-same-config (P-014).
  const [, setEvalView] = useQueryState('evalView', parseAsString);
  const [, setLaunchArm] = useQueryState('launchArm', parseAsString);
  const [, setLaunchTaskSet] = useQueryState('launchTaskSet', parseAsString);
  const [, setLaunchCap] = useQueryState('launchCap', parseAsString);
  const gradeRunMutate = useSyncMutate<{ runId: string }, { ok: boolean; error?: string }>('externalBench.gradeRun', gradeRunRest);
  const deleteRunMutate = useSyncMutate<{ runId: string }, { ok: boolean; deleted?: boolean; error?: string }>('externalBench.deleteRun', deleteRunRest);
  // Filter the run list by arm (P-014 browse/filter).
  const [armFilter, setArmFilter] = useQueryState('runArmFilter', parseAsString);
  const armOptions = useMemo(() => [...new Set(runs.map((r) => r.arm))].sort(), [runs]);
  const filteredRuns = armFilter ? runs.filter((r) => r.arm === armFilter) : runs;

  async function gradeRun() {
    if (!selId) return;
    setGrading(true);
    setActionErr(null);
    try {
      await gradeRunMutate({ runId: selId });
    } catch (e) {
      setActionErr(String(e));
    } finally {
      setGrading(false);
    }
  }

  // Download the 3rd-party export bundle (P-013) — predictions.json + README.md.
  async function exportRun() {
    if (!selId) return;
    setActionErr(null);
    try {
      const res = await fetch(`/api/external-bench/runs/${encodeURIComponent(selId)}/export`);
      const bundle = (await res.json()) as { ok?: boolean; error?: string; predictions?: unknown; readme?: string };
      if (!res.ok || bundle.ok === false) {
        setActionErr(bundle.error || `export failed (${res.status})`);
        return;
      }
      downloadFile(`${selId}-predictions.json`, JSON.stringify(bundle.predictions ?? [], null, 2), 'application/json');
      if (bundle.readme) downloadFile(`${selId}-README.md`, bundle.readme, 'text/markdown');
    } catch (e) {
      setActionErr(String(e));
    }
  }

  // Delete a run (P-014). Snapshot stays on disk (re-importable).
  async function deleteRun() {
    if (!selId) return;
    setActionErr(null);
    try {
      await deleteRunMutate({ runId: selId });
      await setSelId(null);
    } catch (e) {
      setActionErr(String(e));
    }
  }

  // Re-run with the same config (P-014) — pre-fill the launch form + switch to it.
  async function rerunRun() {
    if (!detail) return;
    if (detail.arm) await setLaunchArm(detail.arm);
    if (detail.taskSetId) await setLaunchTaskSet(detail.taskSetId);
    if (detail.config?.cap != null) await setLaunchCap(String(detail.config.cap));
    await setEvalView('launch');
  }

  if (loading) return <p className="pc-evals__empty">Loading runs…</p>;
  if (listErr) {
    return (
      <EmptyCard icon={<Archive size={20} aria-hidden />} title="Couldn’t load preserved runs" body={listErr} />
    );
  }
  if (runs.length === 0) {
    return (
      <EmptyCard
        icon={<Archive size={20} aria-hidden />}
        title="No preserved runs yet"
        body="Preserved benchmark snapshots (the arm-run JSON + the official grader’s per-instance verdicts) live under ~/.papercusp/bench-results/<id>/. When a real pass is preserved for reproducibility, it appears here with the merged per-task resolved/cost table and the throughput + coordination views."
      />
    );
  }

  // Per-task rows mapped to the Compare table: treatment = the resolved score
  // (1/0), baseline left null (a single preserved arm has no control arm yet —
  // an honest caveat shown below). Compare renders the per-task table + bars.
  const perTaskRows: ComparePerTaskRow[] = (detail?.perTask ?? []).map((t) => ({
    label: shortInstance(t.instanceId),
    baseline: null,
    treatment: t.resolved == null ? null : t.resolved ? 1 : 0,
  }));

  // Throughput from the single arm (speedup derived from wall-clock at render).
  const tputArms: ThroughputArm[] = detail
    ? [{
        arm: detail.summary.arm,
        tasksPerHour: detail.summary.wallMs > 0 ? (detail.summary.taskCount / (detail.summary.wallMs / 3_600_000)) : 0,
        costPerTask: detail.summary.taskCount > 0 ? detail.summary.costUsd / detail.summary.taskCount : 0,
        wallClockMs: detail.summary.wallMs,
        speedupVsSerial: null,
      }]
    : [];

  // MAST from the objective substrate-signal rates over the coordEvents trace.
  const mastArms: MastArmRates[] = detail
    ? [{
        arm: detail.summary.arm,
        duplication: detail.coordRates.duplicationRate,
        coordinationBreakdown: detail.coordRates.coordinationBreakdownRate,
        misalignment: detail.coordRates.misalignmentRate,
        redundant: detail.coordRates.redundantWorkRate,
      }]
    : [];

  // Validity signals (P-009 / D-003) — computed from the run metadata + live fleet.
  const validitySignals: ValiditySignal[] = detail
    ? computeValiditySignals({
        taskCount: detail.summary.taskCount,
        nonEmptyDiffs: detail.summary.nonEmptyDiffs,
        capValue: detail.config?.cap ?? null,
        recovered: detail.summary.recovered,
        seedCount: 1,
        live: live
          ? ({
              queenAlive: live.queen.alive,
              queenAgeSec: live.queen.ageSec,
              queenReclaims: live.queen.reclaims,
              nonOpusSamples: live.models.nonOpusSamples,
              totalSamples: live.models.totalSamples,
            } satisfies ValidityLiveFleet)
          : null,
      })
    : [];
  const runValid = isRunValid(validitySignals);

  const s = detail?.summary;
  return (
    <section className="pc-evals__section">
      <div className="pc-preserved__toolbar">
        {armOptions.length > 1 ? (
          <label className="pc-evals__suitepick">
            <span className="pc-evals__suitelabel">arm</span>
            <Select
              ariaLabel="Filter runs by arm"
              value={armFilter || ''}
              onChange={(v: string) => void setArmFilter(v || null)}
              options={[{ value: '', label: 'All arms' }, ...armOptions.map((a) => ({ value: a, label: armLabel(a) }))]}
            />
          </label>
        ) : null}
        <label className="pc-evals__suitepick">
          <Archive size={12} aria-hidden />
          <span className="pc-evals__suitelabel">run</span>
          <Select
            ariaLabel="Preserved run"
            value={selId || ''}
            onChange={(v: string) => void setSelId(v)}
            triggerStyle={{ maxWidth: 300 }}
            options={filteredRuns.map((r) => ({
              value: r.id,
              label: `${r.id} · ${armLabel(r.arm)} · ${r.resolvedPct != null ? Math.round(r.resolvedPct * 100) + '%' : '—'} · ${r.status}`,
            }))}
          />
        </label>
      </div>
      {actionErr ? <div className="pc-evals__caveat" role="alert">{actionErr}</div> : null}

      {detailErr ? (
        <EmptyCard icon={<Archive size={20} aria-hidden />} title="Couldn’t load this run" body={detailErr} />
      ) : !s ? (
        <p className="pc-evals__empty">Loading the run…</p>
      ) : (
        <>
          <div className="pc-preserved__detailhead">
            <div className="pc-preserved__identity">
              <span className="pc-evals__suitelabel">selected run</span>
              <h2>{selId}</h2>
              <div className="pc-preserved__meta" aria-label="Selected run metadata">
                <span>{armLabel(s.arm)}</span>
                <span>{detail.taskSetId || 'task set unknown'}</span>
                <span>{selRun?.source || detail.source || 'store'}</span>
                <span>{fmtShortDate(selRun?.createdAt || detail.run.startedAt)}</span>
              </div>
            </div>
            <div className="pc-preserved__detailright">
              <RunStatusPill status={detail.status || selRun?.status} />
              <div className="pc-preserved__actions">
                <button type="button" className="pc-preserved__action" onClick={() => void gradeRun()} disabled={grading || detail?.status === 'grading'} aria-label="Grade this run with the official grader">
                  <CheckCircle2 size={13} aria-hidden />
                  {detail?.status === 'grading' || grading ? 'Grading…' : 'Grade'}
                </button>
                <button type="button" className="pc-preserved__action" onClick={() => void exportRun()} aria-label="Export this run for third-party reproduction">
                  <Download size={13} aria-hidden />
                  Export
                </button>
                <button type="button" className="pc-preserved__action" onClick={() => void rerunRun()} aria-label="Re-run with the same config">
                  <RotateCcw size={13} aria-hidden />
                  Re-run
                </button>
                <button type="button" className="pc-preserved__action pc-preserved__action--danger" onClick={() => void deleteRun()} aria-label="Delete this run">
                  <Trash2 size={13} aria-hidden />
                  Delete
                </button>
              </div>
            </div>
          </div>

          {/* Validity badges (P-009 / D-003) — the integrity guarantee, surfaced. */}
          <ValidityBadges signals={validitySignals} />
          {!runValid ? (
            <div className="pc-evals__caveat" role="status" style={{ marginBottom: 10 }}>
              ⚠ This run fails a validity check (a red badge above) — the number is shown for transparency but must
              not be treated as a clean result, and the Compare view will refuse to render it as a valid delta.
            </div>
          ) : null}

          {/* Live fleet panel (P-007) while the run is in flight. */}
          {live?.isLive ? <LiveFleetPanel live={live} /> : null}

          {/* Honest caveats (impartial-benchmark-suite D-027): this is a single
              preserved arm, not strictly opus, empty diffs counted as unresolved,
              no valid no-Queen control yet, and an 11-task subset. */}
          <div className="pc-evals__note" role="note">
            <strong>Real graded run · {armLabel(s.arm)}</strong>
            <span>
              Officially graded snapshot. Caveats: ~92% opus (not strictly opus); empty diffs (no patch) score as
              unresolved; no valid no-Mug control arm yet (single treatment arm, so the per-task table has no
              baseline column); {s.taskCount}-task subset, not the full set.
              {s.recovered ? ' This snapshot was reconstructed from recovered fleet state (no preserved wall-clock).' : ''}
            </span>
          </div>

          <div className="pc-evals__scoreboard" aria-label={`${s.arm} — preserved run summary`}>
            <FleetStat
              arm={s.arm}
              value={s.resolvedPct == null ? '—' : `${Math.round(s.resolvedPct * 1000) / 10}%`}
              sub={`${s.resolvedCount}/${s.gradedCount} resolved`}
              hint={`Official-grader pass rate: ${s.resolvedCount} of ${s.gradedCount} graded tasks resolved.`}
            />
            <FleetStat arm={s.arm} value={fmtUsd(s.costUsd)} sub={`${s.taskCount} tasks`} hint="Total cost across the run." />
            <FleetStat arm={s.arm} value={`${s.nonEmptyDiffs}/${s.taskCount}`} sub="non-empty diffs" hint="Tasks where a real patch was produced." />
            <FleetStat arm={s.arm} value={fmtDurMs(s.wallMs)} sub={`${s.coordEventCount} coord events`} hint="Parallel backlog-drain wall-clock + coordination-trace volume." />
          </div>

          {/* Per-task resolved + cost/turns/diff table (the Compare viz; single
              arm so the baseline column is empty — see the caveat note). */}
          <div className="pc-evals__sectionhead"><h2>Per-task results</h2></div>
          <div className="pc-preserved__grid" data-testid="preserved-task-grid">
            <RichGrid<PreservedResolvedTask>
              columns={PRESERVED_TASK_COLUMNS}
              rows={detail!.perTask}
              getRowId={(row) => row.instanceId}
              rowMinHeight={32}
              inline
              empty={<span className="pc-evals__empty">No per-task rows.</span>}
            />
          </div>

          {/* Resolved-as-score per-task bars (Compare) — keeps the shared viz in
              the loop; treatment = resolved (1/0), no baseline arm. */}
          <div className="pc-evals__sectionhead"><h2>Per-task resolved <em>treatment only · no control arm</em></h2></div>
          <Compare
            baseline="control (none)"
            treatment={s.arm}
            perTask={perTaskRows}
            format={(n: number | null | undefined) => (n == null ? '—' : n ? '✓' : '✗')}
            summary={false}
            emptyHint="No per-task rows."
          />

          <div className="pc-evals__sectionhead"><h2>Throughput</h2></div>
          <ThroughputBars
            arms={tputArms}
            highlightArm={s.arm}
            caption="Single preserved arm — $/task + wall-clock (speedup needs a serial-floor control arm)."
            emptyHint="No throughput for this run."
          />

          <div className="pc-evals__sectionhead"><h2>Coordination <em>objective substrate signals · {s.coordEventCount} events</em></h2></div>
          <MastBreakdown
            arms={mastArms}
            baselineBand={MAS_BASELINE_BAND}
            caption="Objective coordination-failure rates counted from the run’s coordEvents trace (rework / stranded-item / conflicts), per task — no judge."
            emptyHint="No coordination events recorded for this run."
          />

          {/* Coordination timeline (P-008) — the Queen's orchestration, event by event. */}
          <CoordTimeline events={detail!.run.coordEvents ?? []} />
        </>
      )}
    </section>
  );
}

/** Trim the long SWE-bench instance id to a readable `org__repo` head. */
function shortInstance(id: string): string {
  const m = id.replace(/^instance_/, '').match(/^([^-]+__[^-]+)/);
  return m ? m[1] : id.replace(/^instance_/, '');
}
const fmtDurMs = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const h = ms / 3_600_000;
  if (h >= 1) return `${Math.round(h * 10) / 10}h`;
  const m = ms / 60_000;
  if (m >= 1) return `${Math.round(m)}m`;
  return `${Math.round(ms / 1000)}s`;
};

// ── Small shared pieces ──────────────────────────────────────────────────────

function ArmStat({
  arm,
  value,
  sub,
  hint,
}: {
  arm: ArmId;
  value: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <div className="pc-evals__stat" aria-label={hint} style={{ ['--arm-accent' as string]: ARM_COLOR[arm] }}>
      <span className="pc-evals__statlabel">
        <span className="pc-evals__statdot" aria-hidden />
        {ARM_LABEL[arm]}
      </span>
      <span className="pc-evals__statvalue">{value}</span>
      {sub ? <span className="pc-evals__statsub">{sub}</span> : null}
    </div>
  );
}

function EmptyCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="pc-evals__empty pc-evals__empty--card">
      {icon}
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

// ── Scoped styles (shared app tokens — matches AdvShell / LearningTab) ────────

function EvalsStyles() {
  return (
    <style>{`
      .pc-evals { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 28px; min-height: 0; }
      .pc-evals__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
      .pc-evals__copy { min-width: 0; max-width: 760px; display: grid; gap: 6px; }
      .pc-evals__copy h1 { display: inline-flex; align-items: center; gap: 8px; margin: 0; font-size: 20px; font-weight: 760; letter-spacing: 0; color: var(--fg, #e7f7ff); }
      .pc-evals__copy p { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--fg-dim, #b9d4e8); }
      .pc-evals__copy em { font-style: italic; color: var(--fg, #e7f7ff); }
      .pc-evals__link { color: var(--accent); text-decoration: none; }
      .pc-evals__link:hover { text-decoration: underline; }

      .pc-evals__legend { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; flex-shrink: 0; }
      .pc-evals__legenditem { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); white-space: nowrap; cursor: default; }
      .pc-evals__legenddot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

      .pc-evals__controls { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-bottom: 1px solid var(--border, rgba(125,211,252,0.15)); padding-bottom: 10px; }
      .pc-evals__subnav { display: inline-flex; gap: 6px; flex-wrap: wrap; }
      .pc-evals__subtab { display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: 9px; border: 1px solid var(--border, rgba(125,211,252,0.18)); background: var(--bg-2, rgba(255,255,255,0.04)); color: var(--fg-mute, #7f9bb4); font-size: 12px; font-weight: 650; cursor: pointer; }
      .pc-evals__subtab em { display: block; font-style: normal; font-size: 9.5px; font-weight: 600; opacity: 0.72; margin-top: 1px; }
      .pc-evals__subtab:hover { color: var(--fg, #e7f7ff); }
      .pc-evals__subtab.is-active { color: var(--fg, #e7f7ff); border-color: color-mix(in oklab, var(--warn), transparent 30%); background: color-mix(in oklab, var(--warn), transparent 86%); }
      .pc-evals__controlsright { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .pc-evals__suitepick { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-mute, #7f9bb4); }
      .pc-evals__suitelabel { font-size: 10px; font-weight: 760; letter-spacing: 0; text-transform: uppercase; }
      .pc-evals__refresh { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--border, rgba(125,211,252,0.2)); background: var(--bg-2, rgba(255,255,255,0.04)); color: var(--fg-dim, #b9d4e8); cursor: pointer; }
      .pc-evals__refresh:disabled { opacity: 0.5; cursor: default; }

      .pc-evals__section { display: flex; flex-direction: column; gap: 14px; }
      .pc-evals__lede { margin: 0; max-width: 760px; font-size: 12.5px; line-height: 1.55; color: var(--fg-dim, #b9d4e8); }
      .pc-evals__caveat { padding: 10px 12px; border-radius: 8px; border: 1px solid color-mix(in oklab, #fbbf24, transparent 50%); background: color-mix(in oklab, #fbbf24, transparent 91%); color: var(--fg-dim, #b9d4e8); font-size: 12px; line-height: 1.5; }
      .pc-evals__caveat code { color: var(--fg, #e7f7ff); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .pc-evals__confirm { display: flex; align-items: flex-start; gap: 8px; color: var(--fg-dim, #b9d4e8); font-size: 12px; line-height: 1.45; }
      .pc-evals__confirm strong { color: var(--fg, #e7f7ff); }
      .pc-evals__sectionhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .pc-evals__sectionhead h2 { margin: 0; font-size: 14px; font-weight: 700; color: var(--fg, #e7f7ff); display: inline-flex; align-items: baseline; gap: 8px; }
      .pc-evals__sectionhead em { font-style: italic; font-size: 11px; font-weight: 600; color: var(--fg-mute, #7f9bb4); }

      .pc-launch__layout { display: grid; grid-template-columns: minmax(280px, 1.1fr) minmax(260px, 0.9fr); gap: 12px; align-items: start; }
      .pc-launch__panel { display: grid; gap: 12px; min-width: 0; padding: 12px; border: 1px solid var(--border, rgba(125,211,252,0.18)); border-radius: 8px; background: var(--bg-2, rgba(255,255,255,0.04)); }
      .pc-launch__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; align-items: center; }
      .pc-launch__wide { grid-column: 1 / -1; align-items: flex-start; }
      .pc-launch__model { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; color: var(--fg-mute, #7f9bb4); }
      .pc-launch__model strong { color: var(--fg, #e7f7ff); font-size: 13px; }
      .pc-launch__model span:last-child { font-size: 11px; color: var(--fg-mute, #7f9bb4); }
      .pc-launch__estimate { grid-template-columns: 1fr; }
      .pc-launch__primary { justify-self: start; display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 34px; padding: 8px 18px; border: 1px solid var(--border, rgba(125,211,252,0.2)); border-radius: 7px; background: var(--accent, #eab308); color: #1a1a1a; font-size: 13px; font-weight: 680; cursor: pointer; }
      .pc-launch__primary:disabled { background: var(--bg-2, rgba(255,255,255,0.04)); color: var(--fg-mute, #7f9bb4); cursor: not-allowed; }

      .pc-evals__scoreboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
      .pc-evals__stat { display: grid; gap: 4px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border, rgba(125,211,252,0.18)); background: var(--bg-2, rgba(255,255,255,0.04)); border-left: 3px solid var(--arm-accent, var(--accent, #38bdf8)); }
      .pc-evals__statlabel { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 650; color: var(--fg-mute, #7f9bb4); }
      .pc-evals__statdot { width: 7px; height: 7px; border-radius: 50%; background: var(--arm-accent, var(--accent, #38bdf8)); flex-shrink: 0; }
      .pc-evals__statvalue { font-size: 22px; font-weight: 760; color: var(--fg, #e7f7ff); line-height: 1; }
      .pc-evals__statsub { font-size: 10.5px; color: var(--fg-mute, #7f9bb4); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

      .pc-evals__compareblock { display: grid; gap: 6px; }
      .pc-evals__h3 { margin: 6px 0 0; font-size: 12.5px; font-weight: 700; color: var(--fg, #e7f7ff); }

      .pc-evals__note { display: grid; gap: 4px; padding: 10px 12px; border-radius: 10px; border: 1px solid color-mix(in oklab, #eab308, transparent 60%); background: color-mix(in oklab, #eab308, transparent 90%); font-size: 12px; line-height: 1.5; color: var(--fg-dim, #b9d4e8); }
      .pc-evals__note strong { color: var(--fg, #e7f7ff); font-size: 12.5px; }

      .pc-runstatus { display: inline-flex; align-items: center; justify-content: center; min-height: 24px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--border, rgba(125,211,252,0.18)); background: var(--bg-2, rgba(255,255,255,0.04)); color: var(--fg-dim, #b9d4e8); font-size: 11px; font-weight: 720; text-transform: capitalize; white-space: nowrap; }
      .pc-runstatus--good { border-color: color-mix(in oklab, #34d399, transparent 40%); color: #34d399; background: color-mix(in oklab, #34d399, transparent 90%); }
      .pc-runstatus--info { border-color: color-mix(in oklab, var(--accent, #38bdf8), transparent 40%); color: var(--accent-strong, var(--accent)); background: color-mix(in oklab, var(--accent, #38bdf8), transparent 90%); }
      .pc-runstatus--warn { border-color: color-mix(in oklab, #fbbf24, transparent 35%); color: #fbbf24; background: color-mix(in oklab, #fbbf24, transparent 90%); }
      .pc-runstatus--bad { border-color: color-mix(in oklab, #fb7185, transparent 35%); color: #fb7185; background: color-mix(in oklab, #fb7185, transparent 91%); }

      .pc-preserved__toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
      .pc-preserved__detailhead { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 12px; border: 1px solid var(--border, rgba(125,211,252,0.18)); border-radius: 8px; background: color-mix(in oklab, var(--bg-2, #0f172a), transparent 20%); }
      .pc-preserved__identity { min-width: 0; display: grid; gap: 5px; }
      .pc-preserved__identity h2 { margin: 0; min-width: 0; overflow-wrap: anywhere; color: var(--fg, #e7f7ff); font-size: 16px; font-weight: 760; letter-spacing: 0; }
      .pc-preserved__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--fg-mute, #7f9bb4); font-size: 11.5px; }
      .pc-preserved__meta span { display: inline-flex; align-items: center; min-height: 20px; padding: 2px 7px; border-radius: 999px; background: var(--bg-2, rgba(255,255,255,0.04)); border: 1px solid var(--border, rgba(125,211,252,0.14)); }
      .pc-preserved__detailright { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
      .pc-preserved__actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
      .pc-preserved__action { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 30px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--border, rgba(125,211,252,0.2)); background: var(--bg-2, rgba(255,255,255,0.04)); color: var(--fg-dim, #b9d4e8); font-size: 12px; font-weight: 650; cursor: pointer; }
      .pc-preserved__action:disabled { opacity: 0.56; cursor: not-allowed; }
      .pc-preserved__action--danger { border-color: color-mix(in oklab, #fb7185, transparent 35%); color: #fb7185; background: color-mix(in oklab, #fb7185, transparent 94%); }
      .pc-preserved__grid { min-width: 0; overflow-x: auto; border: 1px solid var(--border, rgba(125,211,252,0.18)); border-radius: 8px; background: var(--bg-2, rgba(255,255,255,0.04)); }
      .pc-preserved__num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .pc-preserved__task { display: block; min-width: 0; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pc-preserved__stop { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-mute, #7f9bb4); }
      .pc-preserved__ok { color: var(--good, #34d399); font-weight: 700; }
      .pc-preserved__bad { color: var(--bad, #fb7185); font-weight: 700; }

      .pc-evals__empty { font-size: 12px; color: var(--fg-mute, #7f9bb4); margin: 0; text-align: center; }
      .pc-evals__empty--card { display: grid; justify-items: center; gap: 8px; max-width: 560px; margin: 8px auto; padding: 22px; color: var(--fg-mute, #7f9bb4); }
      .pc-evals__empty--card strong { font-size: 14px; color: var(--fg, #e7f7ff); }
      .pc-evals__empty--card span { font-size: 12px; line-height: 1.55; }

      @media (max-width: 820px) {
        .pc-launch__layout { grid-template-columns: 1fr; }
        .pc-launch__fields { grid-template-columns: 1fr; }
        .pc-preserved__detailhead { grid-template-columns: 1fr; }
        .pc-preserved__detailright { align-items: flex-start; }
        .pc-preserved__actions { justify-content: flex-start; }
      }
    `}</style>
  );
}
