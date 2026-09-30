/**
 * PG-source report builder (plan benchmark-report-portable-trace-2026-06-17, P-001).
 *
 * Assembles a {@link BenchReportBundle} for a `runId` from the LIVE recorded data — the
 * `benchmark_run_result` rows (listRunResults → TaskRunResult), their Rollout Cards (getRollout →
 * the replay fingerprint), and the bench-run detail (getBenchRunDetail → coordination events +
 * per-task bee ids) — then reuses the pure {@link bundleFromRollouts} core. The result feeds
 * {@link buildReportHtml}/{@link writeReportHtml} → a portable `report-<runId>.html`.
 *
 * The store readers are INJECTED (default to the real `reproducibility/store` + `run-store`) so this
 * is unit-testable with fakes — NO PG. Every section degrades gracefully: if the rollout/detail reads
 * return nothing, the bundle still carries the scoreable rows + rollups (the viewer hides empty tabs).
 * The defineTool call-log (replay-grade audit) is NOT sourced here — it rides
 * [[route-everything-through-definetool-2026-06-17]]; pass it via `extraCallLog` when available.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BenchReportBundle, BenchReportCall, BenchReportCoordEvent, BenchReportSpawnNode } from './report-schema';
import { bundleFromRollouts, writeReportHtml } from './report-builder';

/** Structural shapes of the store reads we consume (kept loose so real types satisfy them). */
interface TaskRunResultRow {
  runId: string;
  suite: string;
  taskId: string;
  arm: string;
  seed: number;
  resolved: boolean | null;
  score?: number | null;
  graderStatus: string;
  generationStatus?: string;
  generationError?: string | null;
  rolloutId?: string;
  modelId?: string;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  costUsd: number;
  wallClockMs: number;
  turns?: number;
  failToPass?: Array<{ test: string; passed: boolean }> | null;
  passToPass?: Array<{ test: string; passed: boolean }> | null;
  createdAt?: string;
}
interface RolloutRow {
  rolloutId: string;
  taskId: string;
  arm: string;
  seed: number;
  modelId: string;
  modelVersion?: string | null;
  harnessVersion: string;
  harnessGitSha?: string | null;
  configSnapshot?: Record<string, unknown> | null;
  envFingerprint?: Record<string, unknown> | null;
  rawGraderOutput?: string | null;
  submission?: string | null;
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
  createdAt?: string;
}
interface RunDetail {
  coordEvents?: Array<{ ts?: number; kind?: string; agent?: string; taskId?: string | null; detail?: string }>;
  perTask?: Array<{ instanceId: string; cupId?: string; stopReason?: string; costUsd?: number }>;
}

export interface PgReportReaders {
  listRunResults: (opts: { runId: string }) => Promise<TaskRunResultRow[]>;
  getRollout: (rolloutId: string) => Promise<RolloutRow | null>;
  getBenchRunDetail?: (id: string) => Promise<RunDetail | null>;
}

/** Default readers — the real store functions (lazy-imported so a pure-fake test never loads PG). */
async function defaultReaders(scope: { workspace?: string } = {}): Promise<PgReportReaders> {
  const [store, runStore] = await Promise.all([import('../reproducibility/store'), import('../run-store')]);
  const ws = scope.workspace ? { workspace: scope.workspace } : {};
  return {
    listRunResults: (opts) => store.listRunResults({ ...opts, ...ws }) as unknown as Promise<TaskRunResultRow[]>,
    getRollout: (id) => store.getRollout(id, ws) as unknown as Promise<RolloutRow | null>,
    getBenchRunDetail: (id) => runStore.getBenchRunDetail(id, ws) as unknown as Promise<RunDetail | null>,
  };
}

function toCoordTrace(detail: RunDetail | null | undefined): BenchReportCoordEvent[] | undefined {
  if (!detail?.coordEvents?.length) return undefined;
  return detail.coordEvents.map((e) => ({
    ts: e.ts != null ? new Date(e.ts).toISOString() : '',
    kind: e.kind ?? 'event',
    from: e.agent,
    summary: e.detail,
    taskId: e.taskId ?? undefined,
  }));
}

