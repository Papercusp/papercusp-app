/**
 * The compute behind the `learning.improvements` sync resolver — extracted so the
 * PRECOMPUTED default variant (a `system:precompute-derived-reads` producer) and
 * the resolver's live inline path for NON-default variants run the EXACT same code
 * and can never drift (precompute-sync-reads-phase2-compute-latency-2026-07-19
 * P-003 / WI-5460 follow-up; the same "the tab and the tool can never drift"
 * discipline the resolver was written under).
 *
 * ── What is and is NOT in here ───────────────────────────────────────────────
 * This builds the structured ImprovementDigest (+ the `flow` block + the WI-5412
 * humanQueue slimming) — the expensive part (buildDigest + human-queue ranking +
 * flow-metrics over the whole improvement corpus, measured 0.4-0.5s on read).
 *
 * The `recordQueueExposure` side-effect (FB-15 / P-043) is DELIBERATELY NOT here:
 * it records that the queue was rendered TO THE OWNER, so it must fire on the
 * actual user-facing read (the resolver), never on the routine thread that fills
 * the snapshot — otherwise the owner-preference model's "shown but ignored"
 * denominator would count exposures that never happened. The resolver fires it
 * from whatever humanQueue the read returns (snapshot or inline).
 */
import type { ImprovementDigest, ScoredItem } from './digest';
import type { IssueSeverity, IssueStoreKind } from '../../issues-engineer';
import type { CompanionListSummary } from '@papercusp/facets';
import type { ScoutRoutedItem } from '../../sync-resolver/learning-scout-read';
import type { RoutedIdeaProvenance } from '../../scout/outcome-feedback';
import {
  hasLearningImproveViewPredicate,
  learningImproveRowMatches,
  mergeLearningImproveRows,
  normalizeLearningImproveViewArgs,
  projectLearningImproveRows,
  summarizeLearningImproveRows,
  type LearningImproveMergedRow,
  type LearningImproveNumberRange,
  type LearningImproveStage,
  type LearningImproveViewArgs,
  type NormalizedLearningImproveViewArgs,
} from '../../sync-resolver/learning-improve-view-query';

/**
 * The humanQueue fields this read actually puts ON THE WIRE (WI-7279).
 *
 * This is the read-set of the two sync consumers, verified against their
 * mappers — not everything `ScoredItem` declares. Keep it in sync with
 * {@link SlimHumanQueueItem}; the projection loop below iterates exactly this
 * list, so a field absent here never reaches a client.
 *
 * Do NOT add a field here "in case someone needs it": the whole point is that
 * the wire cost of a new `ScoredItem` field is opt-in. Adding one means a
 * consumer reads it — say which, in the comment above the projection.
 */
export const HUMAN_QUEUE_WIRE_FIELDS = [
  'id',
  'kind',
  'title',
  'scope',
  'severity',
  'state',
  'assignee',
  'score',
  'ageDays',
  'ideaType',
  'source',
] as const satisfies ReadonlyArray<keyof ScoredItem>;

/**
 * `tierReason` is NOT in the list above — it ships INTERNED, as `trc` (a code
 * into the payload's own `tierReasonLegend`). It is NOT dropped: dropping it
 * would silently narrow the owner's quick search (see the projection below),
 * which is the failure this encoding exists to avoid.
 *
 * The contract — the key, the legend type, and the `tierReasonOf` reader — lives
 * in `./learning-digest-wire`, a leaf with no imports, because the BROWSER needs
 * `tierReasonOf` and must not pull this module's server-side dynamic-import graph
 * to get it. Re-exported here so server-side callers have one obvious home.
 */
export {
  TIER_REASON_CODE_KEY,
  tierReasonOf,
  type TierReasonLegend,
} from './learning-digest-wire';
import { TIER_REASON_CODE_KEY } from './learning-digest-wire';

/**
 * One `learning.improvements` humanQueue row AS SERVED — deliberately narrower
 * than {@link ScoredItem}, which is the SERVER-side shape (the dispatcher and
 * the `improvements:digest` tool still see all of it).
 *
 * Typing the wire separately is what keeps the projection honest: a consumer
 * that starts reading a dropped field fails to compile here instead of reading
 * `undefined` at runtime, which is how a field declared-but-never-sent rots
 * into a silent bug.
 */
