/**
 * Pure query core for the Learning → Improve merged list.
 *
 * The view joins two stores: classified improvement work items and Scout's
 * routed-idea ledger. Every server row projection, exact matched total, and
 * drill-down facet must use this one predicate so the 500-row wire cap cannot
 * change what a filter or count means.
 */
import { computeFacets, type CompanionListSummary, type FacetDef, type FacetSelection } from '@papercusp/facets';
import type { ScoredItem } from '../harness/improvements/digest';
import type { RoutedIdeaProvenance } from '../scout/outcome-feedback';

export const LEARNING_IMPROVE_ROW_LIMIT = 500;

export type LearningImproveLane = 'auto' | 'human';
export type LearningImproveStage = 'not-ready' | 'approved' | 'in-flight' | 'shipped' | 'dropped';

export interface LearningImproveNumberRange {
  min?: number;
  max?: number;
}

export interface LearningImproveViewArgs {
  q?: string;
  lanes?: readonly LearningImproveLane[];
  sources?: readonly string[];
  rails?: readonly string[];
  kinds?: readonly string[];
  severities?: readonly string[];
  scopes?: readonly string[];
  stages?: readonly LearningImproveStage[];
  ideaTypes?: readonly string[];
  lenses?: readonly string[];
  score?: LearningImproveNumberRange;
  ageDays?: LearningImproveNumberRange;
  limit?: number;
}

export interface NormalizedLearningImproveViewArgs {
  q: string | null;
  lanes: LearningImproveLane[];
  sources: string[];
  rails: string[];
  kinds: string[];
  severities: string[];
  scopes: string[];
  stages: LearningImproveStage[];
  ideaTypes: string[];
  lenses: string[];
  score: LearningImproveNumberRange | null;
  ageDays: LearningImproveNumberRange | null;
  limit: number;
}

export interface LearningImproveMergedRow {
  key: string;
  item: ScoredItem | null;
  idea: RoutedIdeaProvenance | null;
  lane: LearningImproveLane | null;
  source: string | null;
  rail: string | null;
  stage: LearningImproveStage;
  ageDays: number;
}

const uniq = <T extends string>(values: readonly T[] | undefined): T[] =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean) as T[])].sort();

const range = (value: LearningImproveNumberRange | undefined): LearningImproveNumberRange | null => {
  if (!value) return null;
  const min = Number.isFinite(value.min) ? value.min : undefined;
  const max = Number.isFinite(value.max) ? value.max : undefined;
  return min === undefined && max === undefined
    ? null
    : { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
};

export function normalizeLearningImproveViewArgs(
  args: LearningImproveViewArgs = {},
): NormalizedLearningImproveViewArgs {
  return {
    q: args.q?.trim().toLowerCase() || null,
    lanes: uniq(args.lanes),
    sources: uniq(args.sources),
    rails: uniq(args.rails),
    kinds: uniq(args.kinds),
    severities: uniq(args.severities),
    scopes: uniq(args.scopes),
    stages: uniq(args.stages),
    ideaTypes: uniq(args.ideaTypes),
    lenses: uniq(args.lenses),
    score: range(args.score),
    ageDays: range(args.ageDays),
    limit: Math.min(
      Math.max(Math.trunc(Number.isFinite(args.limit) ? args.limit! : LEARNING_IMPROVE_ROW_LIMIT), 1),
      LEARNING_IMPROVE_ROW_LIMIT,
    ),
  };
}

export function hasLearningImproveViewPredicate(args: NormalizedLearningImproveViewArgs): boolean {
  return (
    args.q !== null ||
    args.lanes.length > 0 ||
    args.sources.length > 0 ||
    args.rails.length > 0 ||
    args.kinds.length > 0 ||
    args.severities.length > 0 ||
    args.scopes.length > 0 ||
    args.stages.length > 0 ||
    args.ideaTypes.length > 0 ||
    args.lenses.length > 0 ||
    args.score !== null ||
    args.ageDays !== null
  );
}

function stageOf(item: ScoredItem | null): LearningImproveStage {
  if (!item) return 'not-ready';
  if (item.state === 'resolved' || item.state === 'done') return 'shipped';
  if (item.state === 'closed' || item.state === 'dropped') return 'dropped';
  return item.assignee ? 'in-flight' : 'approved';
}

function routedAgeDays(idea: RoutedIdeaProvenance, nowMs: number): number {
  const at = idea.routedAt ? Date.parse(idea.routedAt) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, (nowMs - at) / 86_400_000) : Number.MAX_SAFE_INTEGER;
}

