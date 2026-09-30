/**
 * goal-io-validation — the ONE seam for a goal's typed INPUTS and OUTPUTS
 * (work-on-everything-goal-2026-08-23 P-021, migration 927).
 *
 * Mirrors the plan pair — plan-input-validation.ts (start readiness) and
 * plan-outputs.ts (publication) — with the differences the goal shape forces:
 *
 *   - ONE schema source. A goal has no code-registry `template:` competitor for
 *     its arguments, so plan-input-validation's conflict case has no analogue.
 *   - ONE row. A goal is its own instance (the template half of its lifecycle is
 *     the Cupboard PACKAGE, P-006), so schema and values live side by side on
 *     `harness_shared.goals` (input_schema/inputs, output_schema/outputs) rather
 *     than splitting across a template row and a run row.
 *   - Inputs arrive COMPLETE at start. Plans draft `template_data` incrementally
 *     (D-004), which is why their WRITE-side check tolerates missing required
 *     fields; a goal's inputs are collected once, at the start door, so this
 *     check enforces completeness immediately. The top-level-`required`
 *     ownership split is kept anyway so "missing" and "invalid" stay two
 *     different, separately-actionable messages (absence is the one a caller
 *     can act on).
 *
 * The achieved-side OUTPUT check is not a mirror but a DELEGATION: a goal
 * publishing its product at wind-down is the same decision as a plan run
 * publishing at completion, so `evaluateGoalWindDownOutputs` calls
 * plan-outputs' `evaluatePublishOutputs` for it — one publication rule, two
 * doors, no drift (D-017's "optional to DECLARE, mandatory to FILL once
 * declared", the canonical-datatype field check included).
 *
 * Fail-CLOSED like the plan gates: an uncompilable schema refuses, because
 * "could not check" must never render as "nothing was required/promised".
 * Pure + DB-free; unit-tests without PG.
 */

import {
  checkAgainstJsonSchema,
  jsonSchemaRequiredKeys,
  withoutTopLevelRequired,
} from '../json-schema-validation';
import {
  evaluatePublishOutputs,
  type DatatypeSchemas,
} from '../agent-tools/plans/plan-outputs';
import type { GoalDisposition } from './wind-down-disposition';

