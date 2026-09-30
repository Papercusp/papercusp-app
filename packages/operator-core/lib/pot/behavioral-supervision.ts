/**
 * Behavioral-supervision family (mug-autonomous-execution P-052) — the HARD half of supervision:
 * catching a cup that stays LIVE + busy but is doing the WRONG thing. The liveness family
 * (placement-watchdog.ts, B-09) catches a hung/dead cup on cheap deterministic signals; this catches
 * "competently doing the wrong thing", which has NO cheap catch — so these are HEURISTIC collectors
 * that surface a WAKE for the Mug to judge, and NEVER auto-kill on a soft signal.
 *
 * Two collector cores (PURE; the live PG/EKG wiring + the wake bridge wrap them):
 *   - **scope-violation** — a cup touched files OUTSIDE its declared lane (the signal EKG tool-mix
 *     drift is blind to: the cup edits + runs like normal, just on the wrong files). The gap the
 *     pot-run-evaluation P-065 eval quantified at "undetected".
 *   - **convergence-churn** — a cup re-attempting work without converging (re-placements / no claim
 *     advance / status oscillation) — thrashing, not progressing. Distinct from the placement
 *     breaker (which escalates a CURSED item); this is the softer "no convergence yet" wake.
 *
 * The WAKE thresholds (the false-positive knobs) live in {@link BehavioralWakePolicy} — DELIBERATELY
 * conservative defaults, flagged for owner tuning against real data (the eval measures the rate).
 */
import { minimatch } from 'minimatch';

// ── scope-violation ───────────────────────────────────────────────────────────

export interface ScopeViolationInput {
  /** The cup's declared lane — glob patterns of files it's allowed to touch (its brief/work-item
   *  files + declared lane). An EMPTY lane means the cup is unconstrained (exploratory work) — never
   *  a violation, so un-laned cups are never false-flagged. */
  declaredLane: readonly string[];
  /** Files the cup actually touched (edited / committed). */
  touchedFiles: readonly string[];
}

export interface ScopeViolationVerdict {
  /** The cup touched ≥1 file outside its declared lane (and it HAD a declared lane). The raw SIGNAL —
   *  a wake decision applies {@link shouldWakeOnScopeViolation} on top (a single incidental out-of-lane
   *  file is a signal, not necessarily a wake). */
  violated: boolean;
  /** The touched files outside every declared-lane glob. */
  outOfLaneFiles: string[];
  /** Out-of-lane ÷ touched — the severity (0..1). */
  outOfLaneRatio: number;
}

/** Flag a cup working outside its declared lane. Pure; conservative (an un-laned or no-touch cup is
 *  never flagged). Glob match via minimatch (`{dot:true}` so dotfiles in a lane match). */
export function scopeViolation(input: ScopeViolationInput): ScopeViolationVerdict {
  if (input.declaredLane.length === 0 || input.touchedFiles.length === 0) {
    return { violated: false, outOfLaneFiles: [], outOfLaneRatio: 0 };
  }
  const outOfLaneFiles = input.touchedFiles.filter(
    (f) => !input.declaredLane.some((g) => minimatch(f, g, { dot: true })),
  );
  return {
    violated: outOfLaneFiles.length > 0,
    outOfLaneFiles,
    outOfLaneRatio: outOfLaneFiles.length / input.touchedFiles.length,
  };
}

// ── convergence-churn ─────────────────────────────────────────────────────────

export interface ConvergenceChurnInput {
  /** Re-placements / recovery attempts recorded for this cup's work (hive_placements.fail_count). */
  failCount: number;
  /** Did the work-item CONVERGE (reach a terminal/completed state)? A converged item is never churn —
   *  retries that eventually succeed are not thrashing. */
  converged: boolean;
  /** Optional: distinct no-progress status transitions observed (oscillation), if tracked. */
  statusOscillations?: number;
}

export interface ConvergenceChurnVerdict {
  /** The cup is thrashing — re-attempting without converging. The raw SIGNAL; the wake decision
   *  applies the threshold ({@link shouldWakeOnChurn}). */
  churning: boolean;
  /** Unproductive attempts (re-placements + oscillations) on an un-converged item — the severity. */
  unproductiveAttempts: number;
}

/** Flag a cup thrashing without convergence. Pure; a converged item is never churn (0 attempts). */
export function convergenceChurn(input: ConvergenceChurnInput): ConvergenceChurnVerdict {
  const unproductiveAttempts = input.converged ? 0 : input.failCount + (input.statusOscillations ?? 0);
  return { churning: false, unproductiveAttempts }; // `churning` decided by the wake policy below
}

// ── the WAKE policy (the false-positive knobs — surfaces a WAKE, never auto-kills) ──

export interface BehavioralWakePolicy {
  /** Wake on a scope violation when the out-of-lane RATIO ≥ this (sustained off-lane work, not one
   *  incidental dependency fix). Default 0.5. */
  scopeOutOfLaneRatioThreshold: number;
  /** …OR when there are ≥ this many out-of-lane files (an absolute floor). Default 3. */
  scopeOutOfLaneCountThreshold: number;
  /** Wake on churn when unproductive attempts (re-placements w/o convergence) ≥ this. Default 2 —
   *  below the placement breaker (3) so the soft churn wake fires BEFORE the cursed-item escalation. */
  churnAttemptsThreshold: number;
}

/**
 * Conservative defaults — these are the FALSE-POSITIVE knobs. They are starting points, flagged for
 * owner tuning against real armed-run data (pot-run-evaluation's P-065 eval measures the resulting
 * detection-rate + false-positive-rate). A soft signal NEVER auto-kills; it only wakes the Mug.
 */
export const DEFAULT_BEHAVIORAL_WAKE_POLICY: BehavioralWakePolicy = {
  scopeOutOfLaneRatioThreshold: 0.5,
  scopeOutOfLaneCountThreshold: 3,
  churnAttemptsThreshold: 2,
};

/** Should a scope-violation verdict wake the Mug? True on a high out-of-lane ratio OR an absolute
 *  out-of-lane count — so both "mostly working off-lane" and "a handful of clearly-off-lane files"
 *  wake, but a single incidental dependency touch does not (the FP guard). */
export function shouldWakeOnScopeViolation(v: ScopeViolationVerdict, policy: BehavioralWakePolicy = DEFAULT_BEHAVIORAL_WAKE_POLICY): boolean {
  if (!v.violated) return false;
  return v.outOfLaneRatio >= policy.scopeOutOfLaneRatioThreshold || v.outOfLaneFiles.length >= policy.scopeOutOfLaneCountThreshold;
}

/** Should a churn verdict wake the Mug? True when unproductive attempts cross the threshold. */
export function shouldWakeOnChurn(v: ConvergenceChurnVerdict, policy: BehavioralWakePolicy = DEFAULT_BEHAVIORAL_WAKE_POLICY): boolean {
  return v.unproductiveAttempts >= policy.churnAttemptsThreshold;
}
