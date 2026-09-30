/**
 * Drill-ground-truth signal cores (self-learning-frontier P-048 / FB-23) — the
 * vaccination drill corpus as the gym's un-gameable judging battery, extending the
 * `plantedBugCaught` precedent (signals.ts / D-011): the optimizer can touch neither
 * the planted drill nor its known answer, so these are trustworthy gates/monitors.
 *
 * Pure cores only (the signals.ts discipline): the integration layer feeds them
 * `DrillOutcome` rows — `readDrillOutcomes()` from lib/red-queen/store.ts once the
 * drill corpus is live (`frontier:drill-corpus-live`). `DrillOutcome` here is the
 * gym-side mirror of the FROZEN v1 contract red-queen exports (lib/red-queen/types.ts,
 * agreed FB-20↔FB-23 2026-06-12): structurally identical, not imported, so this
 * module stays buildable + unit-testable before red-queen lands.
 *
 * Provenance (D-002): every row carries `origin: 'drill'`. `onlyDrillRows` is the
 * defensive runtime guard — a non-drill row never enters a drill metric, mirroring
 * the inverse zero-leak rule (a drill row never reaches an organic learner).
 */

/** One planted drill's full lifecycle vs its known answer (red-queen v1 contract). */
export interface DrillOutcome {
  /** harness_shared.red_queen_drills.id */
  drillId: string;
  /** e.g. 'smoke-fail', 'routine-engine-death' */
  drillClass: string;
  /** Watchdog collector family the class targets ('out-of-band' for engine-death). */
  collectorFamily: string;
  /** ISO timestamp — ground truth. */
  plantedAt: string;
  /** Watchdog signal captured (issue row created). */
  detectedAt?: string | null;
  triagedAt?: string | null;
  resolvedAt?: string | null;
  // ── known answer (ground truth) ──
  /** `<source>:<key>` the collector should produce. */
  expectedWatchdogKey: string;
  expectedKind: 'bug' | 'change';
  expectedSeverity: string;
  /** When the drill class pins one (TriageDecision vocabulary). */
  expectedDecision?: 'place' | 'gate' | 'gym' | 'reject' | null;
  // ── what the system concluded ──
  detectedWatchdogKey?: string | null;
  detectedKind?: string | null;
  /** Actual TriageDecision. */
  triagedDecision?: string | null;
  /** Actual IdeaType (product | code-bug | infra-environment | process-prompt | needs-design). */
  triagedIdeaType?: string | null;
  resolvedWithEvidence: boolean;
  /** The captured engineer_issue id. */
  issueId?: string | null;
  // ── measurement + safety ──
  mttsh?: { detectMs?: number; triageMs?: number; fixMs?: number; totalMs?: number } | null;
  /** Organic read seam returned ZERO drill rows post-capture. */
  leakCheckPassed?: boolean | null;
  status: 'planted' | 'detected' | 'triaged' | 'resolved' | 'failed' | 'expired';
  origin: 'drill';
}

// ── SLO tunables (FB-21 convention: exported, owner-amendable) ──────────────
//
// PROVISIONAL floors/ceilings for the boolean gate forms in GYM_SIGNAL_REGISTRY.
// Like the gates' ε/δ ("derived from measured judge variance", gates.ts), the
// real values come from FB-20's first measured drill rounds — recalibrate before
// arming (P-001); until then these are deliberately permissive defaults.

/** Minimum fraction of settled drills resolved with evidence. */
export const DRILL_RESOLVE_RATE_FLOOR = 0.5;
/** Minimum fraction of decision-pinned, triaged drills whose decision matched. */
export const DRILL_TRIAGE_ACCURACY_FLOOR = 0.8;
/** Maximum mean time-to-safe-hands (planted → resolved) in ms. */
export const DRILL_MTTSH_CEILING_MS = 60 * 60 * 1000;

// ── cores ────────────────────────────────────────────────────────────────────

/** Provenance guard (D-002): only origin='drill' rows may enter a drill metric. */
export function onlyDrillRows(outcomes: readonly DrillOutcome[]): DrillOutcome[] {
  return outcomes.filter((o) => o.origin === 'drill');
}

/** A drill whose lifecycle has finished — the only rows the rates score. */
const SETTLED = new Set<DrillOutcome['status']>(['resolved', 'failed', 'expired']);

function settled(outcomes: readonly DrillOutcome[]): DrillOutcome[] {
  return onlyDrillRows(outcomes).filter((o) => SETTLED.has(o.status));
}

/**
 * Fraction of SETTLED drills resolved with evidence. In-flight drills
 * (planted/detected/triaged) are excluded — scoring a half-run battery as failure
 * would penalize a variant for the clock, not its behavior. `null` when no drill
 * has settled (the caller reports inapplicable, never a fake 0).
 */
export function drillResolveRate(outcomes: readonly DrillOutcome[]): number | null {
  const pool = settled(outcomes);
  if (pool.length === 0) return null;
  const resolved = pool.filter((o) => o.status === 'resolved' && o.resolvedWithEvidence).length;
  return resolved / pool.length;
}

/**
 * Triage accuracy vs the known answer: over drills that were actually triaged AND
 * whose class pins an expected decision, the fraction where the system's
 * TriageDecision matched. Drills without a pinned `expectedDecision` (or not yet
 * triaged) don't enter the denominator. `null` when the denominator is empty.
 */
export function drillTriageAccuracy(outcomes: readonly DrillOutcome[]): number | null {
  const pool = onlyDrillRows(outcomes).filter((o) => o.expectedDecision != null && o.triagedDecision != null);
  if (pool.length === 0) return null;
  const correct = pool.filter((o) => o.triagedDecision === o.expectedDecision).length;
  return correct / pool.length;
}

/**
 * Mean time-to-safe-hands (planted → resolved) in ms over resolved-with-evidence
 * drills. Prefers the row's measured `mttsh.totalMs`; falls back to the
 * plantedAt→resolvedAt timestamp delta. `null` when nothing resolved (a dormant
 * corpus is inapplicable, not infinitely slow — FB-21's dormant-tolerant rule).
 */
export function drillMttshMs(outcomes: readonly DrillOutcome[]): number | null {
  const durations: number[] = [];
  for (const o of onlyDrillRows(outcomes)) {
    if (o.status !== 'resolved' || !o.resolvedWithEvidence) continue;
    const total = o.mttsh?.totalMs;
    if (typeof total === 'number' && Number.isFinite(total)) {
      durations.push(total);
      continue;
    }
    if (o.resolvedAt) {
      const delta = Date.parse(o.resolvedAt) - Date.parse(o.plantedAt);
      if (Number.isFinite(delta) && delta >= 0) durations.push(delta);
    }
  }
  if (durations.length === 0) return null;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}
