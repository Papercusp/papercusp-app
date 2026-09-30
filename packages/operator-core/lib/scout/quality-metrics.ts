/**
 * quality-metrics.ts — Scout standing quality metrics (scout-loop-test-plan
 * P-015): the report that answers "is the Scout loop still producing GOOD ideas,
 * at a sane cost, or has it quietly degraded?".
 *
 * Three layers, the pure-decision-functions-pulled-from-daemons split:
 *
 *  1. **Pure core** — {@link computeScoutQualityReport} folds injected snapshots
 *     of the tick ledger (tick-ledger.ts rows), the routed-idea ledger
 *     (RoutedIdeaProvenance), and the lens-outcome report (outcome-feedback's
 *     gatherLensOutcomes output) into one {@link ScoutQualityReport}; and
 *     {@link evaluateQualityDegradation} compares a report against an INJECTED
 *     baseline + tolerances. No PG, no clock, no network — fully unit-tested.
 *
 *  2. **Assembly** — {@link buildQualityReportInputs} reads the real ledgers
 *     (readScoutTicks / readRoutedIdeas / gatherLensOutcomes over the production
 *     reader bag) via LAZY imports, so importing this module never touches the
 *     PG edge (the scheduler's buildScoutTickDeps pattern). Reuses the existing
 *     ledgers only — the baseline is NOT new PG state; the Phase-2 recorded
 *     baseline arrives injected (routine payload), and a prior
 *     {@link ScoutQualityReport} satisfies {@link ScoutQualityBaseline}
 *     structurally, so "record a baseline" = "keep a past report".
 *
 *  3. **Composition** — {@link checkAndFlagQuality} runs read → report →
 *     evaluate and, on degradation, files ONE improvements capture through an
 *     injected {@link QualityCapturePort} (structurally compatible with
 *     captureImprovement / the improvements:capture tool — this module never
 *     imports agent-tools). One capture per breach SET, with a stable
 *     sorted-metric title, so re-runs over the same degradation dedup cleanly
 *     downstream (capture-core's search-first dedup sees the same title).
 */

import type { RoutedIdeaProvenance, LensOutcomeReport, LensWeightOptions } from './outcome-feedback';
import { gatherLensOutcomes } from './outcome-feedback';
import type { ScoutTickRecord } from './tick-ledger';
import { isPersistedCapacityError } from './capacity-errors';
import type { ScoutLedgerOpts } from './routed-ledger';
import { CREATIVE_LENSES, type CreativeLens, SU_IDEATION_LENSES, type SuIdeationLens } from './types';
import { computeNoveltyGainReport, mapProvenanceToNoveltyRow } from './novelty-metrics';

// ── pure core: the report ─────────────────────────────────────────────────────

/**
 * The self-gates a 'gated' tick can name (scheduler.ts runScoutTick):
 * 'min-interval' / 'no-trigger' from the cadence verdict, 'circuit' from the
 * autoloop fire-gate, 'claim-lost' from the EI-304 single-flight claim. The
 * breakdown always carries all four keys (zeroed), so a dashboard / baseline
 * diff never sees a key appear out of nowhere.
 */
/**
 * The self-gates a tick can be withheld by — every key is always PRESENT (zeroed) in
 * {@link ScoutQualityReport.gatedTickBreakdown}, so "this gate never fired" is a visible 0
 * rather than a missing key.
 *
 * `no-signal` is the volume-mode zero-signal veto (WI-4318, cadence.ts): the corpus is
 * byte-identical to the last cycle, so friction/drain/idle/heartbeat are ALL withheld. It
 * was a live gate reason for its whole life but was never listed here — so it only ever
 * appeared in the histogram once it had already fired, and a healthy quiet period (the
 * veto working exactly as designed) was indistinguishable from the gate not existing. It
 * is the load-bearing evidence for the P-015 "spend drops in quiet periods" bar, so it is
 * zeroed like every other gate.
 */
export const SCOUT_TICK_GATES = [
  'min-interval',
  'no-trigger',
  'no-signal',
  'no-capacity',
  'circuit',
  'claim-lost',
] as const;

