/**
 * plan-input-validation — the ONE seam every plan-input check goes through
 * (plan-structured-inputs-2026-08-01 P-004 + P-005).
 *
 * A plan's input VALUES always live in the `template_data` jsonb (D-001 — one value
 * slot). Their SCHEMA comes from one of two sources (D-002):
 *
 *   - `template:` — a code-registry zod type (in-tree, e.g. `rubric`). Type-safe,
 *     but adding one requires shipping code.
 *   - `input_schema` — a plan-authored JSON Schema (mig 714). Runtime-declarable,
 *     which is the whole point: agents author plans while the operator runs.
 *
 * They are MUTUALLY EXCLUSIVE. plans:set-input-schema refuses to create the overlap,
 * but this module still checks for it, because that verb is not the only way a row
 * can acquire both: federation's projection applies a peer's jsonb without
 * re-running our verbs, and a direct SQL write bypasses them entirely. A gate that
 * trusted an upstream guarantee it cannot enforce would be a gate with a hole in it.
 *
 * Two exports, deliberately layered:
 *
 *   validatePlanData          — is this data VALID for the plan's schema? Used on
 *                               WRITE, where partial data is fine (D-004).
 *   evaluatePlanStartReadiness — is this plan STARTABLE? Same validation plus the
 *                               required-field completeness check that write skips.
 *
 * That split is the reason a plan can be drafted incrementally and still cannot be
 * started half-specified.
 */

import type { z } from 'zod';
import { getPlanTemplate, validateTemplateData } from './template-registry';
import {
  checkAgainstJsonSchema,
  jsonSchemaRequiredKeys,
  withoutTopLevelRequired,
} from '../../json-schema-validation';

/** The two schema-source columns of a plan, as the checks need them. */
export interface PlanSchemaRef {
  /** The `template:` frontmatter-derived type name, or null. */
  template: string | null;
  /** The `input_schema` jsonb, or null. */
  inputSchema: unknown;
}

export type PlanSchemaSource = 'template' | 'input-schema' | 'none' | 'conflict';

export type PlanDataCheck =
  | { ok: true; source: 'template' | 'input-schema'; data: unknown }
  | { ok: false; code: 'no_schema' }
  | { ok: false; code: 'schema_conflict'; template: string }
  | { ok: false; code: 'unknown_template'; template: string; known: string[] }
  | { ok: false; code: 'bad_schema'; issues: string[] }
  | {
      ok: false;
      code: 'invalid_data';
      source: 'template' | 'input-schema';
      template?: string;
      issues: string[];
    };

