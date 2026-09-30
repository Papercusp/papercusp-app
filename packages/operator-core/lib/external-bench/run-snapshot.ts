/**
 * File-dir snapshot writer (benchmark-evaluation-ui-2026-06-16 P-010 / P-013).
 *
 * A UI-launched run persists its live state to PG (the operational store), but the
 * OFFICIAL grader (_xbench_grade.py) and the 3rd-party export read the on-disk
 * snapshot format the CLI launcher produces: ~/.papercusp/bench-results/<runId>/
 * with <arm>.json (the PreservedArmRun) + diffs-<arm>/<instance>.diff +
 * tasks-sample.jsonl. This module writes that snapshot from a completed
 * HiveBacklogResult so a UI run is gradeable + reproducible exactly like a CLI run.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HiveBacklogResult } from './hive-backlog';
import { defaultBenchResultsDir, type PreservedArmRun, type PreservedPerTask } from './preserved-runs';
import { writeTaskSampleJsonl } from './task-sets';

export interface WriteSnapshotInput {
  runId: string;
  arm: string;
  result: HiveBacklogResult;
  /** ms-epoch start (for the ISO startedAt + wall). */
  startedAtMs: number;
  /** The task set + ids, to write the grader's sample jsonl. */
  taskSetId: string;
  taskIds?: string[];
  /** Override the base dir (tests). */
  baseDir?: string;
}

/** Write the on-disk snapshot a UI run needs to be graded + exported. Returns the dir. */
export function writeRunSnapshot(input: WriteSnapshotInput): string {
  const baseDir = input.baseDir ?? defaultBenchResultsDir();
  const dir = join(baseDir, input.runId);
  const diffsDir = join(dir, `diffs-${input.arm}`);
  mkdirSync(diffsDir, { recursive: true });

  const perTask: PreservedPerTask[] = input.result.taskResults.map((tr) => {
    const a = tr.attempt;
    const diff = a.diff ?? '';
    writeFileSync(join(diffsDir, `${a.instanceId}.diff`), diff, 'utf8');
    return {
      instanceId: a.instanceId,
      cupId: tr.cupId,
      disposition: tr.disposition,
      stopReason: a.stopReason,
      generationError: a.generationError ?? null,
      tokensIn: a.tokensIn,
      tokensOut: a.tokensOut,
      costUsd: a.costUsd,
      turns: a.turns,
      wallClockMs: a.wallClockMs,
      diffBytes: Buffer.byteLength(diff, 'utf8'),
      armMeta: a.armMeta ?? undefined,
    };
  });

  const nonEmptyDiffs = perTask.filter((t) => (t.diffBytes ?? 0) > 0).length;
  const snapshot: PreservedArmRun = {
    arm: input.arm,
    runId: input.runId,
    runError: input.result.runError ?? null,
    startedAt: new Date(input.startedAtMs).toISOString(),
    wallMs: Math.max(0, input.result.finishedAtMs - input.result.startedAtMs),
    peakConcurrentBees: input.result.peakConcurrentBees,
    taskCount: perTask.length,
    nonEmptyDiffs,
    totals: {
      costUsd: perTask.reduce((s, t) => s + (t.costUsd ?? 0), 0),
      tokensIn: perTask.reduce((s, t) => s + (t.tokensIn ?? 0), 0),
      tokensOut: perTask.reduce((s, t) => s + (t.tokensOut ?? 0), 0),
    },
    perTask,
    coordEvents: input.result.coordEvents ?? [],
    recovered: false,
  };
  writeFileSync(join(dir, `${input.arm}.json`), JSON.stringify(snapshot, null, 2), 'utf8');

  // The grader's --raw_sample_path (full task metadata: image_name, fail_to_pass, …).
  try {
    writeTaskSampleJsonl(input.taskSetId, input.taskIds, join(dir, 'tasks-sample.jsonl'));
  } catch {
    /* full-set sample not provisioned — grading that set isn't wired anyway */
  }
  return dir;
}