/**
 * Injected snapshots the pure core folds — production via {@link buildQualityReportInputs},
 * tests via fixtures. Generic over the lens roster `L` (su-ideate-learning-substrate P-013):
 * default {@link CreativeLens} keeps the Scout path byte-identical; the su-ideate partition
 * folds over {@link SuIdeationLens}.
 */
export interface ScoutQualityInputs<L extends string = CreativeLens> {
  /** Tick-ledger window snapshot (readScoutTicks rows; ScoutTickRecord is the load-bearing subset). */
  ticks: readonly ScoutTickRecord[];
  /** Routed-idea ledger snapshot (readRoutedIdeas). */
  routedIdeas: readonly RoutedIdeaProvenance[];
  /** The per-lens outcome report (gatherLensOutcomes / getScoutLensOutcomes) over the roster `L`. */
  lensOutcomes: LensOutcomeReport<L>;
}

/** The standing quality report — every rate is null (never NaN) when its denominator is zero. */
export interface ScoutQualityReport<L extends string = CreativeLens> {
  /** Full cycles in the tick window (status 'ran'). */
  windowCycles: number;
  /** All ticks in the window (ran + gated + error). */
  totalTicks: number;
  /** Ticks that fired but threw (status 'error'). */
  errorTicks: number;
  /** Gated ticks per self-gate — all {@link SCOUT_TICK_GATES} keys always present (zeroed). */
  gatedTickBreakdown: Record<string, number>;
  /** Routed ideas in the ledger snapshot. */
  totalRouted: number;
  /** Routed ideas that won (accepted) / lost (rejected) / are still pending, summed across lenses. */
  accepted: number;
  rejected: number;
  pending: number;
  /** Ideas the ideators produced across the window's full cycles. */
  totalIdeasGenerated: number;
  /** LLM spend summed over the window's ticks (USD). */
  totalSpendUsd: number;
  /** accepted / (accepted + rejected) over DECIDED outcomes; null when nothing decided. */
  triageAcceptanceRate: number | null;
  /** accepted / totalIdeasGenerated — how many raw ideas actually ship; null when none generated. */
  ideaToShippedConversion: number | null;
  /** Per-lens win rate over decided outcomes (outcome-feedback's winRate); null when undecided. */
  perLensWinRates: Record<L, number | null>;
  /** totalSpendUsd / accepted; null when nothing accepted (zero-division guard). */
  costPerAcceptedIdeaUsd: number | null;
  /**
   * Fraction of routed ideas flagged near-duplicate at routing time — the reused
   * {@link computeNoveltyGainReport} dedup-rate (P-013). Present ONLY on the su-ideate
   * partition (opt-in `includeDedupRate`, so the Scout report stays byte-identical);
   * null until an idea-level duplicate flag is threaded onto the ledger read (the
   * novelty-metrics "shape live, value null until the input lands" convention).
   */
  dedupRate?: number | null;
}

/**
 * Fold the three ledger snapshots into the standing quality report. Pure —
 * deterministic over the inputs, no IO. Acceptance comes from the lens-outcome
 * report (won = accepted, lost = rejected — the change-feed classification);
 * volume + spend come from the tick window; the routed total from the ledger.
 *
 * `opts.lenses` (default {@link CREATIVE_LENSES}) picks the roster the perLensWinRates
 * span — the su-ideate partition passes {@link SU_IDEATION_LENSES} (P-013). `opts.includeDedupRate`
 * folds in the reused novelty-metrics dedup-rate; it is opt-in so the Scout call
 * (`computeScoutQualityReport(inputs)`) emits NO `dedupRate` key and stays byte-identical.
 */
/** The pure tick-classification fold — windowCycles/errorTicks/gatedTickBreakdown/spend,
 *  derived from ticks ALONE (no routed-idea or lens-outcome input needed). Extracted
 *  (WI-5397) so a caller that only needs the CYCLE-error-rate numbers — e.g. the
 *  code-hash-scoped soak read in scout/success-metrics.ts, which has no matching
 *  routed-idea/lens-outcome snapshot for an arbitrary cross-generation tick union — can
 *  reuse the EXACT SAME classifier {@link computeScoutQualityReport} folds into its own
 *  report, instead of a second hand-rolled copy that could silently drift from it.
 */