/** A jsonb column is only usable as a schema when it is a plain object. */
function asJsonSchema(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Values, normalized: a non-object (null / undefined / array) supplies nothing. */
function asData(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/*
 * Top-level `required` is dropped before ajv validation via
 * `withoutTopLevelRequired` (json-schema-validation.ts — moved there when the
 * goal seam, goal-io-validation.ts / P-021, became its second caller).
 * Required-ness has exactly ONE owner in this module: `planRequiredKeys` + the
 * `missing` computation in the start gate. Letting ajv ALSO enforce it would
 * give two owners and two messages for one rule — and, worse, would make
 * `validatePlanData` reject partial data, which is precisely what D-004
 * forbids: a writer that rejects every incomplete state makes a plan
 * impossible to draft incrementally. Nested required stays enforced: `missing`
 * only ever speaks about top-level fields, so nothing is left unowned.
 */

/** Which schema source this plan declares (or `conflict` when it declares both). */
export function planSchemaSource(ref: PlanSchemaRef): PlanSchemaSource {
  const template = ref.template?.trim() || null;
  // A malformed supplied schema is NOT the legacy/no-schema case. Federation
  // can bypass the authoring verb, so it must reach validation and fail closed.
  const hasSchema = ref.inputSchema !== null && ref.inputSchema !== undefined;
  if (template && hasSchema) return 'conflict';
  if (template) return 'template';
  if (hasSchema) return 'input-schema';
  return 'none';
}

/**
 * The top-level keys a code-registry zod schema requires.
 *
 * Read off the ZodObject shape rather than inferred from error messages: zod 4
 * reports a missing required field as "Invalid input: expected string, received
 * undefined", which does not say "missing" in any form a caller could match on.
 * Defensive by design — a non-object schema, or a zod build without the
 * introspection API, yields [] and the caller falls back to reporting the raw
 * validation issues, which is a worse message but never a wrong one.
 */
export function zodRequiredKeys(schema: z.ZodTypeAny | undefined): string[] {
  if (!schema) return [];
  try {
    const raw = (schema as unknown as { shape?: unknown })?.shape;
    const shape = (typeof raw === 'function' ? (raw as () => unknown)() : raw) as
      | Record<string, { isOptional?: () => boolean }>
      | undefined;
    if (!shape || typeof shape !== 'object') return [];
    return Object.entries(shape)
      .filter(([, v]) => typeof v?.isOptional === 'function' && !v.isOptional())
      .map(([k]) => k);
  } catch {
    return [];
  }
}

/** The declared required-field names for whichever source the plan uses. */
export function planRequiredKeys(ref: PlanSchemaRef): string[] {
  const source = planSchemaSource(ref);
  if (source === 'input-schema') return jsonSchemaRequiredKeys(asJsonSchema(ref.inputSchema));
  if (source === 'template') return zodRequiredKeys(getPlanTemplate(ref.template!.trim())?.schema);
  return [];
}

/**
 * Validate `data` against whichever schema the plan declares — the WRITE-side check.
 *
 * Completeness is NOT checked here: a required field may be absent and this still
 * returns ok, because plans are authored incrementally and a writer that rejected
 * every incomplete state would make a plan impossible to draft (D-004). The start
 * gate below is where completeness is enforced.
 */
export function validatePlanData(ref: PlanSchemaRef, data: unknown): PlanDataCheck {
  const source = planSchemaSource(ref);
  const template = ref.template?.trim() || null;

  if (source === 'conflict') {
    return { ok: false, code: 'schema_conflict', template: template! };
  }
  if (source === 'none') {
    return { ok: false, code: 'no_schema' };
  }
  if (source === 'template') {
    const r = validateTemplateData(template!, data);
    if (r.ok) return { ok: true, source: 'template', data: r.data };
    return r.code === 'unknown_template'
      ? { ok: false, code: 'unknown_template', template: template!, known: r.known }
      : { ok: false, code: 'invalid_data', source: 'template', template: template!, issues: r.issues };
  }
  // input-schema. Structural validity only — required-ness is owned by the start gate
  // (see withoutTopLevelRequired). The registry/zod path above deliberately keeps its
  // own required enforcement on write: its schemas describe code-defined domain
  // objects (a rubric) whose readers assume a complete value, so relaxing it there
  // would let a half-written rubric into a store other code trusts. The two paths
  // differ on WRITE and agree on START, which is where it matters.
  const schema = asJsonSchema(ref.inputSchema);
  if (!schema) return { ok: false, code: 'bad_schema', issues: ['input_schema must be an object'] };
  const r = checkAgainstJsonSchema(withoutTopLevelRequired(schema), asData(data));
  if (r.ok) return { ok: true, source: 'input-schema', data };
  return r.code === 'bad_schema'
    ? { ok: false, code: 'bad_schema', issues: r.errors }
    : { ok: false, code: 'invalid_data', source: 'input-schema', issues: r.errors };
}

export type PlanStartReadiness =
  | { ready: true; source: PlanSchemaSource }
  | {
      ready: false;
      code: 'missing_required' | 'invalid_data' | 'bad_schema' | 'unknown_template' | 'schema_conflict';
      source: PlanSchemaSource;
      /** Declared-required field names that were not supplied. */
      missing: string[];
      /** Validation issues, when the failure is a schema violation rather than absence. */
      issues: string[];
      /** The registry type name, when the failure involves one. */
      template?: string;
      /** A one-line, actionable explanation — surfaced verbatim by the start doors. */
      hint: string;
    };

/**
 * THE START GATE ORACLE. Pure, PG-free, and the single implementation every start
 * door consults (plans:start, plans:launch, plans:run-now, the scheduled fire,
 * plans:arm-schedule, fleet:launch-on-plan) — one oracle so six doors cannot drift
 * into six subtly different notions of "ready".
 *
 * A plan that declares NO schema is always ready: it has no required fields, which
 * is why this gate is a no-op for the entire pre-existing plan corpus and needs no
 * feature flag.
 *
 * Missing keys retain priority in the compatibility code, but supplied invalid
 * values are checked in the SAME call. Otherwise fixing one omission merely
 * reveals a second already-discoverable error on the next request.
 */
export function evaluatePlanStartReadiness(ref: PlanSchemaRef, data: unknown): PlanStartReadiness {
  const source = planSchemaSource(ref);
  if (source === 'none') return { ready: true, source };

  if (source === 'conflict') {
    const template = ref.template!.trim();
    return {
      ready: false,
      code: 'schema_conflict',
      source,
      missing: [],
      issues: [],
      template,
      hint:
        `This plan declares BOTH the code-registry template type '${template}' and its own ` +
        `input_schema. A plan has exactly one schema source, so which one governs is ` +
        `undefined — clear one (plans:set-input-schema { schema: null }, or the template ` +
        `frontmatter) before starting it.`,
    };
  }

  const required = planRequiredKeys(ref);
  const supplied = asData(data);
  const missing = required.filter((k) => supplied[k] === undefined);
  const check = validatePlanData(ref, data);
  if (missing.length > 0 && (check.ok || check.code === 'invalid_data')) {
    const issues = check.ok ? [] : check.issues;
    return {
      ready: false,
      code: 'missing_required',
      source,
      missing,
      issues,
      ...(source === 'template' ? { template: ref.template!.trim() } : {}),
      hint:
        `Required input${missing.length > 1 ? 's' : ''} not supplied: ${missing.join(', ')}. ` +
        `Supply ${missing.length > 1 ? 'them' : 'it'} via plans:set-template-data { slug, data }, ` +
        `or pass them as \`inputs\` on this run.` +
        (issues.length ? ` Also repair schema violations: ${issues.join('; ')}` : ''),
    };
  }

  if (check.ok) return { ready: true, source };

  if (check.code === 'no_schema') return { ready: true, source };

  if (check.code === 'unknown_template') {
    return {
      ready: false,
      code: 'unknown_template',
      source,
      missing: [],
      issues: [],
      template: check.template,
      hint:
        `No schema is registered for template type '${check.template}'` +
        (check.known.length > 0 ? ` (known: ${check.known.join(', ')})` : '') +
        `, so this plan's inputs cannot be checked. Fix the template: frontmatter.`,
    };
  }
  if (check.code === 'bad_schema') {
    return {
      ready: false,
      code: 'bad_schema',
      source,
      missing,
      issues: check.issues,
      hint:
        `This plan's input_schema is not a compilable JSON Schema, so its required fields ` +
        `cannot be checked. Re-declare it via plans:set-input-schema (which validates on ` +
        `declare). Starting is refused rather than allowed unchecked.`,
    };
  }
  if (check.code === 'schema_conflict') {
    // Unreachable in practice (handled above), kept so the switch is total.
    return {
      ready: false,
      code: 'schema_conflict',
      source,
      missing: [],
      issues: [],
      template: check.template,
      hint: 'This plan declares two schema sources; clear one before starting it.',
    };
  }
  return {
    ready: false,
    code: 'invalid_data',
    source,
    missing: [],
    issues: check.issues,
    ...(check.template ? { template: check.template } : {}),
    hint: `The supplied inputs do not satisfy this plan's schema: ${check.issues.join('; ')}`,
  };
}
