/**
 * Tier-3 "prompt-declared column schema" primitives (plan
 * `token-efficient-agent-io-2026-06-06`, D-001/D-003/D-006/D-007).
 *
 * When both ends know a tool's column schema, the schema does not travel on the
 * wire — it is declared once in the agent's prompt and only VALUES travel. This
 * module is the domain-free machinery for that, used in BOTH directions:
 *
 *   - **read** (server → model): `encodePositionalRows` renders a flat array as
 *     a headerless CSV body with a leading `[N]` row-count guard. The columns
 *     come from the tool's output schema and are declared in the prompt, so no
 *     header is on the wire. `[N]` lets the model detect truncation.
 *
 *   - **write** (model → server): `reconstructArgs` takes a positional row the
 *     model emitted and rebuilds the typed args object from the prompt-declared
 *     column order, coercing scalar types and applying the null-rule, BEFORE the
 *     host Zod-validates. `reconstructArgs` also runs the misalignment guard
 *     (D-007): Zod checks shape, not alignment, so a shifted row would otherwise
 *     write wrong-but-valid data silently. The guard rejects on bad arity, a
 *     column sanity-check miss (id/enum), so a mis-emitted row fails loudly.
 *
 * `ColumnSpec[]` is the single source projected into the prompt, the read
 * encoder, AND the write shim — so they cannot desync (the anti-desync equality
 * test asserts exactly this). Both `projectColumns*` functions derive from the
 * SAME JSON-Schema the host already produces for `args`/`result`, so order is
 * structural, not hand-maintained.
 */

import { cellToString, parseRows, quoteField } from './csv';

/** The declared type of a positional column — drives coercion (write) + the prompt legend. */
export type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'id' | 'text';

export interface ColumnSpec {
  /** Property name (the keyed-object key this position maps to). */
  name: string;
  /** Declared scalar type. `text` = the trailing free-text field (write only). `id` = sanity-guarded. */
  type: ColumnType;
  /** Optional (`.optional()`) — a trailing empty value is omitted rather than sent. */
  optional: boolean;
  /** Nullable (`.nullable()`) — an empty value decodes to `null` rather than ''. */
  nullable: boolean;
  /** Allowed members for `enum` columns — used by the misalignment guard + the prompt legend. */
  enumValues?: string[];
  /** A sanity regex (source string) a value must match — used by the misalignment guard (e.g. id columns). */
  pattern?: string;
}

/**
 * A per-column sanity override the registry (not the tool's own Zod schema) can
 * declare for the write misalignment guard (D-007 residual — EI-7927). Some
 * columns can't carry the constraint in their own schema — e.g. a `state` arg
 * is typed as a loose string so it can accept every cross-family alias, or an
 * `id` arg accepts several id-family prefixes so it can't hold one `.regex()`
 * — but the guard can still catch an obviously-misaligned value in that
 * position if the registry supplies the pattern/vocabulary out of band.
 */
export interface ColumnOverride {
  /** Sanity regex (source string) applied like a schema-derived `pattern`. */
  pattern?: string;
  /** Known-vocabulary membership check, applied even to non-`enum`-typed columns. */
  enumValues?: readonly string[];
}

/**
 * Merge registry-declared `ColumnOverride`s onto schema-projected columns, by
 * name. NEVER applied to the trailing free-text column (deliberately
 * unconstrained) and NEVER overwrites a constraint the schema itself already
 * derived — an override only FILLS a gap the schema can't express; it can't
 * loosen or fight a real schema-derived check. Pure (returns a new array).
 */
export function applyColumnOverrides(
  cols: ColumnSpec[],
  overrides?: Record<string, ColumnOverride>,
): ColumnSpec[] {
  if (!overrides) return cols;
  return cols.map((col) => {
    if (col.type === 'text') return col; // free-text stays unconstrained
    const ov = overrides[col.name];
    if (!ov) return col;
    return {
      ...col,
      pattern: col.pattern ?? ov.pattern,
      enumValues: col.enumValues ?? (ov.enumValues ? [...ov.enumValues] : undefined),
    };
  });
}

