/**
 * PaperBench → Papercup arm binding (plan benchmark-suite-paperbench-2026-06-17, #18).
 *
 * `drivePaperViaArm` is the REAL implementation of {@link PaperReplicationOps.drive} — the paper-shaped
 * adapter over the su-independent / hive arm: create a temporary hive → enroll a member harness seeded
 * with the PAPER context (an empty-start worktree, NOT a cloned SWE repo) → FIFO-spawn it through :3170
 * (the place_batch path fixed this session) → wait for terminal → copy the bee's produced `/submission`
 * tree into `outDir` → teardown.
 *
 * GATE (honest): the arm today is SWE-shaped — `prepareTask` CLONES a repo @ base and `collectTask`
 * extracts a unified DIFF. PaperBench needs the opposite ends: an EMPTY-start worktree seeded with the
 * paper, and collection of the WHOLE produced tree (code + reproduce.sh). That generalization is exactly
 * su-1226c070's in-flight `bindLiveBenchHarness` DRIVE work — and even with place_batch fixed, a spawned
 * bee currently infra-fails at $0 because the spine isn't yet runnable for it. Rather than fork a
 * divergent paper-only copy of the arm internals now (guaranteed rework once the DRIVE lands), this throws
 * a clear, actionable error. The DRIVER itself (`_pb_hive_solve.ts`: CLI + never-throw core + paper reader
 * + tree validation) is COMPLETE + unit-tested; this binding is the one focused piece that lights up when
 * the arm can run an empty-start, tree-output task. Track: emit `bench:drive-ready` (su-1226c070).
 */
import type { PaperReplicationRequest } from './_pb_hive_solve';

export class PaperBenchArmNotReadyError extends Error {
  constructor(paperId: string) {
    super(
      `paperbench-arm-binding: cannot drive paper "${paperId}" yet — the su-independent/hive arm is ` +
        `SWE-shaped (clone-repo → extract-diff) and does not yet support an empty-start, tree-output ` +
        `(paper) task. Gated on the bench-harness-live DRIVE binding (su-1226c070); a spawned bee ` +
        `currently infra-fails at $0. The driver core is complete + tested — this binding lights up when ` +
        `the arm can run a paper task. Await event 'bench:drive-ready'.`,
    );
    this.name = 'PaperBenchArmNotReadyError';
  }
}

/**
 * Drive the arm over a paper → write the replication tree into `req.outDir`. Throws
 * {@link PaperBenchArmNotReadyError} until the arm supports paper tasks (see file header). When ready,
 * this is the place to wire: createHive → paper-seeded enrollMember → placeFifoBatch → poll-terminal →
 * copy worktree `/submission` → outDir → teardown, reusing the su-independent arm primitives.
 */
export async function drivePaperViaArm(
  req: PaperReplicationRequest,
): Promise<{ filesWritten: number; costUsd: number; agentId: string | null }> {
  throw new PaperBenchArmNotReadyError(req.paperId);
}
