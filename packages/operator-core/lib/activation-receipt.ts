import type { CheckEntry } from './carry-note';

export const ACTIVATION_RECEIPT_VERSION = 1 as const;
export const ACTIVATION_RECEIPT_CHECK_PREFIX = 'activation-receipt:v1:';

export type ActivationReceiptState = 'committed' | 'loaded' | 'verifying' | 'verified' | 'failed';

export type ActivationRuntime =
  | 'operator-release'
  | 'operator-staging'
  | 'bg-host'
  | 'inference-gateway'
  | 'embed-sidecar';

export interface RuntimeIdentity {
  kind: 'git-sha' | 'content-hash' | 'build-id';
  value: string;
}

export interface ActivationBlocker {
  kind: 'critical-job' | 'resource-lock' | 'runtime-unhealthy' | 'custom';
  ref: string;
  detail?: string;
}

export interface ActivationProbe {
  tool: string;
  args: Record<string, unknown>;
  expected: string;
}

export interface ActivationReceipt {
  version: typeof ACTIVATION_RECEIPT_VERSION;
  id: string;
  workItemId: string;
  runtime: ActivationRuntime;
  expectedIdentity: RuntimeIdentity;
  observedIdentity?: RuntimeIdentity;
  blockers: ActivationBlocker[];
  probe: ActivationProbe;
  state: ActivationReceiptState;
  failure?: string;
  evidence?: string;
  updatedAtMs: number;
}

export type ActivationEligibilityState = 'ready' | 'queued';

export interface ActivationRestartAuthority {
  /** The existing coordinated restart tool/verb that owns this runtime. */
  tool: string;
  args: Record<string, unknown>;
}

export interface ActivationEligibility {
  state: ActivationEligibilityState;
  blockers: ActivationBlocker[];
  restart: ActivationRestartAuthority;
  /** Existing event-plane seam: queued callers await this exact key. */
  readyEvent: string;
  reason?: string;
}

export interface ActivationProbeResult {
  passed: boolean;
  evidence: string;
  failure?: string;
}

export interface ActivationProbeExecutor {
  /** Compare-and-set persistence. False means another caller won the transition. */
  persist(next: ActivationReceipt, expectedState: ActivationReceiptState): Promise<boolean>;
  invoke(probe: ActivationProbe): Promise<ActivationProbeResult>;
  nowMs?: () => number;
}

export interface ActivationProbeExecution {
  executed: boolean;
  receipt: ActivationReceipt;
  reason?: 'identity-mismatch' | 'already-claimed' | 'terminal';
}

/**
 * Stable event key for the transition from queued to restart-eligible. Keeping
 * the receipt id in the key makes repeated evaluation idempotent: clearing a
 * blocker emits the same key that the original queued caller registered.
 */
export function activationReadyEvent(receiptId: string): string {
  return `activation:ready:${receiptId}`;
}

/**
 * Compose activation eligibility without bypassing the existing restart tool.
 * Any declared blocker queues the receipt; a critical job is always a blocker,
 * even if a stale caller omitted it from the receipt it persisted.
 */
export function evaluateActivationEligibility(
  receipt: ActivationReceipt,
  restart: ActivationRestartAuthority,
  activeCriticalJob?: ActivationBlocker,
): ActivationEligibility {
  const blockers = [...receipt.blockers];
  if (activeCriticalJob && !blockers.some((blocker) => blocker.kind === 'critical-job' && blocker.ref === activeCriticalJob.ref)) {
    blockers.push(activeCriticalJob);
  }
  const readyEvent = activationReadyEvent(receipt.id);
  if (blockers.length > 0) {
    return {
      state: 'queued',
      blockers,
      restart,
      readyEvent,
      reason: blockers.map((blocker) => `${blocker.kind}:${blocker.ref}`).join(', '),
    };
  }
  return { state: 'ready', blockers: [], restart, readyEvent };
}

/**
 * Claim and execute a receipt's declared probe exactly once. The compare-and-set
 * `loaded -> verifying` write is the durable concurrency boundary: only its
 * winner invokes the tool. Retries observe `verifying` or a terminal state and
 * return without duplicating the side effect.
 */