/** Names that, as the LAST arg of a write-tool, mark the single trailing free-text column (D-006). */
const FREE_TEXT_NAMES = new Set([
  'summary',
  'body',
  'text',
  'note',
  'message',
  'intent',
  'context',
  'reason',
  'description',
  'comment',
]);

/** Heuristic: does an id-shaped column name (`id`, `*_id`, `msg_id`, `slug`) warrant an id sanity-guard? */
function looksLikeId(name: string): boolean {
  return name === 'id' || name.endsWith('_id') || name.endsWith('Id') || name === 'slug';
}

function asObject(schema: unknown): Record<string, unknown> | undefined {
  return schema !== null && typeof schema === 'object' && !Array.isArray(schema)
    ? (schema as Record<string, unknown>)
    : undefined;
}

/** Collapse `T | null` (zod `.nullable()` → `anyOf:[T,{type:'null'}]`) to `{ inner, nullable }`. */
function unwrapNullable(schema: Record<string, unknown>): { inner: Record<string, unknown>; nullable: boolean } {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const members = schema[key];
    if (Array.isArray(members)) {
      const nulls = (members as unknown[]).filter((m) => asObject(m)?.type === 'null');
      const nonNull = (members as unknown[]).map(asObject).filter((m): m is Record<string, unknown> => !!m && m.type !== 'null');
      if (nulls.length > 0 && nonNull.length === 1) return { inner: nonNull[0], nullable: true };
    }
  }
  // `type: ['string','null']` form.
  if (Array.isArray(schema.type) && (schema.type as unknown[]).includes('null')) {
    const nonNull = (schema.type as unknown[]).filter((t) => t !== 'null');
    return { inner: { ...schema, type: nonNull.length === 1 ? nonNull[0] : nonNull }, nullable: true };
  }
  return { inner: schema, nullable: false };
}

function scalarTypeOf(inner: Record<string, unknown>, name: string): { type: ColumnType; enumValues?: string[]; pattern?: string } {
  if (Array.isArray(inner.enum)) {
    return { type: 'enum', enumValues: (inner.enum as unknown[]).map(String) };
  }
  if ('const' in inner) return { type: 'enum', enumValues: [String(inner.const)] };
  const t = inner.type;
  if (t === 'number') return { type: 'number' };
  if (t === 'integer') return { type: 'integer' };
  if (t === 'boolean') return { type: 'boolean' };
  // string-ish
  if (looksLikeId(name)) return { type: 'id', pattern: typeof inner.pattern === 'string' ? inner.pattern : undefined };
  return { type: 'string', pattern: typeof inner.pattern === 'string' ? inner.pattern : undefined };
}

/**
 * Project the column list from an OBJECT JSON-Schema (the array-item schema for
 * read, the args schema for write). Column order = `properties` insertion order
 * (Zod's `toJSONSchema` preserves field order). Returns `undefined` when the
 * shape isn't a flat object of scalar leaves (i.e. not positional-eligible).
 */
