/**
 * Trace collector (P-002).
 *
 * After a hermetic run, assemble its RawTrace — the per-role transcripts (from
 * harness_run_output) + the produced diff (git diff <base-commit> HEAD in the clone)
 * + terminal state + deterministic signals — and store it as a trace-bundle FILE
 * (high-volume-log exception, D-017), returning a ref for gym_runs.trace_ref. The
 * RawTrace then feeds distillTrace → the judge.
 *
 * Pure cores (buildDiffCommand, assembleRawTrace) + a DI orchestration; the PG read,
 * git exec, and bundle write are injected effects.
 */
import { isPinnedCommit } from './clone';
import type { RawTrace } from './distill';

export interface RunOutputRow {
  runId: string;
  role: string;
  /** The role's final assistant output (harness_run_output.out_body). */
  outBody: string;
}

/** `git -C <clonePath> diff <baseCommit> HEAD` — the produced work. */
export function buildDiffCommand(clonePath: string, baseCommit: string): { argv: string[] } {
  if (!isPinnedCommit(baseCommit)) {
    throw new Error(`collector base commit must be a pinned hex SHA, got: ${JSON.stringify(baseCommit)}`);
  }
  return { argv: ['git', '-C', clonePath, 'diff', baseCommit, 'HEAD'] };
}

export function assembleRawTrace(input: {
  diff: string;
  runOutputs: readonly RunOutputRow[];
  terminalState: string;
  signals?: Record<string, unknown>;
}): RawTrace {
  return {
    diff: input.diff,
    roleTranscripts: input.runOutputs.map((r) => ({ role: r.role, runId: r.runId, text: r.outBody })),
    terminalState: input.terminalState,
    ...(input.signals ? { signals: input.signals } : {}),
  };
}

export interface CollectDeps {
  /** Read per-role final outputs for the run's harness (harness_run_output). */
  readRunOutputs(harnessSlug: string): Promise<RunOutputRow[]>;
  /** Run the diff command and return the diff text. */
  gitDiff(clonePath: string, baseCommit: string): Promise<string>;
  /** Persist the trace bundle as a file; return a ref (path) for gym_runs.trace_ref. */
  writeBundle(traceText: string): Promise<string>;
}

export interface CollectInput {
  harnessSlug: string;
  clonePath: string;
  baseCommit: string;
  terminalState: string;
  signals?: Record<string, unknown>;
}

export async function collectTrace(
  input: CollectInput,
  deps: CollectDeps,
): Promise<{ rawTrace: RawTrace; traceRef: string }> {
  const runOutputs = await deps.readRunOutputs(input.harnessSlug);
  const diff = await deps.gitDiff(input.clonePath, input.baseCommit);
  const rawTrace = assembleRawTrace({ diff, runOutputs, terminalState: input.terminalState, signals: input.signals });
  const traceRef = await deps.writeBundle(JSON.stringify(rawTrace));
  return { rawTrace, traceRef };
}