export async function executeActivationProbeOnce(
  receipt: ActivationReceipt,
  executor: ActivationProbeExecutor,
): Promise<ActivationProbeExecution> {
  if (receipt.state === 'verified' || receipt.state === 'failed') {
    return { executed: false, receipt, reason: 'terminal' };
  }
  if (receipt.state === 'verifying') {
    return { executed: false, receipt, reason: 'already-claimed' };
  }
  if (receipt.state !== 'loaded' || !identitiesMatch(receipt.expectedIdentity, receipt.observedIdentity)) {
    return { executed: false, receipt, reason: 'identity-mismatch' };
  }

  const now = executor.nowMs ?? Date.now;
  const verifying: ActivationReceipt = { ...receipt, state: 'verifying', updatedAtMs: now() };
  if (!(await executor.persist(verifying, 'loaded'))) {
    return { executed: false, receipt, reason: 'already-claimed' };
  }

  try {
    const result = await executor.invoke(receipt.probe);
    const terminal: ActivationReceipt = result.passed
      ? { ...verifying, state: 'verified', evidence: result.evidence, updatedAtMs: now() }
      : {
          ...verifying,
          state: 'failed',
          evidence: result.evidence,
          failure: result.failure?.trim() || 'verification probe did not satisfy its expected result',
          updatedAtMs: now(),
        };
    await executor.persist(terminal, 'verifying');
    return { executed: true, receipt: terminal };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const terminal: ActivationReceipt = {
      ...verifying,
      state: 'failed',
      failure,
      evidence: `probe threw: ${failure}`,
      updatedAtMs: now(),
    };
    await executor.persist(terminal, 'verifying');
    return { executed: true, receipt: terminal };
  }
}

export function identitiesMatch(expected: RuntimeIdentity, observed: RuntimeIdentity | undefined): boolean {
  return observed !== undefined && expected.kind === observed.kind && expected.value === observed.value;
}

export function validateActivationReceipt(receipt: ActivationReceipt): string[] {
  const errors: string[] = [];
  if (!receipt.id.trim()) errors.push('id is required');
  if (!receipt.workItemId.trim()) errors.push('workItemId is required');
  if (!receipt.expectedIdentity.value.trim()) errors.push('expectedIdentity.value is required');
  if (!receipt.probe.tool.trim()) errors.push('probe.tool is required');
  if (!receipt.probe.expected.trim()) errors.push('probe.expected is required');
  if ((receipt.state === 'loaded' || receipt.state === 'verifying' || receipt.state === 'verified') && !identitiesMatch(receipt.expectedIdentity, receipt.observedIdentity)) {
    errors.push(`${receipt.state} requires observedIdentity to match expectedIdentity`);
  }
  if (receipt.state === 'verified' && !receipt.evidence?.trim()) errors.push('verified requires evidence');
  if (receipt.state === 'failed' && !receipt.failure?.trim()) errors.push('failed requires failure');
  return errors;
}

export function activationReceiptToCheck(receipt: ActivationReceipt): CheckEntry {
  const errors = validateActivationReceipt(receipt);
  if (errors.length) throw new Error(`invalid activation receipt: ${errors.join('; ')}`);
  const encoded = Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');
  return {
    id: `activation:${receipt.id}`,
    claim: `${ACTIVATION_RECEIPT_CHECK_PREFIX}${encoded}`,
    recheck: `${receipt.probe.tool} ${JSON.stringify(receipt.probe.args)}`,
    ...(receipt.state === 'verified' ? { verified: receipt.evidence } : {}),
    sinceMs: receipt.updatedAtMs,
  };
}

export function activationReceiptFromCheck(check: CheckEntry): ActivationReceipt | null {
  if (!check.claim.startsWith(ACTIVATION_RECEIPT_CHECK_PREFIX)) return null;
  try {
    const decoded = Buffer.from(check.claim.slice(ACTIVATION_RECEIPT_CHECK_PREFIX.length), 'base64url').toString('utf8');
    const receipt = JSON.parse(decoded) as ActivationReceipt;
    if (receipt.version !== ACTIVATION_RECEIPT_VERSION || validateActivationReceipt(receipt).length) return null;
    return receipt;
  } catch {
    return null;
  }
}
