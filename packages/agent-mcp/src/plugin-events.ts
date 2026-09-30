/**
 * JSON-Schema → wire-kind classifier + validator for plugin event
 * declarations. Phase 4 T3.2.
 *
 * Plugins declare typed events in their `papercusp.json` manifest as
 * JSON-Schema (they don't ship Zod, which would need an extra runtime
 * dependency). The framework needs three things from each plugin
 * event schema:
 *   1. A wire kind ('string' | 'binary' | 'json') so the SSE / IPC
 *      transports know how to serialize the event payload.
 *   2. The serialized JSON-Schema for tools/list discoverability —
 *      same surface built-in tools get via `z.toJSONSchema()`.
 *   3. A loud rejection at manifest-validate time if the plugin
 *      author uses a JSON-Schema keyword we don't support.
 *
 * The supported-keyword set is intentionally small. Plugins author
 * stable wire schemas; we don't try to support every JSON-Schema
 * draft feature. Plugin authors who hit the wall file a request.
 *
 * Plan ref: phase-4-endpoint-system-2026-05-12.md § T3.2.
 */

import type { EventWireKind } from '@papercusp/tooldef';

/** Reserved JSON-Schema keywords we explicitly support. */
export const SUPPORTED_KEYWORDS = new Set<string>([
  // Type discriminator + structural.
  'type',
  'properties',
  'items',
  'required',
  'enum',
  'const',
  // Binary marker.
  'contentEncoding',
  // Documentation.
  'description',
  'title',
  'examples',
  // Allow additionalProperties: false; reject schema-valued forms.
  'additionalProperties',
  // Top-level only.
  '$schema',
]);

/**
 * Keywords we deliberately reject. The plugin author hits a clear
 * error rather than a silent "this didn't take effect."
 */
export const REJECTED_KEYWORDS = new Set<string>([
  'format',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  '$ref',
  '$defs',
  'definitions',
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'propertyNames',
  'unevaluatedProperties',
  'minItems',
  'maxItems',
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'dependentSchemas',
  'dependentRequired',
]);

export class PluginEventSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginEventSchemaError';
  }
}

/**
 * Classify a JSON-Schema-typed event into a wire kind. Mirrors
 * `classifyEventWire` (the Zod-based classifier in tool-projection.ts).
 * Same rules:
 *   - `{type: 'string', contentEncoding: 'base64'}` → 'binary'
 *   - `{type: 'string'}` → 'string'
 *   - everything else → 'json'
 *
 * Doesn't validate the schema — call `validatePluginEventSchema`
 * separately for that.
 */
export function classifyEventWireFromJsonSchema(
  schema: Record<string, unknown>,
): EventWireKind {
  const type = schema.type;
  if (type === 'string' && schema.contentEncoding === 'base64') return 'binary';
  if (type === 'string') return 'string';
  return 'json';
}

/**
 * Validate a single event's JSON-Schema against our supported subset.
 * Recurses into `properties` and `items`. Throws PluginEventSchemaError
 * on the first violation with a clear error message identifying the
 * offending keyword and the supported alternatives.
 *
 * `path` is a dotted breadcrumb (e.g. "delta.text") used in error
 * messages to point at nested violations.
 */
export function validatePluginEventSchema(
  eventName: string,
  schema: Record<string, unknown>,
  path: string = eventName,
): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new PluginEventSchemaError(
      `event "${path}" schema must be a JSON-Schema object; got ${Array.isArray(schema) ? 'array' : typeof schema}`,
    );
  }

  for (const key of Object.keys(schema)) {
    if (REJECTED_KEYWORDS.has(key)) {
      throw new PluginEventSchemaError(
        `unsupported JSON-Schema keyword "${key}" in event "${path}". Supported keywords: ${[...SUPPORTED_KEYWORDS].sort().join(', ')}.`,
      );
    }
    if (!SUPPORTED_KEYWORDS.has(key)) {
      throw new PluginEventSchemaError(
        `unknown JSON-Schema keyword "${key}" in event "${path}". Supported keywords: ${[...SUPPORTED_KEYWORDS].sort().join(', ')}.`,
      );
    }
  }

  // `additionalProperties` may be `false` (allowed) or absent. A
  // schema value is rejected — plugins can't constrain unknown keys
  // via a sub-schema (no recursion path for it).
  if (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false &&
    schema.additionalProperties !== true
  ) {
    throw new PluginEventSchemaError(
      `unsupported additionalProperties:{...} schema in event "${path}". Only false (or omitted) is allowed.`,
    );
  }

  // Recurse into `properties`.
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)) {
      throw new PluginEventSchemaError(
        `event "${path}" properties must be an object`,
      );
    }
    for (const [k, v] of Object.entries(schema.properties as Record<string, unknown>)) {
      validatePluginEventSchema(eventName, v as Record<string, unknown>, `${path}.${k}`);
    }
  }

  // Recurse into `items` (array element schema).
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new PluginEventSchemaError(
        `event "${path}" items must be a single schema (array-form tuple validation not supported)`,
      );
    }
    if (typeof schema.items !== 'object' || schema.items === null) {
      throw new PluginEventSchemaError(
        `event "${path}" items must be a JSON-Schema object`,
      );
    }
    validatePluginEventSchema(eventName, schema.items as Record<string, unknown>, `${path}.items`);
  }

  // `enum` must be an array (sanity check; we don't validate values).
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    throw new PluginEventSchemaError(`event "${path}" enum must be an array`);
  }
  // `required` must be a string array.
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) {
      throw new PluginEventSchemaError(`event "${path}" required must be an array of strings`);
    }
    for (const r of schema.required) {
      if (typeof r !== 'string') {
        throw new PluginEventSchemaError(`event "${path}" required must contain only strings`);
      }
    }
  }
}

/**
 * Convenience: validate an entire `events: Record<name, JSON-Schema>`
 * map. Used by manifest-validate.ts before the plugin loader passes
 * events to registerProjectedTool. Returns a wire-kind map computed
 * in the same pass (saves a second tree walk).
 */
export function validateAndClassifyPluginEvents(
  events: Record<string, Record<string, unknown>>,
): Record<string, EventWireKind> {
  const out: Record<string, EventWireKind> = {};
  for (const [name, schema] of Object.entries(events)) {
    validatePluginEventSchema(name, schema);
    out[name] = classifyEventWireFromJsonSchema(schema);
  }
  return out;
}
