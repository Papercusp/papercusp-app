/**
 * swe-pro-seam.ts — the SWE-bench-Pro {@link CloneGradeSeam} (plan benchmark-capability-injection-redesign
 * P-003), wired against the steward's locked coordination-topology contract (coordination-topology.ts,
 * 2026-06-18). The topology RUNTIME (CoordinationStrategy impl + the shared pool driver) is the steward's;
 * this is the per-BENCHMARK seam SWE-Pro supplies so every topology arm (su-independent / dist-* / hive)
 * clones + grades SWE-Pro identically (fairness C5).
 *
 * modality `diff`: clone the task repo @ base commit → a scratch worktree (the agent edits it) → `extractDiff`
 * (base→worktree git-diff, minus the grader's own test files) → the official SWE-bench-Pro grader
 * (`swe_bench_pro_eval` via _xbench_grade.py + local docker) → resolved. Composes the EXISTING, tested
 * `makeCloneTaskRepo` + `makeExtractDiff` (clone.ts) — no re-roll. The real grader is docker-gated, so it is
 * dependency-INJECTED (`gradeDiff`): the unit test injects a fake (no docker/git), the run wiring injects the
 * real Pro grader.
 *
 * ROW CONTRACT (steward-confirmed 2026-06-18, matches buildCapabilityAttribution's C1 same-denominator):
 *   - clone/extract/grade INFRA crash → `{ resolved: null, graderStatus: 'error' }` (an infra non-completion;
 *     bench-metrics reconciles null→false in the C1 headline, never silently dropped).
 *   - EMPTY diff (the agent produced nothing) → `{ resolved: false, graderStatus: 'failed' }` (a genuine,
 *     SCORED capability-fail — an empty patch cannot pass, the SWE-bench convention; `detail.reason:
 *     'empty-diff'` keeps the distinction for diagnostics; no wasted grader run). It must be a CANONICAL
 *     scored status (`failed`), NOT a bespoke `'empty-diff'`: the topology row-builder coerces any
 *     non-canonical status to `'error'`, and bench-metrics' `isScored` treats `graderStatus:'error'` as
 *     INFRA — which would wrongly DROP the empty-diff fail from the exclude-infra denominator (flattering
 *     the arm, the exact C1 trap). `failed` ⇒ isScored=true ⇒ counted under both denominators.
 *   - graded → `{ resolved, graderStatus: resolved ? 'passed' : 'failed' }`.
 * `teardown` is NEVER-THROW + ALWAYS run (success / capability-fail / infra) so a run never leaks worktrees.
 */
import type { CloneGradeSeam } from './coordination-topology';
import { makeCloneTaskRepo, makeExtractDiff } from './clone';
import type { BenchTask, CloneTaskRepo, ExtractDiff, TaskCheckout } from './types';

/** The real per-instance Pro grade: given a task + its diff, run the official grader → resolved. Docker-gated
 *  (swe_bench_pro_eval + local docker images), so it is injected; the production run wiring binds it. */
export type SweProGradeDiff = (task: BenchTask, diff: string) => Promise<boolean>;