function toSpawnTree(detail: RunDetail | null | undefined): BenchReportSpawnNode[] | undefined {
  if (!detail?.perTask?.length) return undefined;
  const nodes = detail.perTask
    .filter((t) => t.cupId)
    .map((t) => ({ spawnId: t.cupId as string, parentSpawnId: null, role: 'cup', taskId: t.instanceId, status: t.stopReason, costUsd: t.costUsd }));
  return nodes.length ? nodes : undefined;
}

/**
 * Build a report bundle for `runId` from the live store. Returns null if the run has no run_result
 * rows. `extraCallLog` lets a caller attach the defineTool call-log when the audit layer can supply it.
 */
export async function buildBundleFromPg(
  runId: string,
  opts: { workspace?: string; readers?: PgReportReaders; extraCallLog?: BenchReportCall[] } = {},
): Promise<BenchReportBundle | null> {
  const readers = opts.readers ?? (await defaultReaders({ workspace: opts.workspace }));
  const runResults = await readers.listRunResults({ runId });
  if (!runResults.length) return null;

  const rolloutIds = Array.from(new Set(runResults.map((r) => r.rolloutId).filter((x): x is string => !!x)));
  const rolloutList = (
    await Promise.all(rolloutIds.map((id) => readers.getRollout(id).catch(() => null)))
  ).filter((r): r is RolloutRow => !!r);

  const detail = readers.getBenchRunDetail ? await readers.getBenchRunDetail(runId).catch(() => null) : null;

  const arms = Array.from(new Set(runResults.map((r) => r.arm)));
  const models: Record<string, string> = {};
  for (const ro of rolloutList) if (!models[ro.arm]) models[ro.arm] = ro.modelId;
  for (const rr of runResults) if (!models[rr.arm] && rr.modelId) models[rr.arm] = rr.modelId;

  return bundleFromRollouts({
    runId,
    suite: runResults[0].suite,
    createdAt: rolloutList[0]?.createdAt ?? runResults[0].createdAt ?? new Date().toISOString(),
    arms,
    models,
    runResults: runResults.map((rr) => ({
      taskId: rr.taskId,
      arm: rr.arm,
      seed: rr.seed,
      resolved: rr.resolved,
      score: rr.score ?? null,
      graderStatus: rr.graderStatus,
      generationStatus: rr.generationStatus,
      generationError: rr.generationError ?? null,
      stopReason: rr.generationStatus,
      costUsd: rr.costUsd,
      tokensIn: rr.tokensIn,
      tokensOut: rr.tokensOut,
      tokensTotal: rr.tokensTotal,
      wallClockMs: rr.wallClockMs,
      turns: rr.turns,
      failToPass: rr.failToPass ?? null,
      passToPass: rr.passToPass ?? null,
    })),
    rollouts: rolloutList.map((ro) => ({
      rolloutId: ro.rolloutId,
      taskId: ro.taskId,
      arm: ro.arm,
      seed: ro.seed,
      modelId: ro.modelId,
      modelVersion: ro.modelVersion ?? null,
      harnessVersion: ro.harnessVersion,
      harnessGitSha: ro.harnessGitSha ?? null,
      configSnapshot: ro.configSnapshot ?? null,
      envFingerprint: ro.envFingerprint ?? null,
      rawGraderOutput: ro.rawGraderOutput ?? null,
      submission: ro.submission ?? null,
      trajectoryRef: ro.trajectoryRef ?? null,
      trajectoryKind: ro.trajectoryKind ?? null,
    })),
    coordTrace: toCoordTrace(detail),
    spawnTree: toSpawnTree(detail),
    callLog: opts.extraCallLog,
  });
}

/**
 * Build + write a portable `report-<runId>.html` for a completed run. Best-effort emit primitive:
 * returns the path written, or null if the run has no result rows (nothing to report — e.g. an id that
 * isn't a run_result.run_id). Default out dir: ~/.papercusp/bench-results/reports/.
 */
export async function emitReport(
  runId: string,
  opts: { workspace?: string; outDir?: string; readers?: PgReportReaders; extraCallLog?: BenchReportCall[] } = {},
): Promise<string | null> {
  const bundle = await buildBundleFromPg(runId, opts);
  if (!bundle) return null;
  const dir = opts.outDir ?? join(homedir(), '.papercusp', 'bench-results', 'reports');
  mkdirSync(dir, { recursive: true });
  return writeReportHtml(bundle, join(dir, `report-${runId}.html`));
}
