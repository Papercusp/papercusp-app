/**
 * Pure poll-state classifier for a hermetic gym run.
 *
 * The DBOS feature pipeline is fire-and-forget (no synchronous result handle), so
 * the runner polls `(workflow status, feature status)` until terminal. The DBOS
 * terminal status is the authoritative "the pipeline finished" signal; the feature
 * status supplies the outcome. The outcome is recorded as OBSERVABILITY only
 * (terminal_state, D-011) — never an optimization reward.
 */

export type GymRunOutcome = 'running' | 'passed' | 'failed' | 'escalated' | 'errored' | 'timeout';

export interface GymRunClassification {
  outcome: GymRunOutcome;
  terminal: boolean;
}

export interface ClassifyGymRunInput {
  /** DBOS workflow status (PENDING/ENQUEUED = live; SUCCESS/ERROR/… = terminal). */
  workflowStatus: string;
  /** The harness feature's status, or null if not yet readable. */
  featureStatus: string | null;
  /** Wall-clock elapsed since the pipeline started. */
  elapsedMs: number;
  /** Hard wall-clock cap; past it while still live ⇒ timeout. */
  timeoutMs: number;
}

/** DBOS statuses meaning the pipeline is still in flight. */
const LIVE_WORKFLOW = new Set(['pending', 'enqueued']);
const PASSED_FEATURE = new Set(['passed', 'shipped']);
const FAILED_FEATURE = new Set(['failing', 'failed']);

export function classifyGymRun(input: ClassifyGymRunInput): GymRunClassification {
  const wf = input.workflowStatus.toLowerCase();
  const feat = input.featureStatus?.toLowerCase() ?? null;

  if (LIVE_WORKFLOW.has(wf)) {
    if (input.elapsedMs >= input.timeoutMs) return { outcome: 'timeout', terminal: true };
    return { outcome: 'running', terminal: false };
  }

  // Workflow is terminal. SUCCESS = the pipeline ran to a clean DONE; anything
  // else (ERROR, CANCELLED, MAX_RECOVERY_ATTEMPTS_EXCEEDED, unknown) = errored.
  if (wf !== 'success') return { outcome: 'errored', terminal: true };

  if (feat && PASSED_FEATURE.has(feat)) return { outcome: 'passed', terminal: true };
  if (feat && FAILED_FEATURE.has(feat)) return { outcome: 'failed', terminal: true };
  // Pipeline ended without a clean pass/fail (e.g. ESCALATE, blocked, deprecated,
  // or feature status unreadable) → escalated/abandoned.
  return { outcome: 'escalated', terminal: true };
}
