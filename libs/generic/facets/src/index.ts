/**
 * @papercusp/facets — a domain-free faceted-filtering core.
 *
 * The whole point is CONTEXT-DEPENDENT facets: both *which facets appear* and
 * *which values appear* are derived from the ACTUAL rows you pass in, never a
 * fixed menu. A facet with a single distinct value across the rows can't filter
 * anything, so it's hidden by default. Every value carries its count, so a pill
 * can say `claude 12` and the user knows whether it's worth clicking.
 *
 * Genericity is achieved the same way `@papercusp/search`'s recency seam is:
 * **generalize the algorithm, parameterize the field access.** The lib owns the
 * tally / hide / sort / cap / predicate math; the caller owns exactly one thing
 * — how to pull a facet's value(s) out of one row — via `FacetDef.extract`. So a
 * session-search UI, a work-items list, and a plans list can all call
 * `computeFacets` over their own row types with zero domain code in here.
 *
 * Pure + synchronous + no React. Anything async or server-side (e.g. re-querying
 * a backend for a wider result set) is deliberately the caller's concern, not
 * folded in here.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A value a row contributes to a facet. `value` is the stable identity used for
 * grouping, counting, selection, and URL serialization. `meta` is OPAQUE
 * passthrough the core never reads — it just carries it to the renderer, so a
 * caller can attach a display label, a color, a sort hint, etc. without the core
 * learning anything domain-specific. This is what lets you generalize the row
 * type WITHOUT flattening every value to a bare string and losing per-value
 * display data (e.g. a fleet's color).
 */
export interface FacetValueRef<M = unknown> {
  value: string;
  meta?: M;
}

/** What a `FacetDef.extract` may return for one row: nothing (this row has no
 *  value for this facet — simply not counted), a single value, or many (a
 *  multi-valued facet). A value is a bare string or a `{ value, meta }` ref. */
export type FacetExtractResult<M = unknown> =
  | string
  | FacetValueRef<M>
  | ReadonlyArray<string | FacetValueRef<M>>
  | null
  | undefined;

/**
 * One facet dimension over rows of type T. `extract` is the ONLY domain-aware
 * part — it maps a row to the value(s) it contributes to this facet. Returning
 * `null`/`undefined`/`[]` means "this row has no value for this facet", which is
 * exactly what makes a facet reflect only the values actually present.
 */
export interface FacetDef<T, M = unknown> {
  /** Stable facet id — the selection key + URL key. */
  key: string;
  /** Optional human label for the facet header. */
  label?: string;
  extract: (row: T) => FacetExtractResult<M>;
}

/** One tallied facet value: its identity, how many rows have it, and the opaque
 *  meta from the first row that contributed it. */
export interface FacetValueTally<M = unknown> {
  value: string;
  count: number;
  meta?: M;
}

/** A computed facet group ready to render as a row of pills. */
export interface FacetGroup<M = unknown> {
  key: string;
  label?: string;
  /** Values sorted count-desc (ties broken by first-seen order for stability),
   *  capped to `maxValuesPerFacet` when set. */
  values: FacetValueTally<M>[];
  /** How many distinct values were dropped by the cap (render as "+k more"). */
  hiddenValueCount: number;
  /** Distinct value count BEFORE the cap — the number the hide-rule tested. */
  distinctCount: number;
}

/**
 * The flat rows returned by one server-side companion-summary aggregate.
 *
 * A summary named query still obeys the sync layer's flat-array contract. Its
 * resolver runs ONE aggregate statement and returns these intermediate rows;
 * {@link composeCompanionSummary} folds them into exactly one response row.
 * The explicit totals row is load-bearing: it preserves the truthful
 * `{ total: N, matched: 0 }` result when every facet SELECT is empty.
 */
export type CompanionSummaryAggregateRow<M = unknown> =
  | {
      kind: 'totals';
      /** Exact size of the declared corpus before user filters. */
      total: number;
      /** Exact number matching every active filter. */
      matched: number;
    }
  | {
      kind: 'facet';
      /** Stable facet dimension key. */
      facet: string;
      /** Optional human label for the facet header. */
      label?: string;
      /** Stable option identity. */
      value: string;
      /** Drill-down count: every active filter except `facet` itself. */
      count: number;
      /** Opaque display metadata, matching {@link FacetValueRef}. */
      meta?: M;
    };

