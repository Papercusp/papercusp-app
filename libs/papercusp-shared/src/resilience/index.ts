/**
 * @papercusp resilience primitives (generic, domain-independent).
 *
 * Rate-limit pacing + (soon) a retry-with-classification policy loop, reusable by ANY
 * rate-limited / flaky I/O — not just agents. The agent layer (`../agent/*`) layers its
 * backend-specific TurnError taxonomy + classifier on top of these. Promotable to a
 * standalone `libs/generic/@papercusp/resilience` later (BORROWABLE.md).
 */
export {
  RateLimitGovernor,
  initGovernorState,
  decideAcquire,
  decideConcurrency,
  decideRate,
  effectiveRpmFactor,
  effectiveRpm,
  effectivePaceMs,
  recordAcquire,
  recordRate,
  recordRelease,
  recordPenalty,
  recordHeaders,
  type GovernorLimits,
  type GovernorState,
  type GovernorDeps,
  type GovernorStore,
  type GovernorPauseEvent,
  type AcquireOpts,
  type AcquireDecision,
  type AdmissionDenial,
  type AdmissionDenialReason,
  type TokenEstimate,
  type UnifiedWindowState,
} from './governor';
export { ROLLING_WINDOW_REPROBE_MAX_MS } from './governor';
export {
  runWithRetry,
  type RetryVerdict,
  type AttemptOutcome,
  type RetryResult,
  type RetryOptions,
  type RetryDeps,
} from './retry';
export {
  PriorityAdmissionQueue,
  QueueFullError,
  priorityFromLabel,
  tierOf,
  tiersOfMap,
  defaultTierCaps,
  shedTierCaps,
  parsePriorityTierMap,
  DEFAULT_GATEWAY_PRIORITY_MAP,
  DEFAULT_TIER,
  type PriorityAdmissionOptions,
  type AdmissionSnapshot,
  type TierAdmissionConfig,
  type TierSnapshot,
  type PriorityTierMap,
} from './priority-admission';
export {
  AimdConcurrencyController,
  type AimdConcurrencyOptions,
  type AimdSnapshot,
} from './aimd-concurrency';