export function foldScoutTickStats(ticks: readonly ScoutTickRecord[]): {
  windowCycles: number;
  totalTicks: number;
  errorTicks: number;
  gatedTickBreakdown: Record<string, number>;
  totalIdeasGenerated: number;
  totalSpendUsd: number;
} {
  let windowCycles = 0;
  let errorTicks = 0;
  let totalIdeasGenerated = 0;
  let totalSpendUsd = 0;
  const gatedTickBreakdown: Record<string, number> = Object.fromEntries(SCOUT_TICK_GATES.map((g) => [g, 0]));

  for (const t of ticks) {
    if (t.status === 'ran') {
      windowCycles += 1;
      totalIdeasGenerated += t.ideasGenerated ?? 0;
    } else if (t.status === 'gated') {
      const gate = t.gate ?? 'unknown';
      gatedTickBreakdown[gate] = (gatedTickBreakdown[gate] ?? 0) + 1;
    } else if (t.status === 'error') {
      // WI-4475: re-classify a HISTORICAL capacity-failure tick the same way the
      // scheduler now classifies a live one. Typed evidence is authoritative on current
      // rows; only an unversioned legacy row may use the old provider-ceiling signatures.
      // A proven pool-capacity ceiling is folded into the 'no-capacity' gate bucket,
      // NOT counted as a genuine error — so the
      // "error rate < 5%" bar reflects real breakage regardless of when the write-path
      // reclassification went live, instead of staying red on legacy rows for the ~10
      // days it takes them to age out of the window. Pool pressure stays VISIBLE (its
      // own gate count grows); it just stops masquerading as ideator breakage.
      if (isPersistedCapacityError(t.detail)) {
        gatedTickBreakdown['no-capacity'] = (gatedTickBreakdown['no-capacity'] ?? 0) + 1;
      } else {
        errorTicks += 1;
      }
    }
    if (typeof t.budgetUsedUsd === 'number' && Number.isFinite(t.budgetUsedUsd)) {
      totalSpendUsd += t.budgetUsedUsd;
    }
  }
  return { windowCycles, totalTicks: ticks.length, errorTicks, gatedTickBreakdown, totalIdeasGenerated, totalSpendUsd };
}

export function computeScoutQualityReport<L extends string = CreativeLens>(
  inputs: ScoutQualityInputs<L>,
  opts: { lenses?: readonly L[]; includeDedupRate?: boolean } = {},
): ScoutQualityReport<L> {
  const lenses = opts.lenses ?? (CREATIVE_LENSES as readonly string[] as readonly L[]);
  const { windowCycles, errorTicks, gatedTickBreakdown, totalIdeasGenerated, totalSpendUsd } = foldScoutTickStats(
    inputs.ticks,
  );

  let accepted = 0;
  let rejected = 0;
  let pending = 0;
  const perLensWinRates = {} as Record<L, number | null>;
  for (const lens of lenses) {
    const s = inputs.lensOutcomes.byLens[lens];
    perLensWinRates[lens] = s?.winRate ?? null;
    if (!s) continue;
    accepted += s.won;
    rejected += s.lost;
    pending += s.pending;
  }
  const decided = accepted + rejected;

  return {
    windowCycles,
    totalTicks: inputs.ticks.length,
    errorTicks,
    gatedTickBreakdown,
    totalRouted: inputs.routedIdeas.length,
    accepted,
    rejected,
    pending,
    totalIdeasGenerated,
    totalSpendUsd,
    triageAcceptanceRate: decided > 0 ? accepted / decided : null,
    ideaToShippedConversion: totalIdeasGenerated > 0 ? accepted / totalIdeasGenerated : null,
    perLensWinRates,
    costPerAcceptedIdeaUsd: accepted > 0 ? totalSpendUsd / accepted : null,
    ...(opts.includeDedupRate ? { dedupRate: suIdeationDedupRate(inputs.routedIdeas) } : {}),
  };
}

/**
 * Reuse the novelty-metrics dedup fold over the routed-idea snapshot: the fraction of
 * ideas flagged near-duplicate of the existing corpus at routing time. Runs
 * {@link computeNoveltyGainReport} with no elites (only the dedup leg is read). Null
 * until a per-idea duplicate flag is threaded onto the ledger read — the novelty-metrics
 * convention (the report shape is live; the value lights up when the input lands).
 */
