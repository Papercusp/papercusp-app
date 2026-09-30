/**
 * Corpus-accurate scorecard history + companion summary (P-009).
 *
 * The row feed is a bounded newest-first keyset page over immutable
 * `(created_at, issue_id)`. The companion count reuses the existing exact
 * scorecard aggregate with the same hidden-row policy as the history read.
 * Trend aggregation is deliberately separate: it is a latest-N analytical
 * sample, never this history corpus total.
 */
import type { CompanionSummaryAggregateRow } from '@papercusp/facets';
import type { BoundedListPage } from './bounded-list-read';
import type {
  ListScorecardsFilter,
  ScorecardCountFilter,
  ScorecardListCursor,
  ScorecardPage,
  ScorecardRow,
} from '../scorecards';

export const SCORECARD_HISTORY_PAGE_LIMIT = 500;
export const SCORECARD_HISTORY_DEFAULT_PAGE = 100;

export interface ScorecardHistoryWireArgs {
  rubricRef: string;
  cursor?: string | null;
  limit?: number;
}

export interface NormalizedScorecardHistoryArgs {
  rubricRef: string;
  cursor: ScorecardListCursor | null;
  limit: number;
}

export interface ScorecardHistoryPredicate {
  args: NormalizedScorecardHistoryArgs;
  fingerprint: string;
}

export interface ScorecardHistoryReadDeps {
  listPage: (filter: ListScorecardsFilter) => Promise<ScorecardPage>;
}

export interface ScorecardHistorySummaryDeps {
  countByRubric: (filter?: ScorecardCountFilter) => Promise<Record<string, number>>;
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function decodeScorecardHistoryCursor(raw: string | null | undefined): ScorecardListCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ScorecardListCursor>;
    return typeof parsed.createdAt === 'string' &&
      Number.isFinite(Date.parse(parsed.createdAt)) &&
      typeof parsed.issueId === 'string' &&
      parsed.issueId.length > 0
      ? { createdAt: new Date(parsed.createdAt).toISOString(), issueId: parsed.issueId }
      : null;
  } catch {
    return null;
  }
}

export const encodeScorecardHistoryCursor = (row: Pick<ScorecardRow, 'createdAt' | 'issueId'>): string =>
  JSON.stringify({ createdAt: row.createdAt, issueId: row.issueId });

export function normalizeScorecardHistoryArgs(args: ScorecardHistoryWireArgs): NormalizedScorecardHistoryArgs {
  const limit = Math.min(
    Math.max(Math.trunc(finite(args.limit) ?? SCORECARD_HISTORY_DEFAULT_PAGE), 1),
    SCORECARD_HISTORY_PAGE_LIMIT,
  );
  return {
    rubricRef: args.rubricRef.trim(),
    cursor: decodeScorecardHistoryCursor(args.cursor),
    limit,
  };
}

export function buildScorecardHistoryPredicate(args: NormalizedScorecardHistoryArgs): ScorecardHistoryPredicate {
  return { args, fingerprint: JSON.stringify(args) };
}

export async function readScorecardHistoryPage(
  predicate: ScorecardHistoryPredicate,
  deps: ScorecardHistoryReadDeps,
): Promise<BoundedListPage<ScorecardRow>> {
  const args = predicate.args;
  const page = await deps.listPage({
    rubricRef: args.rubricRef,
    limit: args.limit,
    ...(args.cursor ? { before: args.cursor } : {}),
    // The history row opens ScorecardDetail, whose linked-items rail consumes
    // this field. Aggregate/trend callers continue to skip the join.
    includeLinks: true,
  });
  const tail = page.rows[page.rows.length - 1];
  return {
    rows: page.rows,
    hasMore: page.hasMore,
    nextCursor: page.hasMore && tail ? encodeScorecardHistoryCursor(tail) : null,
    previousCursor: args.cursor ? JSON.stringify(args.cursor) : null,
  };
}

export async function readScorecardHistorySummary(
  predicate: ScorecardHistoryPredicate,
  deps: ScorecardHistorySummaryDeps,
): Promise<readonly CompanionSummaryAggregateRow[]> {
  const rubricRef = predicate.args.rubricRef;
  const counts = await deps.countByRubric({
    rubricRef,
    // Match listScorecardPage's default history population exactly. The
    // aggregate's no-arg behavior remains unchanged for the Rubrics overview.
    includeSuperseded: false,
    includeRetracted: false,
  });
  const count = counts[rubricRef] ?? 0;
  return [{ kind: 'totals', total: count, matched: count }];
}