export interface SweProSeamDeps {
  /** Clone seam (default the real {@link makeCloneTaskRepo}). */
  cloneTaskRepo?: CloneTaskRepo;
  /** Diff-extraction seam (default the real {@link makeExtractDiff}). */
  extractDiff?: ExtractDiff;
  /** The official Pro grader (REQUIRED — docker-gated; the test injects a fake, the run injects the real one). */
  gradeDiff: SweProGradeDiff;
  /** Scratch root the worktrees clone under. */
  workRoot?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Build the SWE-bench-Pro {@link CloneGradeSeam} (handle = {@link TaskCheckout}). Every topology arm the
 * steward's runtime drives uses this ONE seam, so clone + grade are identical across arms (C5).
 */
export function makeSweProCloneGradeSeam(deps: SweProSeamDeps): CloneGradeSeam<TaskCheckout> {
  const clone = deps.cloneTaskRepo ?? makeCloneTaskRepo();
  const extract = deps.extractDiff ?? makeExtractDiff();
  const gradeDiff = deps.gradeDiff;

  return {
    modality: 'diff',

    clone: (task: BenchTask): Promise<TaskCheckout> => clone(task, deps.workRoot ? { workRoot: deps.workRoot } : undefined),

    async grade(task: BenchTask, handle: TaskCheckout) {
      let diff: string;
      try {
        diff = await extract(handle, task);
      } catch (e) {
        // extracting the submission failed = infra (the agent's work couldn't be read) → null (reconciled false).
        return { resolved: null, graderStatus: 'error', detail: { stage: 'extract', error: errMsg(e) } };
      }
      if (!diff.trim()) {
        // The agent produced no diff → a genuine, SCORED capability-fail (an empty patch cannot pass; skip
        // the grader). MUST be canonical 'failed' (not 'empty-diff'): a non-canonical status coerces to
        // 'error' in the row, which bench-metrics counts as INFRA and would drop this fail from the
        // exclude-infra denominator (the C1 flatter-the-arm trap). detail keeps the empty-diff distinction.
        return { resolved: false, graderStatus: 'failed', detail: { reason: 'empty-diff' } };
      }
      try {
        const resolved = await gradeDiff(task, diff);
        return { resolved, graderStatus: resolved ? 'passed' : 'failed' };
      } catch (e) {
        // The official grader crashed (docker/harness infra) → null, not a false (never penalize the arm).
        return { resolved: null, graderStatus: 'error', detail: { stage: 'grade', error: errMsg(e) } };
      }
    },

    async teardown(handle: TaskCheckout): Promise<void> {
      // Never-throw, always-run: a run must not leak worktrees on ANY path.
      await handle.cleanup().catch(() => {});
    },
  };
}

/**
 * The plan's framework arms (P-012) → their TWO axes, per su-37e53's runTopology + P-013 decision
 * (2026-06-18, benchmark-arms-su-vs-queen-expansion):
 *   - `topology` — the coordination structure (a topology blueprint runTopology's `resolveCoordinationSpec`
 *     reads).
 *   - `solver`   — the per-task SOLVER blueprint each agent spawns. Every su-system arm solves with the
 *     FULL su spine (`external-bench`) held CONSTANT; the bare baseline is the floor (`coding-solo`).
 *
 * Holding the SOLVER constant (external-bench) makes `su`-vs-`hive` isolate COORDINATION; holding the
 * TOPOLOGY constant (`su-independent`) makes `vanilla`-vs-`su` isolate the SU-SPINE capability. So
 * `vanilla` is the no-coord FLOOR (su-independent topology + coding-solo solver) — NOT the su-system
 * no-coord pole, which is `su` (su-independent topology + external-bench solver). Reconciled with the
 * steward: vanilla ≠ su-independent.
 */
export const SWE_PRO_FRAMEWORK_ARMS = {
  vanilla: { topology: 'su-independent', solver: 'coding-solo' },
  su: { topology: 'su-independent', solver: 'external-bench' },
  hive: { topology: 'hive', solver: 'external-bench' },
} as const;

export type SweProFrameworkArm = keyof typeof SWE_PRO_FRAMEWORK_ARMS;

/** Coordination-study topology arm ids (+ baseline ids) whose per-task SOLVER is the bare floor — not the
 *  su system. Everything else resolves to the su spine. */
const SWE_PRO_BASELINE_ARMS = new Set<string>(['mini-swe', 'mini-swe-agent', 'baseline', 'vanilla', 'coding-solo']);

/**
 * P-013 (su-37e53's runTopology decision): the per-task SOLVER blueprint a SWE-Pro topology agent spawns,
 * by arm. EVERY su-system arm — su-independent / dist-broadcast / dist-peer-review / dist-blackboard /
 * dist-repo-huddle / hier-lead-worker / pair / ensemble-solve / hive — solves with the FULL su spine
 * (`external-bench`), so per-task solving capability is CONSTANT and the coordination topology is the ONLY
 * variable (the fairness core). The bare baseline is the floor (`coding-solo`). Every su-system role
 * (worker / solver / driver / navigator / lead / judge) is an su-ROLE agent on this spine — NEVER a
 * place_batch bee — which is exactly what P-013 requires. The topology STRUCTURE (1 solver vs ensemble vs
 * pair vs lead+workers) is runTopology's job; the SOLVER blueprint is held constant here.
 */
export function sweProSolverBlueprint(arm: string): string {
  return SWE_PRO_BASELINE_ARMS.has(arm) ? 'coding-solo' : 'external-bench';
}
