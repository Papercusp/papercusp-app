/**
 * Standing workspace policy for unattended Attention resolution (P-006).
 *
 * This is the durable source of truth. A bulk run copies it into the run's
 * `automationPolicy` receipt at launch; the receipt explains what that run
 * used, but it is never edited to configure the next run.
 */
import { readOperatorState, writeOperatorState } from '../operator-state-pg';
import { activeWorkspaceId } from '../workspace-registry';
import { registerOverrideConcern, type OverrideEntry } from '../config-overrides/registry';
import { delegationFor } from './terminal-coverage';
import {
  DEFAULT_STANDING_BULK_AUTOMATION_POLICY,
  isBulkAutomationLevel,
  isBulkConfidence,
  meetsBulkConfidenceFloor,
  normalizeStandingBulkAutomationPolicy,
  type BulkConfidence,
  type StandingBulkAutomationPolicy,
} from './bulk-dispositions';

const STORE = 'operator_attention_automation_policy' as const;

export type StandingAutomationRefusal =
  | 'review-all'
  | 'unknown-kind'
  | 'never-auto'
  | 'owner-by-right'
  | 'confidence-missing'
  | 'confidence-below-floor';

export interface StandingAutomationEligibility {
  allowed: boolean;
  reason: StandingAutomationRefusal | null;
}

/**
 * Compose the two independent axes with P-005's canonical delegation map.
 * Authority never comes from confidence and confidence never comes from level.
 */
export function standingAutomationEligibility(
  policy: StandingBulkAutomationPolicy,
  kind: string,
  confidence: BulkConfidence | null | undefined,
): StandingAutomationEligibility {
  const authority = delegationFor(kind);
  if (authority == null) return { allowed: false, reason: 'unknown-kind' };
  if (authority === 'never-auto') return { allowed: false, reason: 'never-auto' };
  if (policy.level === 'L0') return { allowed: false, reason: 'review-all' };
  if (authority === 'owner-by-right' && policy.level !== 'L2') {
    return { allowed: false, reason: 'owner-by-right' };
  }
  if (confidence == null) return { allowed: false, reason: 'confidence-missing' };
  if (!meetsBulkConfidenceFloor(confidence, policy.minConfidence)) {
    return { allowed: false, reason: 'confidence-below-floor' };
  }
  return { allowed: true, reason: null };
}

/** Missing/unreadable storage fails closed to L0 review-all. */
export async function readStandingBulkAutomationPolicy(
  workspaceId: string = activeWorkspaceId(),
): Promise<StandingBulkAutomationPolicy> {
  try {
    const stored = await readOperatorState<Partial<StandingBulkAutomationPolicy>>(STORE, workspaceId);
    return normalizeStandingBulkAutomationPolicy(stored);
  } catch {
    return { ...DEFAULT_STANDING_BULK_AUTOMATION_POLICY };
  }
}

/** Strict partial write: malformed policy values are refused, never defaulted. */
export async function writeStandingBulkAutomationPolicy(
  patch: Partial<StandingBulkAutomationPolicy>,
  workspaceId: string = activeWorkspaceId(),
): Promise<StandingBulkAutomationPolicy> {
  if (patch.level !== undefined && !isBulkAutomationLevel(patch.level)) {
    throw new Error(`invalid attention automation level ${JSON.stringify(patch.level)}`);
  }
  if (patch.minConfidence !== undefined && !isBulkConfidence(patch.minConfidence)) {
    throw new Error(`invalid attention confidence floor ${JSON.stringify(patch.minConfidence)}`);
  }
  const next = { ...(await readStandingBulkAutomationPolicy(workspaceId)), ...patch };
  await writeOperatorState<StandingBulkAutomationPolicy>(STORE, next, workspaceId);
  return next;
}

export async function resetStandingBulkAutomationPolicy(
  workspaceId: string = activeWorkspaceId(),
): Promise<StandingBulkAutomationPolicy> {
  const next = { ...DEFAULT_STANDING_BULK_AUTOMATION_POLICY };
  await writeOperatorState<StandingBulkAutomationPolicy>(STORE, next, workspaceId);
  return next;
}

registerOverrideConcern({
  name: 'attention-automation-policy',
  description: 'standing inbox automation level and confidence floor',
  auditAction: 'inbox:automation-policy',
  diff: async () => {
    const policy = await readStandingBulkAutomationPolicy();
    const entries: OverrideEntry[] = [];
    for (const key of ['level', 'minConfidence'] as const) {
      if (policy[key] !== DEFAULT_STANDING_BULK_AUTOMATION_POLICY[key]) {
        entries.push({
          key,
          effective: policy[key],
          default: DEFAULT_STANDING_BULK_AUTOMATION_POLICY[key],
          layer: 'pg-settings',
        });
      }
    }
    return entries;
  },
  capture: () => readStandingBulkAutomationPolicy(),
  reset: () => resetStandingBulkAutomationPolicy(),
  restore: (snapshot) =>
    writeStandingBulkAutomationPolicy(snapshot as StandingBulkAutomationPolicy).then(() => {}),
});
