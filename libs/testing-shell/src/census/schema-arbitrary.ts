/**
 * `schema-arbitrary` — derive a fast-check `Arbitrary` from a censused surface's JSON Schema.
 *
 * Plan: design-to-code-coverage-seam-2026-09-02 (P-023), Decisions D-042 and D-043.
 *
 * WHY THIS READS JSON SCHEMA AND NOT ZOD. P-023 originally said "a zod-4 adapter, deriving
 * arbitraries from the `testing_surfaces.schema_ref` zod schemas". There are no zod schemas to
 * derive from: `schema_ref` holds JSON Schema, because `defineTool` projects `def.args` through
 * zod 4's own `z.toJSONSchema` at definition time (`tooldef/src/schema-adapter.ts`) and the
 * projected registry keeps only `Record<string, unknown>`. The zod object is gone before the
 * census ever sees a surface. D-042 has the full measurement; the short version is that a zod
 * adapter has no zod to consume, and the three candidate packages are each unusable here
 * (`zod-fast-check` needs fast-check <4 and zod ^3; `@fast-check/zod` does not exist;
 * `json-schema-fast-check` is 2022-era on fast-check ^1). So: JSON Schema in, arbitrary out.
 *
 * WHY REFUSING BEATS IGNORING. Every unknown keyword is REJECTED (`UnsupportedSchemaError`)
 * rather than skipped. A generator that silently drops a constraint it does not understand
 * emits values the surface legitimately rejects, and the property test then reports a failure
 * that is the INSTRUMENT's fault, not the code's. On a plan whose subject is silent wrong
 * answers, a generator that quietly lies about what it covered is the worst possible tool. The
 * supported set below is not a guess: it is the measured vocabulary of all 885 live mcp-tool
 * `schema_ref` values (D-043 lists the occurrence counts).
 *
 * WHY UNSATISFIABLE IS A DISTINCT OUTCOME. zod's `z.never()` projects to `{"not":{}}`, which
 * appears 42 times in the live corpus. "No value can satisfy this" is NOT the same as "error",
 * and it is not something you can represent as an arbitrary — `fc.constant(undefined)` would be
 * a lie. It is raised as `UnsatisfiableSchemaError` so the object builder can do the only
 * correct thing: omit the key when it is optional, and propagate when it is required.
 */

import fc from 'fast-check';

/** A keyword this converter understands. Anything else is refused — see the module header. */
const SUPPORTED_KEYWORDS = new Set([
  // structural
  'type', 'properties', 'required', 'additionalProperties', 'propertyNames',
  'items', 'prefixItems', 'enum', 'const',
  // combinators
  'anyOf', 'oneOf', 'allOf', 'not', '$ref', '$defs',
  // scalar constraints
  'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems',
  // annotations — carry no constraint, so ignoring them is sound rather than silent
  'description', 'title', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly', '$comment', '$schema', '$id', 'additionalItems',
]);

/**
 * Keywords that carry NO constraint, so a merge across combinator branches may simply take one.
 * Kept separate from `SUPPORTED_KEYWORDS` because "safe to ignore" and "safe to overwrite during
 * an intersection" are different questions.
 */
const ANNOTATION_KEYWORDS = new Set([
  'description', 'title', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly', '$comment', '$schema', '$id',
]);

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

/** Lower-case alphanumeric run of a bounded length — the safe building block for `format` values. */
function alnumRun(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...LOWER_ALNUM), { minLength, maxLength })
    .map((chars) => chars.join(''));
}

/**
 * String `format` values present in the live corpus, with a faithful generator for each.
 *
 * These are deliberately CANONICAL rather than maximally diverse. In the live corpus a `format` is
 * routinely paired with a stricter `pattern` (RFC 3339 for `date-time`, a hand-written address
 * regex for `email`), and `buildString` composes the two by filtering. A generator that ranges
 * over the whole format-legal space would be filtered down to nothing; one that emits the
 * conventional shape satisfies both. Widening any of these means re-running the corpus probe.
 */