/**
 * The single row returned by a `<domain>.summary` named query.
 *
 * `total` and `matched` are independent of the bounded row page. `facets`
 * carries every enumerated drill-down group in the same round trip, using the
 * same render-ready shape as {@link computeFacets}.
 */
export interface CompanionListSummary<M = unknown> {
  total: number;
  matched: number;
  facets: FacetGroup<M>[];
}

/** A selection: for each facet key, the set of chosen values. Absent key or
 *  empty set ⇒ that facet is not constraining. */
export type FacetSelection = ReadonlyMap<string, ReadonlySet<string>>;

export interface ComputeFacetsOptions {
  /** Hide a facet unless it has at least this many DISTINCT values in the rows
   *  (default 2 — a single-value facet can't narrow anything). Set to 1 to keep
   *  single-value facets (e.g. to show them as a passive summary chip). */
  minDistinctValues?: number;
  /** Cap the values shown per facet; the surplus is reported as
   *  `hiddenValueCount`. Omit ⇒ show all. */
  maxValuesPerFacet?: number;
  /**
   * When provided, counts become DRILL-DOWN counts: each facet's values are
   * tallied over only the rows matching the OTHER facets' current selection
   * (this facet's own selection is NOT applied to its own pool, so you can still
   * see + deselect its values). Omit ⇒ STABLE counts over the full row set (the
   * simpler, less-jumpy default). A value currently selected in a facet is
   * always kept (possibly at count 0) so a selection is never stranded.
   */
  selection?: FacetSelection;
}

