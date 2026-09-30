/**
 * Desktop-perf per-run persistence + trend (desktop-performance-suite-2026-07-20 P-010).
 *
 * The `desktop-performance` admin suite (and the packaged-binary wdio runner)
 * produce structured per-metric measures on each run. This module PERSISTS one
 * row per run in Postgres (harness_shared.desktop_perf_runs, migration 643) and
 * reads the last-N rows back with per-measure deltas — the substrate for the
 * admin testing trend panel and the flag-gated release gate (P-011).
 *
 * The pure parts (types, `extractDesktopPerfMeasures`, `summarizeMeasureStatus`,
 * `computeDesktopPerfTrend`) carry NO IO and are unit-tested without a DB. The
 * DB functions mirror dock-layouts.ts: a lazily-created postgres-js pool over
 * getHarnessAdminUrl(), sql.json() for the jsonb body.
 */

// `postgres` stays imported for the JSONValueCompat type below (the value-side pool now
// comes from getLongLivedAdminPool) — same retained-type-only import as llm-testing/storage.ts.
import postgres from 'postgres';
import { sharedUtilityPoolMax } from '../resource-profile';
import { getLongLivedAdminPool } from '../long-lived-admin-pool';
import type {
  AdminTestCheckResult,
  AdminTestStatus,
  DesktopPerfMeasure,
  DesktopPerfMetricUnit,
  DesktopPerfSource,
  DesktopPerfRunStatus,
  DesktopPerfMeasureDelta,
  DesktopPerfTrendPoint,
} from '../admin-test-suites-shared';

export type {
  DesktopPerfMeasure,
  DesktopPerfMetricUnit,
  DesktopPerfSource,
  DesktopPerfRunStatus,
  DesktopPerfMeasureDelta,
  DesktopPerfTrendPoint,
} from '../admin-test-suites-shared';

// ───────── Types (pure) ─────────

/** One persisted desktop-perf run row (persistence shape; adds workspaceId). */
export interface DesktopPerfRun {
  id: string;
  workspaceId: string;
  createdTs: number;
  source: DesktopPerfSource;
  status: DesktopPerfRunStatus;
  gitSha: string | null;
  /**
   * Source identity of the packaged binary this run MEASURED, read from the build's
   * own identity record — not the checkout HEAD (that is `gitSha`). Null when the
   * build recorded none; the gate then falls back to the file-mtime rule
   * (desktop-perf-measure-candidate-build-2026-09-29 D-001).
   */
  buildSha: string | null;
  runId: string | null;
  measures: DesktopPerfMeasure[];
}

// ───────── Pure helpers ─────────

const UNIT_BY_STATUS_FALLBACK: DesktopPerfMetricUnit = 'ms';

/**
 * Extract the structured measures carried on a set of desktop-performance check
 * results. Checks attach `measures` (admin-test-suites `statusResult`); a check
 * with none (e.g. a hard failure before a measurement) contributes nothing.
 */
export function extractDesktopPerfMeasures(results: AdminTestCheckResult[]): DesktopPerfMeasure[] {
  const out: DesktopPerfMeasure[] = [];
  for (const r of results) {
    if (!r.measures) continue;
    for (const m of r.measures) {
      out.push({
        key: m.key,
        value: Number(m.value) || 0,
        unit: m.unit ?? UNIT_BY_STATUS_FALLBACK,
        budget: m.budget ?? null,
        ok: m.ok !== false,
        // P-003c: this rebuilds rather than spreads, so the invariant flag has to
        // be named explicitly or an in-app suite's invariant would reach the gate
        // stripped down to an ordinary measure. Only a literal true arms it.
        ...(m.invariant === true ? { invariant: true as const } : {}),
      });
    }
  }
  return out;
}

/** Worst status across a run's measures: any budgeted breach — or any breached
 *  INVARIANT, budgeted or not (P-003c) — = 'fail', else 'pass'.
 *  (The suite's own pass/warn/fail rollup lives on the run status the caller passes;
 *  this is the measure-only fallback used when the caller has no suite verdict.)
 *
 *  The invariant clause is not redundant with the budget clause: an invariant need
 *  not carry a numeric budget, and one recorded without a budget would otherwise
 *  roll a breached run up as 'pass' — leaving the run status contradicting the gate
 *  decision derived from the very same measures. */
export function summarizeMeasureStatus(measures: DesktopPerfMeasure[]): DesktopPerfRunStatus {
  return measures.some((m) => !m.ok && (m.budget !== null || m.invariant === true)) ? 'fail' : 'pass';
}