function projectFromObjectSchema(
  objectSchema: Record<string, unknown> | undefined | null,
  opts: { freeTextLast?: boolean; freeTextName?: string } = {},
): ColumnSpec[] | undefined {
  const obj = asObject(objectSchema);
  if (!obj || obj.type !== 'object') return undefined;
  const props = asObject(obj.properties);
  if (!props || Object.keys(props).length === 0) return undefined;
  // Unknown extra columns → can't prove flat / positional.
  if (obj.additionalProperties !== undefined && obj.additionalProperties !== false) return undefined;

  const required = new Set(Array.isArray(obj.required) ? (obj.required as unknown[]).map(String) : []);
  const names = Object.keys(props);
  const cols: ColumnSpec[] = [];
  for (const name of names) {
    const raw = asObject(props[name]);
    if (!raw) return undefined;
    const { inner, nullable } = unwrapNullable(raw);
    // Reject nested object/array columns — positional/CSV has no native cell nesting.
    const innerType = inner.type;
    if (innerType === 'object' || innerType === 'array') return undefined;
    if (Array.isArray(inner.anyOf) || Array.isArray(inner.oneOf)) {
      // A union that isn't a plain nullable scalar → not positional-safe.
      return undefined;
    }
    const { type, enumValues, pattern } = scalarTypeOf(inner, name);
    // A field with a Zod `.default()` projects as `required` (it always has a
    // value on output) but is omittable on INPUT — treat it as optional so the
    // model may drop it and Zod fills the default.
    const optional = !required.has(name) || 'default' in raw;
    cols.push({ name, type, optional, nullable, enumValues, pattern });
  }

  // Mark the single trailing free-text column for write tools (D-006): the LAST
  // column, when it is a plain string named like prose. Splitting on the first
  // N-1 delimiters then makes its embedded commas/newlines safe — no model-side
  // escaping. Only one is allowed and it must be last.
  if (opts.freeTextLast && cols.length > 0) {
    const last = cols[cols.length - 1];
    const isFree = opts.freeTextName ? last.name === opts.freeTextName : last.type === 'string' && FREE_TEXT_NAMES.has(last.name);
    if (isFree) last.type = 'text';
    // Any EARLIER free-text-shaped column makes the tool ineligible (≥2 free-text).
    for (let i = 0; i < cols.length - 1; i++) {
      if (cols[i].type === 'string' && FREE_TEXT_NAMES.has(cols[i].name)) return undefined;
    }
    // Positional safety (D-006 — "not a pile of optionals"): optional columns
    // must form a contiguous TRAILING block. A required column AFTER an optional
    // would let the model omit the optional and silently SHIFT every later value
    // into the wrong column. Such a tool stays typed-JSON.
    let seenOptional = false;
    for (const c of cols) {
      if (c.optional) seenOptional = true;
      else if (seenOptional) return undefined;
    }
  } else {
    // Read path / all-scalar write: ≥1 prose-shaped column means it isn't a
    // clean positional shape (embedded delimiters with no trailing-split rule).
    // Read tolerates it (RFC-quoted), so only guard the write caller via opts.
  }
  return cols;
}

function pickWriteColumnSchema(
  objectSchema: Record<string, unknown> | undefined | null,
  names: readonly string[] | undefined,
  requiredNames: readonly string[] | undefined,
): Record<string, unknown> | undefined {
  if (!names || names.length === 0) return asObject(objectSchema);
  const obj = asObject(objectSchema);
  if (!obj || obj.type !== 'object') return undefined;
  const props = asObject(obj.properties);
  if (!props) return undefined;
  const pickedProps: Record<string, unknown> = {};
  for (const name of names) {
    if (!(name in props)) return undefined;
    pickedProps[name] = props[name];
  }
  const baseRequired = new Set(Array.isArray(obj.required) ? (obj.required as unknown[]).map(String) : []);
  const required = requiredNames ? requiredNames.map(String) : names.filter((name) => baseRequired.has(name));
  const known = new Set(names);
  if (required.some((name) => !known.has(name))) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties: pickedProps,
  };
}

/**
 * READ projection: the columns of a tool's list RESULT, from the JSON-Schema of
 * its output `data` node (must be `array(object{…scalars…})`). Used by the read
 * encoder and the prompt "## Wire schemas" legend.
 */
export function projectReadColumns(dataJsonSchema: Record<string, unknown> | undefined | null): ColumnSpec[] | undefined {
  const schema = asObject(dataJsonSchema);
  if (!schema) return undefined;
  const { inner } = unwrapNullable(schema);
  if (inner.type !== 'array' || !('items' in inner)) return undefined;
  const items = inner.items;
  if (Array.isArray(items)) return undefined; // tuple → heterogeneous
  return projectFromObjectSchema(asObject(items));
}

/**
 * WRITE projection: the columns of a tool's ARGS, from the JSON-Schema of its
 * `args` object. `freeTextName` (from the registry) pins which arg is the
 * trailing free-text column; otherwise the name heuristic applies. Returns
 * `undefined` when the args shape doesn't fit the bounded positional shape
 * (nested args, ≥2 free-text, a union column) — such tools stay typed-JSON.
 */