function suIdeationDedupRate(routedIdeas: readonly RoutedIdeaProvenance[]): number | null {
  return computeNoveltyGainReport({
    elites: [],
    ideas: routedIdeas.map(mapProvenanceToNoveltyRow),
  }).dedupRate;
}

// ── pure core: degradation ────────────────────────────────────────────────────

/**
 * The recorded baseline a fresh report is compared against. A structural SUBSET
 * of {@link ScoutQualityReport} — a prior report IS a valid baseline, so the
 * Phase-2 "record a baseline" step is just keeping a past report (no new PG
 * schema; the routine payload carries it). Null/absent metrics are skipped
 * (you can't degrade from a baseline that never measured).
 */
export interface ScoutQualityBaseline {
  triageAcceptanceRate?: number | null;
  ideaToShippedConversion?: number | null;
  costPerAcceptedIdeaUsd?: number | null;
  perLensWinRates?: Partial<Record<CreativeLens, number | null>>;
}

/**
 * Per-metric degradation tolerances. Rates use ABSOLUTE drop (they live in
 * [0,1]); cost uses RELATIVE increase (it's an open-ended USD amount). A metric
 * exactly AT its tolerance is NOT degraded — only strictly past it breaches.
 */
export interface QualityTolerances {
  /** Max absolute drop in triageAcceptanceRate (default 0.10). */
  triageAcceptanceRate?: number;
  /** Max absolute drop in ideaToShippedConversion (default 0.05). */
  ideaToShippedConversion?: number;
  /** Max RELATIVE increase in costPerAcceptedIdeaUsd — 0.5 = +50% (default 0.5). */
  costPerAcceptedIdeaUsd?: number;
  /** Max absolute drop in any single lens's win rate (default 0.20). */
  perLensWinRate?: number;
}

export const DEFAULT_QUALITY_TOLERANCES: Required<QualityTolerances> = {
  triageAcceptanceRate: 0.1,
  ideaToShippedConversion: 0.05,
  costPerAcceptedIdeaUsd: 0.5,
  perLensWinRate: 0.2,
};

/** One metric past its tolerance: which metric, and the baseline → current pair. */
export interface QualityBreach {
  /** 'triageAcceptanceRate' | 'ideaToShippedConversion' | 'costPerAcceptedIdeaUsd' | 'perLensWinRates.<lens>'. */
  metric: string;
  baseline: number;
  current: number;
}

export interface QualityDegradationVerdict {
  degraded: boolean;
  breaches: QualityBreach[];
}

/** FP guard so "exactly at tolerance" never breaches on representation error (0.8 − 0.1 ≠ 0.7 in FP). */
const EPS = 1e-9;

/**
 * Compare a report against the injected baseline. Pure. Missing baseline →
 * never degraded (a Scout with no recorded baseline can't have regressed);
 * per-metric null/absent on EITHER side → that metric is skipped.
 */
export function evaluateQualityDegradation(
  report: ScoutQualityReport,
  baseline: ScoutQualityBaseline | null | undefined,
  tolerances: QualityTolerances = {},
): QualityDegradationVerdict {
  if (!baseline) return { degraded: false, breaches: [] };
  const tol = { ...DEFAULT_QUALITY_TOLERANCES, ...tolerances };
  const breaches: QualityBreach[] = [];

  const lowerIsWorse = (
    metric: string,
    base: number | null | undefined,
    current: number | null | undefined,
    allowedDrop: number,
  ): void => {
    if (base == null || current == null || !Number.isFinite(base) || !Number.isFinite(current)) return;
    if (current < base - allowedDrop - EPS) breaches.push({ metric, baseline: base, current });
  };

  lowerIsWorse(
    'triageAcceptanceRate',
    baseline.triageAcceptanceRate,
    report.triageAcceptanceRate,
    tol.triageAcceptanceRate,
  );
  lowerIsWorse(
    'ideaToShippedConversion',
    baseline.ideaToShippedConversion,
    report.ideaToShippedConversion,
    tol.ideaToShippedConversion,
  );

  // Cost: HIGHER is worse, relative headroom (a $0.02 → $0.04 jump on a tiny
  // baseline should flag the same as $2 → $4; an absolute band would not).
  const baseCost = baseline.costPerAcceptedIdeaUsd;
  const curCost = report.costPerAcceptedIdeaUsd;
  if (baseCost != null && curCost != null && Number.isFinite(baseCost) && Number.isFinite(curCost)) {
    if (curCost > baseCost * (1 + tol.costPerAcceptedIdeaUsd) + EPS) {
      breaches.push({ metric: 'costPerAcceptedIdeaUsd', baseline: baseCost, current: curCost });
    }
  }

  for (const lens of CREATIVE_LENSES) {
    lowerIsWorse(
      `perLensWinRates.${lens}`,
      baseline.perLensWinRates?.[lens],
      report.perLensWinRates[lens],
      tol.perLensWinRate,
    );
  }

  return { degraded: breaches.length > 0, breaches };
}

