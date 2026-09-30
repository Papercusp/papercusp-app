/**
 * json-schema-validation — the ONE ajv seam for runtime-DECLARED JSON Schemas.
 *
 * Two subsystems let a caller declare a schema while the operator is running and
 * then validate instances against it:
 *
 *   - datatypes (`meta:define-datatype`'s `payload_schema`, migration 605) — a
 *     work_item payload is checked against the kind's declared schema;
 *   - plans (`plans:set-input-schema`, migration 714) — a plan's `template_data`
 *     is checked against the plan's declared input schema, and its `required`
 *     array is what makes a field mandatory at start time.
 *
 * They are the same problem, so they share one ajv instance and one compiled-
 * validator cache rather than each standing up their own (the second hand-rolled
 * validator is how two callers drift into disagreeing about the same schema).
 * This module was extracted from `datatype-payload-validation.ts`, which now
 * delegates to it and keeps its own domain-named wrapper.
 *
 * ⚠ FAIL-CLOSED BY DEFAULT. `checkAgainstJsonSchema` reports a non-compilable
 * schema as `bad_schema` rather than waving the value through. The datatype path
 * deliberately maps that back to ok (its declare-time gate owns schema validity,
 * and a declaration bug must not block instance creation), but the plan START
 * gate must NOT: a plan whose schema does not compile cannot have its required
 * fields checked, and "we could not check" must never render as "nothing was
 * required". A malformed schema can still reach a live row despite the
 * declare-time gate — federation's projection INSERT applies a peer's jsonb
 * without revalidating it, and a direct SQL write bypasses the verb entirely —
 * so the gate keeps its own guard rather than trusting an upstream one.
 *
 * Pure + cached; unit-testable with no DB.
 */
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject, ValidateFunction } from 'ajv';

// One instance; compiled validators cached by serialized schema. A workspace's
// declared schemas are few and stable, so this avoids recompiling per call.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const cache = new Map<string, ValidateFunction>();

/** Compile (or reuse) a validator for `schema`. Throws on a malformed schema. */
export function compileJsonSchema(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = cache.get(key);
  if (!v) {
    v = ajv.compile(schema);
    cache.set(key, v);
  }
  return v;
}

/** True iff `schema` is a compilable JSON Schema. The DECLARE-time gate: reject a
 *  malformed schema at the door so validation never has to guess later. */
export function isCompilableSchema(schema: Record<string, unknown>): boolean {
  try {
    compileJsonSchema(schema);
    return true;
  } catch {
    return false;
  }
}

/** ajv errors as readable `"<path> <message>"` lines. */
export function formatSchemaErrors(
  errors: readonly ErrorObject[] | null | undefined,
  fallback = 'value is invalid',
): string[] {
  if (!errors || errors.length === 0) return [fallback];
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim());
}

export type JsonSchemaCheck =
  | { ok: true }
  | { ok: false; code: 'invalid_data'; errors: string[] }
  | { ok: false; code: 'bad_schema'; errors: string[] };

/**
 * Validate `value` against `schema`, FAIL-CLOSED (see the module header).
 *
 *   - null / empty schema ⇒ ok (no constraint was declared).
 *   - non-compilable schema ⇒ `bad_schema` (the caller decides whether that is
 *     fatal; it is fatal for the plan start gate, tolerated for datatypes).
 *   - otherwise `value` must satisfy the schema.
 */
export function checkAgainstJsonSchema(
  schema: Record<string, unknown> | null | undefined,
  value: unknown,
): JsonSchemaCheck {
  if (!schema || Object.keys(schema).length === 0) return { ok: true };
  let validate: ValidateFunction;
  try {
    validate = compileJsonSchema(schema);
  } catch (e) {
    return {
      ok: false,
      code: 'bad_schema',
      errors: [e instanceof Error ? e.message : String(e)],
    };
  }
  if (validate(value ?? {})) return { ok: true };
  return { ok: false, code: 'invalid_data', errors: formatSchemaErrors(validate.errors) };
}

/**
 * The schema's TOP-LEVEL `required` property names, in declaration order.
 *
 * Deliberately top-level only: this feeds the human/agent-facing `missing[]` list
 * on a refused plan start, where "you did not supply `harness`" is the useful
 * answer. A violation nested inside a supplied object is a genuine schema
 * violation and surfaces through `invalid_data`'s errors with its full instance
 * path, which is the more informative shape for that case anyway.
 */
export function jsonSchemaRequiredKeys(
  schema: Record<string, unknown> | null | undefined,
): string[] {
  if (!schema) return [];
  const req = (schema as { required?: unknown }).required;
  if (!Array.isArray(req)) return [];
  return req.filter((k): k is string => typeof k === 'string');
}

/**
 * `schema` with its TOP-LEVEL `required` dropped — everything else (types,
 * enums, formats, additionalProperties, NESTED required) still enforced.
 *
 * For callers that own required-ness themselves (a start/publish gate computing
 * an actionable `missing[]` list): validating with the full schema would give
 * the same rule two owners and two messages, so they validate against this and
 * report absence separately. Moved here from plan-input-validation.ts when the
 * goal seam (goal-io-validation.ts, work-on-everything-goal-2026-08-23 P-021)
 * became its second caller.
 */
export function withoutTopLevelRequired(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray((schema as { required?: unknown }).required)) return schema;
  const { required: _required, ...rest } = schema;
  return rest;
}

/**
 * Which of the schema's top-level required keys are absent from `value`.
 *
 * `undefined` counts as absent; an explicit `null` does NOT — supplying null is
 * supplying a value, and whether null is acceptable is the schema's own call
 * (`type: ['string','null']` says yes). Conflating the two would make it
 * impossible to pass a deliberate null for a required nullable field.
 */
export function missingRequiredJsonSchemaKeys(
  schema: Record<string, unknown> | null | undefined,
  value: unknown,
): string[] {
  const required = jsonSchemaRequiredKeys(schema);
  if (required.length === 0) return [];
  const obj =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return required.filter((k) => obj[k] === undefined);
}
