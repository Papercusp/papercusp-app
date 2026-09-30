/**
 * Executes the pure plans in `papercusp-substrate.ts` to turn ADMITTED task
 * descriptors into gym tasks. Plan gym-real-fitness-signal-2026-07-27, P-001;
 * ruling D-007.
 *
 * ── WHY THIS IS A SEPARATE MODULE ────────────────────────────────────────────
 * `papercusp-substrate.ts` is deliberately PURE — it builds command plans and
 * judges observed results, so every rule in it is unit-testable without git, a
 * container, or a gym cycle. Execution therefore lives here, behind a single
 * injected `RunGit` port, which keeps that property on both sides: these rules
 * are tested against a fake git that records argv, and the real one is a thin
 * `execFile` the tests never need.
 *
 * ── THE ONE THING THIS MODULE EXISTS TO GET RIGHT ────────────────────────────
 * `buildTaskCommitPlan` is not a flat command list: two of its steps produce a
 * SHA on stdout that the next step consumes (write-tree → tree, commit-tree →
 * commit). A caller that ran the commands blindly and ignored stdout would
 * produce no task commit at all — and the failure mode is silent, because
 * `update-ref` would simply never run and `repoCommit` would fall back to
 * whatever the caller had. Threading those two captures is this module's whole
 * job, and it is why the plan exposes them as functions rather than as data.
 */
import { buildTaskCommitPlan, papercuspTaskToGymTask, type PapercuspTaskDescriptor } from './papercusp-substrate';
import type { GitCommand } from './clone';

/** Runs one git command and returns its stdout. Throws on a non-zero exit. */
export type RunGit = (cmd: GitCommand) => Promise<string>;

export interface MaterialisedTask {
  descriptor: PapercuspTaskDescriptor;
  /** The generated commit whose tree carries the rewound file (D-007). */
  taskCommit: string;
  /** Branch that makes `taskCommit` reachable by a default `git clone`. */
  branchName: string;
  /** The row handed to the gym runner. */
  gymTask: ReturnType<typeof papercuspTaskToGymTask>;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * `git write-tree` / `commit-tree` print the SHA and nothing else, but a stray
 * warning on stdout (or an empty capture from a runner that returned stderr by
 * mistake) would otherwise be passed straight into the next command, producing
 * a confusing failure two steps later. Fail where the fault actually is.
 */
function expectSha(raw: string, step: string, taskId: string): string {
  const sha = raw.trim();
  if (!SHA_RE.test(sha)) {
    throw new Error(`papercusp task ${taskId}: ${step} did not return a 40-hex SHA, got: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  return sha;
}

/**
 * Create ONE task's commit inside an already-materialised substrate and return
 * its SHA. Idempotent in effect: the plan pins author/committer identity AND
 * dates, so re-running for the same descriptor rewrites the branch to the same
 * commit rather than accumulating new ones.
 */
export async function materialiseTaskCommit(
  desc: PapercuspTaskDescriptor,
  substrateDir: string,
  runGit: RunGit,
  /** Tree the task starts from; defaults to the oracle pin. See buildTaskCommitPlan. */
  baseCommit?: string,
): Promise<{ taskCommit: string; branchName: string }> {
  const plan = buildTaskCommitPlan(desc, substrateDir, baseCommit);

  await runGit(plan.readTree);
  const entry = await runGit(plan.readRewoundEntry);
  // Throws with a precise message when the file did not exist at the rewind
  // point — a "revert" that is really a DELETE is a different, much easier task.
  await runGit(plan.spliceEntry(entry));

  const tree = expectSha(await runGit(plan.writeTree), 'write-tree', desc.taskId);
  const taskCommit = expectSha(await runGit(plan.commitTree(tree)), 'commit-tree', desc.taskId);
  await runGit(plan.setBranch(taskCommit));

  return { taskCommit, branchName: plan.branchName };
}

/**
 * Materialise every admitted descriptor into a gym task.
 *
 * Takes ONLY descriptors that already cleared `judgeDiscrimination` — this
 * function deliberately has no opinion about validity, so the discrimination
 * gate stays the single place a task can be admitted (D-006) and cannot be
 * quietly bypassed by calling the materialiser directly with raw candidates.
 *
 * Sequential on purpose: the steps are cheap plumbing (no test runs, no
 * checkout), and a shared substrate under concurrent `update-ref` writes buys
 * nothing but a harder failure mode to read.
 */
export async function materialisePapercuspCorpus(
  admitted: readonly PapercuspTaskDescriptor[],
  substrateDir: string,
  runGit: RunGit,
  /** Tree every task starts from; defaults to the oracle pin. See buildTaskCommitPlan. */
  baseCommit?: string,
): Promise<MaterialisedTask[]> {
  const out: MaterialisedTask[] = [];
  const seen = new Set<string>();
  for (const desc of admitted) {
    if (seen.has(desc.taskId)) {
      throw new Error(`papercusp corpus: duplicate taskId ${desc.taskId} — its branch would be overwritten and two tasks would share one commit`);
    }
    seen.add(desc.taskId);

    const { taskCommit, branchName } = await materialiseTaskCommit(desc, substrateDir, runGit, baseCommit);
    out.push({
      descriptor: desc,
      taskCommit,
      branchName,
      // Throws if taskCommit === pinCommit — the D-007 guard, re-checked here on
      // the real generated SHA rather than trusted from the plan.
      gymTask: papercuspTaskToGymTask(desc, substrateDir, taskCommit),
    });
  }
  return out;
}
