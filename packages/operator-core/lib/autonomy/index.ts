/**
 * @module autonomy — the Queen-autonomy CATEGORY taxonomy + action-surface audit
 * (queen-autonomy-policy-2026-06-13 B-04: P-015 audit · P-016 coverage · P-020
 * taxonomy encoding + capability→category map).
 *
 * This is the behavior-neutral FOUNDATION the rest of the plan builds on — pure
 * data + pure functions, no DB, no gate, nothing armed:
 *   • {@link ./categories}             — the canonical 13-category taxonomy (the
 *                                         shared seam B-03's store seeds + keys on).
 *   • {@link ./capability-category-map}— resolve a tool/verb → its category
 *                                         (fail-safe `null` → never-auto).
 *   • {@link ./action-surface}         — the authoritative human-driving action
 *                                         inventory + coverage verdicts.
 *
 * The gate that CONSUMES this (B-12), the policy STORE keyed on it (B-03), and the
 * arming gate (P-092) are elsewhere. Importing from here arms nothing.
 */

export {
  type AutonomyCategory,
  type CategoryDef,
  type SuggestedPosture,
  CATEGORIES,
  AUTONOMY_CATEGORY_IDS,
  PROTECTED_CATEGORIES,
  isAutonomyCategory,
  getCategory,
  isProtectedCategory,
} from './categories';

export {
  type CategoryResult,
  classifyActionCategory,
  categoryForAction,
  categoryMapRules,
} from './capability-category-map';

export {
  type Authority,
  type Coverage,
  type HumanDrivingAction,
  ACTION_SURFACE,
  coverageGaps,
  partialCoverage,
  categoriesInAudit,
} from './action-surface';

export {
  type AutonomyPosture,
  type EconomicSignals,
  type AutonomyDecisionInput,
  type AutonomyDecision,
  type DeciderDeps,
  decideAutonomy,
  resolveAutonomyDecision,
  decideRankedItem,
  defaultDeciderDeps,
  graduationEvidenceSignals,
  extractEconomicSignals,
} from './decider';

// The auto-revert tripwire + graduation engine (B-16 / P-080-082, D-006/D-005).
export {
  type RevertHandle,
  type TripwireSignalKind,
  type TripwireWatchSignal,
  type TripwireStatus,
  type TripwireArming,
  type ArmedTripwire,
  type TripwireVerdict,
  TRIPWIRE_SIGNAL_KINDS,
  DEFAULT_TRIPWIRE_WINDOW_HOURS,
  armTripwire,
  evaluateTripwire,
  demoteGraduatedLevel,
  findingClassForDecision,
} from './tripwire/core';
export {
  type AutonomyGraduationPolicy,
  type CategoryGraduationTarget,
  DEFAULT_AUTONOMY_GRADUATION_POLICY,
  computeAutonomyStandings,
  computeCategoryGraduationTargets,
  earnedLevelForStreak,
  buildAutonomyGraduationReport,
} from './tripwire/graduation';
export {
  type AutonomyTrustScanDeps,
  type AutonomyTrustScanOutcome,
  type ArmTripwireForDecisionInput,
  type ArmTripwireForDecisionResult,
  type RevertOutcome,
  runAutonomyTrustScan,
  runAutonomyTripwireSweep,
  runAutonomyGraduationLeg,
  armTripwireForDecision,
  defaultAutonomyTrustScanDeps,
  DEFAULT_AUTONOMY_TRUST_SCAN_OPTIONS,
} from './tripwire/scan';
// The revert-handle vocabulary + executor registry (B-16 / P-081) — the Queen
// execution layer registers reverters for its own action kinds.
export {
  type RevertHelpers,
  type Reverter,
  BUILTIN_REVERTERS,
  makeRevertRegistry,
  registerReverter,
  executeRevertVia,
  defaultRevertHelpers,
} from './tripwire/revert-executor';
