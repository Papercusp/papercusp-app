/**
 * Generic, pure, dependency-free per-column FILTER ENGINE for RichGrid
 * consumers.
 *
 * The symmetric sibling of `sort-util.ts`: just as `ColumnDef.sortKey` opts a
 * column into controlled sort and `applySort(rows, state)` is a pure helper
 * the consumer calls, `ColumnDef.filter` opts a column into filtering and
 * `applyColumnFilters(rows, state, columns)` is the pure helper that runs it.
 *
 * Design constraints (intentional, mirror sort-util):
 *  - PURE: no React, no URL/nuqs knowledge, no I/O, never mutates inputs,
 *    never throws. The consumer owns where filter state lives (nuqs URL,
 *    useState, server params, …) — this engine only transforms data.
 *  - DEPENDENCY-FREE: same dep budget as the rest of grid-core.
 *  - SMALL-DATASET oriented: like `applySort`, intended for row counts where
 *    re-filtering on every render is fine (a few thousand rows). For larger
 *    sets, push the predicate into the data source.
 *
 * Null handling: a `null` / `undefined` accessor value FAILS any *active*
 * predicate (it has nothing to match), the same spirit as `applySort`'s
 * "nullish sorts last" rule — empty cells don't sneak through a filter.
 */

// ─── Filter specs (per column) ───────────────────────────────────────────────

/** Text column: case-insensitive substring match. */
export interface TextFilterSpec<TRow> {
  type: 'text';
  accessor: (row: TRow) => string | null | undefined;
}

/** Enum column: membership in a selected set of string values. */
export interface EnumFilterSpec<TRow> {
  type: 'enum';
  accessor: (row: TRow) => string | null | undefined;
  /**
   * Explicit option list. When omitted, `deriveEnumOptions` discovers the
   * distinct values from the rows. When present, its order + labels are kept
   * and live counts are attached (count 0 allowed).
   */
  options?: { value: string; label?: string }[];
  /** Whether multiple values may be selected at once. Purely advisory for the
   *  UI layer — the predicate is membership either way. */
  multi?: boolean;
}

/** Number column: inclusive `min <= v <= max` range (either bound optional). */
export interface NumberFilterSpec<TRow> {
  type: 'number';
  accessor: (row: TRow) => number | null | undefined;
}

/** Boolean column: strict equality against the selected boolean. */
export interface BooleanFilterSpec<TRow> {
  type: 'boolean';
  accessor: (row: TRow) => boolean | null | undefined;
}

/** Discriminated union over `type`. */
export type ColumnFilterSpec<TRow> =
  | TextFilterSpec<TRow>
  | EnumFilterSpec<TRow>
  | NumberFilterSpec<TRow>
  | BooleanFilterSpec<TRow>;

// ─── Filter values (per active filter) ───────────────────────────────────────

/** Inclusive numeric range. Both bounds optional (open-ended either side). */
export interface NumberFilterValue {
  min?: number;
  max?: number;
}

/**
 * The value union, matched to the spec `type` by the engine:
 *   text    → string   (the query; empty string = inactive)
 *   enum    → string[] (selected values; empty array = inactive)
 *   number  → { min?, max? } (both empty = inactive)
 *   boolean → boolean  (the value to equal)
 */
export type ColumnFilterValue = string | string[] | NumberFilterValue | boolean;

/** Active filter values keyed by column `key`. */
export type ColumnFilterState = Record<string, ColumnFilterValue>;

// ─── Minimal hook-facing column shape ────────────────────────────────────────

/**
 * The minimal column shape the engine needs. `ColumnDef<TRow>` is structurally
 * assignable to this, so RichGrid columns work directly — but non-grid
 * consumers can drive the engine with a bare `{ key, header, filter }` too.
 */
export interface FilterableColumn<TRow> {
  key: string;
  header: unknown;
  /**
   * Optional plain-text column name. Used as the label fallback when `header`
   * is an empty string or non-textual (e.g. an icon-only column whose
   * `header` is ''). `ColumnDef` already carries `headerText`, so it flows
   * through automatically — icon-only columns still get a readable filter
   * option / chip / editor label.
   */
  headerText?: unknown;
  filter?: ColumnFilterSpec<TRow>;
}

