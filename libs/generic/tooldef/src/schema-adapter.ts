/**
 * Pluggable JSON-Schema generation (plan P-021 / D-002).
 *
 * Standard Schema (the validator interface the core is moving to in P-020) has
 * **no** JSON-Schema export — so turning a tool's `args`/`events`/`state` schema
 * into the JSON Schema that `tools/list` + OpenAPI need is a *separate*,
 * swappable concern. The engine routes every schema→JSON-Schema conversion
 * through the adapter registered here instead of calling a validator library
 * directly.
 *
 * The default is the version-aware Zod adapter (Zod 4's built-in
 * `z.toJSONSchema`, with `zod-to-json-schema` only for a Zod 3 host), so the
 * Papercusp host — and every existing tool — keeps working with zero changes.
 * A host using Valibot / ArkType / etc. registers its own adapter at startup
 * via `setJsonSchemaAdapter`, before its tools self-register (the schema is
 * converted eagerly at `defineTool` time, same load-order contract as the
 * capability-tier resolver — see capability-tiers.ts).
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Convert a validator schema to a JSON Schema object. Host-supplied. */
export type JsonSchemaAdapter = (schema: unknown) => Record<string, unknown>;

/**
 * Default adapter — use Zod 4's native converter when it exists and retain the
 * legacy converter solely as the Zod 3 fallback. `zod-to-json-schema@3`
 * accepts a Zod 4 value but emits only `{ $schema }`, so capability detection
 * must happen before conversion rather than by catching an exception.
 */
export const zodJsonSchemaAdapter: JsonSchemaAdapter = (schema) => {
  const native = (z as unknown as {
    toJSONSchema?: (value: unknown) => Record<string, unknown>;
  }).toJSONSchema;
  return typeof native === 'function'
    ? native(schema)
    : (zodToJsonSchema(
        schema as Parameters<typeof zodToJsonSchema>[0],
      ) as Record<string, unknown>);
};

let adapter: JsonSchemaAdapter = zodJsonSchemaAdapter;

/** Register the host's schema→JSON-Schema adapter. Call once at startup. */
export function setJsonSchemaAdapter(fn: JsonSchemaAdapter): void {
  adapter = fn;
}

/** Convert a schema to JSON Schema via the active adapter. */
export function toJsonSchema(schema: unknown): Record<string, unknown> {
  return adapter(schema);
}