export function projectWriteColumns(
  argsJsonSchema: Record<string, unknown> | undefined | null,
  opts: {
    freeTextName?: string;
    columnOverrides?: Record<string, ColumnOverride>;
    columnNames?: readonly string[];
    requiredColumnNames?: readonly string[];
  } = {},
): ColumnSpec[] | undefined {
  const rowSchema = pickWriteColumnSchema(asObject(argsJsonSchema), opts.columnNames, opts.requiredColumnNames);
  const cols = projectFromObjectSchema(rowSchema, { freeTextLast: true, freeTextName: opts.freeTextName });
  if (!cols) return undefined;
  return applyColumnOverrides(cols, opts.columnOverrides);
}

// ---------------------------------------------------------------------------
// Read encoding — headerless CSV + `[N]` row-count guard
// ---------------------------------------------------------------------------

/**
 * Encode a flat array as a headerless positional CSV/TSV body: a `[N]` count line
 * (truncation guard) followed by one RFC-4180-quoted row per element, columns in
 * the projected order. The columns themselves are NOT emitted — they live in the
 * prompt. The host prefixes the `format: csv` marker.
 */
export function encodePositionalRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: ColumnSpec[],
  delimiter: ',' | '\t' = ',',
): string {
  const lines: string[] = [`[${rows.length}]`];
  for (const row of rows) {
    lines.push(columns.map((c) => quoteField(cellToString(row[c.name]), delimiter)).join(delimiter));
  }
  return lines.join('\n');
}

/**
 * The JSON-Schema a write-positional tool ADVERTISES in `tools/list` instead of
 * its keyed args: a single `row` string. This is what makes the model emit a
 * positional row at all — the per-column meaning lives in the prompt's "## Wire
 * schemas" legend, and the `row` description names the column order as a
 * belt-and-suspenders reminder. Some bulk-capable write tools advertise this
 * schema inside a `oneOf` next to their full keyed args, but the row member
 * itself stays this exact shape.
 */