const FORMAT_ARBITRARIES: Record<string, () => fc.Arbitrary<string>> = {
  uuid: () => fc.uuid(),
  /**
   * Bounded to 1970..2100 and always UTC `Z`.
   *
   * An UNBOUNDED `fc.date()` reaches years ±275760, whose ISO form ("+275760-09-13T00:00:00.000Z",
   * "-271821-04-20T00:00:00.000Z") is not valid RFC 3339: it fails ajv's `format: date-time` AND
   * every date-time `pattern` in the corpus. That bug shipped green because the test's ajv had no
   * `ajv-formats` registered, so `format` was silently ignored — see the test's header.
   */
  'date-time': () =>
    fc
      .date({
        min: new Date(Date.UTC(1970, 0, 1)),
        max: new Date(Date.UTC(2100, 0, 1)),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString()),
  uri: () => fc.webUrl(),
  url: () => fc.webUrl(),
  /**
   * Narrower than `fc.emailAddress()` on purpose. `fc.emailAddress` legitimately emits quoted and
   * symbol-rich local parts (`{`, `|`, `'`) that every `pattern` beside `format: email` in this
   * corpus rejects, so the pattern filter would starve.
   */
  email: () =>
    fc
      .tuple(alnumRun(1, 10), alnumRun(1, 8), fc.constantFrom('com', 'org', 'net', 'io', 'dev'))
      .map(([local, host, tld]) => `${local}@${host}.${tld}`),
};

/** Raised when the schema uses a keyword this converter does not model. */
export class UnsupportedSchemaError extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`unsupported schema at ${path || '#'}: ${detail}`);
    this.name = 'UnsupportedSchemaError';
  }
}

/**
 * Raised when a schema admits NO value (zod `z.never()` → `{"not":{}}`).
 * Distinct from `UnsupportedSchemaError`: the schema is understood perfectly, and the correct
 * answer is that nothing satisfies it.
 */
export class UnsatisfiableSchemaError extends Error {
  constructor(readonly path: string) {
    super(`schema at ${path || '#'} admits no value (never)`);
    this.name = 'UnsatisfiableSchemaError';
  }
}

export interface SchemaArbitraryOptions {
  /**
   * Root schema used to resolve `$ref`. Defaults to the schema passed in, which is what you
   * want for a whole-surface schema whose `$defs` sit at its own root.
   */
  root?: JsonSchema;
  /** Cap on generated string/array size, so a fuzz run stays bounded. */
  maxSize?: number;
}

export type JsonSchema = Record<string, unknown>;

const DEFAULT_MAX_SIZE = 8;

function isPlainObject(v: unknown): v is JsonSchema {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve a local `#/$defs/name` pointer. Remote refs are refused rather than fetched. */
function resolveRef(ref: string, root: JsonSchema, path: string): JsonSchema {
  if (!ref.startsWith('#/')) {
    throw new UnsupportedSchemaError(path, `only local #/ refs are supported, got ${ref}`);
  }
  let node: unknown = root;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(node) || !(seg in node)) {
      throw new UnsupportedSchemaError(path, `unresolvable $ref ${ref}`);
    }
    node = (node as JsonSchema)[seg];
  }
  if (!isPlainObject(node)) throw new UnsupportedSchemaError(path, `$ref ${ref} is not a schema`);
  return node;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
}

function asNumber(v: unknown, path: string, keyword: string): number {
  if (typeof v !== 'number') {
    throw new UnsupportedSchemaError(path, `"${keyword}" must be a number to intersect`);
  }
  return v;
}

/**
 * Intersect two schemas into one that admits exactly the values BOTH admit.
 *
 * Used wherever a combinator sits beside constraining siblings. It is deliberately partial: any
 * keyword pair it cannot intersect EXACTLY is refused, never approximated. Widening a constraint
 * to make a merge succeed would emit values the real schema rejects, which is the failure this
 * whole module exists to avoid.
 */
