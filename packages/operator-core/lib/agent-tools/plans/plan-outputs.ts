/**
 * plan-outputs — the pure core of a plan's declared OUTPUTS
 * (external-triggers-gmail-slack-2026-08-22 P-026 / D-017).
 *
 * Two things live here, both DB-free so they unit-test without a live PG and so the
 * declare door and the publish door cannot drift apart by re-implementing the same
 * rule twice:
 *
 *   1. `collectDatatypeRefs` — which canonical datatypes an output schema REFERENCES.
 *      D-004 is the standing convention that external-data shapes are canonical
 *      platform datatypes in the reflexive registry rather than app-local types
 *      ("we don't want each app built on papercusp inventing their own version of a
 *      post or email"), and D-017 binds plan outputs to it. A plan therefore names a
 *      shape rather than re-describing it: `{ properties: { msg: { datatype:
 *      'email-message' } } }`. The reference is a plain JSON Schema ANNOTATION, which
 *      is why it costs nothing structurally — the shared ajv seam runs `strict: false`,
 *      so an unknown keyword is carried, not rejected, and a schema using it still
 *      compiles for every other consumer.
 *
 *   2. `evaluatePublishOutputs` — whether a completing run's published values satisfy
 *      what the plan promised. D-017's publication rule is explicit and is the reason
 *      this is a gate rather than a store: "a declared-but-unfilled output fails the
 *      run loudly rather than silently chaining undefined values."
 *
 * WHY THE FAIL-LOUD RULE IS STRUCTURAL, not defensive coding: a declared output is a
 * PROMISE to a downstream step. Per D-015 a deterministic target (a recipe, or a
 * one-step tool call) may only be fed by an upstream that declared its outputs,
 * precisely because no agent interprets a loose payload for it. So an unfilled output
 * does not degrade into "a missing field" — it becomes `undefined` flowing into a step
 * that has no way to notice. The loud failure is what keeps the optionality in D-017
 * ("outputs should be optional") honest: optional to DECLARE, mandatory to FILL once
 * declared.
 *
 * Note the deliberate contrast with `validateDatatypePayload`, whose fail-OPEN policy
 * on a malformed schema is correct for its own domain (a datatype-declaration bug must
 * not block instance creation). It is NOT correct here, for the same reason the plan
 * START gate refuses it: "could not check" must never render as "nothing was promised".
 * That is why the compile check happens at DECLARE time (set-output-schema) and this
 * module treats an uncompilable schema as a hard failure rather than a pass.
 */

import { checkAgainstJsonSchema } from '../../json-schema-validation';
import { jsonSchemaRequiredKeys } from '../../json-schema-validation';

/** Guard for a plain object node inside a JSON Schema. */
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every canonical datatype name an output schema references, deduped, in first-seen
 * order. Walks nested `properties` / `items` / `$defs` and the applicator arrays so a
 * reference is found wherever it is legal to write one — a reference the walk missed
 * would be silently unvalidated, which is the failure this whole module exists to
 * prevent. Depth-bounded: a hand-authored schema is shallow, and a bound means a
 * cyclic or pathological input cannot hang the declare door.
 */
export function collectDatatypeRefs(schema: unknown, maxDepth = 12): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > maxDepth) return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    if (!isObj(node)) return;
    const dt = node.datatype;
    if (typeof dt === 'string' && dt.trim() && !seen.has(dt.trim())) {
      seen.add(dt.trim());
      out.push(dt.trim());
    }
    for (const key of ['properties', '$defs', 'definitions', 'patternProperties']) {
      const sub = node[key];
      if (isObj(sub)) for (const v of Object.values(sub)) walk(v, depth + 1);
    }
    for (const key of ['items', 'additionalProperties', 'contains', 'not']) {
      walk(node[key], depth + 1);
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
      walk(node[key], depth + 1);
    }
  };
  walk(schema, 0);
  return out;
}

