/**
 * R-6 PRIMARY (judge-free) oracle — the decision rule pre-registered in plan
 * decision D-033 of `deterministic-tool-definition-delivery-2026-09-21`, with the
 * data-source correction from D-037:
 *
 *   "extract emitted tool calls from both arms and schema-validate them. Any malformed-call
 *    CLASS present in the compact arm and absent in the full arm = R-6 FAILS, regardless of
 *    pass rates. A class is a distinct (tool, violation-kind) pair, not an instance."
 *
 * D-037: the calls live in `llm_test_runs.transcript_norm_json[].toolCalls`
 * (`{name,input,responseIndex}`). `telemetry_json.toolInvocations` is EMPTY on every
 * row and would yield a guaranteed-pass vacuous result. Arms are selected by
 * `telemetry_json->>'variantId'`, never by timestamp — a sequential-arm design is
 * perfectly confounded with its time window (D-039).
 *
 * Both arms are validated against the FULL (canonical) schema on purpose: R-3
 * establishes that any argument object valid under FULL is valid under COMPACT, so the
 * full schema is the correct shared oracle and needs no model in the loop.
 *
 * This module is deliberately PURE — no fs, no network, no registry read — so the
 * two-way validation that makes it trustworthy (catches every class it claims to
 * detect; silent on well-formed calls) is a committed test over a committed fixture
 * rather than an untracked scratch script whose input a cleanup can delete.
 *
 * ── THE ENGINE, AND WHY IT IS AJV RATHER THAN A HAND-ROLLED WALK ────────────────────
 *
 * The first draft checked six TOP-LEVEL classes by hand: unknown-tool, input-not-object,
 * missing-required, type-mismatch, enum-violation, and unknown-property on closed objects.
 * Each one was genuinely two-way validated, so the instrument was sound about what it
 * claimed — and still the wrong instrument for the bar it serves. R-3 defines the compact
 * tier as preserving *"numeric and length bounds, discriminators and nested shape"*, and a
 * top-level walk is blind to every one of those: no bounds, no pattern, no nested object or
 * array shape, no anyOf/oneOf, and no check at all on a property carrying constraints but
 * no top-level `type`. So "ZERO malformed-call classes" meant zero among six classes that
 * deliberately exclude the elements a tier change is most likely to break — measured on the
 * committed fixture, 10 of 20 properties carried bounds the walk ignored. A narrower
 * instrument reporting a clean result reads exactly like a broad one, which is the failure
 * this whole module exists to refuse.
 *
 * It now validates through `../json-schema-validation`, the repo's ONE ajv seam (ajv 8,
 * 2020-12, `allErrors`), so every keyword in the schema counts — and ajv errors are mapped
 * back onto the SAME class spellings for the six original kinds, so the taxonomy did not
 * churn underneath the recorded results. Nesting is explicit in the class name
 * (`nested-…`) rather than collapsed, because "the compact tier broke a top-level enum" and
 * "it broke a property three levels down" are different findings.
 *
 * ── AND WHY A SCHEMA THAT WILL NOT COMPILE IS COUNTED APART ─────────────────────────
 *
 * A stricter engine has a failure mode the hand walk did not: ajv can REFUSE a schema
 * (an unresolvable `$ref`, a duplicate `$id` in the shared instance). Folding that into a
 * violation class would be the vacuous-pass bug wearing a new coat — the same refusal hits
 * both arms, the classes cancel, and power silently drains out of the contrast while the
 * verdict still reads PASS. Those calls are therefore counted as UNMEASURED and reported
 * separately, and an arm whose calls are ALL unmeasured is INDETERMINATE, never a pass.
 */
import type { ErrorObject } from 'ajv';

import { compileJsonSchema } from '../json-schema-validation';

export type OracleViolation = { kind: string; detail: string };

/**
 * The kind stamped on a call the oracle could not judge because the SCHEMA does not
 * compile. Never a class: see the module header — "we could not measure" must not be
 * able to render as "clean".
 */
export const UNMEASURED_KIND = 'oracle-unmeasured';

export type OracleToolCall = {
  /** `telemetry_json->>'variantId'` for the run this call came from. */
  arm: string;
  scenario?: string;
  /** The tool name as the transcript records it — canonical (`docs:search`) or sanitized. */
  name: string;
  input: unknown;
};

/** A tool definition as the built catalog carries it. */
export type OracleCatalogTool = {
  name: string;
  input_schema?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
};

export type OracleClassCounts = Map<string, { count: number; example: string }>;

