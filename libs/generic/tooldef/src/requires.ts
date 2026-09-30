/**
 * requires.ts — declarative tool PRECONDITIONS (the preInvoke mirror of `emits:`).
 *
 * A tool declares `requires: [ToolRequireSpec, …]` on `defineTool`: each spec is
 * a declarative condition (a `@papercusp/rules` DataCondition / MatchMap over
 * `{ tool, args, ctx, state }`) that must HOLD for the call to proceed, plus a
 * response when it does not —
 *
 *   - `{ error }`                 → REJECT the call (`precondition_failed`).
 *   - `{ fire, then: 'retry' }`   → AUTO-CORRECT: fire a corrective tool through
 *                                   the host's injectable fire port, re-resolve
 *                                   state, re-evaluate ONCE; reject if it still
 *                                   fails. Always visible (audited), never silent.
 *
 * The dispatcher evaluates these in the `preconditions` dispatch-stack step
 * (after `authorize`, before `timeout`) via `evaluateDataCondition` — the same
 * engine `emits:`-desugared reaction rules run on. This lifts hardcoded
 * `throw`-style guards out of handlers into declarative, inspectable,
 * uniformly-enforced policy (autoloop-pot-operator-rebuild-2026-06-05 D-006).
 *
 * SAFETY INVARIANTS ARE EXCLUDED BY DESIGN (D-007): don't-deploy-on-red,
 * protected-paths, budget/quota caps, the auth perimeter and friends stay
 * imperative + audited gates in code. `requires:` is for *functional*
 * preconditions (an arg shape, a resolvable scope, a resumable resource) —
 * never for a guard whose failure mode is harm.
 *
 * Conditions are DECLARATIVE ONLY — there is deliberately no JS-predicate
 * escape-hatch here (unlike `emits.when`): a predicate would defeat the lift
 * (inspectability, serializability). Host state enters through the spec's
 * `state` resolver instead.
 */

import type { DataCondition } from '@papercusp/rules';

/**
 * The event shape a precondition's condition evaluates over — the preInvoke
 * mirror of `ToolEventLike` (which is postInvoke). There is no `result` yet;
 * host state the condition needs is resolved into `state` by the spec's
 * resolver. Structural + domain-free, like `ToolEventLike`.
 */
export interface ToolPreInvokeEvent {
  /** The tool being invoked (MCP name, e.g. `'autoloop:status'`). */
  tool: string;
  /**
   * The RAW input args (pre-schema-validation — argument zod parsing happens
   * inside the invoke step's wrapper, after the gates). Test presence/values,
   * not zod defaults.
   */
  args: Record<string, unknown>;
  /** Invocation context — the fields a condition commonly reads. Structural/open. */
  ctx: {
    uiClientId?: string | null;
    harnessSlug?: string | null;
    workspaceId?: string | null;
    role?: string | null;
    runId?: string | null;
    spawnId?: string | null;
    [key: string]: unknown;
  };
  /** Host state resolved by the spec's `state` resolver; `{}` when none declared. */
  state: Record<string, unknown>;
}

/**
 * One declarative precondition on a tool. See the module doc for semantics.
 */
export interface ToolRequireSpec {
  /**
   * Optional explicit id (diagnostics + audit). Defaults to the entry's index
   * in the `requires` array.
   */
  id?: string;
  /**
   * The precondition — a declarative DataCondition (a MatchMap of
   * dot-path → OperatorTest, or `all`/`any`/`not` combinators) over
   * `{ tool, args, ctx, state }` that must HOLD for the call to proceed.
   * e.g. `{ any: [{ 'args.harnessSlug': { exists: true } }, { 'ctx.harnessSlug': { exists: true } }] }`.
   */
  when: DataCondition;
  /**
   * Resolve host state the condition needs (a PG read, a config probe, …).
   * Omitted ⇒ `state` is `{}` and the condition is over `tool`/`args`/`ctx`
   * only. Re-resolved after an auto-correct fire, before the retry
   * evaluation. Keep it READ-ONLY — corrections go through `fire`.
   */
  state?: (
    args: Record<string, unknown>,
    ctx: ToolPreInvokeEvent['ctx'],
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  /**
   * Reject message when the precondition fails (after the auto-correct retry,
   * when `fire` is declared). Defaults to a generic message naming the spec.
   */
  error?: string;
  /**
   * Auto-correct: the corrective tool to fire (MCP name) when the condition
   * fails. Fired through the host's `DispatchProjectedDeps.firePrecondition`
   * port — fail-closed when the host wired none. Implies `then: 'retry'`.
   */
  fire?: string;
  /**
   * Derive the corrective fire's args from the (failed) pre-invoke event.
   * Keep it PURE — no I/O. Default `{}`. Mirrors `ToolEmitSpec.render`.
   */
  render?: (event: ToolPreInvokeEvent) => Record<string, unknown>;
  /**
   * Post-fire behavior. `'retry'` (the only mode, and the default when `fire`
   * is set): re-resolve state + re-evaluate once; reject if still failing.
   */
  then?: 'retry';
}

/** The payload the dispatcher hands the host's precondition fire port. */
export interface PreconditionFireRequest {
  /** The corrective tool to fire (MCP name). */
  fire: string;
  /** Resolved args for the corrective call (from the spec's `render`). */
  args: Record<string, unknown>;
  /** The trigger tool whose precondition failed. */
  trigger: string;
  /** The failing precondition's id. */
  requireId: string;
  /** The trigger's invocation ctx — the host re-scopes the corrective call with it. */
  ctx: ToolPreInvokeEvent['ctx'];
}