// ─── Predicate helpers ───────────────────────────────────────────────────────

/** Is this filter value "empty" (i.e. inactive / no constraint)? */
function isInactiveValue(spec: ColumnFilterSpec<unknown>, value: ColumnFilterValue): boolean {
  switch (spec.type) {
    case 'text':
      return typeof value !== 'string' || value.length === 0;
    case 'enum':
      return !Array.isArray(value) || value.length === 0;
    case 'number': {
      if (value == null || typeof value !== 'object' || Array.isArray(value)) return true;
      const { min, max } = value as NumberFilterValue;
      return min == null && max == null;
    }
    case 'boolean':
      return typeof value !== 'boolean';
    default:
      return true;
  }
}

/**
 * Run one column's predicate against one row. Returns `true` when the row
 * passes (or the filter is inactive / malformed). A nullish accessor value
 * fails an active predicate. Never throws.
 */
function rowPassesFilter<TRow>(
  spec: ColumnFilterSpec<TRow>,
  value: ColumnFilterValue,
  row: TRow,
): boolean {
  if (isInactiveValue(spec as ColumnFilterSpec<unknown>, value)) return true;

  switch (spec.type) {
    case 'text': {
      const v = spec.accessor(row);
      if (v == null) return false;
      return String(v).toLowerCase().includes((value as string).toLowerCase());
    }
    case 'enum': {
      const v = spec.accessor(row);
      if (v == null) return false;
      return (value as string[]).includes(v);
    }
    case 'number': {
      const v = spec.accessor(row);
      if (v == null || typeof v !== 'number' || Number.isNaN(v)) return false;
      const { min, max } = value as NumberFilterValue;
      if (min != null && v < min) return false;
      if (max != null && v > max) return false;
      return true;
    }
    case 'boolean': {
      const v = spec.accessor(row);
      if (v == null) return false;
      return v === (value as boolean);
    }
    default:
      return true;
  }
}

// ─── applyColumnFilters ──────────────────────────────────────────────────────

/**
 * Filter `rows` by `state`, an AND across every active per-column filter.
 *
 * Pure + non-mutating: returns a fresh array (a filtered shallow copy). An
 * inactive filter (empty string / empty array / open-on-both-sides range) is
 * skipped. A filter whose column key isn't in `columns` (or the column has no
 * `filter` spec) is ignored. A nullish accessor value fails the predicate.
 * Never throws.
 */
export function applyColumnFilters<TRow>(
  rows: readonly TRow[],
  state: ColumnFilterState | null | undefined,
  columns: readonly FilterableColumn<TRow>[],
): TRow[] {
  if (!state) return rows as TRow[];
  // Resolve each active state entry to a (spec, value) pair once, up front,
  // so the per-row loop stays tight.
  const active: { spec: ColumnFilterSpec<TRow>; value: ColumnFilterValue }[] = [];
  for (const key of Object.keys(state)) {
    const col = columns.find((c) => c.key === key);
    if (!col?.filter) continue;
    const value = state[key];
    if (isInactiveValue(col.filter as ColumnFilterSpec<unknown>, value)) continue;
    active.push({ spec: col.filter, value });
  }
  if (active.length === 0) return rows as TRow[];
  return rows.filter((row) => active.every(({ spec, value }) => rowPassesFilter(spec, value, row)));
}

// ─── deriveEnumOptions ───────────────────────────────────────────────────────

export interface EnumOption {
  value: string;
  label?: string;
  count: number;
}

/**
 * Compute the enum option list for an enum column, with live occurrence counts.
 *
 *  - If the spec carries explicit `options`, keep their order + labels and
 *    attach the live count for each (count 0 allowed for options absent from
 *    the rows).
 *  - Otherwise discover distinct non-null accessor values from `rows`, sorted
 *    with `localeCompare`, each carrying its occurrence count.
 *
 * Pure; never throws. Returns `[]` for non-enum columns / columns without a
 * filter spec.
 */
export function deriveEnumOptions<TRow>(
  rows: readonly TRow[],
  col: FilterableColumn<TRow>,
): EnumOption[] {
  const spec = col.filter;
  if (!spec || spec.type !== 'enum') return [];

  const counts = new Map<string, number>();
  for (const row of rows) {
    const v = spec.accessor(row);
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }

  if (spec.options && spec.options.length > 0) {
    return spec.options.map((o) => ({
      value: o.value,
      ...(o.label !== undefined ? { label: o.label } : {}),
      count: counts.get(o.value) ?? 0,
    }));
  }

  return [...counts.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value, count: counts.get(value)! }));
}

