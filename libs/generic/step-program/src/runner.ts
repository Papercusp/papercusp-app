/**
 * `runProgram` — the program executor. The runtime half of the pure
 * planStep/selectGateBranch interpreter: it walks a program's `steps`, runs each
 * op (through an injected `runOp` seam), binds the result into the scope,
 * evaluates the `gate`, and fires the chosen gate op.
 *
 * **The `runOp` seam is the durability + registry boundary.** The consumer
 * injects a `runOp` that resolves the op name (against its own op registry) and
 * runs it — and decides whether that run is durable. A durable host wraps each op
 * in a checkpointed step (so a top-level program survives a restart and resumes
 * from the last completed step); an inline host (nested programs / unit tests)
 * runs the op directly. So this core is fully testable without any durability
 * runtime, and recursion composes (a runOp can itself start a nested runProgram).
 *
 * Cost + recursion guards: the depth cap aborts (→ a non-resolved outcome) a
 * program recursed past `maxDepth`; per-op caps (spawn counts, timeouts) are the
 * ops' own concern, honoured inside `runOp`.
 *
 * The runner is generic over the consumer's context type `Ctx` — an opaque value
 * threaded to every `runOp` call. The runner never reads it; the ops do.
 */
import type { Program, WhenEval } from './types.js';
import type { Scope } from './expr.js';
import { planStep, selectGateBranch } from './interpreter.js';

/** A single op invocation the executor delegates to its runner. */
export interface OpCall {
  op: string;
  args: Record<string, unknown>;
  /** A stable label (`op-<stepId>` / `gate-<op>`) — e.g. a durable step name. */
  label: string;
}

/** The injected op runner: resolve + run `call.op`, return its result. */
export type RunOp<Ctx = unknown> = (call: OpCall, ctx: Ctx) => Promise<unknown>;

/** The shape the runner inspects on a gate op's result to decide resolution. */
export interface GateResultShape {
  resolved?: boolean;
  decision?: unknown;
}

export interface ProgramOutcome {
  /** The gate op that fired, or `recursion-exceeded` / `no-gate-match`. */
  outcome: string;
  /** True when the gate resolved decisively (per `isResolved`). */
  resolved: boolean;
  /** The decision value the gate op returned, if any. */
  decision?: unknown;
  /** The full final scope (debug / chaining). */
  scope?: Record<string, unknown>;
}

export interface RunProgramArgs<Ctx = unknown> {
  program: Program;
  /** The initial bound scope (the consumer builds it — e.g. from a payload). */
  scope: Scope;
  ctx: Ctx;
  runOp: RunOp<Ctx>;
  /** Recursion level of THIS program (a top-level run is 0). Default 0. */
  depth?: number;
  /**
   * The deepest level allowed to RUN, so the guard is strict `>` (maxDepth itself
   * runs; one level past it aborts). Default: no cap (`Infinity`).
   */
  maxDepth?: number;
  /**
   * Decide whether a gate op's outcome counts as a decisive resolution. Default:
   * `(_op, result) => result?.resolved === true`. A host can widen this — e.g.
   * also treat a specific terminal op name as resolved.
   */
  isResolved?: (gateOp: string, gateResult: GateResultShape | undefined) => boolean;
  /**
   * The injected `when`-condition evaluator (the condition-language seam). Default
   * is the string-expr evaluator; the papercusp spine injects
   * `@papercusp/rules`' `evaluateDataCondition` so a `when` is a `MatchMap`
   * (adopt-event-rules-engines D-002).
   */
  evalWhen?: WhenEval;
  /** Optional progress log. */
  log?: (msg: string) => void;
  /** Label for diagnostics (the program's id). */
  programId?: string;
}

const defaultIsResolved = (_op: string, res: GateResultShape | undefined): boolean => res?.resolved === true;

/**
 * Run a program to its gate decision. Throws only on a structural problem (a
 * program with no steps); a gate that doesn't resolve returns a non-resolved
 * outcome (never throws). The depth guard turns an over-deep recursion into an
 * abort outcome rather than a stack blow-up.
 */
export async function runProgram<Ctx = unknown>(input: RunProgramArgs<Ctx>): Promise<ProgramOutcome> {
  const { program, scope, ctx, runOp } = input;
  const depth = input.depth ?? 0;
  const maxDepth = input.maxDepth ?? Infinity;
  const isResolved = input.isResolved ?? defaultIsResolved;
  const evalWhen = input.evalWhen;
  const log = input.log;
  const id = input.programId ?? 'program';

  if (!program.steps || program.steps.length === 0) {
    throw new Error(`step-program: "${id}" has no program steps (steps[])`);
  }

  // ── recursion guard ────────────────────────────────────────────────────────
  // `depth` is the recursion level of THIS program (a top-level run is 0; a
  // sub-program a step's op starts is parent.depth + 1). `maxDepth` is the
  // deepest level allowed to RUN, so the guard is strict `>` (maxDepth itself
  // runs; one level past it aborts).
  if (depth > maxDepth) {
    log?.(`step-program "${id}": depth ${depth} > maxDepth ${maxDepth} — aborting`);
    return {
      outcome: 'recursion-exceeded',
      resolved: false,
      decision: undefined,
      scope: { error: `recursion depth ${depth} exceeds maxDepth ${maxDepth}` },
    };
  }

  // ── steps ──────────────────────────────────────────────────────────────────
  for (const step of program.steps) {
    const plan = planStep(step, scope, evalWhen);
    if (plan.kind === 'skip') {
      log?.(`step-program "${id}": skip step ${step.id} (${plan.reason})`);
      continue;
    }
    const result = await runOp({ op: plan.op, args: plan.args, label: `op-${step.id}` }, ctx);
    if (plan.bind) scope[plan.bind] = result;
  }

  // ── gate ───────────────────────────────────────────────────────────────────
  const gate = selectGateBranch(program.gate, scope, evalWhen);
  if (!gate) {
    log?.(`step-program "${id}": no gate branch matched — unresolved`);
    return { outcome: 'no-gate-match', resolved: false, scope };
  }
  const gateResult = (await runOp({ op: gate.op, args: gate.args, label: `gate-${gate.op}` }, ctx)) as
    | GateResultShape
    | undefined;

  return {
    outcome: gate.op,
    resolved: Boolean(isResolved(gate.op, gateResult)),
    decision: gateResult?.decision,
    scope,
  };
}
