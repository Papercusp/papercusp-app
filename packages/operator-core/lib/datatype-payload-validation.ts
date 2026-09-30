/**
 * datatype-payload-validation — validate a datatype INSTANCE payload against the
 * datatype's declared `payload_schema` (reflexive-platform-extensibility-datatypes P-001).
 *
 * This is the "validation" a datatype exists to provide: when you create a `bet` via
 * `work_items:create { kind:'bet', payload }`, the payload is checked against the schema the
 * datatype declared — a malformed bet is REJECTED instead of stored as an untyped blob.
 *
 * The ajv machinery itself now lives in `./json-schema-validation`, shared with the
 * plan-input schemas that migration 714 added (plan-structured-inputs-2026-08-01 P-002) —
 * same problem, one instance, one compiled-validator cache. This module keeps the
 * DOMAIN-named wrapper and, importantly, this domain's fail-open policy: see below.
 */
import {
  checkAgainstJsonSchema,
  isCompilableSchema as isCompilableJsonSchema,
} from './json-schema-validation';

/** True iff `schema` is a compilable JSON Schema. Used at DECLARE time to reject a datatype
 *  whose `payload_schema` is malformed, so instance creation never has to fail-open. */
export const isCompilableSchema = isCompilableJsonSchema;

export type PayloadValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate `payload` against a datatype's `payload_schema`.
 *   - null / empty schema ⇒ ok (the datatype imposes no payload constraint).
 *   - malformed schema ⇒ ok (fail-open: a datatype-declaration bug must not block instance
 *     creation; declare-time `isCompilableSchema` is the gate that catches it).
 *   - otherwise the payload must satisfy the schema.
 *
 * The fail-open branch is deliberate and LOCAL TO DATATYPES — the shared seam reports a
 * non-compilable schema as `bad_schema` and this wrapper maps it back to ok. Do not copy
 * that mapping into a gate that DENIES on failure (the plan start gate treats `bad_schema`
 * as fatal, because "could not check" must not render as "nothing was required").
 */
export function validateDatatypePayload(
  schema: Record<string, unknown> | null | undefined,
  payload: unknown,
): PayloadValidation {
  const r = checkAgainstJsonSchema(schema, payload ?? {});
  if (r.ok) return { ok: true };
  if (r.code === 'bad_schema') return { ok: true }; // declare-time gate owns schema validity
  return { ok: false, errors: r.errors.length > 0 ? r.errors : ['payload is invalid'] };
}
