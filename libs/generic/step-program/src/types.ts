/**
 * The generic step-program shape — the data a consumer hands the interpreter +
 * runner. Domain-free: a `Step` names an `op` (a string the consumer's injected
 * `runOp` resolves) with `{{ path }}`-templated `args`, an optional `when` guard
 * (an `expr` condition over the scope), and an optional `bind` (the scope key the
 * op's result is stored under). A `GateBranch` is the conditional decision after
 * the steps run: the first branch whose `when` is true (or the `else`/no-`when`
 * fallback) fires its `op`.
 *
 * These are intentionally structural interfaces (not a Zod schema) so a host
 * schema — e.g. a richer "blueprint spine" — whose step/gate objects carry MORE
 * fields is assignable to them and runs through the same interpreter unchanged.
 * `args` is optional here (defaulted to `{}` by the interpreter) so a host whose
 * schema makes it required is still assignable.
 */
import type { Scope } from './expr.js';

export type { Scope };

/**
 * The condition evaluator seam (the `when`-language injection point). `when` is
 * opaque to the interpreter — a consumer injects how to evaluate it against the
 * scope. The built-in default is the string-expr `evalExpr` (so step-program is
 * usable standalone), but the papercusp spine injects `@papercusp/rules`'
 * `evaluateDataCondition` so a `when` is the canonical serializable `MatchMap`
 * (adopt-event-rules-engines D-002 — one condition language across all layers).
 */
export type WhenEval = (when: unknown, scope: Scope) => boolean;

/** One step: invoke `op` with interpolated `args`, optionally guarded + bound. */
export interface Step {
  /** Human/debug id; the runner derives the op-call label `op-<id>` from it. */
  id: string;
  /** The op to invoke — a name the injected `runOp` resolves. */
  op: string;
  /** Op args, `{{ path }}`-interpolated against the bound scope before invoke. */
  args?: Record<string, unknown>;
  /** Scope key to bind the op's result under (later steps + the gate read it). */
  bind?: string;
  /** Optional condition over the scope — skip the step when false. Opaque: the
   *  injected `WhenEval` interprets it (a string expr by default, a `MatchMap`
   *  when the consumer injects `evaluateDataCondition`). */
  when?: unknown;
}

/** One gate branch: fire `op` when `when` is true (or as the fallback). */
export interface GateBranch {
  /** Condition over the scope; omit (or set `else`) for the fallback. Opaque —
   *  see {@link Step.when} / {@link WhenEval}. */
  when?: unknown;
  /** Marks the fallback branch (sugar; an omitted `when` is equivalent). */
  else?: boolean;
  /** The op this branch fires. */
  op: string;
  /** Op args, `{{ path }}`-interpolated against the bound scope. */
  args?: Record<string, unknown>;
}

/** A program: an ordered list of steps, then a conditional decision gate. */
export interface Program {
  steps: Step[];
  gate?: GateBranch[];
}
