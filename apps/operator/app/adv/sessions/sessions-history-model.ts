import type { CompanionListSummary } from '@papercusp/facets';
import {
  NO_SESSION_HARNESS,
  NO_SESSION_PLAN,
  type AdvSessionFacetMeta,
} from '@papercusp/operator-core/lib/sync-resolver/adv-sessions-list-query';
import type { CountEvidence } from '@/app/harness/filters';

export interface SessionHistoryEvidence {
  loaded: CountEvidence;
  matched: CountEvidence;
}

/** Page one replaces; cursor pages append idempotently by ledger identity. */
export function mergeAdvSessionPage<T extends { id: number }>(
  previous: readonly T[],
  page: readonly T[],
  cursor: string | null,
): T[] {
  if (!cursor) return [...page];
  const byId = new Map(previous.map((row) => [row.id, row] as const));
  for (const row of page) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * Build both visible populations together so a refetch cannot accidentally
 * keep one exact number while replacing the other with a new page length.
 */
export function sessionHistoryEvidence(args: {
  error: boolean;
  updating: boolean;
  loadedCount: number | null;
  summary: CompanionListSummary<AdvSessionFacetMeta> | null;
}): SessionHistoryEvidence {
  if (args.error) {
    const failed = { kind: 'unknown', reason: 'failed' } as const;
    return { loaded: failed, matched: failed };
  }
  if (args.updating) {
    const updating = { kind: 'unknown', reason: 'updating' } as const;
    return { loaded: updating, matched: updating };
  }
  if (args.loadedCount === null || !args.summary) {
    const loading = { kind: 'unknown', reason: 'loading' } as const;
    return { loaded: loading, matched: loading };
  }
  return {
    loaded: {
      kind: 'window',
      count: args.loadedCount,
      window: 'loaded server-filtered session history',
      corpusTotal: args.summary.matched,
    },
    matched: {
      kind: 'corpus',
      count: args.summary.matched,
      total: args.summary.total,
      population: 'the workspace session ledger',
    },
  };
}

export function sessionHarnessOptions(
  summary: CompanionListSummary<AdvSessionFacetMeta> | null,
  updating: boolean,
): Array<{ value: string; label: string }> {
  const values = summary?.facets.find((facet) => facet.key === 'harness')?.values ?? [];
  return values
    .filter((value) => value.value !== NO_SESSION_HARNESS)
    .map((value) => ({
      value: value.value,
      label: updating
        ? value.value
        : `${value.value} · ${value.count.toLocaleString()} sessions`,
    }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

export function sessionPlanStats(
  summary: CompanionListSummary<AdvSessionFacetMeta> | null,
): Map<string, { count: number; active: number }> {
  const values = summary?.facets.find((facet) => facet.key === 'plan')?.values ?? [];
  return new Map(
    values.map((value) => [
      value.value === NO_SESSION_PLAN ? '_' : value.value,
      { count: value.count, active: value.meta?.active ?? 0 },
    ] as const),
  );
}