/** Merge the work and idea halves once, newest-first, deduping repeated wi: routes. */
export function mergeLearningImproveRows(
  items: readonly ScoredItem[],
  ideas: readonly RoutedIdeaProvenance[],
  nowMs = Date.now(),
): LearningImproveMergedRow[] {
  const ideaByItem = new Map<string, RoutedIdeaProvenance>();
  for (const idea of ideas) {
    if (!idea.routedRef.startsWith('wi:')) continue;
    const id = idea.routedRef.slice(3);
    const previous = ideaByItem.get(id);
    if (!previous || (idea.routedAt ?? '') > (previous.routedAt ?? '')) ideaByItem.set(id, idea);
  }

  // An item LEAVES Improve exactly when it arrives on Retain (D-005 of
  // learning-tab-improve-retain-clarity-2026-08-28). Retain is the keep-ledger of
  // what LANDED (D-002), so a row that reached a terminal SHIPPED state belongs
  // there and only there; listing it here too is precisely the double-listing this
  // plan exists to remove.
  //
  // `dropped` / `closed` work deliberately STAYS. Retain is shipped-only and never
  // takes it, so excluding it here would make it invisible on BOTH tabs. The
  // invariant is "never on both, never on neither" — not "Improve holds only open
  // work".
  //
  // Applied at this single merge point ON PURPOSE: every row projection, the exact
  // matched total and every drill-down facet are derived from these rows, so one
  // exclusion here cannot disagree with itself the way separate per-leg filters can.
  //
  // ⚠ `itemIds` is intentionally built from the UNFILTERED input. An idea whose work
  // item shipped must not resurrect below as a bare `not-ready` idea row — its
  // outcome landed, and the funnel instruments (not this table) are where that is
  // counted.
  const itemIds = new Set(items.map((item) => item.id));
  const rows: LearningImproveMergedRow[] = items
    .filter((item) => stageOf(item) !== 'shipped')
    .map((item) => {
      const idea = ideaByItem.get(item.id) ?? null;
      return {
        key: item.id,
        item,
        idea,
        lane: item.tier === 'auto' ? 'auto' : 'human',
        source: item.source ?? null,
        rail: idea?.rail ?? null,
        stage: stageOf(item),
        ageDays: item.ageDays,
      };
    });
  for (const idea of ideas) {
    const itemId = idea.routedRef.startsWith('wi:') ? idea.routedRef.slice(3) : null;
    if (itemId && itemIds.has(itemId)) continue;
    rows.push({
      key: idea.ideaId,
      item: null,
      idea,
      lane: null,
      source: null,
      rail: idea.rail,
      stage: 'not-ready',
      ageDays: routedAgeDays(idea, nowMs),
    });
  }
  return rows.sort((a, b) => a.ageDays - b.ageDays || b.key.localeCompare(a.key));
}

const inRange = (value: number, selected: LearningImproveNumberRange | null): boolean =>
  selected === null ||
  ((selected.min === undefined || value >= selected.min) && (selected.max === undefined || value <= selected.max));

const selected = (values: readonly string[], value: string | null | undefined): boolean =>
  values.length === 0 || (value != null && values.includes(value));