// ── composition: check + flag through an injected capture port ────────────────

/**
 * The capture request the degradation path files — a structural subset of
 * capture-core's CaptureImprovementInput, so production wires the port as
 * `(req) => captureImprovement(req)` (or the improvements:capture tool) without
 * this module importing either (the injected-port pattern — same reason
 * scheduler.ts lazy-imports the autoloop instead of binding it).
 */
export interface QualityCaptureRequest {
  title: string;
  kind: 'bug' | 'change' | 'feature';
  body: string;
  subTopic?: string;
  sourceRole?: 'Queen' | 'cup' | 'system' | 'human';
}

/** The injected improvements-capture port. */
export type QualityCapturePort = (req: QualityCaptureRequest) => Promise<unknown>;

export interface CheckAndFlagQualityDeps {
  /** Read the three ledger snapshots (production: () => buildQualityReportInputs(opts)). */
  readInputs: () => Promise<ScoutQualityInputs>;
  /** The recorded baseline (routine payload); null/undefined → never degraded. */
  baseline: ScoutQualityBaseline | null | undefined;
  tolerances?: QualityTolerances;
  /** Files the improvement on degradation — called at most ONCE per check. */
  capture: QualityCapturePort;
}

export interface QualityCheckResult {
  report: ScoutQualityReport;
  verdict: QualityDegradationVerdict;
  /** True when the capture port was invoked (degraded). */
  captured: boolean;
}

/**
 * Stable capture title for a breach set: sorted, deduped metric names — the
 * same degradation always produces the SAME title, so capture-core's
 * search-first dedup recognizes a re-run instead of filing a twin.
 */
export function qualityBreachTitle(verdict: QualityDegradationVerdict): string {
  const metrics = [...new Set(verdict.breaches.map((b) => b.metric))].sort();
  return `Scout quality degradation: ${metrics.join(', ')}`;
}

const fmt = (v: number): string => String(Number(v.toFixed(4)));

/** Human-readable capture body: the breach lines + the window summary. */
export function qualityBreachBody(report: ScoutQualityReport, verdict: QualityDegradationVerdict): string {
  return [
    `Scout standing quality check: ${verdict.breaches.length} metric(s) past tolerance vs the recorded baseline.`,
    '',
    ...verdict.breaches.map((b) => `- ${b.metric}: baseline ${fmt(b.baseline)} -> current ${fmt(b.current)}`),
    '',
    `Window: ${report.windowCycles} cycles over ${report.totalTicks} ticks (${report.errorTicks} errors); ` +
      `${report.accepted} accepted / ${report.rejected} rejected / ${report.pending} pending of ` +
      `${report.totalRouted} routed; spend $${report.totalSpendUsd.toFixed(2)}.`,
  ].join('\n');
}

/**
 * The composed standing check: read snapshots → compute report → evaluate vs
 * baseline → on degradation file EXACTLY ONE improvements capture (kind
 * 'change', sourceRole 'system', sub-topic 'scout-quality') through the
 * injected port. Returns the report + verdict either way so the caller (the
 * standing routine) can log/persist the fresh report as the next baseline.
 */
export async function checkAndFlagQuality(deps: CheckAndFlagQualityDeps): Promise<QualityCheckResult> {
  const inputs = await deps.readInputs();
  const report = computeScoutQualityReport(inputs);
  const verdict = evaluateQualityDegradation(report, deps.baseline, deps.tolerances ?? {});
  if (!verdict.degraded) return { report, verdict, captured: false };
  await deps.capture({
    title: qualityBreachTitle(verdict),
    kind: 'change',
    body: qualityBreachBody(report, verdict),
    subTopic: 'scout-quality',
    sourceRole: 'system',
  });
  return { report, verdict, captured: true };
}

