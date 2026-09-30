/**
 * The `acceptance.soak-24h` release receipt (D-391): one caller of the shared workspace-host
 * release-stage writer (release-stage-receipt.ts, D-394).
 *
 * The stage identity is "bundle B soaked under policy P" — the bundle and the policy only. Which
 * host, incarnation and soak produced the evidence are evidence refs, not identity.
 *
 * A receipt records a driver TRANSITION; it is not the outcome. The outcome is the evaluator over
 * the persisted samples (soak.ts / soak-store.ts), which is what an acceptance reader joins.
 */
import {
  assertWorkspaceHostReleaseStageWritable,
  beginWorkspaceHostReleaseStage,
  settleWorkspaceHostReleaseStage,
  type WorkspaceHostReleaseBinding,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';
import {
  WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE,
  type WorkspaceHostSoakEvaluation,
  type WorkspaceHostSoakPolicy,
  type WorkspaceHostSoakSubject,
} from './soak';

function soakStage(policy: WorkspaceHostSoakPolicy): WorkspaceHostReleaseStage {
  return { stage: WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE, identity: { policy: { ...policy } } };
}

/** Refuse a soak whose receipt could never be written, BEFORE a day is spent sampling. Read-only. */
export async function assertWorkspaceHostSoakReceiptWritable(
  binding: WorkspaceHostReleaseBinding,
  policy: WorkspaceHostSoakPolicy,
): Promise<void> {
  await assertWorkspaceHostReleaseStageWritable(binding, soakStage(policy));
}

/** Record the soak's intent; a pending intent for the same input is adopted (see the shared writer). */
export async function beginWorkspaceHostSoakReceipt(
  binding: WorkspaceHostReleaseBinding,
  policy: WorkspaceHostSoakPolicy,
): Promise<{ requestIdentity: string; adopted: boolean }> {
  return beginWorkspaceHostReleaseStage(binding, soakStage(policy));
}

/** Evidence refs naming exactly which soak, machine and window produced the verdict. */
export function workspaceHostSoakEvidenceRefs(
  subject: WorkspaceHostSoakSubject,
  evaluation: WorkspaceHostSoakEvaluation,
): string[] {
  return [
    `soak:${subject.soakId}`,
    `soak-host:${subject.workspaceId}/${subject.hostId}`,
    `soak-incarnation:${subject.instanceId}`,
    `soak-image:${subject.image}`,
    `soak-window:${evaluation.window.first ?? 'none'}/${evaluation.window.last ?? 'none'}`,
    `soak-samples:${evaluation.samples}/${evaluation.expectedSamples}`,
    `soak-measured:${evaluation.measuredSamples}`,
    `soak-verdict:${evaluation.verdict}`,
    ...evaluation.reasons.slice(0, 8).map((reason) => `soak-reason:${reason.slice(0, 900)}`),
  ];
}

/** Settle the receipt from the evaluator's verdict; a failed soak settles `refused` and stays retryable. */
export async function settleWorkspaceHostSoakReceipt(input: {
  binding: WorkspaceHostReleaseBinding;
  policy: WorkspaceHostSoakPolicy;
  requestIdentity: string;
  subject: WorkspaceHostSoakSubject;
  evaluation: WorkspaceHostSoakEvaluation;
}): Promise<void> {
  await settleWorkspaceHostReleaseStage({
    binding: input.binding,
    stage: soakStage(input.policy),
    requestIdentity: input.requestIdentity,
    outcome: input.evaluation.verdict === 'pass' ? 'committed' : 'refused',
    evidenceRefs: workspaceHostSoakEvidenceRefs(input.subject, input.evaluation),
  });
}
