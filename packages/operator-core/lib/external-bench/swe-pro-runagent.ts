/**
 * swe-pro-runagent.ts — the fleet-spawn `runAgent` for the SWE-bench-Pro topology arms (plan
 * benchmark-capability-injection-redesign P-003), built against the steward's run-topology.ts driver.
 *
 * `runTopology` clones the worktree (via my swe-pro-seam `CloneGradeSeam`), then calls THIS `runAgent` to
 * actually run an agent in that worktree, then grades it (the seam) + tears it down. So the runAgent's job is
 * narrow: spawn a coding agent ON THE PROVIDED worktree (input.handle — NOT a fresh clone), inject the
 * topology coordination `directive` + `forbidTools` tool-scope, run it to DONE under the iso-budget, and
 * report the diff (`submission`) + usage + the C4 evidence (`coordCalls` — how many coordination tool calls
 * the agent actually made; the driver sums it onto armMeta.coordCalls so the fairness audit can flag a
 * coordination arm whose agents never coordinated — the C4 trap that sank the tau2 +memory "lift", D-022).
 *
 * It wraps the shared generation primitive (`runArmGeneration`), overriding `GenerationPorts.clone` to
 * return the already-prepared handle (runTopology owns the clone). The SOLVER blueprint is chosen by
 * {@link sweProSolverBlueprint}(input.arm) per su-37e53's P-013 decision — `external-bench` (the FULL su
 * spine) for EVERY su-system arm so per-task solving capability is CONSTANT (coordination is the only
 * variable), `coding-solo` for the bare baseline floor; NEVER coding-solo for a su arm and NEVER a
 * place_batch bee. The live spawn binding (instantiate = spinRunAndCost; directive via env per D-020;
 * coordCalls from agent_usage_samples) cannot be unit-tested without docker+opus, so it is a SEPARATE
 * injected `spawn` seam: the mapping + structure here are fully unit-tested with a fake spawn; the live
 * binding is exercised on the proof run.
 */
import type { GenerationStatus } from '@papercusp/bench-metrics';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import type { ArmAttempt, BenchTask, GenerationBudget, TaskCheckout } from './types';

/** The injected spawn-on-an-existing-worktree seam → an {@link ArmAttempt} (+ optional model-call/coord
 *  counts the live binding reads from telemetry). Default = the live binding spinning
 *  {@link sweProSolverBlueprint}(arm) — the su spine for su-system arms, coding-solo for the baseline. */
export type SweProSpawn = (input: {
  task: BenchTask;
  /** The already-prepared worktree (from the seam's clone) the agent edits in place. */
  handle: TaskCheckout;
  /** Reproducibility prefix for this attempt. */
  seedPrefix: string;
  budget: GenerationBudget;
  arm: string;
  /** Topology coordination directive injected into the agent's prompt. */
  directive: string;
  /** coord/* tools this agent may NOT use (tool-scope). */
  forbidTools: string[];
}) => Promise<ArmAttempt & { modelCalls?: number; coordCalls?: number }>;

export interface SweProRunAgentDeps {
  /** The spawn seam (default: the live binding — see {@link liveSweProSpawn}). Tests inject a fake. */
  spawn?: SweProSpawn;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Map an ArmAttempt stopReason → the AgentRunOutput generation status. */
function statusFromStop(stopReason: string): GenerationStatus {
  if (stopReason === 'error') return 'error';
  if (stopReason === 'timeout') return 'timeout';
  return 'completed';
}

/**
 * Build the SWE-Pro {@link RunAgentInput} → {@link AgentRunOutput} runAgent the steward's `runTopology`
 * drives. Spawns the agent on the provided worktree, returns the diff as the opaque `submission` + the
 * iso-budget usage + the C4 `coordCalls` evidence. Never throws — a spawn failure becomes an infra
 * (`status:'error'`) row (reconciled false under the C1 same-denominator headline), never an exception.
 */
export function makeSweProRunAgent(deps: SweProRunAgentDeps = {}): (input: RunAgentInput<TaskCheckout>) => Promise<AgentRunOutput> {
  const spawn = deps.spawn;
  if (!spawn) {
    throw new Error('makeSweProRunAgent: a spawn seam is required (inject the live binding or a fake)');
  }
  return async (input: RunAgentInput<TaskCheckout>): Promise<AgentRunOutput> => {
    try {
      const r = await spawn({
        task: input.task,
        handle: input.handle,
        // distinct per (arm, task) so re-runs/seeds don't collide; the driver stamps the row seed separately.
        seedPrefix: `${input.arm}-${input.task.instanceId}`,
        budget: budgetFromIso(input.attemptBudget),
        arm: input.arm,
        directive: input.directive,
        forbidTools: input.forbidTools,
      });
      return {
        submission: r.diff ?? '',
        status: statusFromStop(r.stopReason),
        // model-call count is the iso-budget PRIMARY axis (C3); fall back to turns when the binding can't
        // separate them.
        modelCalls: r.modelCalls ?? r.turns ?? 0,
        tokensIn: r.tokensIn ?? 0,
        tokensOut: r.tokensOut ?? 0,
        costUsd: r.costUsd ?? 0,
        turns: r.turns ?? 0,
        coordCalls: r.coordCalls ?? 0, // C4 evidence; the live binding reads it from agent_usage_samples.
        capped: r.stopReason === 'budget-exhausted',
        error: r.generationError ?? null,
      };
    } catch (e) {
      // Never-throw: a spawn crash is an infra non-completion, not an exception (driver emits resolved:null).
      return {
        submission: '',
        status: 'error',
        modelCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        turns: 0,
        coordCalls: 0,
        capped: false,
        error: errMsg(e),
      };
    }
  };
}

/** Map the topology {@link RunAgentInput.attemptBudget} (IsoBudget) → the solver's GenerationBudget. */
function budgetFromIso(iso: RunAgentInput['attemptBudget']): GenerationBudget {
  const b: GenerationBudget = {};
  if (iso.maxCostUsd != null) (b as { maxUsd?: number }).maxUsd = iso.maxCostUsd;
  if (iso.maxTokens != null) (b as { maxTokens?: number }).maxTokens = iso.maxTokens;
  return b;
}
