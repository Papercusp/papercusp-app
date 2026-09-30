/**
 * Benchmark report BUILDER (plan benchmark-report-portable-trace-2026-06-17).
 *
 * Two jobs:
 *   1. `buildReportHtml(bundle)` — inject a {@link BenchReportBundle} into the dependency-free
 *      `report-viewer.html` template as `window.__BENCH_REPORT__`, yielding ONE self-contained,
 *      double-clickable `report-<runId>.html` (no server, no network, works offline anywhere).
 *   2. `bundleFromRollouts(...)` — assemble the SHARED core of a bundle from the data the system
 *      already records (RolloutRecord[] + TaskRunResult[] + optional coord/spawn/call-log). Per-suite
 *      callers attach `suiteData` (AgentsNet graph, PaperBench rubric, TheAgentCompany checkpoints, …).
 *
 * This file maps existing records → the report projection; it does not collect new data. The call-log
 * (the replay-grade audit) is sourced from the defineTool audit layer as that lands — pass it in.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BENCH_REPORT_SCHEMA_VERSION,
  type BenchReportArmSummary,
  type BenchReportBundle,
  type BenchReportCall,
  type BenchReportCoordEvent,
  type BenchReportRollout,
  type BenchReportSpawnNode,
} from './report-schema';

/** Minimal shapes we read — kept structural so callers can pass RolloutRecord / TaskRunResult directly. */
interface RolloutLike {
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
  graderFamily?: string;
  graderVersion?: string;
  rawGraderOutput?: string | null;
  graderOutput?: unknown;
  submission?: string | null;
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
}
interface RunResultLike {
  taskId: string;
  arm: string;
  seed: number;
  resolved: boolean | null;
  score?: number | null;
  graderStatus: string;
  generationStatus?: string;
  generationError?: string | null;
  stopReason?: string;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
  wallClockMs: number;
  turns?: number;
  failToPass?: Array<{ test: string; passed: boolean }> | null;
  passToPass?: Array<{ test: string; passed: boolean }> | null;
}

function key(taskId: string, arm: string, seed: number): string {
  return `${arm}::${taskId}::${seed}`;
}

/** Is this a SCORED row (counted in resolved%/meanScore) vs an infra/transient exclusion? */
function isScored(rr: RunResultLike): boolean {
  const g = rr.generationStatus;
  if (g === 'error' || g === 'timeout') return false;
  if (rr.graderStatus === 'error' || rr.graderStatus === 'timeout') return false;
  return rr.resolved !== null;
}

/**
 * Assemble the shared core of a report bundle. Joins each TaskRunResult to its RolloutRecord (by
 * task×arm×seed) so a rollout row carries BOTH the score/cost AND the replay fingerprint
 * (config/version/sha/env/submission/grader-output/trajectory). Computes per-arm rollups.
 */
