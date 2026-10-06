/**
 * Portfolio frontier — the bounded transition between idea grading and outcome
 * verification.
 *
 * The grading queue is the priority frontier. It remains the primary budget,
 * but a small reserved slice is always available for pending outcome
 * verification so a continuously replenished grading queue cannot starve the
 * outcome cache forever. The cursor is an idea id, not an array offset, so a
 * checkpoint survives insertions and terminal removals without silently
 * skipping work.
 */

export const PORTFOLIO_FRONTIER_CHECKPOINT_VERSION = 1 as const;
/** Outcome work reserved on each wake while grading remains actionable. */
export const PORTFOLIO_FRONTIER_VERIFICATION_FLOOR = 3 as const;

export type PortfolioFrontierPhase = 'grading' | 'outcome-verification' | 'drained';

/**
 * Verification slots ALWAYS left to the cursor round-robin when the slice has
 * more than one slot. The stale tier below is least-recently-checked-first, so
 * a row whose refresh never stamps `outcome_checked_at` would otherwise sit at
 * the head of that tier on every wake; a permanent reserve means such poison
 * rows can occupy at most `budget - 1` slots and the round-robin keeps moving.
 */
export const PORTFOLIO_FRONTIER_CURSOR_RESERVE = 1 as const;

export interface PortfolioOutcomeCandidate {
  ideaId: string;
  origin: string;
  routedRef: string;
  routedAtMs: number;
  humanGrade: number | null;
  /**
   * Epoch ms of the last authoritative outcome verification
   * (`outcome_checked_at`). `null` = never verified; `undefined` = the caller
   * did not read it, so the staleness tier is skipped for this row.
   */
  outcomeCheckedAtMs?: number | null;
}

export interface PortfolioEvidenceSource {
  kind: string;
  ref: string;
}

export interface PortfolioFrontierCheckpoint {
  version: typeof PORTFOLIO_FRONTIER_CHECKPOINT_VERSION;
  phase: PortfolioFrontierPhase;
  cursorIdeaId: string | null;
  /** Stable ordering boundary retained even if cursorIdeaId becomes terminal. */
  cursorGrade: number | null;
  cursorRoutedAtMs: number | null;
  currentIdeaId: string | null;
  itemBudget: number;
  timeBudgetMs: number;
  consumedItems: number;
  elapsedMs: number;
  gradingBacklog: number;
  pendingOutcomes: number;
  evidenceSource: PortfolioEvidenceSource | null;
  updatedAt: string;
}

export interface PortfolioFrontierPlan {
  checkpoint: PortfolioFrontierCheckpoint;
  /**
   * Stale/never-verified rows first (`priorityCount` of them), then the
   * cursor round-robin rows. Process in this order.
   */
  selected: PortfolioOutcomeCandidate[];
  /**
   * How many LEADING entries of `selected` came from the staleness tier. They
   * do not move the round-robin cursor, so a caller that rebases the cursor
   * after a partial batch must only consider `selected.slice(priorityCount)`.
   */
  priorityCount: number;
}

const finiteNonNegative = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Decode persisted state fail-safely. Unknown/old shapes restart at the head. */
export function decodePortfolioFrontierCheckpoint(value: unknown): PortfolioFrontierCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<PortfolioFrontierCheckpoint>;
  if (row.version !== PORTFOLIO_FRONTIER_CHECKPOINT_VERSION) return null;
  if (!['grading', 'outcome-verification', 'drained'].includes(String(row.phase))) return null;
  return {
    version: PORTFOLIO_FRONTIER_CHECKPOINT_VERSION,
    phase: row.phase as PortfolioFrontierPhase,
    cursorIdeaId: typeof row.cursorIdeaId === 'string' && row.cursorIdeaId ? row.cursorIdeaId : null,
    cursorGrade:
      row.cursorGrade == null || !Number.isFinite(Number(row.cursorGrade))
        ? null
        : Number(row.cursorGrade),
    cursorRoutedAtMs:
      row.cursorRoutedAtMs == null || !Number.isFinite(Number(row.cursorRoutedAtMs))
        ? null
        : Number(row.cursorRoutedAtMs),
    currentIdeaId: typeof row.currentIdeaId === 'string' && row.currentIdeaId ? row.currentIdeaId : null,
    itemBudget: finiteNonNegative(row.itemBudget, 0),
    timeBudgetMs: finiteNonNegative(row.timeBudgetMs, 0),
    consumedItems: finiteNonNegative(row.consumedItems, 0),
    elapsedMs: finiteNonNegative(row.elapsedMs, 0),
    gradingBacklog: finiteNonNegative(row.gradingBacklog, 0),
    pendingOutcomes: finiteNonNegative(row.pendingOutcomes, 0),
    evidenceSource:
      row.evidenceSource &&
      typeof row.evidenceSource.kind === 'string' &&
      typeof row.evidenceSource.ref === 'string'
        ? { kind: row.evidenceSource.kind, ref: row.evidenceSource.ref }
        : null,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
  };
}

