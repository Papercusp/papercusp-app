/**
 * `@papercusp/step-program` — a generic, pure declarative step-program
 * interpreter + runner. A program is an ordered list of steps (each invokes a
 * named op with `{{ path }}`-interpolated args, an optional `when` guard, and a
 * result `bind`) followed by a conditional `gate`. The interpreter
 * (`planStep` / `selectGateBranch`) decides WHAT op to run; the runner
 * (`runProgram`) drives it, delegating every op to an injected `runOp` seam (the
 * op registry / durability boundary). Zero I/O, zero domain coupling.
 *
 * Modules:
 *   - `expr`        — a safe, no-eval boolean/comparison expression evaluator.
 *   - `interpolate` — type-preserving `{{ path }}` arg substitution.
 *   - `interpreter` — the pure `planStep` / `selectGateBranch` decisions.
 *   - `runner`      — `runProgram`: walk steps → injected `runOp` → gate.
 *   - `aggregate`   — a structured-block poll reducer (votes + an advocate veto).
 */

// Program shape
export type { Step, GateBranch, Program, Scope, WhenEval } from './types.js';

// Expression evaluator
export { evalExpr, parseExpr, isValidExpr, readPath, truthy } from './expr.js';

// `{{ path }}` interpolation
export { interpolate, interpolateArgs } from './interpolate.js';

// Pure interpreter
export { planStep, selectGateBranch, isProgramSpine, defaultWhenEval } from './interpreter.js';
export type { StepPlan, GateDecision } from './interpreter.js';

// Runner
export { runProgram } from './runner.js';
export type { OpCall, RunOp, ProgramOutcome, GateResultShape, RunProgramArgs } from './runner.js';

// Structured-block poll reducer
export { aggregateVotes, parsePost } from './aggregate.js';
export type { AggregateInput, AggregateResult, ParsedVote, ParsedAdvocate } from './aggregate.js';