/** A jsonb column is only usable as a schema when it is a plain object. */
function asJsonSchema(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Values, normalized: a non-object (null / undefined / array) supplies nothing. */
function asData(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export type GoalStartInputsVerdict =
  | { ready: true; inputs: Record<string, unknown> | null }
  | {
      ready: false;
      code: 'missing_required' | 'invalid_inputs' | 'bad_schema';
      /** Declared-required field names that were not supplied. */
      missing: string[];
      /** Validation issues, when the failure is a schema violation rather than absence. */
      issues: string[];
      /** One-line, actionable explanation — surfaced verbatim by the start doors. */
      hint: string;
    };

/**
 * THE GOAL START GATE for typed inputs — the sibling of
 * `evaluatePlanStartReadiness`, consulted by every door that starts a goal
 * (goals:start today; the package start door P-017 when it lands), so two
 * doors cannot drift into two notions of "ready".
 *
 * A goal that declares NO schema is always ready — no required fields — which
 * is why this gate is a no-op for the entire existing goal corpus and needs no
 * flag. Inputs supplied WITHOUT a schema are carried as-is (unvalidated
 * context is allowed; un-CHECKABLE promises are not, which is the schema-side
 * rule below).
 *
 * `missing` is reported ahead of raw validation issues, because "you did not
 * supply `budgetWindow`" is the answer a caller can act on.
 */
export function evaluateGoalStartInputs(
  inputSchema: unknown,
  inputs: unknown,
): GoalStartInputsVerdict {
  const schema = asJsonSchema(inputSchema);
  const supplied = asData(inputs);
  const carried = Object.keys(supplied).length > 0 ? supplied : null;
  if (!schema || Object.keys(schema).length === 0) {
    return { ready: true, inputs: carried };
  }

  // Completeness first: absence is the more actionable failure.
  const required = jsonSchemaRequiredKeys(schema);
  const missing = required.filter((k) => supplied[k] === undefined);
  if (missing.length > 0) {
    return {
      ready: false,
      code: 'missing_required',
      missing,
      issues: [],
      hint:
        `Required input${missing.length > 1 ? 's' : ''} not supplied: ${missing.join(', ')}. ` +
        `Pass ${missing.length > 1 ? 'them' : 'it'} as \`inputs\` on the start call.`,
    };
  }

  // Structural validity, minus top-level `required` — required-ness has exactly
  // one owner (the `missing` computation above), so ajv must not report it a
  // second time in a different voice. Nested required stays enforced.
  const r = checkAgainstJsonSchema(withoutTopLevelRequired(schema), supplied);
  if (r.ok) return { ready: true, inputs: carried };
  if (r.code === 'bad_schema') {
    return {
      ready: false,
      code: 'bad_schema',
      missing: [],
      issues: r.errors,
      hint:
        `This goal's input_schema is not a compilable JSON Schema, so its required fields ` +
        `cannot be checked. Re-declare it (goals:set-input-schema validates on declare). ` +
        `Starting is refused rather than allowed unchecked.`,
    };
  }
  return {
    ready: false,
    code: 'invalid_inputs',
    missing: [],
    issues: r.errors,
    hint: `The supplied inputs do not satisfy this goal's input_schema: ${r.errors.join('; ')}`,
  };
}

export type GoalWindDownOutputsVerdict =
  | { ok: true; outputs: Record<string, unknown> | null }
  | {
      ok: false;
      code: 'no_outputs_declared' | 'missing_outputs' | 'invalid_outputs' | 'datatype_mismatch' | 'bad_schema';
      missing: string[];
      errors: string[];
      /** One-line, actionable explanation — surfaced verbatim by the wind-down doors. */
      hint: string;
    };

/**
 * The wind-down decision for a goal's declared outputs, per disposition:
 *
 *   - `handoff`  — the goal STAYS ACTIVE; nothing is recorded yet. Always ok
 *     with `outputs: null`, whatever was passed: the continuing owner reports
 *     at the real wind-down.
 *   - `achieved` + declared schema — the full publication rule, DELEGATED to
 *     plan-outputs' `evaluatePublishOutputs`: a declared-but-unfilled output
 *     fails the achieve loudly rather than chaining undefined downstream, and
 *     a field naming a canonical datatype is held to that shape.
 *   - `killed` + declared schema — outputs are OPTIONAL (an abandoned goal
 *     need not have produced), and a PARTIAL product is acceptable: supplied
 *     values are validated minus top-level `required`, so what is recorded is
 *     honest without demanding completeness from an abandonment.
 *   - No declared schema — supplying outputs refuses (`no_outputs_declared`,
 *     the plan rule: publishing to a subject that promised nothing is a caller
 *     bug, not a no-op); supplying none is the ordinary ok.
 */
export function evaluateGoalWindDownOutputs(opts: {
  outputSchema: unknown;
  outputs: unknown;
  disposition: GoalDisposition;
  /** Resolved registry shapes for datatype-ref'd fields; caller supplies (DB-free here). */
  datatypeSchemas?: DatatypeSchemas;
}): GoalWindDownOutputsVerdict {
  if (opts.disposition === 'handoff') return { ok: true, outputs: null };

  const schema = asJsonSchema(opts.outputSchema);
  const values = asData(opts.outputs);
  const suppliedAny = Object.keys(values).length > 0;

  if (!schema || Object.keys(schema).length === 0) {
    if (suppliedAny) {
      return {
        ok: false,
        code: 'no_outputs_declared',
        missing: [],
        errors: [],
        hint:
          `This goal declares no output_schema, so there is nothing these outputs were ` +
          `promised AS. Declare the schema first (goals:set-output-schema) or drop the ` +
          `outputs — recording unpromised values would let a downstream consumer rely on ` +
          `a shape nothing checks.`,
      };
    }
    return { ok: true, outputs: null };
  }

  if (opts.disposition === 'killed') {
    if (!suppliedAny) return { ok: true, outputs: null };
    const r = checkAgainstJsonSchema(withoutTopLevelRequired(schema), values);
    if (r.ok) return { ok: true, outputs: values };
    if (r.code === 'bad_schema') {
      return {
        ok: false,
        code: 'bad_schema',
        missing: [],
        errors: r.errors,
        hint:
          `This goal's output_schema does not compile, so the partial outputs cannot be ` +
          `checked. Fix the schema (goals:set-output-schema) or omit the outputs — a ` +
          `killed goal records none by default.`,
      };
    }
    return {
      ok: false,
      code: 'invalid_outputs',
      missing: [],
      errors: r.errors,
      hint: `The supplied outputs do not satisfy this goal's output_schema: ${r.errors.join('; ')}`,
    };
  }

  // achieved — the publication rule, one implementation shared with plan runs.
  const v = evaluatePublishOutputs(schema, values, opts.datatypeSchemas ?? {});
  if (v.ok) return { ok: true, outputs: v.published };
  switch (v.code) {
    case 'missing_outputs':
      return {
        ok: false,
        code: 'missing_outputs',
        missing: v.missing,
        errors: [],
        hint:
          `Disposition 'achieved' with declared outputs unfilled: ${v.missing.join(', ')}. ` +
          `A declared output is a promise — fill ${v.missing.length > 1 ? 'them' : 'it'} via ` +
          `the \`outputs\` arg, or (honestly) wind down as 'killed', which does not demand a product.`,
      };
    case 'invalid_outputs':
      return {
        ok: false,
        code: 'invalid_outputs',
        missing: [],
        errors: v.errors,
        hint: `The reported outputs do not satisfy this goal's output_schema: ${v.errors.join('; ')}`,
      };
    case 'datatype_mismatch':
      return {
        ok: false,
        code: 'datatype_mismatch',
        missing: [],
        errors: v.errors,
        hint:
          `Output field '${v.field}' references canonical datatype '${v.datatype}' and the ` +
          `reported value does not match that registry shape: ${v.errors.join('; ')}`,
      };
    case 'bad_schema':
      return {
        ok: false,
        code: 'bad_schema',
        missing: [],
        errors: [],
        hint:
          `This goal's output_schema does not compile, so what it promised cannot be ` +
          `checked — refused rather than passed unchecked. Re-declare it via ` +
          `goals:set-output-schema.`,
      };
    case 'no_outputs_declared':
      // Unreachable (schema non-null here), kept so the switch is total.
      return { ok: true, outputs: null };
  }
}
