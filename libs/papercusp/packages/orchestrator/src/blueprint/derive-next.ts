/**
 * `deriveNext` — the pure blueprint-spine interpreter that replaces the
 * `classifyDecision` switch (`harness-blueprint-orchestration-2026-06-03` P-003,
 * D-002/D-024).
 *
 * The director (spine.decider) emits a `DecisionVerb` each turn; `deriveNext`
 * looks the verb up in `spine.edges` and returns the corresponding
 * `PipelineAction`, falling back to `spine.default` for a null/unparseable
 * decision or a verb with no edge. It is the *flat-graph* engine (D-024): a data
 * lookup, not a switch. The `coding` blueprint encodes today's 20-case switch as
 * `edges`, so `deriveNext(coding.spine, …)` is byte-equivalent to
 * `classifyDecision(…)` — proven by the operator-side equivalence test before
 * the live wire-in (P-004).
 *
 * Pure: reads only its arguments, no I/O / DB / DBOS. The durable workflow
 * consumes its output; the side-effectful work happens behind injected seams.
 */
import type { BlueprintSpine, SpineAction } from './schema.js';
import type { PipelineAction } from './action.js';

/**
 * The minimal parsed-decision shape `deriveNext` reads — satisfied by both
 * `ParsedDecision` (built-in verbs) and `ParsedSpineDecision` (a blueprint's own
 * vocabulary). Kept structural so the interpreter is vocabulary-agnostic.
 */
export interface ParsedDecisionLike {
  verb: string;
  arg: string | null;
  n: number | null;
}

/** Stop cleanly — nothing to do here; the dispatcher will re-scan. */
const STOP_IDLE: PipelineAction = { kind: 'terminal', outcome: 'idle' };

/**
 * Expand `extras` templates against the decision. `{feature}` → the resolved
 * feature (arg ?? defaultFeature); `{arg}` → the raw arg (or '' when absent).
 * Mirrors the legacy switch's `FEATURE_ID=${feature}` / `VAL_ID=${arg ?? ''}`.
 */
function templateExtras(extras: string[], feature: string, arg: string | null): string[] {
  return extras.map((e) => e.replace(/\{feature\}/g, feature).replace(/\{arg\}/g, arg ?? ''));
}

/**
 * Map one spine action → a `PipelineAction`, given the decision context. Kept
 * separate so both the verb path and the `default` fallback share it.
 */
function actionFor(
  action: SpineAction,
  parsed: ParsedDecisionLike | null,
  defaultFeature: string,
): PipelineAction {
  const arg = parsed?.arg ?? null;
  const feature = arg ?? defaultFeature;

  switch (action.to) {
    case 'done':
      return { kind: 'terminal', outcome: 'done' };
    case 'idle':
      return STOP_IDLE;
    case 'escalate':
      // ESCALATE → `arg ?? ''`; CHECKPOINT (deprecated) → `arg ?? 'checkpoint…'`.
      // `reasonFrom: 'arg'` prefers the decision arg; `reason` is the fallback.
      return {
        kind: 'terminal',
        outcome: 'escalate',
        reason: action.reasonFrom === 'arg' ? arg ?? action.reason ?? '' : action.reason ?? '',
      };
    case 'role': {
      // Per-feature pipelines reject parallel-lane (N=k) dispatch for this verb
      // (D-001) — lanes are the global orchestrator's job.
      if (action.rejectWhenParallel && parsed?.n != null) {
        return { kind: 'unsupported', verb: `${parsed.verb} N=${parsed.n}` };
      }
      return {
        kind: 'dispatch',
        role: action.role,
        feature,
        extras: templateExtras(action.extras, feature, arg),
      };
    }
    case 'unsupported':
      return { kind: 'unsupported', verb: parsed?.verb ?? '<unknown>' };
  }
}

/**
 * Derive the next pipeline action from a blueprint spine + a parsed decision.
 * `defaultFeature` is the pipeline's bound feature id (used when the decision
 * omits an arg). Returns `spine.default` for a null decision or an unmapped verb.
 */
export function deriveNext(
  spine: BlueprintSpine,
  parsed: ParsedDecisionLike | null,
  defaultFeature: string,
): PipelineAction {
  // `edges` is optional on the schema (a program-mode spine omits it — D-002);
  // deriveNext is the decider-model interpreter, so treat an absent map as "no
  // edge for any verb" → the default.
  const edges = spine.edges ?? {};
  if (!parsed) return actionFor(spine.default, null, defaultFeature);
  const edge = edges[parsed.verb] ?? spine.default;
  return actionFor(edge, parsed, defaultFeature);
}