/** Stable value/age/id order. A grade of zero is still a recorded value. */
export function orderPortfolioCandidates(
  candidates: readonly PortfolioOutcomeCandidate[],
): PortfolioOutcomeCandidate[] {
  return [...candidates].sort(comparePortfolioCandidates);
}

function comparePortfolioCandidates(a: PortfolioOutcomeCandidate, b: PortfolioOutcomeCandidate): number {
  const gradeA = a.humanGrade ?? Number.NEGATIVE_INFINITY;
  const gradeB = b.humanGrade ?? Number.NEGATIVE_INFINITY;
  if (gradeA !== gradeB) return gradeB - gradeA;
  if (a.routedAtMs !== b.routedAtMs) return a.routedAtMs - b.routedAtMs;
  return a.ideaId.localeCompare(b.ideaId);
}

/** True when this row is due for verification regardless of cursor position. */
function isStalePortfolioCandidate(candidate: PortfolioOutcomeCandidate, staleBeforeMs: number): boolean {
  const checkedAt = candidate.outcomeCheckedAtMs;
  if (checkedAt === undefined) return false;
  return checkedAt === null || checkedAt < staleBeforeMs;
}

/** Never-verified rows first, then least-recently-verified, then stable order. */
function compareStalePortfolioCandidates(a: PortfolioOutcomeCandidate, b: PortfolioOutcomeCandidate): number {
  const checkedA = a.outcomeCheckedAtMs ?? Number.NEGATIVE_INFINITY;
  const checkedB = b.outcomeCheckedAtMs ?? Number.NEGATIVE_INFINITY;
  if (checkedA !== checkedB) return checkedA - checkedB;
  return comparePortfolioCandidates(a, b);
}

/**
 * Plan one bounded step. A non-empty grading frontier keeps priority, but
 * reserves a bounded outcome-verification slice so it cannot starve forever.
 *
 * WI-10005247: the slice is NOT a pure cursor round-robin. Two independent
 * writers stamp `outcome_checked_at` — the frontier itself, and the Scout
 * corpus refresh, which only covers origin=scout. A cursor that ignores the
 * stamp spends its few reserved slots re-verifying rows another path just
 * refreshed, while su-ideate rows (all graded, so they sort FIRST and are only
 * reached once per full wrap, ~5 days at 3 slots/wake over ~1.5k rows) and
 * brand-new routes (never verified) wait out the whole lap. When the caller
 * passes `staleBeforeMs`, rows never verified or last verified before it are
 * selected first, least-recently-verified first; the cursor round-robin
 * fills the rest and always keeps `PORTFOLIO_FRONTIER_CURSOR_RESERVE` slot.
 */