export interface ComposeCompanionSummaryOptions {
  /**
   * Current selection, used only to keep a selected option visible at count 0
   * when the cross-facet predicate empties its pool. Counting semantics stay
   * server-authored; this never manufactures a positive count.
   */
  selection?: FacetSelection;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize an extract result to a clean, de-duplicated list of refs, dropping
 *  empty-string / nullish values. De-dup is BY VALUE within the single result
 *  (a row must not count the same facet value twice). */
function normalizeExtract<M>(raw: FacetExtractResult<M>): FacetValueRef<M>[] {
  if (raw == null) return [];
  const arr: ReadonlyArray<string | FacetValueRef<M> | null | undefined> = Array.isArray(raw)
    ? (raw as ReadonlyArray<string | FacetValueRef<M>>)
    : [raw as string | FacetValueRef<M>];
  const out: FacetValueRef<M>[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (v == null) continue;
    const ref: FacetValueRef<M> = typeof v === 'string' ? { value: v } : v;
    if (typeof ref.value !== 'string' || ref.value.length === 0) continue;
    if (seen.has(ref.value)) continue;
    seen.add(ref.value);
    out.push(ref);
  }
  return out;
}

/** Distinct facet values across ALL items (ignores any selection) — the number
 *  the visibility hide-rule tests, so facets stay stable during drill-down. */
function distinctValueCount<T, M>(items: readonly T[], def: FacetDef<T, M>): number {
  const seen = new Set<string>();
  for (const row of items) {
    for (const ref of normalizeExtract(def.extract(row))) seen.add(ref.value);
  }
  return seen.size;
}

/** True if `row` satisfies every ACTIVE facet selection except `exceptKey`
 *  (AND across facets, OR within a facet). Used for drill-down pools. */
function matchesSelectionExcept<T>(
  defs: readonly FacetDef<T>[],
  selection: FacetSelection,
  exceptKey: string,
  row: T,
): boolean {
  for (const def of defs) {
    if (def.key === exceptKey) continue;
    const sel = selection.get(def.key);
    if (!sel || sel.size === 0) continue;
    const refs = normalizeExtract(def.extract(row));
    if (!refs.some((r) => sel.has(r.value))) return false;
  }
  return true;
}

function assertSummaryCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the facet groups for `items` under `defs`. See {@link ComputeFacetsOptions}.
 * Pure — the same inputs always produce the same output, ties resolved by
 * first-seen order so re-renders are stable.
 */
export function computeFacets<T, M = unknown>(
  items: readonly T[],
  defs: readonly FacetDef<T, M>[],
  opts: ComputeFacetsOptions = {},
): FacetGroup<M>[] {
  const minDistinct = opts.minDistinctValues ?? 2;
  const cap = opts.maxValuesPerFacet;
  const selection = opts.selection;

  const groups: FacetGroup<M>[] = [];
  for (const def of defs) {
    const pool = selection
      ? items.filter((row) => matchesSelectionExcept(defs, selection, def.key, row))
      : items;

    const counts = new Map<string, number>();
    const metaByValue = new Map<string, M | undefined>();
    const order: string[] = []; // first-seen order → stable tie-break

    for (const row of pool) {
      for (const ref of normalizeExtract(def.extract(row))) {
        if (!counts.has(ref.value)) {
          order.push(ref.value);
          metaByValue.set(ref.value, ref.meta);
        }
        counts.set(ref.value, (counts.get(ref.value) ?? 0) + 1);
      }
    }

    // Never strand a selection: keep this facet's selected values even if the
    // drill-down pool zeroed them out.
    const sel = selection?.get(def.key);
    if (sel) {
      for (const v of sel) {
        if (!counts.has(v)) {
          order.push(v);
          counts.set(v, 0);
          metaByValue.set(v, undefined);
        }
      }
    }

    // Visibility (the hide-rule) is decided over the FULL item set so facets
    // stay STABLE — they don't pop in and out as you select within another
    // facet. Only the COUNTS above reflect the drill-down pool. With no
    // selection the pool IS the full set, so these coincide.
    const distinctCount = selection ? distinctValueCount(items, def) : counts.size;
    if (distinctCount < minDistinct) continue;

    // ...but stability never means rendering an EMPTY facet. If the drill-down
    // pool has no values for this facet at all (e.g. every surviving item has a
    // null plan), the facet has nothing to offer and a consumer would paint a
    // bare label with no pills under it. A selected value is always re-added
    // above (at count 0), so a facet the user has selected in never lands here.
    if (counts.size === 0) continue;

    const orderIndex = new Map(order.map((v, i) => [v, i] as const));
    let values: FacetValueTally<M>[] = order
      .map((value) => ({ value, count: counts.get(value) ?? 0, meta: metaByValue.get(value) }))
      .sort((a, b) => b.count - a.count || (orderIndex.get(a.value)! - orderIndex.get(b.value)!));

    let hiddenValueCount = 0;
    if (cap != null && values.length > cap) {
      hiddenValueCount = values.length - cap;
      values = values.slice(0, cap);
    }

    groups.push({ key: def.key, label: def.label, values, hiddenValueCount, distinctCount });
  }
  return groups;
}

/**
 * Fold the output of one server aggregate statement into the one-row companion
 * summary consumed by clients.
 *
 * The input is intentionally stricter than a generic GROUP BY result:
 * exactly one totals row and at most one row per `(facet,value)`. Duplicates
 * indicate a broken SQL composition and throw instead of silently double
 * counting. Facet values sort count-desc with first-seen tie stability, the
 * same rule as {@link computeFacets}.
 */
export function composeCompanionSummary<M = unknown>(
  rows: readonly CompanionSummaryAggregateRow<M>[],
  opts: ComposeCompanionSummaryOptions = {},
): CompanionListSummary<M> {
  const totals = rows.filter(
    (row): row is Extract<CompanionSummaryAggregateRow<M>, { kind: 'totals' }> =>
      row.kind === 'totals',
  );
  if (totals.length !== 1) {
    throw new Error(`companion summary requires exactly one totals row; received ${totals.length}`);
  }
  assertSummaryCount(totals[0].total, 'summary total');
  assertSummaryCount(totals[0].matched, 'summary matched');
  if (totals[0].matched > totals[0].total) {
    throw new RangeError('summary matched count cannot exceed total');
  }

  const groups = new Map<
    string,
    {
      label?: string;
      order: string[];
      values: Map<string, FacetValueTally<M>>;
    }
  >();
  for (const row of rows) {
    if (row.kind !== 'facet') continue;
    if (!row.facet || !row.value) {
      throw new Error('companion facet rows require non-empty facet and value');
    }
    assertSummaryCount(row.count, `facet ${row.facet}:${row.value} count`);
    if (row.count > totals[0].total) {
      throw new RangeError(`facet ${row.facet}:${row.value} count cannot exceed total`);
    }
    let group = groups.get(row.facet);
    if (!group) {
      group = { label: row.label, order: [], values: new Map() };
      groups.set(row.facet, group);
    } else if (row.label !== undefined && group.label !== undefined && row.label !== group.label) {
      throw new Error(`facet ${row.facet} returned conflicting labels`);
    } else if (group.label === undefined) {
      group.label = row.label;
    }
    if (group.values.has(row.value)) {
      throw new Error(`duplicate companion facet row ${row.facet}:${row.value}`);
    }
    group.order.push(row.value);
    group.values.set(row.value, { value: row.value, count: row.count, meta: row.meta });
  }

  // A selected option must always remain available to deselect. The query owns
  // every positive count; adding a missing selection at zero is the only safe
  // client-independent completion.
  for (const [facet, selected] of opts.selection ?? []) {
    if (selected.size === 0) continue;
    let group = groups.get(facet);
    if (!group) {
      group = { order: [], values: new Map() };
      groups.set(facet, group);
    }
    for (const value of selected) {
      if (group.values.has(value)) continue;
      group.order.push(value);
      group.values.set(value, { value, count: 0, meta: undefined });
    }
  }

  const facets: FacetGroup<M>[] = [];
  for (const [key, group] of groups) {
    const orderIndex = new Map(group.order.map((value, index) => [value, index] as const));
    const values = [...group.values.values()].sort(
      (a, b) => b.count - a.count || orderIndex.get(a.value)! - orderIndex.get(b.value)!,
    );
    facets.push({
      key,
      label: group.label,
      values,
      hiddenValueCount: 0,
      distinctCount: values.length,
    });
  }

  return { total: totals[0].total, matched: totals[0].matched, facets };
}

/**
 * Build the filter predicate for a selection using the SAME `defs` — so the
 * value-extraction logic is written once and shared by counting and filtering.
 * Semantics: AND across facets, OR within a facet. An empty / all-empty
 * selection matches everything.
 */
export function facetPredicate<T, M = unknown>(
  defs: readonly FacetDef<T, M>[],
  selection: FacetSelection,
): (row: T) => boolean {
  const active = defs.filter((d) => (selection.get(d.key)?.size ?? 0) > 0);
  if (active.length === 0) return () => true;
  return (row: T) =>
    active.every((def) => {
      const sel = selection.get(def.key)!;
      return normalizeExtract(def.extract(row)).some((r) => sel.has(r.value));
    });
}

/** Convenience: filter `items` by a selection (== `items.filter(facetPredicate(...))`). */
export function applyFacetSelection<T, M = unknown>(
  items: readonly T[],
  defs: readonly FacetDef<T, M>[],
  selection: FacetSelection,
): T[] {
  return items.filter(facetPredicate(defs, selection));
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection helpers — small, generic batteries so a consumer (nuqs URL state,
// a toggle handler) doesn't re-implement them. No React / URL-framework coupling.
// ─────────────────────────────────────────────────────────────────────────────

/** Return a NEW selection with `value` toggled in facet `key` (immutable — safe
 *  for React state). An emptied facet is removed so the selection stays compact. */
export function toggleFacetValue(
  selection: FacetSelection,
  key: string,
  value: string,
): Map<string, Set<string>> {
  const next = new Map<string, Set<string>>();
  for (const [k, v] of selection) next.set(k, new Set(v));
  const cur = next.get(key) ?? new Set<string>();
  if (cur.has(value)) cur.delete(value);
  else cur.add(value);
  if (cur.size) next.set(key, cur);
  else next.delete(key);
  return next;
}

/** Total number of selected values across all facets (for a "clear (n)" affordance). */
export function facetSelectionSize(selection: FacetSelection): number {
  let n = 0;
  for (const v of selection.values()) n += v.size;
  return n;
}

/** Compact, URL-safe serialization: `key:v1,v2;key2:v3`, each key/value
 *  percent-encoded so slugs/ids with reserved chars round-trip. Empty selection
 *  ⇒ `''`. Deterministic (insertion order preserved). */
export function serializeFacetSelection(selection: FacetSelection): string {
  const parts: string[] = [];
  for (const [key, values] of selection) {
    if (values.size === 0) continue;
    parts.push(`${encodeURIComponent(key)}:${[...values].map(encodeURIComponent).join(',')}`);
  }
  return parts.join(';');
}

/** Inverse of {@link serializeFacetSelection}. Tolerant of malformed input —
 *  skips empty / key-less segments rather than throwing (URL state is untrusted). */
export function parseFacetSelection(raw: string | null | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (!raw) return map;
  for (const part of raw.split(';')) {
    if (!part) continue;
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const key = safeDecode(part.slice(0, idx));
    if (!key) continue;
    const values = part
      .slice(idx + 1)
      .split(',')
      .map(safeDecode)
      .filter((v): v is string => v.length > 0);
    if (values.length) map.set(key, new Set(values));
  }
  return map;
}

/** decodeURIComponent that never throws on malformed escapes (returns the raw
 *  segment instead). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
