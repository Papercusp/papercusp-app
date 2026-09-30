/**
 * eval-viz — shared, purely-presentational benchmark visualizations
 * (impartial-benchmark-suite-2026-06-15 P-021 / BRIEF 10).
 *
 * Lifted from the gym dashboard + realized for the Evaluation surface (D-007).
 * Consumed by the Evaluation dock-tab (operator-vite, via `@/app/eval-viz/*`)
 * and the gym `compare` tab (`apps/operator/app/gym`, relatively). These
 * components read NO data — callers feed props, keyed on the locked arm vocab.
 */
// L1 per-task charts (Phase 2)
export { Frontier, paretoOptimal, projectFrontier } from './Frontier';
export type { FrontierPoint, FrontierProps } from './Frontier';
export { Compare, summarizeDeltas } from './Compare';
export type { ComparePerTaskRow, CompareSummary, CompareProps } from './Compare';

// L2–L4 fleet/Hive charts (Phase 5 / D-010 reframe)
export { ThroughputBars, computeThroughputBars } from './ThroughputBars';
export type { ThroughputArm, ThroughputBarsProps } from './ThroughputBars';
export { MastBreakdown, mastTotal, MAST_MODES } from './MastBreakdown';
export type { MastArmRates, MastBreakdownProps } from './MastBreakdown';
export { ValueCaptureCurve, projectValueCurves } from './ValueCaptureCurve';
export type { ValuePoint, ValueSeries, ValueCaptureCurveProps } from './ValueCaptureCurve';

// Arm vocabulary (locked L1 + provisional fleet arms)
export { ARM_IDS, armLabel, armColor } from './arms';
export type { ArmId } from './arms';

// Run validity signals — the integrity guarantee (P-009 / P-012 / D-003)
export { computeValiditySignals, isRunValid, validityCaveats, SUBSET_STABLE_MIN, QUEEN_SURVIVAL_SEC } from './validity';
export type { ValidityStatus, ValidityKey, ValiditySignal, ValidityLiveFleet, ValidityInput } from './validity';
