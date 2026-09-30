/**
 * `worker:chunk-loop` — the coding WORKER's chunk loop as an operator-hosted
 * DETERMINISTIC blueprint step (worker-chunk-loop-operator-hosted-2026-06-14
 * P-002/P-003, = deterministic-blueprints-migration-2026-06-13 P-142).
 *
 * The deterministic step kind = a registered typed function the program-mode
 * spine runs as a checkpointed step. This op WRAPS the SHIPPED canonical worker
 * model (`runWorkerChunkLoop` — up-front chunk planning, per-chunk file locks, the
 * L1 typecheck gate, replan-strikes, escalate-to-debugger) so the migration
 * reshapes, it does not rewrite (D-001/D-005): the op is a near-PORT — it builds
 * the operator-side `InvokeContext` `invoke-once` builds in the subprocess, then
 * calls the EXISTING `runWorkerChunkLoop(featureId, ctx, logger, cfg, lock)`.
 *
 * SHAPE (D-005): a single gateless program step on `blueprints/worker/blueprint.yaml`
 * fires this op with `{ featureId }`; the op runs the loop and maps the
 * `ChunkLoopOutcome` (completed / planning_failed / escalated / aborted) into its
 * bound result — outcome-shape parity with the subprocess path — so the coding
 * director can route the next turn off it. There is no decision fork: the program
 * resolves by running the step (a deterministic pipeline).
 *
 * STAGED + DARK (D-003): the dispatch that routes the coding director's worker
 * turn here is gated behind the DEFAULT-OFF `papercusp-worker-chunk-loop-blueprint`
 * flag; the subprocess path is the live default until the owner-watched ramp
 * validates parity (P-010+). The ctx-construction (the `defaultRunWorkerChunkLoop`
 * runner) is mock-only-testable — a wrong ctx (esp. `extraSpawnEnv` / the pg
 * bridge) compiles + passes mocks but is only PROVEN by the Phase-1 dark-launch
 * parity run (D-005). So the runner is dynamic-imported (this op module stays
 * test-light) and behind the injectable `runLoop` seam below.
 */
import { z } from 'zod';
import type { CoordOp, CoordOpCtx } from '../../coord-ops/types.js';
import { registerCoordOp } from '../../coord-ops/registry.js';
// Type-only: erased at runtime, so importing the op module never loads the
// orchestrator package (the heavy runner is dynamic-imported in run()).
import type { ChunkLoopOutcome } from '@papercusp/orchestrator';

/** Declared input I/O — the feature the coding director is dispatching a worker for. */
const args = z.object({
  /** The coding feature id (e.g. F-AUTH-001) whose chunk loop to run. */
  featureId: z.string().min(1),
});

/**
 * Declared output I/O — a faithful, JSON-shaped projection of the loop's
 * `ChunkLoopOutcome` (outcome-shape parity with the subprocess path). `outcome`
 * mirrors `ChunkLoopOutcome.kind`; the per-variant fields carry its payload.
 */
const result = z.object({
  outcome: z.enum(['completed', 'planning_failed', 'escalated', 'aborted']),
  /** completed → chunks committed this run (incl. resume-skipped already-committed). */
  chunksCommitted: z.number().int().nonnegative().optional(),
  /** planning_failed → the planner/parse error. */
  error: z.string().optional(),
  /** escalated → the chunk that exhausted its replan strikes. */
  escalatedChunkId: z.string().optional(),
  /** escalated / aborted → the human-readable reason. */
  reason: z.string().optional(),
  /** escalated → how many replan strikes were spent. */
  strikes: z.number().int().nonnegative().optional(),
});

type WorkerChunkLoopResult = z.infer<typeof result>;

/**
 * Injectable seam (mirrors the other deterministic ops' dep setters). The op
 * delegates the loop EXECUTION to `runLoop`; the default
 * (`defaultRunWorkerChunkLoop`, dynamic-imported) builds the operator-side
 * `InvokeContext` per the D-005 recipe + governs the run as a unit (D-002) + calls
 * `runWorkerChunkLoop`. Tests inject a fake `runLoop` (a scripted `ChunkLoopOutcome`,
 * or the real `runChunkLoopCore` with mocked invoke/lock deps) so the op's mapping +
 * program integration are unit-testable without agents/PG/a repo.
 */
export interface WorkerChunkLoopOpDeps {
  runLoop: (featureId: string, ctx: CoordOpCtx) => Promise<ChunkLoopOutcome>;
}

let _deps: WorkerChunkLoopOpDeps | null = null;
export function setWorkerChunkLoopOpDeps(deps: WorkerChunkLoopOpDeps | null): void {
  _deps = deps;
}

/** Map the loop's discriminated `ChunkLoopOutcome` into the declared result I/O. */
function mapOutcome(o: ChunkLoopOutcome): WorkerChunkLoopResult {
  switch (o.kind) {
    case 'completed':
      return { outcome: 'completed', chunksCommitted: o.chunksCommitted };
    case 'planning_failed':
      return { outcome: 'planning_failed', error: o.error };
    case 'escalated':
      return { outcome: 'escalated', escalatedChunkId: o.chunk.id, reason: o.reason, strikes: o.strikes };
    case 'aborted':
      return { outcome: 'aborted', reason: o.reason };
  }
}

export const workerChunkLoopOp: CoordOp<z.infer<typeof args>, WorkerChunkLoopResult> = {
  name: 'worker:chunk-loop',
  description:
    'Deterministic step: run one coding feature\'s chunk loop (plan → per-chunk acquire/implement/typecheck-gate → commit / replan / escalate) operator-hosted — the durable-program port of the subprocess worker.',
  argsSchema: args,
  resultSchema: result,
  async run(a, ctx) {
    // A coding worker run is harness-scoped + workspace-scoped: the op resolves
    // the feature's project repo from (harnessSlug, workspaceId). Absent ⇒ a
    // misconfigured fire — fail loud rather than run against the wrong scope.
    if (!ctx.workspaceId) throw new Error('worker:chunk-loop requires ctx.workspaceId');
    if (!ctx.harnessSlug) throw new Error('worker:chunk-loop requires ctx.harnessSlug');

    const runLoop =
      _deps?.runLoop ?? (await import('./worker-chunk-loop-runner.js')).defaultRunWorkerChunkLoop;
    const outcome = await runLoop(a.featureId, ctx);
    ctx.log?.(
      `worker:chunk-loop ${a.featureId} → ${outcome.kind}` +
        (outcome.kind === 'completed' ? ` (${outcome.chunksCommitted} committed)` : '') +
        (outcome.kind === 'escalated' ? ` (chunk ${outcome.chunk.id}, ${outcome.strikes} strikes)` : '') +
        (outcome.kind === 'planning_failed' || outcome.kind === 'aborted'
          ? ` (${outcome.kind === 'planning_failed' ? outcome.error : outcome.reason})`
          : ''),
    );
    return mapOutcome(outcome);
  },
};

registerCoordOp(workerChunkLoopOp);
