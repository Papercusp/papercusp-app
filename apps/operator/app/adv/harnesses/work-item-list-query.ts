import type {
  ColumnFilterState,
  EnumOption,
  NumberFilterValue,
} from '@papercusp/grid-core';
import type { CompanionListSummary } from '@papercusp/facets';
import type { WorkItemRow } from './WorkItemsPanel';

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
    : [];

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const range = (value: unknown): NumberFilterValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as NumberFilterValue)
    : {};

/** Compile the canonical wif state into the server's normalized predicate args. */
export function workItemServerFilters(state: ColumnFilterState) {
  const priority = range(state.priority);
  const rankValue = range(state.rank);
  return {
    ...(text(state.id) ? { id: text(state.id) } : {}),
    ...(text(state.title) ? { title: text(state.title) } : {}),
    ...(strings(state.kind).length ? { kinds: strings(state.kind) } : {}),
    ...(strings(state.state).length ? { states: strings(state.state) } : {}),
    ...(strings(state.stage).length ? { stages: strings(state.stage) } : {}),
    ...(strings(state.assignee).length ? { assignees: strings(state.assignee) } : {}),
    ...(strings(state.severity).length ? { severities: strings(state.severity) } : {}),
    ...(strings(state.plan).length ? { plans: strings(state.plan) } : {}),
    ...(priority.min != null ? { priorityMin: priority.min } : {}),
    ...(priority.max != null ? { priorityMax: priority.max } : {}),
    ...(rankValue.min != null ? { rankMin: rankValue.min } : {}),
    ...(rankValue.max != null ? { rankMax: rankValue.max } : {}),
  };
}

/** The server's drill-down facets in the shape ColumnFilterBar already reads. */
export function workItemFacetOptions(
  summary: CompanionListSummary | null | undefined,
): ReadonlyMap<string, EnumOption[]> {
  const out = new Map<string, EnumOption[]>();
  for (const key of ['kind', 'state', 'stage', 'assignee', 'severity', 'plan']) {
    out.set(key, []);
  }
  for (const group of summary?.facets ?? []) {
    out.set(
      group.key,
      group.values.map((value) => ({
        value: value.value,
        count: value.count,
      })),
    );
  }
  return out;
}

/**
 * Page 1 replaces a mutable feed; cursor pages append idempotently. Re-delivery
 * after an invalidation cannot duplicate a row, and a newer page-1 copy wins.
 */
export function mergeWorkItemPage(
  previous: readonly WorkItemRow[],
  page: readonly WorkItemRow[],
  cursor: string | null,
): WorkItemRow[] {
  if (!cursor) return [...page];
  const byId = new Map(previous.map((row) => [row.id, row] as const));
  for (const row of page) byId.set(row.id, row);
  return [...byId.values()];
}
