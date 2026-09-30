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

export interface PortfolioOutcomeCandidate {
  ideaId: string;
  origin: string;
  routedRef: string;
  routedAtMs: number;
  humanGrade: number | null;
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
  selected: PortfolioOutcomeCandidate[];
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

/**
 * Plan one bounded step. A non-empty grading frontier keeps priority, but
 * reserves a bounded outcome-verification slice so it cannot starve forever.
 */
export function planPortfolioFrontierStep(args: {
  gradingBacklog: number;
  pending: readonly PortfolioOutcomeCandidate[];
  previous?: PortfolioFrontierCheckpoint | null;
  itemBudget: number;
  timeBudgetMs: number;
  nowMs: number;
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
    };
  }

  const cursorIndex = previousCursor ? ordered.findIndex((candidate) => candidate.ideaId === previousCursor) : -1;
  let start = cursorIndex >= 0 ? (cursorIndex + 1) % ordered.length : 0;
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
    const afterBoundary = ordered.findIndex((candidate) => comparePortfolioCandidates(candidate, boundary) > 0);
    start = afterBoundary >= 0 ? afterBoundary : 0;
  }
  const selected: PortfolioOutcomeCandidate[] = [];
  const count = Math.min(verificationBudget, ordered.length);
  for (let offset = 0; offset < count; offset += 1) {
    selected.push(ordered[(start + offset) % ordered.length]!);
  }
  const lastSelected = selected.at(-1);

  return {
    selected,
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