export type R6Verdict = {
  verdict: 'PASS' | 'FAIL' | 'INDETERMINATE';
  /** Malformed-call classes present in compact and absent in full — the D-033 falsifier. */
  onlyInCompact: string[];
  compactClasses: string[];
  fullClasses: string[];
  callCounts: Record<string, number>;
  /** Calls the oracle could NOT judge, per arm — a ceiling on power, never a class. */
  unmeasuredCalls: Record<string, number>;
  reason: string;
};

/**
 * Index the canonical schemas by EVERY spelling a transcript may record.
 *
 * ⚠ The bug this exists to prevent: keying only by the catalog's SANITIZED name
 * (Anthropic forbids `:` in a tool name) while transcripts record the CANONICAL name
 * makes every call read as `unknown-tool`. Both arms carry the identical defect, the
 * classes cancel, and the oracle reports a confident VACUOUS PASS.
 */
export function buildOracleSchemaIndex(
  tools: readonly OracleCatalogTool[],
  canonicalBySanitized?: ReadonlyMap<string, string>,
): Map<string, Record<string, unknown>> {
  const schemas = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    const sanitized = String(tool.name ?? '');
    const canonical = canonicalBySanitized?.get(sanitized) ?? sanitized;
    const schema = tool.input_schema ?? tool.inputSchema;
    if (!canonical || !schema) continue;
    schemas.set(canonical, schema);
    schemas.set(sanitized, schema);
  }
  return schemas;
}

const typeName = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** Resolve an ajv `instancePath` (a JSON Pointer) against the validated input. */
function atPointer(root: unknown, pointer: string): unknown {
  if (!pointer) return root;
  let cur: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The keywords R-3 calls "numeric and length bounds". */
const BOUND_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

/** The keywords R-3 calls "discriminators" — a shape chosen between alternatives. */
const COMPOSITION_KEYWORDS = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  'if',
  'dependentRequired',
  'dependentSchemas',
]);

/**
 * `required` and `additionalProperties` report at the CONTAINING object, every other
 * keyword at the offending value — so the depth at which each becomes "nested" differs by
 * one. Getting this backwards would label every top-level missing-required as nested and
 * silently rename the most common class in the recorded results.
 */
const CONTAINER_KEYWORDS = new Set(['required', 'additionalProperties', 'propertyNames']);

function violationFor(error: ErrorObject, input: unknown): OracleViolation {
  const keyword = error.keyword;
  const path = error.instancePath ?? '';
  const depth = path ? path.split('/').length - 1 : 0;
  const container = CONTAINER_KEYWORDS.has(keyword);
  const nested = container ? depth >= 1 : depth >= 2;
  const params = (error.params ?? {}) as Record<string, unknown>;

  let base: string;
  let detail: string;
  if (keyword === 'required') {
    base = 'missing-required';
    const missing = String(params.missingProperty ?? '?');
    detail = nested ? `${path}/${missing}` : missing;
  } else if (keyword === 'additionalProperties') {
    base = 'unknown-property';
    const extra = String(params.additionalProperty ?? '?');
    detail = nested ? `${path}/${extra}` : extra;
  } else {
    detail = nested ? path : path.split('/').pop() ?? '';
    if (keyword === 'type') {
      const types = String(params.type ?? 'unknown').split(',').join('|');
      base = `type-mismatch:${types}->${typeName(atPointer(input, path))}`;
    } else if (keyword === 'enum') {
      base = 'enum-violation';
    } else if (BOUND_KEYWORDS.has(keyword)) {
      base = `bound-violation:${keyword}`;
    } else if (keyword === 'pattern') {
      base = 'pattern-violation';
    } else if (keyword === 'format') {
      base = 'format-violation';
    } else if (COMPOSITION_KEYWORDS.has(keyword)) {
      base = `composition-violation:${keyword}`;
    } else {
      base = `schema-violation:${keyword}`;
    }
  }
  return { kind: nested ? `nested-${base}` : base, detail };
}

/**
 * Schema-validate one recorded call. An empty array means well-formed.
 *
 * `unknown-tool` and `input-not-object` are decided BEFORE ajv, deliberately: a root-level
 * `type` error is ajv's way of saying "the arguments were not an object at all", which is a
 * different finding from a property being the wrong type, and collapsing the two would put
 * the commonest transport-shaped failure into the same class as a schema-comprehension one.
 */
