/**
 * Pure policy for hosted workspace lifecycle admission and reconciliation (P-040 / D-146).
 *
 * Persistence lives in hosted-lifecycle-store.ts. Keeping the decision layer pure makes quota,
 * budget, approval, idle-stop, and recovery behavior deterministic and cheap to falsify.
 */

export type HostedLifecycleRiskTier = 'low' | 'moderate' | 'high' | 'critical';
export type HostedLifecycleApprovalStatus = 'not-required' | 'pending' | 'approved' | 'rejected';
export type HostedLifecycleAction =
  | 'provision'
  | 'start'
  | 'stop'
  | 'restart'
  | 'snapshot'
  | 'restore'
  | 'upgrade'
  | 'repair'
  | 'destroy';

export interface HostedLifecyclePolicy {
  tenantConcurrencyLimit: number;
  providerConcurrencyLimit: number;
  monthlyBudgetCents: number | null;
  idleStopAfterMinutes: number | null;
  approvalRequiredAt: HostedLifecycleRiskTier;
  stuckAfterMs: number;
  orphanAfterMs: number;
  maxRecoveryAttempts: number;
}

export const DEFAULT_HOSTED_LIFECYCLE_POLICY: HostedLifecyclePolicy = {
  tenantConcurrencyLimit: 2,
  providerConcurrencyLimit: 8,
  monthlyBudgetCents: null,
  idleStopAfterMinutes: 60,
  approvalRequiredAt: 'high',
  stuckAfterMs: 5 * 60_000,
  orphanAfterMs: 20 * 60_000,
  maxRecoveryAttempts: 3,
};

export interface HostedCostEstimate {
  cents: number;
  currency: string;
  source: string;
  evidenceRef: string;
  estimatedAt: string;
}

export interface HostedBillingOwner {
  kind: 'organization' | 'customer' | 'platform';
  id: string;
}

export interface HostedLifecycleAdmissionRequest {
  action: HostedLifecycleAction;
  riskTier: HostedLifecycleRiskTier;
  approvalStatus: HostedLifecycleApprovalStatus;
  estimate: HostedCostEstimate;
  billingOwner: HostedBillingOwner;
  emergencyTeardown?: boolean;
  teardownReason?: string;
}

export interface HostedLifecycleAdmissionSnapshot {
  activeTenantJobs: number;
  activeProviderJobs: number;
  committedMonthlyCents: number;
}

export interface HostedLifecycleAdmissionDecision {
  allowed: boolean;
  reasons: string[];
  projectedMonthlyCents: number;
  emergencyBypass: boolean;
}

const RISK_WEIGHT: Record<HostedLifecycleRiskTier, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

function finiteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validIso(value: string): boolean {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

export function validateHostedLifecyclePolicy(policy: HostedLifecyclePolicy): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(policy.tenantConcurrencyLimit) || policy.tenantConcurrencyLimit < 1) {
    problems.push('tenantConcurrencyLimit must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.providerConcurrencyLimit) || policy.providerConcurrencyLimit < 1) {
    problems.push('providerConcurrencyLimit must be a positive integer');
  }
  if (policy.monthlyBudgetCents !== null && !finiteInteger(policy.monthlyBudgetCents)) {
    problems.push('monthlyBudgetCents must be a non-negative safe integer or null');
  }
  if (policy.idleStopAfterMinutes !== null &&
      (!Number.isSafeInteger(policy.idleStopAfterMinutes) || policy.idleStopAfterMinutes < 1)) {
    problems.push('idleStopAfterMinutes must be a positive integer or null');
  }
  if (!finiteInteger(policy.stuckAfterMs) || policy.stuckAfterMs < 1_000) {
    problems.push('stuckAfterMs must be at least 1000');
  }
  if (!finiteInteger(policy.orphanAfterMs) || policy.orphanAfterMs <= policy.stuckAfterMs) {
    problems.push('orphanAfterMs must be greater than stuckAfterMs');
  }
  if (!Number.isSafeInteger(policy.maxRecoveryAttempts) || policy.maxRecoveryAttempts < 0) {
    problems.push('maxRecoveryAttempts must be a non-negative integer');
  }
  return problems;
}

export function validateHostedCostEstimate(estimate: HostedCostEstimate): string[] {
  const problems: string[] = [];
  if (!finiteInteger(estimate.cents)) problems.push('estimate.cents must be a non-negative safe integer');
  if (!/^[A-Z]{3}$/.test(estimate.currency)) problems.push('estimate.currency must be an ISO-4217 code');
  if (!nonEmpty(estimate.source)) problems.push('estimate.source is required');
  if (!nonEmpty(estimate.evidenceRef)) problems.push('estimate.evidenceRef is required');
  if (!validIso(estimate.estimatedAt)) problems.push('estimate.estimatedAt must be an ISO timestamp');
  return problems;
}