function mergeSchemas(a: JsonSchema, b: unknown, path: string): JsonSchema {
  if (b === true) return a;
  if (b === false) throw new UnsatisfiableSchemaError(path);
  if (!isPlainObject(b)) {
    throw new UnsupportedSchemaError(path, `cannot intersect with a ${typeof b} branch`);
  }

  const out: JsonSchema = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (!(key in out)) {
      out[key] = value;
      continue;
    }
    const prev = out[key];
    if (deepEqual(prev, value)) continue;

    switch (key) {
      case 'required': {
        const left = Array.isArray(prev) ? prev : [];
        const right = Array.isArray(value) ? value : [];
        out[key] = [...new Set([...left, ...right])];
        break;
      }
      case 'properties': {
        // Both sides constrain the same key ⇒ the value must satisfy both, so recurse.
        const left = isPlainObject(prev) ? prev : {};
        const right = isPlainObject(value) ? value : {};
        const merged: JsonSchema = { ...left };
        for (const [propKey, propSchema] of Object.entries(right)) {
          merged[propKey] =
            propKey in merged && !deepEqual(merged[propKey], propSchema)
              ? mergeSchemas(
                  isPlainObject(merged[propKey]) ? (merged[propKey] as JsonSchema) : {},
                  propSchema,
                  `${path}/properties/${propKey}`,
                )
              : propSchema;
        }
        out[key] = merged;
        break;
      }
      // The tighter bound wins — that IS the intersection for a numeric range.
      case 'minLength':
      case 'minItems':
      case 'minimum':
      case 'exclusiveMinimum':
        out[key] = Math.max(asNumber(prev, path, key), asNumber(value, path, key));
        break;
      case 'maxLength':
      case 'maxItems':
      case 'maximum':
      case 'exclusiveMaximum':
        out[key] = Math.min(asNumber(prev, path, key), asNumber(value, path, key));
        break;
      case 'additionalProperties':
        // Closed beats open: a value with extra keys fails the closed side of the intersection.
        out[key] = prev === false || value === false ? false : value;
        break;
      case 'uniqueItems':
        out[key] = prev === true || value === true;
        break;
      default:
        if (ANNOTATION_KEYWORDS.has(key)) {
          out[key] = value;
          break;
        }
        throw new UnsupportedSchemaError(
          path,
          `cannot intersect conflicting "${key}" across a combinator branch`,
        );
    }
  }
  return out;
}

/**
 * Convert one JSON Schema into an arbitrary producing values that CONFORM to it.
 *
 * Throws `UnsupportedSchemaError` for anything it cannot model faithfully and
 * `UnsatisfiableSchemaError` for a schema no value satisfies.
 */
export function jsonSchemaToArbitrary(
  schema: JsonSchema,
  options: SchemaArbitraryOptions = {},
): fc.Arbitrary<unknown> {
  const root = options.root ?? schema;
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  return build(schema, { root, maxSize, path: '#', seen: new Set() });
}

interface Ctx {
  root: JsonSchema;
  maxSize: number;
  path: string;
  seen: Set<JsonSchema>;
}