export function validateToolCall(
  schemas: ReadonlyMap<string, Record<string, unknown>>,
  name: string,
  input: unknown,
): OracleViolation[] {
  const schema = schemas.get(name);
  if (!schema) return [{ kind: 'unknown-tool', detail: name }];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return [{ kind: 'input-not-object', detail: typeName(input) }];
  }

  let validate;
  try {
    validate = compileJsonSchema(schema);
  } catch (e) {
    // NOT a violation — see the module header. A schema the engine cannot compile means
    // this call went unjudged, and an unjudged call must never read as a clean one.
    return [{ kind: UNMEASURED_KIND, detail: e instanceof Error ? e.message : String(e) }];
  }
  if (validate(input)) return [];

  // `allErrors` plus composition keywords can report the same (kind, detail) twice — once
  // from the branch and once from the combinator. Dedupe so an instance count stays a
  // count of CALLS-with-that-class rather than of ajv error objects.
  const out: OracleViolation[] = [];
  const seen = new Set<string>();
  for (const error of validate.errors ?? []) {
    const violation = violationFor(error, input);
    const key = `${violation.kind}\u0000${violation.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(violation);
  }
  return out;
}

/**
 * Fold recorded calls into per-arm malformed-call CLASSES (`<tool> :: <violation-kind>`).
 *
 * `unmeasured` is tracked beside the classes rather than inside them: a call whose schema
 * would not compile was not judged, and the D-033 rule must not be handed an
 * uncompiled-schema "class" that cancels across both arms.
 */
export function classifyArms(
  rows: readonly OracleToolCall[],
  schemas: ReadonlyMap<string, Record<string, unknown>>,
  arms: { compactArm: string; fullArm: string },
): {
  perArm: Map<string, OracleClassCounts>;
  callCounts: Map<string, number>;
  unmeasured: Map<string, number>;
} {
  const perArm = new Map<string, OracleClassCounts>([
    [arms.compactArm, new Map()],
    [arms.fullArm, new Map()],
  ]);
  const callCounts = new Map<string, number>();
  const unmeasured = new Map<string, number>();
  for (const row of rows) {
    callCounts.set(row.arm, (callCounts.get(row.arm) ?? 0) + 1);
    const bucket = perArm.get(row.arm);
    if (!bucket) continue;
    const violations = validateToolCall(schemas, row.name, row.input);
    if (violations.some((v) => v.kind === UNMEASURED_KIND)) {
      unmeasured.set(row.arm, (unmeasured.get(row.arm) ?? 0) + 1);
      continue;
    }
    for (const violation of violations) {
      const cls = `${row.name} :: ${violation.kind}`;
      const prev = bucket.get(cls);
      if (prev) prev.count++;
      else bucket.set(cls, { count: 1, example: `${violation.detail} (${row.scenario ?? '?'})` });
    }
  }
  return { perArm, callCounts, unmeasured };
}

/**
 * Apply D-033's primary rule. An arm that contributed NO calls is INDETERMINATE, never a
 * pass: a silent all-clear from an instrument that measured nothing is the vacuous-green
 * failure mode this whole oracle exists to avoid.
 */
export function r6PrimaryVerdict(
  rows: readonly OracleToolCall[],
  schemas: ReadonlyMap<string, Record<string, unknown>>,
  arms: { compactArm: string; fullArm: string },
): R6Verdict {
  const { perArm, callCounts, unmeasured } = classifyArms(rows, schemas, arms);
  const compact = perArm.get(arms.compactArm) ?? new Map();
  const full = perArm.get(arms.fullArm) ?? new Map();
  const onlyInCompact = [...compact.keys()].filter((cls) => !full.has(cls)).sort();
  const counts = Object.fromEntries(callCounts);
  const base = {
    onlyInCompact,
    compactClasses: [...compact.keys()].sort(),
    fullClasses: [...full.keys()].sort(),
    callCounts: counts,
    unmeasuredCalls: Object.fromEntries(unmeasured),
  };
  if (!callCounts.get(arms.compactArm) || !callCounts.get(arms.fullArm)) {
    return { ...base, verdict: 'INDETERMINATE', reason: 'one arm contributed no calls — not a pass' };
  }
  // An arm whose every call went unjudged measured nothing, which is the same standing as
  // an arm that contributed no calls at all — and it would otherwise report a clean PASS.
  for (const arm of [arms.compactArm, arms.fullArm]) {
    if ((unmeasured.get(arm) ?? 0) >= (callCounts.get(arm) ?? 0)) {
      return {
        ...base,
        verdict: 'INDETERMINATE',
        reason: `every call in ${arm} had an uncompilable schema — nothing was judged`,
      };
    }
  }
  if (onlyInCompact.length > 0) {
    return {
      ...base,
      verdict: 'FAIL',
      reason: `${onlyInCompact.length} malformed-call class(es) present ONLY in the compact arm`,
    };
  }
  return {
    ...base,
    verdict: 'PASS',
    reason: `no malformed-call class is unique to the compact arm (${compact.size} vs ${full.size} classes)`,
  };
}