/**
 * Map of a referenced datatype name → its registry `payload_schema` (null when the
 * datatype declares no payload constraint). A name ABSENT from this map is an
 * unknown datatype; the caller resolves the map from the registry so this module
 * stays DB-free.
 */
export type DatatypeSchemas = Readonly<Record<string, Record<string, unknown> | null>>;

export type PublishOutputsVerdict =
  | { ok: true; published: Record<string, unknown>; keys: string[] }
  /** The plan promised nothing — publishing to it is a caller bug, not a no-op. */
  | { ok: false; code: 'no_outputs_declared' }
  /** Declared-but-unfilled: D-017's loud failure. */
  | { ok: false; code: 'missing_outputs'; missing: string[] }
  /** The values do not satisfy the plan's own declared schema. */
  | { ok: false; code: 'invalid_outputs'; errors: string[] }
  /** A value does not satisfy the CANONICAL shape its field references (D-004). */
  | { ok: false; code: 'datatype_mismatch'; datatype: string; field: string; errors: string[] }
  /** Stored schema will not compile — refused, never treated as "nothing promised". */
  | { ok: false; code: 'bad_schema' };

/**
 * The pure publication decision for one completing run. `outputSchema` is the plan's
 * declared promise (null ⇒ the plan declared none), `outputs` the values the executing
 * agent filled, `datatypeSchemas` the resolved registry shapes for whatever
 * `collectDatatypeRefs(outputSchema)` returned. Never throws.
 *
 * Order is deliberate: MISSING is reported before INVALID. An unfilled required output
 * and a malformed one are different failures with different fixes, and the missing-field
 * message is the more actionable of the two — reporting "invalid" for a field the agent
 * simply never filled would send it to inspect a value that does not exist.
 */
export function evaluatePublishOutputs(
  outputSchema: Record<string, unknown> | null,
  outputs: unknown,
  datatypeSchemas: DatatypeSchemas = {},
): PublishOutputsVerdict {
  if (outputSchema === null) return { ok: false, code: 'no_outputs_declared' };

  const values: Record<string, unknown> = isObj(outputs) ? outputs : {};

  // D-017's loud failure, checked FIRST and by the same helper the input side uses for
  // `required`, so "what did this plan promise" has one reading across both doors.
  const required = jsonSchemaRequiredKeys(outputSchema);
  const missing = required.filter(
    (k) => !(k in values) || values[k] === undefined || values[k] === null,
  );
  if (missing.length > 0) return { ok: false, code: 'missing_outputs', missing };

  const r = checkAgainstJsonSchema(outputSchema, values);
  if (!r.ok) {
    // Unlike validateDatatypePayload, an uncompilable schema is FATAL here — see the
    // module header: a promise that cannot be checked must not pass as one that was.
    if (r.code === 'bad_schema') return { ok: false, code: 'bad_schema' };
    return {
      ok: false,
      code: 'invalid_outputs',
      errors: r.errors.length > 0 ? r.errors : ['outputs are invalid'],
    };
  }

  // Per-field canonical-shape check (D-004): a field that names a platform datatype is
  // held to THAT shape, not merely to whatever the plan restated locally.
  const props = isObj(outputSchema.properties) ? outputSchema.properties : {};
  for (const [field, spec] of Object.entries(props)) {
    if (!isObj(spec)) continue;
    const dt = typeof spec.datatype === 'string' ? spec.datatype.trim() : '';
    if (!dt) continue;
    if (!(field in values)) continue; // optional + absent: nothing to check
    const payloadSchema = datatypeSchemas[dt];
    if (payloadSchema == null) continue; // datatype imposes no payload constraint
    const dr = checkAgainstJsonSchema(payloadSchema, values[field]);
    if (!dr.ok && dr.code !== 'bad_schema') {
      return {
        ok: false,
        code: 'datatype_mismatch',
        datatype: dt,
        field,
        errors: dr.errors.length > 0 ? dr.errors : [`value does not match datatype ${dt}`],
      };
    }
  }

  return { ok: true, published: values, keys: Object.keys(values) };
}