function matchesTextAndNumeric(row: LearningImproveMergedRow, args: NormalizedLearningImproveViewArgs): boolean {
  if (!inRange(row.item?.score ?? 0, args.score)) return false;
  if (!inRange(row.ageDays, args.ageDays)) return false;
  if (!args.q) return true;
  const item = row.item;
  const idea = row.idea;
  const haystack = [
    item?.id,
    item?.title,
    item?.tierReason,
    item?.scope,
    item?.ideaType,
    item?.source,
    idea?.ideaId,
    idea?.title,
    idea?.lens,
    idea?.rail,
    idea?.routedRef,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return haystack.includes(args.q);
}

/** OR within one dimension; AND across dimensions. */
export function learningImproveRowMatches(
  row: LearningImproveMergedRow,
  args: NormalizedLearningImproveViewArgs,
): boolean {
  const item = row.item;
  const idea = row.idea;
  if (!selected(args.lanes, row.lane)) return false;
  if (!selected(args.sources, row.source)) return false;
  if (!selected(args.rails, row.rail)) return false;
  if (!selected(args.kinds, item?.kind)) return false;
  if (!selected(args.severities, item?.severity)) return false;
  if (!selected(args.scopes, item?.scope)) return false;
  if (!selected(args.stages, row.stage)) return false;
  if (!selected(args.ideaTypes, item?.ideaType)) return false;
  if (!selected(args.lenses, idea?.lens)) return false;
  return matchesTextAndNumeric(row, args);
}

const FACETS: readonly FacetDef<LearningImproveMergedRow>[] = [
  { key: 'lane', label: 'Lane', extract: (row) => row.lane },
  { key: 'source', label: 'Source', extract: (row) => row.source },
  { key: 'rail', label: 'Rail', extract: (row) => row.rail },
  { key: 'kind', label: 'Kind', extract: (row) => row.item?.kind },
  { key: 'severity', label: 'Severity', extract: (row) => row.item?.severity },
  { key: 'scope', label: 'Scope', extract: (row) => row.item?.scope },
  { key: 'stage', label: 'Stage', extract: (row) => row.stage },
  { key: 'ideaType', label: 'Idea type', extract: (row) => row.item?.ideaType },
  { key: 'lens', label: 'Lens', extract: (row) => row.idea?.lens },
];

export function learningImproveFacetSelection(args: NormalizedLearningImproveViewArgs): FacetSelection {
  const selection = new Map<string, ReadonlySet<string>>();
  for (const [key, values] of [
    ['lane', args.lanes],
    ['source', args.sources],
    ['rail', args.rails],
    ['kind', args.kinds],
    ['severity', args.severities],
    ['scope', args.scopes],
    ['stage', args.stages],
    ['ideaType', args.ideaTypes],
    ['lens', args.lenses],
  ] as const) {
    if (values.length > 0) selection.set(key, new Set(values));
  }
  return selection;
}

/** Return at most 500 rows; the exact matched total remains independent of the cap. */
export function projectLearningImproveRows(
  corpus: readonly LearningImproveMergedRow[],
  args: NormalizedLearningImproveViewArgs,
): LearningImproveMergedRow[] {
  return corpus.filter((row) => learningImproveRowMatches(row, args)).slice(0, args.limit);
}

/** Exact total + drill-down facets over the same normalized predicate as rows. */
export function summarizeLearningImproveRows(
  corpus: readonly LearningImproveMergedRow[],
  args: NormalizedLearningImproveViewArgs,
): CompanionListSummary {
  const matched = corpus.filter((row) => learningImproveRowMatches(row, args));
  // Text and numeric filters apply to every facet pool. Enum selections are
  // delegated to computeFacets so it can omit only the facet's own dimension.
  const facetBase = corpus.filter((row) => matchesTextAndNumeric(row, args));
  return {
    total: corpus.length,
    matched: matched.length,
    facets: computeFacets(facetBase, FACETS, {
      minDistinctValues: 1,
      selection: learningImproveFacetSelection(args),
    }),
  };
}