/** Collapse an AdminTestStatus to the persisted run status (skip → pass). */
export function toRunStatus(status: AdminTestStatus): DesktopPerfRunStatus {
  if (status === 'fail') return 'fail';
  if (status === 'warn') return 'warn';
  return 'pass';
}

/**
 * Enrich runs (ordered NEWEST-FIRST) with each measure's delta vs the nearest
 * OLDER run that carries the same measure key. Pure — the trend panel and the
 * release gate share it.
 */
export function computeDesktopPerfTrend(runsNewestFirst: DesktopPerfRun[]): DesktopPerfTrendPoint[] {
  return runsNewestFirst.map((run, idx) => {
    // Search runs strictly older than this one (later in the newest-first array).
    const older = runsNewestFirst.slice(idx + 1);
    const measures: DesktopPerfMeasureDelta[] = run.measures.map((m) => {
      let prevValue: number | null = null;
      for (const prevRun of older) {
        const hit = prevRun.measures.find((pm) => pm.key === m.key);
        if (hit) { prevValue = hit.value; break; }
      }
      const deltaValue = prevValue === null ? null : m.value - prevValue;
      const deltaPct = prevValue === null || prevValue === 0 ? null : deltaValue! / prevValue;
      return { ...m, prevValue, deltaValue, deltaPct };
    });
    return {
      id: run.id,
      createdTs: run.createdTs,
      source: run.source,
      status: run.status,
      gitSha: run.gitSha,
      runId: run.runId,
      measures,
    };
  });
}

// ───────── DB plumbing (mirrors dock-layouts.ts) ─────────

/** The exact value type postgres-js `sql.json()` accepts (llm-testing/storage.ts pattern). */
type JSONValueCompat = Parameters<ReturnType<typeof postgres>['json']>[0];

// Transactional pool — re-resolves the admin URL on every use and rebinds if the endpoint
// moved (EI-19306394439939264). Shared connection options + idle policy come with it.
const db = () =>
  getLongLivedAdminPool('desktop-perf-runs', { max: sharedUtilityPoolMax(), prepare: false });

function nextPerfRunId(): string {
  return `perfrun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface RecordDesktopPerfRunInput {
  workspaceId: string;
  source: DesktopPerfSource;
  status: DesktopPerfRunStatus;
  measures: DesktopPerfMeasure[];
  gitSha?: string | null;
  /** Identity of the measured build (see DesktopPerfRun.buildSha). Absent = unknown. */
  buildSha?: string | null;
  runId?: string | null;
  createdTs?: number;
}

/** Persist one desktop-perf run. Returns the generated row id. */
export async function recordDesktopPerfRun(input: RecordDesktopPerfRunInput): Promise<string> {
  const sql = db();
  const id = nextPerfRunId();
  const createdTs = input.createdTs ?? Date.now();
  await sql`
    INSERT INTO harness_shared.desktop_perf_runs
      (id, workspace_id, created_ts, source, status, git_sha, build_sha, run_id, measures)
    VALUES
      (${id}, ${input.workspaceId}, ${createdTs}, ${input.source}, ${input.status},
       ${input.gitSha ?? null}, ${input.buildSha ?? null}, ${input.runId ?? null},
       ${sql.json(input.measures as unknown as JSONValueCompat)})
  `;
  return id;
}

/** Read the last-N desktop-perf runs for a workspace, newest first. */
export async function readDesktopPerfRuns(
  workspaceId: string,
  limit = 20,
): Promise<DesktopPerfRun[]> {
  const sql = db();
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = await sql<
    Array<{
      id: string;
      workspace_id: string;
      created_ts: bigint;
      source: string;
      status: string;
      git_sha: string | null;
      build_sha: string | null;
      run_id: string | null;
      measures: DesktopPerfMeasure[] | null;
    }>
  >`
    SELECT id, workspace_id, created_ts, source, status, git_sha, build_sha, run_id, measures
      FROM harness_shared.desktop_perf_runs
     WHERE workspace_id = ${workspaceId}
     ORDER BY created_ts DESC
     LIMIT ${capped}
  `;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    createdTs: Number(r.created_ts),
    source: (r.source === 'wdio' ? 'wdio' : 'admin-suite') as DesktopPerfSource,
    status: toRunStatus(r.status as AdminTestStatus),
    gitSha: r.git_sha,
    buildSha: r.build_sha,
    runId: r.run_id,
    measures: Array.isArray(r.measures) ? r.measures : [],
  }));
}

/** Read the last-N runs already enriched with per-measure deltas. */
export async function readDesktopPerfTrend(
  workspaceId: string,
  limit = 20,
): Promise<DesktopPerfTrendPoint[]> {
  const runs = await readDesktopPerfRuns(workspaceId, limit);
  return computeDesktopPerfTrend(runs);
}
