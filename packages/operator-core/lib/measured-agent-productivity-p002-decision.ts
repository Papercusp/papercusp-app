/**
 * measured-agent-productivity-2026-09-06 P-002 — re-derive the context-strategy
 * decision from matched, judged replay cells instead of trusting a recorded verdict.
 *
 * Three outcome requirements govern this decision, and each is enforced here:
 *  - R-001 verified productivity: a strategy wins only on an independently judged
 *    QUALITY improvement (the composite score). Latency, tokens or tool calls are
 *    carried for disclosure but can never produce an adoption on their own.
 *  - R-002 preserve useful preload: a strategy that drops mandatory, current or
 *    task-linked preload is ineligible, and a removal-only overlay is adopted only
 *    when the matched quality evidence shows the removed material was unnecessary.
 *  - R-004 fair comparison: every compared arm must cover the baseline's exact task
 *    set, every cell must be scored under one rubric, no winner may be preselected,
 *    and an arm that could not run is reported with its reason rather than dropped.
 *
 * Deliberately dependency-free so the mutation probe can import a copied mutant.
 */

export type P002PreloadClass =
  | 'mandatory'
  | 'current'
  | 'task-linked'
  | 'duplicate'
  | 'older-history'
  | 'irrelevant';

/** Preload a strategy may never drop: removing it is not a relevance/dedup change. */
export const P002_PROTECTED_PRELOAD: readonly P002PreloadClass[] = ['mandatory', 'current', 'task-linked'];

export interface P002Variant {
  id: string;
  removes: P002PreloadClass[];
}

export interface P002Cell {
  taskId: string;
  variantId: string;
  status: string;
  composite: number | null;
  rubricHash: string;
  /** Disclosure only — never a success signal (R-001). */
  elapsedMs?: number | null;
  tokens?: number | null;
  toolCalls?: number | null;
}

export interface P002ComparisonInput {
  method: {
    baselineVariant: string;
    minDelta: number;
    preselectedWinner: string | null;
    rubricHash: string;
  };
  variants: P002Variant[];
  unavailableArms: Array<{ id: string; reason: string }>;
  cells: P002Cell[];
}

export interface P002ArmResult {
  variantId: string;
  eligible: boolean;
  ineligibleReason: string | null;
  meanComposite: number;
  delta: number;
  matchedDeltas: Record<string, number>;
  wins: number;
}

export type P002Verdict = 'adopt' | 'baseline-holds' | 'unfair-comparison';

export interface P002ComparisonResult {
  fair: boolean;
  fairnessViolations: string[];
  baselineMeanComposite: number | null;
  compared: P002ArmResult[];
  notCompared: Array<{ id: string; reason: string }>;
  winner: string | null;
  verdict: P002Verdict;
  preload: 'retain-current-preload' | 'apply-overlay';
  /** Per-task quality deltas that justify an adopted overlay's removals (R-002). */
  removalEvidence: Record<string, number> | null;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function evaluateP002Comparison(input: P002ComparisonInput): P002ComparisonResult {
  const violations: string[] = [];
  const baselineId = input.method.baselineVariant;

  if (input.method.preselectedWinner !== null) {
    violations.push(`preselected-winner:${input.method.preselectedWinner}`);
  }
  for (const arm of input.unavailableArms) {
    if (!arm.reason.trim()) violations.push(`unavailable-arm-without-reason:${arm.id}`);
  }
  for (const cell of input.cells) {
    if (cell.status !== 'scored' || typeof cell.composite !== 'number' || !Number.isFinite(cell.composite)) {
      violations.push(`unscored-cell:${cell.variantId}:${cell.taskId}`);
    }
    if (cell.rubricHash !== input.method.rubricHash) {
      violations.push(`rubric-mismatch:${cell.variantId}:${cell.taskId}`);
    }
  }

  const byVariant = new Map<string, Map<string, number>>();
  for (const cell of input.cells) {
    if (typeof cell.composite !== 'number') continue;
    const tasks = byVariant.get(cell.variantId) ?? new Map<string, number>();
    if (tasks.has(cell.taskId)) violations.push(`duplicate-cell:${cell.variantId}:${cell.taskId}`);
    tasks.set(cell.taskId, cell.composite);
    byVariant.set(cell.variantId, tasks);
  }

  const baseline = byVariant.get(baselineId);
  if (!baseline || baseline.size === 0) violations.push(`baseline-missing:${baselineId}`);
  const baselineTasks = [...(baseline?.keys() ?? [])].sort();

  const compared: P002ArmResult[] = [];
  for (const variant of input.variants) {
    if (variant.id === baselineId) continue;
    const tasks = byVariant.get(variant.id);
    const candidateTasks = [...(tasks?.keys() ?? [])].sort();
    if (!tasks || candidateTasks.join('|') !== baselineTasks.join('|')) {
      violations.push(`unmatched-task-set:${variant.id}`);
      continue;
    }
    const dropped = variant.removes.filter((cls) => P002_PROTECTED_PRELOAD.includes(cls));
    const matchedDeltas: Record<string, number> = {};
    let wins = 0;
    for (const taskId of baselineTasks) {
      const delta = (tasks.get(taskId) as number) - (baseline!.get(taskId) as number);
      matchedDeltas[taskId] = delta;
      if (delta > 0) wins += 1;
    }
    const meanComposite = mean(baselineTasks.map((taskId) => tasks.get(taskId) as number));
    compared.push({
      variantId: variant.id,
      eligible: dropped.length === 0,
      ineligibleReason: dropped.length ? `drops-protected-preload:${dropped.join(',')}` : null,
      meanComposite,
      delta: meanComposite - mean(baselineTasks.map((taskId) => baseline!.get(taskId) as number)),
      matchedDeltas,
      wins,
    });
  }

  const notCompared = input.unavailableArms.map(({ id, reason }) => ({ id, reason }));
  const baselineMeanComposite = baseline && baseline.size ? mean([...baseline.values()]) : null;

  if (violations.length > 0) {
    return {
      fair: false,
      fairnessViolations: violations,
      baselineMeanComposite,
      compared,
      notCompared,
      winner: null,
      verdict: 'unfair-comparison',
      preload: 'retain-current-preload',
      removalEvidence: null,
    };
  }

  const best = compared
    .filter((arm) => arm.eligible && arm.delta > input.method.minDelta)
    .sort((a, b) => b.delta - a.delta)[0];

  return {
    fair: true,
    fairnessViolations: [],
    baselineMeanComposite,
    compared,
    notCompared,
    winner: best ? best.variantId : baselineId,
    verdict: best ? 'adopt' : 'baseline-holds',
    preload: best && input.variants.find((v) => v.id === best.variantId)?.removes.length ? 'apply-overlay' : 'retain-current-preload',
    removalEvidence: best ? { ...best.matchedDeltas } : null,
  };
}