function build(schema: unknown, ctx: Ctx): fc.Arbitrary<unknown> {
  // `true`/`false` are legal JSON Schema shorthand for "anything"/"nothing".
  if (schema === true) return fc.jsonValue();
  if (schema === false) throw new UnsatisfiableSchemaError(ctx.path);
  if (!isPlainObject(schema)) {
    throw new UnsupportedSchemaError(ctx.path, `expected an object schema, got ${typeof schema}`);
  }

  for (const key of Object.keys(schema)) {
    // `x-` vendor extensions are ignored rather than refused, and that is NOT a silent drop:
    // the property under test is "every generated value conforms to what the VALIDATOR checks",
    // and ajv ignores unknown `x-` keywords too. Generator and validator therefore still agree.
    // (`x-soft-maxLength` is the live instance: an advisory cap beside a real `maxLength`.)
    if (SUPPORTED_KEYWORDS.has(key) || key.startsWith('x-')) continue;
    throw new UnsupportedSchemaError(ctx.path, `unknown keyword "${key}"`);
  }

  // --- $ref -------------------------------------------------------------------------------
  if (typeof schema.$ref === 'string') {
    const target = resolveRef(schema.$ref, ctx.root, ctx.path);
    if (ctx.seen.has(target)) {
      // A recursive schema has no finite generator without a depth budget we do not model.
      throw new UnsupportedSchemaError(ctx.path, `recursive $ref ${schema.$ref}`);
    }
    const seen = new Set(ctx.seen);
    seen.add(target);
    return build(target, { ...ctx, seen });
  }

  // --- not --------------------------------------------------------------------------------
  // The ONLY form in the corpus is `{"not":{}}` = zod z.never(). Any other negation would
  // require a validator to reject against, which we deliberately do not fake.
  if ('not' in schema) {
    const negated = schema.not;
    const isEmptyNegation =
      negated === true || (isPlainObject(negated) && Object.keys(negated).length === 0);
    if (isEmptyNegation) throw new UnsatisfiableSchemaError(ctx.path);
    throw new UnsupportedSchemaError(ctx.path, 'only `not: {}` (never) is supported');
  }

  // --- const / enum -----------------------------------------------------------------------
  if ('const' in schema) return fc.constant(schema.const);
  if (Array.isArray(schema.enum)) {
    if (schema.enum.length === 0) throw new UnsatisfiableSchemaError(ctx.path);
    return fc.constantFrom(...schema.enum);
  }

  // --- combinators ------------------------------------------------------------------------
  // JSON Schema keywords at one level are CONJUNCTIVE: `{type:'object', properties:{…},
  // anyOf:[…]}` means the value must satisfy the object part AND one branch. Treating the
  // combinator as if it replaced its siblings generates values that ignore the siblings —
  // `gitnexus.api_impact` is the live instance (`type:'object'` beside `anyOf` of two `required`
  // variants), where branch-only generation emitted `[]` for a schema demanding an object.
  const unionKey = Array.isArray(schema.anyOf)
    ? 'anyOf'
    : Array.isArray(schema.oneOf)
      ? 'oneOf'
      : undefined;
  if (unionKey) {
    // `oneOf` means EXACTLY one branch matches. Generating from any single branch satisfies
    // that whenever the branches are disjoint, which is how zod emits discriminated unions.
    const union = schema[unionKey] as unknown[];
    const base = { ...schema };
    delete base[unionKey];
    const constrains = Object.keys(base).some((k) => !ANNOTATION_KEYWORDS.has(k));

    const arbs: fc.Arbitrary<unknown>[] = [];
    for (const [i, branch] of union.entries()) {
      const path = `${ctx.path}/${unionKey}/${i}`;
      try {
        const effective = constrains ? mergeSchemas(base, branch, path) : branch;
        arbs.push(build(effective, { ...ctx, path }));
      } catch (err) {
        // A never-branch is a normal part of a union; it just contributes nothing.
        if (!(err instanceof UnsatisfiableSchemaError)) throw err;
      }
    }
    if (arbs.length === 0) throw new UnsatisfiableSchemaError(ctx.path);
    return arbs.length === 1 ? arbs[0]! : fc.oneof(...arbs);
  }

  if (Array.isArray(schema.allOf)) {
    // An intersection folded into ONE schema. `mergeSchemas` refuses any conflict it cannot
    // resolve exactly, so an allOf that is not soundly mergeable is reported rather than
    // approximated — which is the same trade this module makes for unknown keywords.
    const base = { ...schema };
    delete base.allOf;
    let merged: JsonSchema = base;
    for (const [i, branch] of schema.allOf.entries()) {
      merged = mergeSchemas(merged, branch, `${ctx.path}/allOf/${i}`);
    }
    return build(merged, ctx);
  }

  // --- type -------------------------------------------------------------------------------
  const type = schema.type;
  if (Array.isArray(type)) {
    const arbs = type.map((t) => build({ ...schema, type: t }, ctx));
    return arbs.length === 1 ? arbs[0]! : fc.oneof(...arbs);
  }
  if (type === undefined) {
    // No type and no combinator: an unconstrained schema. Legal, and `{}` appears as a
    // property schema for genuinely free-form payloads.
    //
    // `fc.jsonValue`, NOT `fc.anything`: `fc.anything()` emits `undefined` (93/4000 sampled),
    // which is not a JSON value at all. As a REQUIRED property that is a silent wrong answer —
    // `fc.record` stores the key with an `undefined` value, `JSON.stringify` drops it, and ajv's
    // `required` check (`data.x === undefined`) fails on a schema the generator claimed to
    // satisfy. `plans:set-property.value` is the live instance.
    return fc.jsonValue({ maxDepth: 2 });
  }
  if (typeof type !== 'string') {
    throw new UnsupportedSchemaError(ctx.path, `"type" must be a string or array`);
  }

  switch (type) {
    case 'null':
      return fc.constant(null);
    case 'boolean':
      return fc.boolean();
    case 'string':
      return buildString(schema, ctx);
    case 'integer':
    case 'number':
      return buildNumber(schema, ctx, type === 'integer');
    case 'array':
      return buildArray(schema, ctx);
    case 'object':
      return buildObject(schema, ctx);
    default:
      throw new UnsupportedSchemaError(ctx.path, `unknown type "${type}"`);
  }
}

