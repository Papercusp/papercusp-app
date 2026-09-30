/**
 * Static eligibility analysis — schema → capability set (plan P-002 / D-004).
 *
 * Given the JSON-Schema projection of a tool's output **`data`** node, decide
 * which formats that shape can be SAFELY rendered in. The walk is purely
 * structural (no runtime data) so the result is computed once at tool
 * registration and reused on every call.
 *
 * Rules (D-004 — the envelope is excluded; this analyzes `data` only):
 *   | data shape                                          | capability set        |
 *   | --------------------------------------------------- | --------------------- |
 *   | array(object{ …all scalar leaves… })                | {json,toon,csv,tsv,md}|
 *   | array(object{ …≥1 nested/array/record field… })     | {json,toon}           |
 *   | array of heterogeneous row shapes (anyOf/oneOf)     | {json,toon}           |
 *   | array of scalars / unknown items                    | {json,toon}           |
 *   | record / any / unknown / NON-array (single object)  | {json}                |
 *
 * `bestFormat` is the most compact AUTO-selectable member: `toon` whenever the
 * data is array-shaped (TOON is lossless for any array), else `json`. CSV is
 * never auto-selected — it is unlocked only by an explicit client request that
 * intersects with a capability set proving the data is flat (D-002).
 */

import type { ResultFormat } from './formats';

export interface EligibilityResult {
  /** Formats this data shape can be rendered in. Always contains `json`. */
  capabilities: Set<ResultFormat>;
  /** Most compact AUTO default: `toon` for arrays, `json` otherwise (never csv). */
  bestFormat: ResultFormat;
}

const JSON_ONLY = (): EligibilityResult => ({ capabilities: new Set<ResultFormat>(['json']), bestFormat: 'json' });
const TOON_ARRAY = (): EligibilityResult => ({ capabilities: new Set<ResultFormat>(['json', 'toon']), bestFormat: 'toon' });
const FLAT_ARRAY = (): EligibilityResult => ({
  capabilities: new Set<ResultFormat>(['json', 'toon', 'csv', 'tsv', 'md']),
  bestFormat: 'toon',
});

function isScalarTypeName(t: unknown): boolean {
  return t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'null';
}

/** A JSON-Schema node representing a scalar leaf — incl. enum/const + nullable/scalar unions. */
function isScalarLeaf(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum) || 'const' in s) return true;
  if (Array.isArray(s.type)) return (s.type as unknown[]).every(isScalarTypeName);
  if (typeof s.type === 'string') return isScalarTypeName(s.type);
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(s[key])) return (s[key] as unknown[]).every(isScalarLeaf);
  }
  return false;
}

/** Collapse `T | null` (zod `.nullable()` → `anyOf:[T, {type:'null'}]`) to its single non-null member. */
function unwrapNullable(schema: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      const nonNull = (members as unknown[]).filter(
        (m): m is Record<string, unknown> =>
          m !== null && typeof m === 'object' && (m as Record<string, unknown>).type !== 'null',
      );
      if (nonNull.length === 1) return nonNull[0];
    }
  }
  return schema;
}

/** True when the object-schema has an enumerable, all-scalar column set (CSV-provable). */
function isFlatObjectSchema(schema: Record<string, unknown>): boolean {
  if (schema.type !== 'object') return false;
  const props = schema.properties;
  if (!props || typeof props !== 'object' || Object.keys(props).length === 0) return false;
  // additionalProperties: true / a schema → unknown extra columns → can't prove flat.
  const addl = schema.additionalProperties;
  if (addl !== undefined && addl !== false) return false;
  for (const v of Object.values(props as Record<string, unknown>)) {
    if (!isScalarLeaf(v)) return false;
  }
  return true;
}

function hasArrayType(schema: Record<string, unknown>): boolean {
  return schema.type === 'array' || (Array.isArray(schema.type) && (schema.type as unknown[]).includes('array'));
}

/**
 * Analyze the JSON-Schema of a tool's output `data` node. `undefined`/`null`/
 * non-object schemas (no declared output schema, or `any`/`unknown`) → `{json}`.
 */
export function analyzeSchema(jsonSchema: Record<string, unknown> | undefined | null): EligibilityResult {
  if (!jsonSchema || typeof jsonSchema !== 'object') return JSON_ONLY();
  const schema = unwrapNullable(jsonSchema as Record<string, unknown>);

  if (!hasArrayType(schema) || !('items' in schema)) {
    // Non-array: single object, scalar, record, or any/unknown → JSON only.
    return JSON_ONLY();
  }

  const items = schema.items;
  // Tuple form (items is an array of positional schemas) → heterogeneous rows.
  if (Array.isArray(items)) return TOON_ARRAY();
  if (!items || typeof items !== 'object') return TOON_ARRAY();

  const itemSchema = unwrapNullable(items as Record<string, unknown>);
  // Heterogeneous union of row shapes → not safely tabular.
  if (Array.isArray(itemSchema.anyOf) || Array.isArray(itemSchema.oneOf)) return TOON_ARRAY();
  if (isFlatObjectSchema(itemSchema)) return FLAT_ARRAY();
  // Array of objects with nested fields, array of scalars, or unknown items.
  return TOON_ARRAY();
}

/** The most compact format in a capability set, excluding the never-auto CSV family. */
export function bestCompactFormat(caps: Set<ResultFormat>): ResultFormat {
  return caps.has('toon') ? 'toon' : 'json';
}