export function planPortfolioFrontierStep(args: {
  gradingBacklog: number;
  pending: readonly PortfolioOutcomeCandidate[];
  previous?: PortfolioFrontierCheckpoint | null;
  itemBudget: number;
  timeBudgetMs: number;
  nowMs: number;
  /** Rows with `outcomeCheckedAtMs` null or below this are due. Omit to disable the tier. */
  staleBeforeMs?: number;
}): PortfolioFrontierPlan {
  const itemBudget = Math.max(0, Math.floor(finiteNonNegative(args.itemBudget, 0)));
  const timeBudgetMs = Math.max(0, Math.floor(finiteNonNegative(args.timeBudgetMs, 0)));
  const gradingBacklog = Math.max(0, Math.floor(finiteNonNegative(args.gradingBacklog, 0)));
  const ordered = orderPortfolioCandidates(args.pending);
  const previousCursor = args.previous?.cursorIdeaId ?? null;
  const updatedAt = new Date(args.nowMs).toISOString();
  const hasGradingBacklog = gradingBacklog > 0;
  const verificationBudget = hasGradingBacklog
    ? Math.min(itemBudget, PORTFOLIO_FRONTIER_VERIFICATION_FLOOR)
    : itemBudget;

  if (ordered.length === 0 || verificationBudget === 0 || timeBudgetMs === 0) {
    return {
      selected: [],
      checkpoint: {
        version: PORTFOLIO_FRONTIER_CHECKPOINT_VERSION,
        phase:
          ordered.length === 0
            ? (hasGradingBacklog ? 'grading' : 'drained')
            : 'outcome-verification',
        cursorIdeaId: previousCursor,
        cursorGrade: args.previous?.cursorGrade ?? null,
        cursorRoutedAtMs: args.previous?.cursorRoutedAtMs ?? null,
        currentIdeaId: null,
        itemBudget,
        timeBudgetMs,
        consumedItems: 0,
        elapsedMs: 0,
        gradingBacklog,
        pendingOutcomes: ordered.length,
        evidenceSource: args.previous?.evidenceSource ?? null,
        updatedAt,
      },
      priorityCount: 0,
    };
  }

  // Staleness tier. Leave the cursor its reserved slot(s) whenever it has rows
  // to walk, so a row that never gets stamped cannot freeze the round-robin.
  const stale =
    args.staleBeforeMs === undefined
      ? []
      : ordered
          .filter((candidate) => isStalePortfolioCandidate(candidate, args.staleBeforeMs as number))
          .sort(compareStalePortfolioCandidates);
  const cursorReserve = Math.min(PORTFOLIO_FRONTIER_CURSOR_RESERVE, Math.max(0, verificationBudget - 1));
  const priority = stale.slice(0, Math.max(0, Math.min(stale.length, verificationBudget - cursorReserve)));
  const priorityIds = new Set(priority.map((candidate) => candidate.ideaId));
  const roundRobin = priority.length === 0 ? ordered : ordered.filter((candidate) => !priorityIds.has(candidate.ideaId));

  const cursorIndex = previousCursor ? roundRobin.findIndex((candidate) => candidate.ideaId === previousCursor) : -1;
  let start = cursorIndex >= 0 ? (cursorIndex + 1) % Math.max(1, roundRobin.length) : 0;
  if (
    cursorIndex < 0 &&
    previousCursor &&
    args.previous?.cursorRoutedAtMs != null
  ) {
    const boundary: PortfolioOutcomeCandidate = {
      ideaId: previousCursor,
      origin: '',
      routedRef: '',
      routedAtMs: args.previous.cursorRoutedAtMs,
      humanGrade: args.previous.cursorGrade,
    };
    const afterBoundary = roundRobin.findIndex((candidate) => comparePortfolioCandidates(candidate, boundary) > 0);
    start = afterBoundary >= 0 ? afterBoundary : 0;
  }
  const cursorSelected: PortfolioOutcomeCandidate[] = [];
  const count = Math.min(verificationBudget - priority.length, roundRobin.length);
  for (let offset = 0; offset < count; offset += 1) {
    cursorSelected.push(roundRobin[(start + offset) % roundRobin.length]!);
  }
  const selected = [...priority, ...cursorSelected];
  // Only the round-robin rows move the cursor; a priority pick must not drag
  // the lap position to wherever that stale row happens to sort.
  const lastSelected = cursorSelected.at(-1);

  return {
    selected,
    priorityCount: priority.length,
    checkpoint: {
      version: PORTFOLIO_FRONTIER_CHECKPOINT_VERSION,
      phase: 'outcome-verification',
      cursorIdeaId: lastSelected?.ideaId ?? previousCursor,
      cursorGrade: lastSelected ? lastSelected.humanGrade : (args.previous?.cursorGrade ?? null),
      cursorRoutedAtMs: lastSelected
        ? lastSelected.routedAtMs
        : (args.previous?.cursorRoutedAtMs ?? null),
      currentIdeaId: selected[0]?.ideaId ?? null,
      itemBudget,
      timeBudgetMs,
      consumedItems: selected.length,
      elapsedMs: 0,
      gradingBacklog,
      pendingOutcomes: ordered.length,
      evidenceSource: null,
      updatedAt,
    },
  };
}

/** Stamp the observable evidence/duration after the selected batch completes. */
export function finishPortfolioFrontierStep(
  checkpoint: PortfolioFrontierCheckpoint,
  args: { elapsedMs: number; evidenceSource?: PortfolioEvidenceSource | null; nowMs: number },
): PortfolioFrontierCheckpoint {
  return {
    ...checkpoint,
    elapsedMs: finiteNonNegative(args.elapsedMs, 0),
    evidenceSource: args.evidenceSource ?? null,
    updatedAt: new Date(args.nowMs).toISOString(),
  };
}
