/**
 * Per-blueprint trace-collection strategies — the FIFTH SEAM (D-015) that breaks
 * the gym's repo-coupling (harness-blueprint-orchestration-2026-06-03 P-014).
 *
 * The original collector (`collector.ts`) ALWAYS builds a trace from `git diff
 * <base> HEAD` over a clone, and the real wiring (`ab-runner-real.ts`) execs `git
 * diff` directly — so a `requiresRepo:false` harness (research, gym) cannot be
 * traced: it has no clone and no diff. D-015 makes the trace source a per-blueprint
 * choice the TARGET declares via `blueprint.gym.collectTrace`:
 *
 *   - `git-diff`          → the produced work IS the git diff over the substrate
 *                           clone (coding). Needs a clone + a pinned base commit.
 *   - `work-item-output`  → the produced work IS the work-item's output + the role
 *                           transcripts (research / gym). NO git, NO clone.
 *   - `<custom>`          → a named host-registered collector (none built-in yet;
 *                           an unknown name is a hard error, not a silent empty trace).
 *
 * The strategy dispatches on the NAME; the actual effects (the git exec, the
 * work-item read, the bundle write) are injected, so this is unit-tested with fakes
 * — including the repo-less path with NO `gitDiff` dep at all. It reuses
 * `assembleRawTrace` so the RawTrace shape stays identical across strategies (the
 * judge/distiller don't care which seam produced the trace).
 */
import { assembleRawTrace, type RunOutputRow } from './collector';
import { isPinnedCommit } from './clone';
import type { RawTrace } from './distill';

/** The trace-source strategy a target blueprint declares (`blueprint.gym.collectTrace`). */
export type CollectStrategy = 'git-diff' | 'work-item-output' | (string & {});

/** The two built-in strategies; anything else is a custom name that must be host-registered. */
export const BUILTIN_COLLECT_STRATEGIES = ['git-diff', 'work-item-output'] as const;

/** Does this strategy need a git repo / clone to collect its trace? (coding=yes.) */
export function strategyRequiresRepo(strategy: CollectStrategy): boolean {
  return strategy === 'git-diff';
}

export interface TraceCollectInput {
  harnessSlug: string;
  terminalState: string;
  signals?: Record<string, unknown>;
  /** git-diff: the substrate clone path + pinned base commit. */
  clonePath?: string | null;
  baseCommit?: string | null;
  /** work-item-output: the work-item whose output is the produced artifact (optional). */
  workItemId?: string | null;
}

export interface TraceCollectDeps {
  /** Per-role final outputs for the run's harness (harness_run_output). All strategies use this. */
  readRunOutputs(harnessSlug: string): Promise<RunOutputRow[]>;
  /** git-diff ONLY: run the diff command, return the diff text. Absent ⇒ git-diff is unusable. */
  gitDiff?(clonePath: string, baseCommit: string): Promise<string>;
  /** work-item-output ONLY: the produced work-item output (the primary artifact for a repo-less run). */
  readWorkItemOutput?(harnessSlug: string, workItemId?: string | null): Promise<string>;
  /** Persist the trace bundle; return a ref (path) for gym_runs.trace_ref. */
  writeBundle(traceText: string): Promise<string>;
}

export interface CollectedTrace {
  rawTrace: RawTrace;
  traceRef: string;
  /** Which strategy produced it (observability). */
  strategy: CollectStrategy;
}

/**
 * Collect a run's trace using the target blueprint's declared strategy. Pure
 * dispatch over injected effects — `git-diff` reads the clone diff; `work-item-output`
 * reads the work-item output (no git); an unknown strategy throws.
 */
export async function collectTraceByStrategy(
  strategy: CollectStrategy,
  input: TraceCollectInput,
  deps: TraceCollectDeps,
): Promise<CollectedTrace> {
  const runOutputs = await deps.readRunOutputs(input.harnessSlug);

  let diff: string;
  switch (strategy) {
    case 'git-diff': {
      if (!deps.gitDiff) throw new Error('collectTrace "git-diff": no gitDiff effect provided');
      if (!input.clonePath) throw new Error('collectTrace "git-diff": no clonePath');
      if (!input.baseCommit || !isPinnedCommit(input.baseCommit)) {
        throw new Error(`collectTrace "git-diff": baseCommit must be a pinned hex SHA, got ${JSON.stringify(input.baseCommit)}`);
      }
      diff = await deps.gitDiff(input.clonePath, input.baseCommit);
      break;
    }
    case 'work-item-output': {
      // The repo-less path: the produced work is the work-item output (when a reader
      // is wired) — NOT a git diff. With no reader, the role transcripts alone carry
      // the trace (diff empty). Either way: zero git, so a requiresRepo:false harness
      // is fully traceable.
      diff = deps.readWorkItemOutput ? await deps.readWorkItemOutput(input.harnessSlug, input.workItemId) : '';
      break;
    }
    default:
      throw new Error(
        `collectTrace: unknown strategy "${strategy}" — expected one of ${BUILTIN_COLLECT_STRATEGIES.join(', ')} or a host-registered collector`,
      );
  }

  const rawTrace = assembleRawTrace({ diff, runOutputs, terminalState: input.terminalState, signals: input.signals });
  const traceRef = await deps.writeBundle(JSON.stringify(rawTrace));
  return { rawTrace, traceRef, strategy };
}
