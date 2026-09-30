/**
 * `interpreter` — the pure step-program interpreter. It reads a program's steps +
 * gate and a bound scope and decides *what op to run with what args* — but never
 * runs it (no I/O). The runner consumes these decisions, invokes the op, binds
 * the result back into the scope, and asks again. That purity boundary is what
 * makes a program unit-testable + replay-safe.
 *
 *   planStep(step, scope)         → run the op (interpolated args) | skip it (`when` false)
 *   selectGateBranch(gate, scope) → the first matching branch + its interpolated args
 *
 * Conditions are evaluated by `expr` (safe, no-eval) and args by `interpolate`
 * (`{{ path }}`, type-preserving).
 */
import type { Step, GateBranch, WhenEval } from './types.js';
import { evalExpr, type Scope } from './expr.js';
import { interpolateArgs } from './interpolate.js';

/** The decision for one step: invoke `op` with interpolated `args`, or skip. */
export type StepPlan =
  | { kind: 'skip'; reason: string }
  | { kind: 'invoke'; op: string; args: Record<string, unknown>; bind?: string };

/**
 * Does a `when` carry an actual condition (vs. "always")? A null/undefined `when`
 * — or an empty/whitespace string — is "no condition". Any other value (a string
 * expr, or a `MatchMap` object) is a real condition the injected `WhenEval`
 * interprets.
 */
function hasCondition(when: unknown): boolean {
  if (when == null) return false;
  if (typeof when === 'string') return when.trim() !== '';
  return true;
}

/**
 * The default `when` evaluator: the string-expr `evalExpr` (so step-program runs
 * standalone). A consumer overrides it — e.g. the papercusp spine injects
 * `@papercusp/rules`' `evaluateDataCondition` to make `when` a `MatchMap`.
 */
export const defaultWhenEval: WhenEval = (when, scope) =>
  typeof when === 'string' ? evalExpr(when, scope) : Boolean(when);

/**
 * Decide what to do with one step against the current scope. A `when` guard that
 * evaluates false → skip (the step's bind stays unset). Otherwise → invoke the op
 * with `{{ path }}`-interpolated args. `evalWhen` is the injected condition
 * language (string expr by default; a `MatchMap` matcher when the host injects one).
 */
export function planStep(step: Step, scope: Scope, evalWhen: WhenEval = defaultWhenEval): StepPlan {
  if (hasCondition(step.when) && !evalWhen(step.when, scope)) {
    return { kind: 'skip', reason: `when ${JSON.stringify(step.when)} is false` };
  }
  return {
    kind: 'invoke',
    op: step.op,
    args: interpolateArgs(step.args ?? {}, scope),
    bind: step.bind,
  };
}

/** The chosen gate branch + its interpolated args (or null when nothing matched). */
export interface GateDecision {
  branch: GateBranch;
  op: string;
  args: Record<string, unknown>;
  /** Index of the chosen branch (for tracing). */
  index: number;
}

/**
 * Select the gate branch that fires: the first branch whose `when` is true, in
 * declaration order; a branch with `else: true` or no `when` is the fallback and
 * always matches. Returns null only when no branch matched AND there is no
 * fallback (a well-formed program gate should always carry a fallback).
 */
export function selectGateBranch(
  gate: GateBranch[] | undefined,
  scope: Scope,
  evalWhen: WhenEval = defaultWhenEval,
): GateDecision | null {
  if (!gate || gate.length === 0) return null;
  for (let i = 0; i < gate.length; i++) {
    const b = gate[i]!;
    const isFallback = b.else === true || !hasCondition(b.when);
    if (isFallback || evalWhen(b.when, scope)) {
      return { branch: b, op: b.op, args: interpolateArgs(b.args ?? {}, scope), index: i };
    }
  }
  return null;
}

/** True if a spine/program is in program mode (has `steps`); false otherwise. */
export function isProgramSpine(spine: { steps?: unknown[] }): boolean {
  return Array.isArray(spine.steps) && spine.steps.length > 0;
}