// ─── URL codec ───────────────────────────────────────────────────────────────
//
// Compact, readable, round-tripping. The whole state encodes to a single
// string the consumer can park in a nuqs URL param (the engine itself stays
// nuqs-agnostic). Format:
//
//   clauses joined by "~", each clause is "<colKey>:<encodedValue>"
//     enum    → comma-joined values            kind:bug,change
//     number  → "min..max" (either side omittable)   prio:1..3 / prio:..5 / prio:2..
//     boolean → "true" / "false"               open:true
//     text    → the raw query, percent-escaped so the delimiters
//               "~" "," ":" "%" survive a round-trip       q:foo%3Abar
//
// Only the delimiter set + "%" is escaped (a minimal, human-readable scheme —
// not full encodeURIComponent), so typical text stays legible in the URL.

const CLAUSE_SEP = '~';
const KV_SEP = ':';
const LIST_SEP = ',';
const RANGE_SEP = '..';

/** Percent-escape the chars that would break the codec's delimiter grammar. */
function escapeText(s: string): string {
  return s.replace(/[%~,:]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** Inverse of `escapeText`. Tolerates malformed/trailing "%" by passing through. */
function unescapeText(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function encodeClauseValue(spec: ColumnFilterSpec<unknown>, value: ColumnFilterValue): string | null {
  if (isInactiveValue(spec, value)) return null;
  switch (spec.type) {
    case 'text':
      return escapeText(value as string);
    case 'enum':
      return (value as string[]).map(escapeText).join(LIST_SEP);
    case 'number': {
      const { min, max } = value as NumberFilterValue;
      const lo = min != null ? String(min) : '';
      const hi = max != null ? String(max) : '';
      return `${lo}${RANGE_SEP}${hi}`;
    }
    case 'boolean':
      return (value as boolean) ? 'true' : 'false';
    default:
      return null;
  }
}

/**
 * Serialize filter state to a compact URL-friendly string. Inactive clauses
 * are dropped. The result round-trips through `decodeColumnFilters` for every
 * value type. Empty state → empty string. Pure; never throws.
 *
 * Note: encoding does not require the column set — keys are taken from `state`
 * and the value's runtime shape determines the encoding. (Decoding *does* need
 * columns, to know each key's spec type.)
 */
export function encodeColumnFilters(state: ColumnFilterState | null | undefined): string {
  if (!state) return '';
  const parts: string[] = [];
  for (const key of Object.keys(state)) {
    const value = state[key];
    const spec = inferSpecFromValue(value);
    if (!spec) continue;
    const encoded = encodeClauseValue(spec, value);
    if (encoded == null) continue;
    parts.push(`${escapeKey(key)}${KV_SEP}${encoded}`);
  }
  return parts.join(CLAUSE_SEP);
}

/** A column key may itself contain a delimiter; escape the same set. */
function escapeKey(key: string): string {
  return escapeText(key);
}

/**
 * Infer just enough of a spec (its `type`) from a runtime value, so encoding
 * doesn't need the column set. The accessor is never invoked during encoding,
 * so a stub is fine.
 */
function inferSpecFromValue(value: ColumnFilterValue): ColumnFilterSpec<unknown> | null {
  if (typeof value === 'string') return { type: 'text', accessor: () => null };
  if (Array.isArray(value)) return { type: 'enum', accessor: () => null };
  if (typeof value === 'boolean') return { type: 'boolean', accessor: () => null };
  if (value != null && typeof value === 'object') return { type: 'number', accessor: () => null };
  return null;
}

function parseNumberRange(raw: string): NumberFilterValue | null {
  const idx = raw.indexOf(RANGE_SEP);
  if (idx === -1) return null;
  const loStr = raw.slice(0, idx);
  const hiStr = raw.slice(idx + RANGE_SEP.length);
  const out: NumberFilterValue = {};
  if (loStr !== '') {
    const lo = Number(loStr);
    if (Number.isNaN(lo)) return null;
    out.min = lo;
  }
  if (hiStr !== '') {
    const hi = Number(hiStr);
    if (Number.isNaN(hi)) return null;
    out.max = hi;
  }
  if (out.min == null && out.max == null) return null;
  return out;
}

/**
 * Parse a string produced by `encodeColumnFilters` back into filter state.
 *
 *  - Decodes each clause according to its column's spec `type` (so the typed
 *    value shape is correct).
 *  - Drops clauses whose key is unknown / not a filterable column, and any
 *    malformed clause (missing `:`, bad number, empty value).
 *  - Round-trips `encodeColumnFilters` exactly for every value type.
 *
 * Pure; never throws.
 */
export function decodeColumnFilters<TRow>(
  str: string | null | undefined,
  columns: readonly FilterableColumn<TRow>[],
): ColumnFilterState {
  const out: ColumnFilterState = {};
  if (!str) return out;
  const byKey = new Map<string, ColumnFilterSpec<TRow>>();
  for (const c of columns) if (c.filter) byKey.set(c.key, c.filter);

  for (const clause of str.split(CLAUSE_SEP)) {
    if (clause === '') continue;
    const sep = clause.indexOf(KV_SEP);
    if (sep === -1) continue;
    const key = unescapeText(clause.slice(0, sep));
    const rawValue = clause.slice(sep + KV_SEP.length);
    const spec = byKey.get(key);
    if (!spec) continue;

    switch (spec.type) {
      case 'text': {
        const text = unescapeText(rawValue);
        if (text.length === 0) continue;
        out[key] = text;
        break;
      }
      case 'enum': {
        const values = rawValue
          .split(LIST_SEP)
          .filter((s) => s !== '')
          .map(unescapeText);
        if (values.length === 0) continue;
        out[key] = values;
        break;
      }
      case 'number': {
        const range = parseNumberRange(rawValue);
        if (!range) continue;
        out[key] = range;
        break;
      }
      case 'boolean': {
        if (rawValue === 'true') out[key] = true;
        else if (rawValue === 'false') out[key] = false;
        // anything else → malformed, drop
        break;
      }
    }
  }
  return out;
}

// ─── filterChipLabel ─────────────────────────────────────────────────────────

/** Look up an enum option's display label, falling back to its raw value. */
function enumLabelFor(spec: EnumFilterSpec<unknown>, value: string): string {
  const opt = spec.options?.find((o) => o.value === value);
  return opt?.label ?? value;
}

/** The column's short display name for a chip prefix. */
function columnLabel(col: FilterableColumn<unknown>): string {
  if (typeof col.header === 'string' && col.header.length > 0) return col.header;
  if (typeof col.header === 'number') return String(col.header);
  if (typeof col.headerText === 'string' && col.headerText.length > 0) return col.headerText;
  return col.key;
}

/**
 * Render a short, human-readable chip label for an active filter, e.g.
 *   text    →  "Plan: auth"
 *   enum    →  "Kind: bug, change"
 *   number  →  "Prio: 1–3"  /  "Prio: ≤5"  /  "Prio: ≥2"
 *   boolean →  "State: open" (header is the noun; value renders true/false)
 *
 * Pure; never throws. Returns '' when the value is inactive for the spec.
 */
export function filterChipLabel<TRow>(
  col: FilterableColumn<TRow>,
  value: ColumnFilterValue,
): string {
  const spec = col.filter;
  const name = columnLabel(col as FilterableColumn<unknown>);
  if (!spec) return '';
  if (isInactiveValue(spec as ColumnFilterSpec<unknown>, value)) return '';

  switch (spec.type) {
    case 'text':
      return `${name}: ${value as string}`;
    case 'enum': {
      const labels = (value as string[]).map((v) =>
        enumLabelFor(spec as EnumFilterSpec<unknown>, v),
      );
      return `${name}: ${labels.join(', ')}`;
    }
    case 'number': {
      const { min, max } = value as NumberFilterValue;
      if (min != null && max != null) return `${name}: ${min}–${max}`;
      if (min != null) return `${name}: ≥${min}`;
      return `${name}: ≤${max}`;
    }
    case 'boolean':
      return `${name}: ${(value as boolean) ? 'true' : 'false'}`;
    default:
      return '';
  }
}