function compilePattern(pattern: string, path: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new UnsupportedSchemaError(path, `uncompilable pattern ${pattern}: ${String(err)}`);
  }
}

/**
 * `fc.stringMatching`'s default size tops out around 12 characters, so a `minLength` above that
 * can NEVER be met by filtering — measured 0/500 for `^[A-Za-z0-9]+$` against `minLength: 15`.
 * The size is therefore derived from the schema's own bound rather than left at the default.
 * Measured reach per size (500 samples): small ≈ 12, medium ≈ 111, large ≈ 1100, xlarge ≈ 11000.
 */
function sizeForMinLength(minLength: number): 'medium' | 'large' | 'xlarge' | undefined {
  if (minLength <= 10) return undefined;
  if (minLength <= 100) return 'medium';
  if (minLength <= 1000) return 'large';
  return 'xlarge';
}

function buildString(schema: JsonSchema, ctx: Ctx): fc.Arbitrary<unknown> {
  const format = typeof schema.format === 'string' ? schema.format : undefined;
  const pattern = typeof schema.pattern === 'string' ? schema.pattern : undefined;
  const minLength = typeof schema.minLength === 'number' ? schema.minLength : 0;
  const maxLengthRaw = typeof schema.maxLength === 'number' ? schema.maxLength : undefined;
  if (maxLengthRaw !== undefined && maxLengthRaw < minLength) {
    throw new UnsatisfiableSchemaError(ctx.path);
  }

  // `format`, `pattern` and the length bounds are CONJUNCTIVE — a value must satisfy all three.
  // Honouring only the first one found is what produced the largest failure class in the corpus:
  // 13 of 19 non-conforming surfaces paired `format: date-time` with an RFC 3339 `pattern`.
  let arb: fc.Arbitrary<string>;
  if (format) {
    const make = FORMAT_ARBITRARIES[format];
    if (!make) throw new UnsupportedSchemaError(ctx.path, `unknown string format "${format}"`);
    arb = make();
    if (pattern !== undefined) {
      const re = compilePattern(pattern, ctx.path);
      arb = arb.filter((v) => re.test(v));
    }
  } else if (pattern !== undefined) {
    const re = compilePattern(pattern, ctx.path);
    try {
      // Anchoring is the pattern's own job; `stringMatching` matches the regex as written.
      arb = fc.stringMatching(re, { size: sizeForMinLength(minLength) });
    } catch (err) {
      // fast-check refuses some regex features outright ("Meta character \b not implemented
      // yet!"). Surface that as an honest refusal instead of letting a raw Error escape and
      // read as an instrument crash.
      throw new UnsupportedSchemaError(
        ctx.path,
        `pattern ${pattern} is not generatable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    const maxLength = Math.max(minLength, maxLengthRaw ?? Math.max(ctx.maxSize, minLength));
    return fc.string({ minLength, maxLength });
  }

  if (minLength > 0 || maxLengthRaw !== undefined) {
    const hi = maxLengthRaw ?? Number.POSITIVE_INFINITY;
    arb = arb.filter((v) => v.length >= minLength && v.length <= hi);
  }
  return arb;
}

function buildNumber(schema: JsonSchema, ctx: Ctx, integer: boolean): fc.Arbitrary<unknown> {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  let min = num(schema.minimum);
  let max = num(schema.maximum);
  const exMin = num(schema.exclusiveMinimum);
  const exMax = num(schema.exclusiveMaximum);
  const step = integer ? 1 : Number.EPSILON;
  if (exMin !== undefined) min = min === undefined ? exMin + step : Math.max(min, exMin + step);
  if (exMax !== undefined) max = max === undefined ? exMax - step : Math.min(max, exMax - step);

  const multipleOf = num(schema.multipleOf);
  if (multipleOf !== undefined) {
    if (!integer || !Number.isInteger(multipleOf) || multipleOf <= 0) {
      throw new UnsupportedSchemaError(ctx.path, 'multipleOf is only supported for positive integer steps');
    }
    const lo = Math.ceil((min ?? -(2 ** 31)) / multipleOf);
    const hi = Math.floor((max ?? 2 ** 31) / multipleOf);
    if (lo > hi) throw new UnsatisfiableSchemaError(ctx.path);
    return fc.integer({ min: lo, max: hi }).map((k) => k * multipleOf);
  }

  if (integer) {
    const lo = min === undefined ? -(2 ** 31) : Math.ceil(min);
    const hi = max === undefined ? 2 ** 31 : Math.floor(max);
    if (lo > hi) throw new UnsatisfiableSchemaError(ctx.path);
    return fc.integer({ min: lo, max: hi });
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new UnsatisfiableSchemaError(ctx.path);
  }
  return fc.double({
    min: min ?? -(2 ** 31),
    max: max ?? 2 ** 31,
    noNaN: true,
    noDefaultInfinity: true,
  });
}

function buildArray(schema: JsonSchema, ctx: Ctx): fc.Arbitrary<unknown> {
  if (Array.isArray(schema.prefixItems)) {
    const parts = schema.prefixItems.map((s, i) =>
      build(s, { ...ctx, path: `${ctx.path}/prefixItems/${i}` }),
    );
    return fc.tuple(...parts);
  }
  const itemSchema = schema.items ?? true;
  const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
  const maxItemsRaw = typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
  if (maxItemsRaw !== undefined && maxItemsRaw < minItems) {
    throw new UnsatisfiableSchemaError(ctx.path);
  }
  const maxLength = Math.max(minItems, Math.min(maxItemsRaw ?? ctx.maxSize, ctx.maxSize));

  let item: fc.Arbitrary<unknown>;
  try {
    item = build(itemSchema, { ...ctx, path: `${ctx.path}/items` });
  } catch (err) {
    // An array of `never` is satisfiable only when it is allowed to be empty.
    if (err instanceof UnsatisfiableSchemaError && minItems === 0) return fc.constant([]);
    throw err;
  }
  if (schema.uniqueItems === true) {
    return fc.uniqueArray(item, { minLength: minItems, maxLength });
  }
  return fc.array(item, { minLength: minItems, maxLength });
}

function buildObject(schema: JsonSchema, ctx: Ctx): fc.Arbitrary<unknown> {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  );

  const model: Record<string, fc.Arbitrary<unknown>> = {};
  const requiredKeys: string[] = [];
  for (const [key, propSchema] of Object.entries(properties)) {
    const propPath = `${ctx.path}/properties/${key}`;
    try {
      model[key] = build(propSchema, { ...ctx, path: propPath });
      if (required.has(key)) requiredKeys.push(key);
    } catch (err) {
      if (err instanceof UnsatisfiableSchemaError) {
        // z.never() as a property: impossible to supply. Required ⇒ the whole object is
        // impossible; optional ⇒ the only conforming objects omit the key entirely.
        if (required.has(key)) throw new UnsatisfiableSchemaError(propPath);
        continue;
      }
      throw err;
    }
  }

  const declared = fc.record(model, { requiredKeys });

  // `additionalProperties` absent or true ⇒ open. A schema ⇒ open with a typed value.
  const additional = schema.additionalProperties;
  if (additional === false || additional === undefined) return declared;

  const keyArb = isPlainObject(schema.propertyNames)
    ? (build(schema.propertyNames, { ...ctx, path: `${ctx.path}/propertyNames` }) as fc.Arbitrary<string>)
    : fc.string({ minLength: 1, maxLength: ctx.maxSize });

  let valueArb: fc.Arbitrary<unknown>;
  try {
    valueArb =
      additional === true
        ? fc.jsonValue({ maxDepth: 1 })
        : build(additional, { ...ctx, path: `${ctx.path}/additionalProperties` });
  } catch (err) {
    if (err instanceof UnsatisfiableSchemaError) return declared;
    throw err;
  }

  const extras = fc.dictionary(keyArb, valueArb, { maxKeys: 2 });
  return fc.tuple(declared, extras).map(([base, extra]) => {
    // Declared properties WIN: an extra key colliding with one would violate its schema.
    const out: Record<string, unknown> = { ...(extra as Record<string, unknown>) };
    for (const [k, v] of Object.entries(base as Record<string, unknown>)) out[k] = v;
    return out;
  });
}