export type SlimHumanQueueItem = Pick<ScoredItem, (typeof HUMAN_QUEUE_WIRE_FIELDS)[number]> & {
  /**
   * The INTERNED `tierReason`: an index into
   * {@link LearningImprovementsRow.tierReasonLegend}. Omitted when the item has
   * no tier reason (the ranker leaves it '' for some rows), exactly as the
   * null-omit below drops an absent `assignee`.
   *
   * Read it through `tierReasonOf(row, item)` — never index the legend by hand,
   * or a row from a stale snapshot (one legend) paired with a fresh legend
   * silently resolves to the WRONG sentence instead of failing.
   */
  trc?: number;
};

/** The `learning.improvements` payload row as served to the Learning tab. */
export type LearningImprovementsRow = Omit<ImprovementDigest, 'humanQueue'> & {
  humanQueue: SlimHumanQueueItem[];
  /** Predicate-bearing reads carry the complete idea half for their bounded merged rows. */
  routedRows?: ScoutRoutedItem[];
  flow: import('./flow-metrics').ImprovementFlow;
  /**
   * The legend for {@link SlimHumanQueueItem.trc} — every distinct `tierReason`
   * in THIS payload, in code order. Self-contained per payload on purpose: it
   * travels with the rows it describes, so a client never has to hold a shared
   * enum in sync with the server (the tier-reason strings are generated prose
   * and DO change when the risk-tier policy changes).
   */
  tierReasonLegend: string[];
  /**
   * The CORPUS-wide set of `Filed by` (sourceRole) values, with their corpus counts —
   * NOT the values present in this payload's rows.
   *
   * EI-21708963364424082 / WI-471938. The tab's source chips fell back to deriving their
   * option set from `autoEligible + humanQueue`, which is the projected WINDOW: a source
   * whose rows all sit past the 500-row cap offered no chip and could not be selected at
   * all (measured live 2026-08-28: `system`, 15 corpus rows, 0 in the window). A filter
   * control's option set is a claim about what EXISTS, so it has to come from an aggregate
   * over the corpus — the same argument `digest.census.total` already settled in WI-39675.
   *
   * Only the NON-EMPTY sourceRole values appear here: rows with no source are not a
   * selectable option (`sources: ['<blank>']` would render a chip that means "unfiled").
   * Present only on the unfiltered snapshot path — a predicate-bearing read carries the
   * same information, dimension-omitted, through the paired `CompanionListSummary` facets.
   * Absent (rather than empty) when the aggregate could not be read, so a client can tell
   * "no sources exist" from "we did not manage to ask".
   */
  sourceOptions?: Array<{ value: string; count: number }>;
};

export interface LearningImprovementsArgs {
  state?: 'open' | 'resolved' | 'closed';
  q?: string;
  kinds?: readonly (IssueStoreKind | 'feature')[];
  severities?: readonly IssueSeverity[];
  scopes?: readonly string[];
  lanes?: readonly ('auto' | 'human')[];
  sources?: readonly string[];
  rails?: readonly string[];
  stages?: readonly LearningImproveStage[];
  ideaTypes?: readonly string[];
  lenses?: readonly string[];
  score?: LearningImproveNumberRange;
  ageDays?: LearningImproveNumberRange;
  limit?: number;
  /** A Hive HOME slug narrows to that Hive's member-harness scopes; omit ⇒ whole workspace. */
  hive?: string;
  /**
   * Provenance scope (learning-tab-surface-public-release-2026-07-27 P-002 / D-002).
   *
   * `'loop'` (THE DEFAULT) = only what the learning loop produced — the union of the
   * three Scout provenance records (`loop-output.ts`). `'all'` = every captured
   * improvement, the pre-P-002 behaviour.
   *
   * Defaulting to `'loop'` rather than taking a flag is deliberate and load-bearing
   * for LATENCY, not just semantics: the resolver serves only its DEFAULT variant
   * from the precomputed snapshot, so if the Learning tab had to pass an explicit
   * arg to get its own scope, every mount would miss the snapshot and pay the
   * 0.4-0.5s inline compute. The default IS the tab's view.
   */
  scope?: 'loop' | 'all';
}

function normalizedViewArgs(a: LearningImprovementsArgs): NormalizedLearningImproveViewArgs {
  const view: LearningImproveViewArgs = {
    q: a.q,
    lanes: a.lanes,
    sources: a.sources,
    rails: a.rails,
    kinds: a.kinds,
    severities: a.severities,
    scopes: a.scopes,
    stages: a.stages,
    ideaTypes: a.ideaTypes,
    lenses: a.lenses,
    score: a.score,
    ageDays: a.ageDays,
    limit: a.limit,
  };
  return normalizeLearningImproveViewArgs(view);
}

