import type { ColumnFilterState, EnumOption } from '@papercusp/grid-core';
import type { CompanionListSummary } from '@papercusp/facets';

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string =>
        typeof entry === 'string' && entry.length > 0))]
    : [];

/** Compile obsf + signal chips + selected plans into one server predicate. */
export function observationServerFilters(
  state: ColumnFilterState,
  plans: readonly string[],
  signalKind: string | null,
) {
  return {
    ...(strings(state.scope).length ? { scopes: strings(state.scope) } : {}),
    ...(strings(state.sourceRole).length
      ? { sourceRoles: strings(state.sourceRole) }
      : {}),
    ...(strings(state.confidence).length
      ? { confidences: strings(state.confidence) }
      : {}),
    ...(signalKind ? { kinds: [signalKind] } : {}),
    ...(plans.length ? { plans: [...new Set(plans.filter(Boolean))] } : {}),
  };
}

/** Authoritative drill-down options in ColumnFilterBar's existing shape. */
export function observationFacetOptions(
  summary: CompanionListSummary | null | undefined,
): ReadonlyMap<string, EnumOption[]> {
  const out = new Map<string, EnumOption[]>();
  for (const key of ['scope', 'sourceRole', 'confidence']) out.set(key, []);
  for (const group of summary?.facets ?? []) {
    if (!out.has(group.key)) continue;
    out.set(
      group.key,
      group.values.map((value) => ({ value: value.value, count: value.count })),
    );
  }
  return out;
}

/** Kind remains the compact signal-chip affordance, backed by the same summary. */
export function observationSignalCounts(
  summary: CompanionListSummary | null | undefined,
): Array<[string, number]> {
  const kind = summary?.facets.find((group) => group.key === 'kind');
  return (kind?.values ?? [])
    .map((value): [string, number] => [value.value, value.count])
    .sort((a, b) => {
      if (a[0] === 'other') return 1;
      if (b[0] === 'other') return -1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    });
}

/** Page 1 replaces; cursor pages append idempotently after an invalidation. */
export function mergeObservationPage<Row extends { id: string }>(
  previous: readonly Row[],
  page: readonly Row[],
  cursor: string | null,
): Row[] {
  if (!cursor) return [...page];
  const byId = new Map(previous.map((row) => [row.id, row] as const));
  for (const row of page) byId.set(row.id, row);
  return [...byId.values()];
}