export function positionalRowSchema(columns: ColumnSpec[]): Record<string, unknown> {
  const order = columns.map((c) => (c.optional ? `${c.name}?` : c.name)).join(', ');
  const freeText = columns.length > 0 && columns[columns.length - 1].type === 'text';
  const tail = freeText
    ? ' The last column is free-text and may contain commas — do not quote it.'
    : '';
  return {
    type: 'object',
    additionalProperties: false,
    required: ['row'],
    properties: {
      row: {
        type: 'string',
        description: `Comma-separated VALUES in column order: ${order}. Omit trailing optional columns.${tail}`,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Write reconstruction — positional row → typed args, with the misalignment guard
// ---------------------------------------------------------------------------

export type ReconstructResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; reason: string };

function coerceScalar(raw: string, col: ColumnSpec): { ok: true; value: unknown } | { ok: false; reason: string } {
  // Null-rule (D-003): an empty cell is `null` when nullable, omitted when merely
  // optional, else an explicit empty string for string-ish columns.
  if (raw === '') {
    if (col.nullable) return { ok: true, value: null };
    if (col.optional) return { ok: true, value: undefined };
    if (col.type === 'string' || col.type === 'text' || col.type === 'id') return { ok: true, value: '' };
    return { ok: false, reason: `column "${col.name}" is required but empty` };
  }
  switch (col.type) {
    case 'number':
    case 'integer': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, reason: `column "${col.name}" expected ${col.type}, got "${raw}"` };
      if (col.type === 'integer' && !Number.isInteger(n)) return { ok: false, reason: `column "${col.name}" expected integer, got "${raw}"` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      const v = raw.toLowerCase();
      if (v === 'true' || v === '1') return { ok: true, value: true };
      if (v === 'false' || v === '0') return { ok: true, value: false };
      return { ok: false, reason: `column "${col.name}" expected boolean, got "${raw}"` };
    }
    case 'enum': {
      if (col.enumValues && !col.enumValues.includes(raw)) {
        return { ok: false, reason: `column "${col.name}" must be one of ${col.enumValues.join('|')}, got "${raw}"` };
      }
      return { ok: true, value: raw };
    }
    case 'text':
      // Free-text trailing column: deliberately unconstrained (D-006) — never
      // pattern/enum-checked even when the registry declared a columnOverride
      // (applyColumnOverrides already refuses to attach one to `text`).
      return { ok: true, value: raw };
    case 'id':
    case 'string':
    default: {
      if (col.pattern) {
        try {
          if (!new RegExp(col.pattern).test(raw)) {
            return { ok: false, reason: `column "${col.name}" failed sanity check /${col.pattern}/ on "${raw}"` };
          }
        } catch {
          /* an unparseable pattern never blocks — guard is best-effort */
        }
      }
      // D-007 residual (EI-7927): a column whose OWN schema is a loose string
      // (so it can't carry a Zod `.enum()`) may still have a registry-declared
      // known-vocabulary check (ColumnOverride.enumValues) — catches a
      // misaligned row (e.g. a state-shaped value landing in an id column, or
      // vice versa) that arity + an id-shape regex alone would miss.
      if (col.enumValues && col.enumValues.length > 0 && !col.enumValues.includes(raw)) {
        return { ok: false, reason: `column "${col.name}" must be one of ${col.enumValues.join('|')}, got "${raw}"` };
      }
      return { ok: true, value: raw };
    }
  }
}

/**
 * Split a positional row into field strings, honoring the trailing free-text
 * column. When the last column is `text`, the first N-1 fields split on the
 * first N-1 commas and the remainder (commas/newlines and all) is the free-text
 * field — no model-side escaping. Otherwise the whole row is RFC-4180-parsed so
 * a quoted scalar can still carry a comma if the model chose to quote it.
 */
function splitRow(rowText: string, columns: ColumnSpec[]): string[] {
  const hasFreeText = columns.length > 0 && columns[columns.length - 1].type === 'text';
  if (hasFreeText) {
    const scalarCount = columns.length - 1;
    const fields: string[] = [];
    let rest = rowText;
    for (let i = 0; i < scalarCount; i++) {
      const idx = rest.indexOf(',');
      if (idx === -1) {
        fields.push(rest);
        rest = '';
      } else {
        fields.push(rest.slice(0, idx));
        rest = rest.slice(idx + 1);
      }
    }
    fields.push(rest); // the free-text remainder, verbatim
    return fields;
  }
  const parsed = parseRows(rowText.replace(/\n+$/, ''), ',');
  return parsed.length > 0 ? parsed[0] : rowText === '' ? [] : [rowText];
}

/**
 * Reconstruct a typed args object from a positional row + the prompt-declared
 * columns, running the misalignment guard. The result is handed to the host's
 * Zod validator. Rejects (rather than silently writing wrong-but-valid data)
 * when arity is wrong or a column sanity-check fails (D-007).
 */
export function reconstructArgs(rowText: string, columns: ColumnSpec[]): ReconstructResult {
  if (columns.length === 0) return { ok: false, reason: 'no columns declared' };
  const fields = splitRow(rowText, columns);

  // Arity guard. Trailing OPTIONAL columns may be omitted, so the row may carry
  // anywhere from (#required) to (#columns) fields — but never more.
  const requiredCount = columns.filter((c) => !c.optional).length;
  if (fields.length > columns.length) {
    return { ok: false, reason: `too many fields: got ${fields.length}, expected at most ${columns.length}` };
  }
  if (fields.length < requiredCount) {
    return { ok: false, reason: `too few fields: got ${fields.length}, expected at least ${requiredCount} required` };
  }

  const args: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    // Normalize EDGE whitespace per field: a model that writes the natural CSV
    // style `WI-42, passed` must not be rejected by the enum/id guard over a
    // stray leading space. Internal content (commas/newlines inside a free-text
    // field) is untouched — `.trim()` only strips the field's own edges.
    const raw = (i < fields.length ? fields[i] : '').trim();
    const coerced = coerceScalar(raw, col);
    if (!coerced.ok) return { ok: false, reason: coerced.reason };
    if (coerced.value !== undefined) args[col.name] = coerced.value;
  }
  return { ok: true, args };
}