export function evaluateHostedLifecycleAdmission(
  policy: HostedLifecyclePolicy,
  snapshot: HostedLifecycleAdmissionSnapshot,
  request: HostedLifecycleAdmissionRequest,
): HostedLifecycleAdmissionDecision {
  const reasons = [
    ...validateHostedLifecyclePolicy(policy),
    ...validateHostedCostEstimate(request.estimate),
  ];
  if (!nonEmpty(request.billingOwner.id)) reasons.push('billingOwner.id is required');
  if (![snapshot.activeTenantJobs, snapshot.activeProviderJobs, snapshot.committedMonthlyCents]
    .every(finiteInteger)) {
    reasons.push('admission snapshot counters must be non-negative safe integers');
  }

  const emergencyBypass = request.emergencyTeardown === true;
  if (emergencyBypass) {
    if (request.action !== 'destroy') reasons.push('emergency teardown is valid only for destroy');
    if (!nonEmpty(request.teardownReason ?? '')) reasons.push('emergency teardown requires a reason');
  }

  const requiresApproval = RISK_WEIGHT[request.riskTier] >= RISK_WEIGHT[policy.approvalRequiredAt];
  if (request.approvalStatus === 'rejected') reasons.push('lifecycle request was rejected');
  if (requiresApproval && request.approvalStatus !== 'approved') {
    reasons.push(`risk tier ${request.riskTier} requires approval`);
  }

  const projectedMonthlyCents = snapshot.committedMonthlyCents + request.estimate.cents;
  if (!emergencyBypass) {
    if (snapshot.activeTenantJobs >= policy.tenantConcurrencyLimit) {
      reasons.push('tenant concurrency limit reached');
    }
    if (snapshot.activeProviderJobs >= policy.providerConcurrencyLimit) {
      reasons.push('provider concurrency limit reached');
    }
    if (policy.monthlyBudgetCents !== null && projectedMonthlyCents > policy.monthlyBudgetCents) {
      reasons.push('monthly lifecycle budget exceeded');
    }
  }

  return { allowed: reasons.length === 0, reasons, projectedMonthlyCents, emergencyBypass };
}

export type HostedLifecycleJobHealth = 'healthy' | 'stuck' | 'orphaned' | 'recovery-exhausted' | 'terminal';

/**
 * Whether DBOS still owns this operation's workflow as runnable (WI-10001739 link 3b).
 *
 * `unknown` means THE PROBE DID NOT ANSWER — the reconciler could not read
 * `dbos.workflow_status` (no grant, schema absent, query failed). It is a failed measurement,
 * never evidence that a workflow is dead, and it must behave exactly like the pre-3b code.
 */
export type HostedLifecycleWorkflowLiveness = 'live' | 'gone' | 'unknown';

export interface HostedLifecycleJobObservation {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  heartbeatAt?: string | null;
  updatedAt: string;
  recoveryAttempts: number;
  /** Omitted is treated as `unknown`; see `HostedLifecycleWorkflowLiveness`. */
  workflowLiveness?: HostedLifecycleWorkflowLiveness;
}

export function classifyHostedLifecycleJob(
  job: HostedLifecycleJobObservation,
  policy: HostedLifecyclePolicy,
  now = Date.now(),
): HostedLifecycleJobHealth {
  if (job.status === 'succeeded' || job.status === 'failed') return 'terminal';
  // WI-10001739 link 3b. Everything below this line infers abandonment from ROW RECENCY, which
  // cannot distinguish "the executor died" from "the executor is busy and has not checkpointed
  // lately". A workflow DBOS still holds as runnable is BY DEFINITION not abandoned, however old
  // its row looks, so an authoritative `live` outranks every recency signal.
  //
  // This check sits ahead of the `recoveryAttempts` test on purpose: that is the branch that
  // marks an operation failed and (pre-3a) fabricated a cause over the real one, so it is exactly
  // the branch a live workflow must never reach. Measured 2026-09-17: a row reaches it after ~3
  // sweeps (stuck at 5min, +1 attempt per sweep), which is what produced the 20-29min reap band.
  //
  // ONLY `live` changes behaviour. `gone` and `unknown` both fall through to the original
  // recency path, so an unavailable or failed probe degrades to exactly the pre-3b classifier
  // rather than reaping more aggressively on evidence it does not have.
  if (job.workflowLiveness === 'live') return 'healthy';
  if (job.recoveryAttempts >= policy.maxRecoveryAttempts) return 'recovery-exhausted';
  const heartbeat = Date.parse(job.heartbeatAt || job.updatedAt);
  if (!Number.isFinite(heartbeat)) return 'orphaned';
  const age = Math.max(0, now - heartbeat);
  if (age >= policy.orphanAfterMs) return 'orphaned';
  if (age >= policy.stuckAfterMs) return 'stuck';
  return 'healthy';
}