export function bundleFromRollouts(input: {
  runId: string;
  suite: string;
  label?: string;
  createdAt: string;
  arms: string[];
  models: Record<string, string>;
  prereg?: { hash: string; config?: Record<string, unknown>; gitCommitSha?: string | null };
  harnessGitSha?: string | null;
  envFingerprint?: Record<string, unknown> | null;
  runResults: RunResultLike[];
  rollouts?: RolloutLike[];
  coordTrace?: BenchReportCoordEvent[];
  spawnTree?: BenchReportSpawnNode[];
  callLog?: BenchReportCall[];
  concurrencyTimeline?: Record<string, Array<{ tMs: number; live: number }>>;
  suiteData?: Record<string, unknown>;
}): BenchReportBundle {
  const rolloutByKey = new Map<string, RolloutLike>();
  for (const r of input.rollouts ?? []) rolloutByKey.set(key(r.taskId, r.arm, r.seed), r);

  const rollouts: BenchReportRollout[] = input.runResults.map((rr) => {
    const ro = rolloutByKey.get(key(rr.taskId, rr.arm, rr.seed));
    return {
      rolloutId: ro?.rolloutId ?? key(rr.taskId, rr.arm, rr.seed),
      taskId: rr.taskId,
      arm: rr.arm,
      seed: rr.seed,
      resolved: rr.resolved,
      score: rr.score ?? null,
      graderStatus: rr.graderStatus,
      stopReason: rr.stopReason ?? rr.generationStatus ?? 'unknown',
      generationError: rr.generationError ?? null,
      costUsd: rr.costUsd,
      tokensIn: rr.tokensIn,
      tokensOut: rr.tokensOut,
      tokensTotal: rr.tokensTotal,
      wallMs: rr.wallClockMs,
      turns: rr.turns,
      modelId: ro?.modelId ?? input.models[rr.arm] ?? 'unknown',
      modelVersion: ro?.modelVersion ?? null,
      harnessVersion: ro?.harnessVersion ?? 'unknown',
      harnessGitSha: ro?.harnessGitSha ?? input.harnessGitSha ?? null,
      configSnapshot: ro?.configSnapshot ?? null,
      envFingerprint: ro?.envFingerprint ?? input.envFingerprint ?? null,
      submission: ro?.submission ?? null,
      rawGraderOutput: ro?.rawGraderOutput ?? null,
      failToPass: rr.failToPass ?? null,
      passToPass: rr.passToPass ?? null,
      trajectoryRef: ro?.trajectoryRef ?? null,
      trajectoryKind: ro?.trajectoryKind ?? null,
    };
  });

  // per-arm rollups
  const arms: BenchReportArmSummary[] = input.arms.map((arm) => {
    const rows = input.runResults.filter((r) => r.arm === arm);
    const scoredRows = rows.filter(isScored);
    const resolved = scoredRows.filter((r) => r.resolved === true).length;
    const scoresPresent = scoredRows.filter((r) => typeof r.score === 'number');
    const meanScore = scoresPresent.length
      ? scoresPresent.reduce((s, r) => s + (r.score as number), 0) / scoresPresent.length
      : null;
    return {
      arm,
      resolved,
      scored: scoredRows.length,
      meanScore,
      infraExcluded: rows.length - scoredRows.length,
      costUsd: rows.reduce((s, r) => s + (r.costUsd || 0), 0),
      tokensTotal: rows.reduce((s, r) => s + (r.tokensTotal || 0), 0),
      concurrency: summarizeConcurrency(input.concurrencyTimeline?.[arm]),
    };
  });

  const totals = {
    tasks: new Set(input.runResults.map((r) => r.taskId)).size,
    costUsd: input.runResults.reduce((s, r) => s + (r.costUsd || 0), 0),
    tokensIn: input.runResults.reduce((s, r) => s + (r.tokensIn || 0), 0),
    tokensOut: input.runResults.reduce((s, r) => s + (r.tokensOut || 0), 0),
    wallMs: input.runResults.reduce((m, r) => Math.max(m, r.wallClockMs || 0), 0),
  };

  return {
    schemaVersion: BENCH_REPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    run: {
      runId: input.runId,
      suite: input.suite,
      label: input.label,
      createdAt: input.createdAt,
      arms: input.arms,
      models: input.models,
      prereg: input.prereg,
      harnessGitSha: input.harnessGitSha ?? null,
      envFingerprint: input.envFingerprint ?? null,
      totals,
    },
    arms,
    rollouts,
    coordTrace: input.coordTrace,
    spawnTree: input.spawnTree,
    callLog: input.callLog,
    concurrencyTimeline: input.concurrencyTimeline,
    suite: input.suite,
    suiteData: input.suiteData,
  };
}

function summarizeConcurrency(
  samples: Array<{ tMs: number; live: number }> | undefined,
): { avg: number; peak: number } | undefined {
  if (!samples || !samples.length) return undefined;
  const peak = samples.reduce((m, s) => Math.max(m, s.live), 0);
  const avg = samples.reduce((s, x) => s + x.live, 0) / samples.length;
  return { avg, peak };
}

function viewerTemplatePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'report-viewer.html');
}

/**
 * Inject `bundle` into the dependency-free viewer template → a self-contained HTML string. The viewer
 * reads `window.__BENCH_REPORT__` first (report-viewer.html `loadBundle`), so we splice a script setting
 * it in just before the viewer's own `<script>`. JSON is `<`-escaped so it can't break out of the tag.
 */
export function buildReportHtml(bundle: BenchReportBundle, templatePath = viewerTemplatePath()): string {
  const template = readFileSync(templatePath, 'utf8');
  const json = JSON.stringify(bundle).replace(/</g, '\\u003c');
  const inject = `<script>window.__BENCH_REPORT__=${json};</script>\n<script>`;
  const marker = '<script>\n"use strict";';
  if (template.includes(marker)) return template.replace(marker, inject + '\n"use strict";');
  // Fallback: inject before the first <script> tag.
  return template.replace('<script>', inject);
}

/** Write a portable `report-<runId>.html` for `bundle`. Returns the path written. */
export function writeReportHtml(bundle: BenchReportBundle, outPath: string): string {
  writeFileSync(outPath, buildReportHtml(bundle), 'utf8');
  return outPath;
}