async function resolveLearningImproveHarnessScopes(hive: string | undefined): Promise<string[] | undefined> {
  if (!hive) return undefined;
  try {
    const { loadHarnessRegistry, hiveMemberHarnessScopes } = await import('../../harness-registry');
    const reg = await loadHarnessRegistry();
    return hiveMemberHarnessScopes(reg.projects, hive);
  } catch (err) {
    console.warn('[learning.improvements] hive scope resolution failed:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

interface LearningImproveCorpus {
  candidates: readonly import('./policy').ImprovementCandidate[];
  scored: readonly ScoredItem[];
  routedRows: readonly ScoutRoutedItem[];
  merged: readonly LearningImproveMergedRow[];
  normalized: NormalizedLearningImproveViewArgs;
  nowMs: number;
  ownerFullAutonomy: boolean;
}

async function projectLearningImproveCorpus<T>(
  a: LearningImprovementsArgs,
  maxRows: number,
  project: (corpus: LearningImproveCorpus) => Promise<readonly T[]> | readonly T[],
): Promise<T[]> {
  const { projectImprovementItemsForBoundedRead } = await import('./read-items');
  const { scoreImprovementCandidates } = await import('./digest');
  const { activeWorkspaceId } = await import('../../workspace-registry');
  const { readOwnerFullAutonomyGrant } = await import('./full-autonomy-grant');
  const { getOrgPg } = await import('@papercusp/db-org');
  const { readLearningImproveRoutedRows } = await import('../../sync-resolver/learning-scout-read');
  const workspaceId = activeWorkspaceId();
  const nowMs = Date.now();
  const normalized = normalizedViewArgs(a);
  const harnessScopes = await resolveLearningImproveHarnessScopes(a.hive);
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(workspaceId);
  const { sql } = getOrgPg();
  const memberSlugs = harnessScopes?.map((scope) => scope.replace(/^harness:/, ''));

  return projectImprovementItemsForBoundedRead(
    {
      state: a.state,
      ...(harnessScopes ? { harnessScopes } : {}),
      ...(a.scope === 'all' ? {} : { loopOutputOnly: true }),
    },
    {
      maxRows,
      project: async (candidates) => {
        const routedRows = await readLearningImproveRoutedRows({
          sql,
          workspaceId,
          hive: a.hive,
          hiveMemberSlugs: memberSlugs,
        });
        const routedIdeas: RoutedIdeaProvenance[] = routedRows.map((row) => ({
          ideaId: row.ideaId,
          lens: row.lens as RoutedIdeaProvenance['lens'],
          rail: row.rail as RoutedIdeaProvenance['rail'],
          routedRef: row.routedRef,
          ...(row.title ? { title: row.title } : {}),
          ...(row.routedAt ? { routedAt: row.routedAt } : {}),
          ...(row.cycleId ? { cycleId: row.cycleId } : {}),
          ...(row.humanGrade != null ? { humanGrade: row.humanGrade } : {}),
          ...(row.humanFeedback ? { humanFeedback: row.humanFeedback } : {}),
          ...(row.gradedBy ? { gradedBy: row.gradedBy } : {}),
          ...(row.addressesPatternRefs.length > 0 ? { addressesPatternRefs: row.addressesPatternRefs } : {}),
        }));
        const scored = scoreImprovementCandidates(candidates, { nowMs, ownerFullAutonomy });
        const merged = mergeLearningImproveRows(scored, routedIdeas, nowMs);
        return project({ candidates, scored, routedRows, merged, normalized, nowMs, ownerFullAutonomy });
      },
    },
  );
}

async function computeFlowForDigest(
  items: readonly import('./policy').ImprovementCandidate[],
  digest: ImprovementDigest,
  nowMs: number,
): Promise<import('./flow-metrics').ImprovementFlow> {
  const { computeImprovementFlow, readWatchdogFlowTicks } = await import('./flow-metrics');
  const { activeWorkspaceId } = await import('../../workspace-registry');
  let ticks: Awaited<ReturnType<typeof readWatchdogFlowTicks>> = [];
  try {
    ticks = await readWatchdogFlowTicks(activeWorkspaceId());
  } catch (err) {
    console.warn('[learning.improvements] watchdog tick read failed:', err instanceof Error ? err.message : err);
  }
  let dispatchStats: import('./dispatch-ledger').DispatchStats | null = null;
  try {
    const { readRecentDispatches, computeDispatchStats } = await import('./dispatch-ledger');
    dispatchStats = computeDispatchStats(await readRecentDispatches(activeWorkspaceId()), { nowMs });
  } catch (err) {
    console.warn('[learning.improvements] dispatch ledger read failed:', err instanceof Error ? err.message : err);
  }
  return computeImprovementFlow([...items], ticks, {
    nowMs,
    recurringSignatureCount: digest.recurringSignatures.length,
    dispatchStats,
  });
}

function toLearningImprovementsWireRow(
  digest: ImprovementDigest,
  flow: import('./flow-metrics').ImprovementFlow,
  routedRows?: ScoutRoutedItem[],
  sourceOptions?: Array<{ value: string; count: number }>,
): LearningImprovementsRow {
  const tierReasonLegend: string[] = [];
  const tierReasonCodes = new Map<string, number>();
  const humanQueue: SlimHumanQueueItem[] = digest.humanQueue.map((item) => {
    const slim = {} as Record<string, unknown>;
    for (const key of HUMAN_QUEUE_WIRE_FIELDS) {
      const value = (item as unknown as Record<string, unknown>)[key];
      if (value !== undefined && value !== null) slim[key] = value;
    }
    if (item.tierReason) {
      let code = tierReasonCodes.get(item.tierReason);
      if (code === undefined) {
        code = tierReasonLegend.length;
        tierReasonLegend.push(item.tierReason);
        tierReasonCodes.set(item.tierReason, code);
      }
      slim[TIER_REASON_CODE_KEY] = code;
    }
    return slim as unknown as SlimHumanQueueItem;
  });
  return {
    ...digest,
    humanQueue,
    flow,
    tierReasonLegend,
    ...(routedRows ? { routedRows } : {}),
    ...(sourceOptions ? { sourceOptions } : {}),
  };
}

async function computeFilteredLearningImprovements(
  a: LearningImprovementsArgs,
): Promise<LearningImprovementsRow[]> {
  return projectLearningImproveCorpus(a, 1, async (corpus) => {
    const { buildDigest } = await import('./digest');
    const matchingRows = corpus.merged.filter((row) => learningImproveRowMatches(row, corpus.normalized));
    const projectedRows = projectLearningImproveRows(corpus.merged, corpus.normalized);
    const matchingItemIds = new Set(
      matchingRows.flatMap((row) => (row.item ? [row.item.id] : [])),
    );
    const matchingCandidates = corpus.candidates.filter((candidate) => matchingItemIds.has(candidate.id));
    const digest = buildDigest([...matchingCandidates], {
      nowMs: corpus.nowMs,
      ownerFullAutonomy: corpus.ownerFullAutonomy,
      corpusTotal: matchingCandidates.length,
      nearDuplicates: false,
    });
    const projectedItems = projectedRows.flatMap((row) => (row.item ? [row.item] : []));
    digest.autoEligible = projectedItems.filter((item) => item.tier === 'auto');
    digest.humanQueue = projectedItems.filter((item) => item.tier !== 'auto');
    digest.window = {
      ...digest.window,
      examined: projectedItems.length,
      windowed: matchingCandidates.length > projectedItems.length,
    };

    const projectedIdeaIds = new Set(
      projectedRows.flatMap((row) => (row.idea ? [row.idea.ideaId] : [])),
    );
    const routedRows = corpus.routedRows.filter((row) => projectedIdeaIds.has(row.ideaId));
    const flow = await computeFlowForDigest(matchingCandidates, digest, corpus.nowMs);
    return [toLearningImprovementsWireRow(digest, flow, routedRows)];
  });
}

/** Paired exact total + drill-down facets for the same merged predicate as rows. */
export async function computeLearningImprovementsSummary(
  a: LearningImprovementsArgs,
): Promise<CompanionListSummary[]> {
  return projectLearningImproveCorpus(a, 1, (corpus) => [
    summarizeLearningImproveRows(corpus.merged, corpus.normalized),
  ]);
}

/**
 * Build the `learning.improvements` payload row (the client reads `data[0]`).
 * Pure of the owner-exposure side-effect (see the module note) so it is safe to
 * run on the precompute routine's thread as well as inline on a read.
 */
export async function computeLearningImprovementsSnapshot(
  a: LearningImprovementsArgs,
): Promise<Array<LearningImprovementsRow>> {
  const normalized = normalizedViewArgs(a);
  if (hasLearningImproveViewPredicate(normalized)) {
    return computeFilteredLearningImprovements(a);
  }
  const { readImprovementItems, countImprovementItems, improvementSourceCounts } = await import('./read-items');
  const { buildDigest } = await import('./digest');
  const { applyHumanQueueRanking } = await import('../../queue-ranker/human-queue');
  const { activeWorkspaceId } = await import('../../workspace-registry');
  const { readOwnerFullAutonomyGrant } = await import('./full-autonomy-grant');
  const nowMs = Date.now();
  // The OWNER FULL-AUTONOMY grant (Phase 2): this feed IS the owner's Learning-tab
  // view of the queue — keep its auto/human split consistent with the live dispatch so
  // a protected-surface kind=bug isn't shown as "needs your decision" while the loop
  // auto-implements it once the grant is on.
  const ownerFullAutonomy = await readOwnerFullAutonomyGrant(activeWorkspaceId());
  // P-040: resolve the Hive → its member-harness scope set (the Hive is the
  // tenancy unit) so the feed only shows that Hive's improvements. Best-effort:
  // a registry read failure degrades to the unfiltered (workspace) feed rather
  // than 500ing the tab.
  const harnessScopes = await resolveLearningImproveHarnessScopes(a.hive);
  const readOpts = {
    state: a.state,
    q: a.q,
    kinds: a.kinds?.filter((kind): kind is IssueStoreKind => kind !== 'feature'),
    severities: a.severities,
    scopes: a.scopes,
    limit: a.limit,
    ...(harnessScopes ? { harnessScopes } : {}),
    // D-002: 'loop' is the default — see LearningImprovementsArgs.scope. Passing the
    // flag explicitly (rather than letting read-items default it) keeps the scope
    // decision visible at the one call site that owns the Learning tab's semantics.
    ...(a.scope === 'all' ? {} : { loopOutputOnly: true }),
  };
  // WI-39675: the TRUE corpus total, read alongside the (windowed) items over the
  // SAME filter — so `digest.census.total`, which the tab renders as "From the loop N",
  // stops reporting the WINDOW size. This is the same D2 fix EI-18790490225750395
  // made to the `improvements:digest` AGENT TOOL; it was never propagated to this
  // SYNC-RESOLVER path, so the tab's own total silently saturated at the default
  // 500-row window while the agent-facing tool reported the truth.
  //
  // Best-effort, exactly as on that path: a count failure must never sink an
  // otherwise-good digest, so it degrades to `undefined` and buildDigest falls
  // back to candidates.length (the prior behavior) rather than throwing.
  // WI-471938: the same argument, one dimension over. `corpusTotal` stops the WINDOW SIZE
  // being read as the corpus total; `sourceCounts` stops the WINDOW'S SOURCES being read as
  // the corpus's source vocabulary — which is what the tab's "Filed by" chips do when they
  // fall back to deriving their option set from the projected rows. Both are aggregates over
  // the SAME `readOpts` the row read applies, and both degrade to `undefined` on failure
  // rather than sinking an otherwise-good digest (the client then falls back to its old
  // window-derived behaviour, which is wrong but not broken).
  const [items, corpusTotal, sourceCounts] = await Promise.all([
    readImprovementItems(readOpts),
    countImprovementItems(readOpts).catch(() => undefined),
    improvementSourceCounts(readOpts).catch(() => undefined),
  ]);
  // Drop the empty-string bucket (rows with no sourceRole): the SQL layer keeps it so its
  // histogram still totals `countIssues`, but "unfiled" is not a selectable chip. Sorted by
  // value so the chip strip has a stable order across reads rather than PG's group order.
  const sourceOptions = sourceCounts
    ? Object.entries(sourceCounts)
        .filter(([value]) => value !== '')
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => a.value.localeCompare(b.value))
    : undefined;
  // Human lane ordered by the ONE ranker (frontier P-040; feature #1 is
  // consume-edges P-022's blocking impact) — the owner's queue leads with
  // what blocks the most, each item carrying its per-feature breakdown.
  const digest = await applyHumanQueueRanking(
    buildDigest(items, { nowMs, ownerFullAutonomy, corpusTotal }),
    { candidates: items },
  );
  const flow = await computeFlowForDigest(items, digest, nowMs);
  return [toLearningImprovementsWireRow(digest, flow, undefined, sourceOptions)];
}