// ── assembly: the production reader (thin, PG edge stays lazy) ────────────────

export interface BuildQualityInputsOptions extends ScoutLedgerOpts {
  /** Max tick rows in the window snapshot (newest-first). Default 500. */
  tickLimit?: number;
  /** Inclusive epoch-ms floor for the tick read. With no tickLimit, reads the full time box. */
  tickSinceMs?: number;
  /**
   * Tick-ledger host scope when it differs from the routed-idea harness scope. Workspace-global
   * learning loops write ticks under `@singleton` while their ideas remain harness-scoped.
   */
  tickInstallSlug?: string;
  /** Lens-weight options forwarded to gatherLensOutcomes. */
  weights?: LensWeightOptions;
}

/**
 * Read the real ledgers into {@link ScoutQualityInputs}: the tick window
 * (readScoutTicks), the routed-idea ledger (readRoutedIdeas), and the lens
 * outcomes over the production reader bag (gatherLensOutcomes — which already
 * degrades each reader to empty on failure). Lazy imports keep this module's
 * pure core importable without the PG edge. Assembly only — no derivation here.
 */
export async function buildQualityReportInputs<L extends string = CreativeLens>(
  opts: BuildQualityInputsOptions & { lenses?: readonly L[] } = {},
): Promise<ScoutQualityInputs<L>> {
  const [tickLedger, routedLedger] = await Promise.all([import('./tick-ledger'), import('./routed-ledger')]);
  // `origin` (P-013) partitions ALL three reads to the same ledger slice — Scout
  // (default 'scout') or su-ideate. The ledger opt + the tick opt both default 'scout',
  // so an omitted origin is byte-identical to the pre-P-013 Scout read.
  const ledgerOpts: ScoutLedgerOpts = {
    ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
    ...(opts.harnessSlug ? { harnessSlug: opts.harnessSlug } : {}),
    ...(opts.cycleId ? { cycleId: opts.cycleId } : {}),
    ...(opts.limit != null ? { limit: opts.limit } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  };
  const [ticks, routedIdeas, lensOutcomes] = await Promise.all([
    tickLedger.readScoutTicks({
      ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      ...(opts.tickInstallSlug
        ? { installSlug: opts.tickInstallSlug }
        : opts.harnessSlug
          ? { installSlug: opts.harnessSlug }
          : {}),
      ...(opts.tickLimit != null ? { limit: opts.tickLimit } : {}),
      ...(opts.tickSinceMs != null ? { sinceMs: opts.tickSinceMs } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
    }),
    routedLedger.readRoutedIdeas(ledgerOpts),
    gatherLensOutcomes<L>(routedLedger.buildScoutOutcomeReaders(ledgerOpts), {
      ...(opts.weights ?? {}),
      ...(opts.lenses ? { lenses: opts.lenses } : {}),
    }),
  ]);
  return { ticks, routedIdeas, lensOutcomes };
}

/**
 * The su-ideate PARTITION of the standing quality report (su-ideate-learning-substrate
 * P-013). Same fold as Scout, read over `origin:'su-ideate'` + the su lens vocabulary
 * ({@link SU_IDEATION_LENSES}), and surfacing the reused novelty dedup-rate. Scout's own
 * report is untouched (default origin/lenses) — this is an ADDITIVE partition read that
 * makes su-ideation quality legible the same way the Scout loop's is.
 */
export async function buildSuIdeationQualityReport(
  opts: Pick<BuildQualityInputsOptions, 'workspaceId' | 'harnessSlug' | 'limit' | 'tickLimit' | 'weights'> = {},
): Promise<ScoutQualityReport<SuIdeationLens>> {
  const inputs = await buildQualityReportInputs<SuIdeationLens>({
    ...opts,
    origin: 'su-ideate',
    lenses: SU_IDEATION_LENSES,
  });
  return computeScoutQualityReport(inputs, { lenses: SU_IDEATION_LENSES, includeDedupRate: true });
}