/**
 * A live desktop viewer bound to one of this workspace's desktop sessions (P-014).
 *
 * WHY THIS EXISTS. `desktop-lifecycle` already refuses to freeze a desktop somebody is watching,
 * because freezing a live picture is indistinguishable from a crash to the person looking at it.
 * The control-plane idle-stop sweep is the SAME failure one layer up and with a bigger blast
 * radius: it stops the whole VM. Before this input existed the sweep had no way to know a human
 * was attached, so the two layers disagreed by construction.
 *
 * `holdSec` is passed in rather than imported so this module stays pure policy with no dependency
 * on the desktop registry. It is not a number to invent at the call site: source it from
 * `desktop-lifecycle.VIEWER_HOLD_SEC`, which is itself derived from the two viewer lanes' teardown
 * ceiling, so the hold cannot drift away from the lanes it is covering.
 */
export interface HostedDesktopViewerSignal {
  /** Viewers currently bound in `watch` or `takeover` mode. */
  attachedViewers: number;
  /** When a bound viewer was last observed live. */
  lastSeenAt: string | null;
  /** How long a binding defers governance — `desktop-lifecycle.VIEWER_HOLD_SEC`. */
  holdSec: number;
}

export interface HostedWorkspaceActivity {
  state: string;
  observedState: string;
  lastActivityAt?: string | null;
  idleStopAfterMinutes?: number | null;
  activeLifecycleJobs: number;
  /**
   * Desktop viewers attached to this workspace. OMITTING it is a valid state and means the caller
   * had no viewer signal to offer — which is reported back as `desktopViewerSignal: 'absent'`
   * rather than silently treated as "nobody is watching". See that field.
   */
  desktopViewers?: HostedDesktopViewerSignal | null;
}

export interface HostedIdleStopDecision {
  due: boolean;
  idleForMs: number;
  reason?: string;
  /** Present only when something actively held the stop off. */
  hold?: 'desktop-viewer';
  /**
   * Whether this verdict actually consulted a desktop-viewer signal.
   *
   * `'absent'` means the caller supplied none — so a `due: true` alongside it is NOT evidence
   * that nobody is watching, only that nobody asked. Reported rather than defaulted because an
   * unmeasured absence reads exactly like a measured one, and that mistake here queues a STOP on
   * a machine somebody is using.
   *
   * Emitted only on verdicts that reached the idle computation; the earlier guards
   * (not active, not running, jobs in flight) are refusals to judge, not idle verdicts.
   */
  desktopViewerSignal?: 'absent' | 'observed';
}

export function evaluateHostedIdleStop(
  workspace: HostedWorkspaceActivity,
  now = Date.now(),
): HostedIdleStopDecision {
  if (workspace.state !== 'active') return { due: false, idleForMs: 0 };
  if (workspace.observedState !== 'running') return { due: false, idleForMs: 0 };
  if (workspace.activeLifecycleJobs > 0) return { due: false, idleForMs: 0 };
  const minutes = workspace.idleStopAfterMinutes;
  if (minutes == null || !Number.isSafeInteger(minutes) || minutes < 1) {
    return { due: false, idleForMs: 0 };
  }

  const viewers = workspace.desktopViewers ?? null;
  const desktopViewerSignal: 'absent' | 'observed' = viewers ? 'observed' : 'absent';
  if (viewers && viewers.attachedViewers > 0) {
    const lastSeen = Date.parse(viewers.lastSeenAt ?? '');
    const holdMs = Math.max(0, viewers.holdSec) * 1000;
    // An unparseable timestamp on an attached viewer holds. A viewer we know is bound but cannot
    // date is the case where guessing costs the most, and the hold is bounded anyway.
    if (!Number.isFinite(lastSeen) || now - lastSeen < holdMs) {
      return {
        due: false,
        idleForMs: 0,
        hold: 'desktop-viewer',
        desktopViewerSignal,
      };
    }
  }

  const lastActivity = Date.parse(workspace.lastActivityAt ?? '');
  if (!Number.isFinite(lastActivity)) return { due: false, idleForMs: 0, desktopViewerSignal };
  const idleForMs = Math.max(0, now - lastActivity);
  const due = idleForMs >= minutes * 60_000;
  return {
    due,
    idleForMs,
    ...(due ? { reason: `workspace idle for ${Math.floor(idleForMs / 60_000)} minutes` } : {}),
    desktopViewerSignal,
  };
}

