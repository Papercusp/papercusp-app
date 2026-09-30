/**
 * `jsonSchemaToZod` — compile a (subset of) JSON Schema into a runtime Zod
 * validator (`harness-provided-cadence-ops-2026-06-26` P-002 / D-001).
 *
 * WHY this exists. A blueprint's harness-op manifest (`ops:` in the blueprint
 * schema) carries `argsSchema` / `resultSchema` as **JSON Schema**, not Zod
 * functions — DELIBERATELY, because the manifest crosses the repo/process
 * boundary and is persisted/serialized (D-001: a Zod `ZodType` can't be stored
 * in PG or shipped in a blueprint YAML). But the proxy CoordOp the registrar
 * builds needs real `ZodType` `argsSchema` / `resultSchema` (the `CoordOp`
 * interface), so the durable `coordProgramWorkflow` can validate interpolated
 * step args before dispatch and validate the harness's response before binding
 * it into program data (the trust boundary). This module is that compile step.
 *
 * SCOPE. It handles the JSON-Schema subset a deterministic cadence op realistically
 * declares — `type` (object / array / string / number / integer / boolean / null,
 * incl. a union `type: [...]`), `properties` + `required` + `additionalProperties`,
 * `items`, `enum`, `const`, `nullable`, and `anyOf`/`oneOf` unions. Anything it
 * does not recognize degrades to `z.any()` (accept-and-pass) rather than throwing:
 * the harness re-validates server-side (P-006), so an over-permissive operator-side
 * validator is safe, while a throw at registration would wedge blueprint admission.
 * An empty schema (`{}`) is `z.any()` by the manifest's own "{} ⇒ accept any" rule.
 */
import { z, type ZodTypeAny } from 'zod';

/** A JSON-Schema node as it arrives from the manifest (untyped JSONB). */
export type JsonSchema = Record<string, unknown>;

function isPlainObject(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Wrap with `.nullable()` when the schema admits null (via `nullable:true` or a `null` type member). */
function maybeNullable(zt: ZodTypeAny, nullable: boolean): ZodTypeAny {
  return nullable ? zt.nullable() : zt;
}

/** Build a Zod union of literals from an `enum` / single-value `const` list. */
function literalsUnion(values: unknown[]): ZodTypeAny {
  const literals: ZodTypeAny[] = values.map((v) =>
    // z.literal accepts string | number | boolean | null | bigint; anything else → z.any()
    v === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof v)
      ? z.literal(v as string | number | boolean | null)
      : z.any(),
  );
  if (literals.length === 0) return z.any();
  if (literals.length === 1) return literals[0];
  return z.union(literals as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
}

/** Compile one scalar/array `type` token (null handled by the caller's union split). */
function compilePrimitive(type: string, schema: JsonSchema): ZodTypeAny {
  switch (type) {
    case 'string': {
      if (Array.isArray(schema.enum)) return literalsUnion(schema.enum);
      return z.string();
    }
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = isPlainObject(schema.items) ? jsonSchemaToZod(schema.items) : z.any();
      return z.array(items);
    }
    case 'object':
      return compileObject(schema);
    default:
      return z.any();
  }
}

function compileObject(schema: JsonSchema): ZodTypeAny {
  const props = isPlainObject(schema.properties) ? schema.properties : undefined;
  if (!props) {
    // An object with no declared properties: accept any record.
    return z.record(z.string(), z.any());
  }
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  );
  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, raw] of Object.entries(props)) {
    const child = isPlainObject(raw) ? jsonSchemaToZod(raw) : z.any();
    shape[key] = required.has(key) ? child : child.optional();
  }
  const obj = z.object(shape);
  // additionalProperties:false ⇒ strict; otherwise allow extras (passthrough) so a
  // harness that returns more fields than declared still validates (forward-compat).
  return schema.additionalProperties === false ? obj.strict() : obj.passthrough();
}

/**
 * Compile a JSON Schema object into a Zod validator. Tolerant by design: an
 * unrecognized construct compiles to `z.any()` rather than throwing.
 */
export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  if (!isPlainObject(schema)) return z.any();

  // Empty schema ⇒ accept any (the manifest's "{} ⇒ accept any" rule).
  if (Object.keys(schema).length === 0) return z.any();

  // `const` — an exact value.
  if ('const' in schema) return literalsUnion([schema.const]);

  // `enum` without a `type` — a closed value set.
  if (Array.isArray(schema.enum) && schema.type === undefined) {
    const u = literalsUnion(schema.enum);
    return maybeNullable(u, schema.nullable === true);
  }

  // `anyOf` / `oneOf` — a union of sub-schemas.
  const variants = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (variants) {
    const members = variants.map((v) => jsonSchemaToZod(v));
    const u =
      members.length === 0
        ? z.any()
        : members.length === 1
          ? members[0]
          : z.union(members as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    return maybeNullable(u, schema.nullable === true);
  }

  // `type` — scalar, array, object, OR a union of types (`type: ['string','null']`).
  const type = schema.type;
  if (Array.isArray(type)) {
    const nonNull = type.filter((t): t is string => typeof t === 'string' && t !== 'null');
    const hasNull = type.includes('null') || schema.nullable === true;
    const members = nonNull.map((t) => compilePrimitive(t, schema));
    let u: ZodTypeAny;
    if (members.length === 0) u = z.any();
    else if (members.length === 1) u = members[0];
    else u = z.union(members as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]]);
    return maybeNullable(u, hasNull);
  }
  if (typeof type === 'string') {
    return maybeNullable(compilePrimitive(type, schema), schema.nullable === true);
  }

  // `properties` present but no explicit `type` ⇒ treat as object.
  if (isPlainObject(schema.properties)) {
    return maybeNullable(compileObject(schema), schema.nullable === true);
  }

  // Nothing we recognize — accept-and-pass.
  return z.any();
}
