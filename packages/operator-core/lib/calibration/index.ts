/**
 * Calibration markets (self-learning-frontier-2026-06-12 P-041 / FB-13).
 *
 * Layers:
 *   types.ts         — domain vocabulary + row/score shapes
 *   scoring.ts       — pure Brier + trust-weight transforms
 *   store.ts         — SQL over harness_shared.calibration_predictions (mig 253)
 *   capture.ts       — the never-throw, flag-gated seam the natural-moment
 *                      hosts call (improvements:resolve, plans:start, flake filings)
 *   resolve-sweep.ts — maturity sweep + the live outcome probes
 *   governor.ts      — D-004 gate for the system:calibration-resolve cadence
 *
 * Consumption (D-005): lib/queue-ranker/calibration-feature.ts (ranker
 * feature) and the calibration:summary tool (Queen-weighting reads).
 */
export * from './types';
export * from './scoring';
export * from './store';
export * from './capture';
export * from './resolve-sweep';
export * from './governor';
