/**
 * The `workspace.root-bootstrap` and `workspace.fixed-agent-initialization` release receipts (R-5,
 * WI-10002510): callers of the shared workspace-host release-stage writer (release-stage-receipt.ts,
 * D-394), recorded by the one run that OBSERVES both outcomes — workspace-host initialization.
 *
 * - Root bootstrap: the controller-authored bootstrap reached readiness. The initialization runner's
 *   bootstrap gate saw the remote-initializer conduit that bootstrap installs last (WI-10001677).
 * - Fixed-agent initialization: the run's `verify-initialization` step reported EVERY requested agent
 *   ready through the credentials it delivered. The stage identity names that agent set and the
 *   credential channels, so a receipt can never claim an agent nobody verified; whether the set
 *   satisfies D-338 (only funded direct-Codex skipped) is the grader's reading of that identity.
 *
 * Which host and initialization produced the evidence are evidence refs, not identity; the shared
 * recorder (release-stage-receipt.ts) names the initialization operation on every settle.
 */
import {
  resolveWorkspaceHostRequestedAgents,
  type WorkspaceHostBootstrapReadinessResult,
  type WorkspaceHostInitializationPlan,
  type WorkspaceHostInitializationStepReceipt,
} from '@papercusp/deployment-driver';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import type { WorkspaceHostAgentCredentialAdmissionEvidence } from './agent-credential-admission';
import {
  WorkspaceHostReleaseBindingError,
  openWorkspaceHostReleaseRecorder,
  type WorkspaceHostReleaseRecorder,
  type WorkspaceHostReleaseStage,
} from './release-stage-receipt';

export const WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE = 'workspace.root-bootstrap';
export const WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE = 'workspace.fixed-agent-initialization';

export type WorkspaceHostInitializationReleaseSlot = 'root-bootstrap' | 'fixed-agents';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function workspaceHostRootBootstrapStage(): WorkspaceHostReleaseStage {
  return { stage: WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE, identity: { readiness: 'remote-initializer-conduit' } };
}

/** The stage the plan that actually runs can prove: its verify step's agents and credential channels. */
export function workspaceHostFixedAgentInitializationStage(
  plan: WorkspaceHostInitializationPlan,
): WorkspaceHostReleaseStage {
  const verify = plan.steps.find((step) => step.kind === 'verify-initialization');
  if (!verify) {
    throw new WorkspaceHostReleaseBindingError(
      'stage-unobservable',
      WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
      'the initialization plan has no verify-initialization step',
    );
  }
  const channels = Array.isArray(verify.input.requiredChannels)
    ? verify.input.requiredChannels.filter((channel): channel is string => typeof channel === 'string')
    : [];
  return {
    stage: WORKSPACE_HOST_FIXED_AGENT_INITIALIZATION_STAGE,
    identity: {
      agents: [...resolveWorkspaceHostRequestedAgents(verify.input.requestedAgents)],
      channels: [...channels].sort(),
    },
  };
}

export function workspaceHostRootBootstrapEvidenceRefs(
  subject: { workspaceId: string; hostId: string },
  readiness: WorkspaceHostBootstrapReadinessResult,
): string[] {
  return [
    `bootstrap-host:${subject.workspaceId}/${subject.hostId}`,
    `bootstrap-probes:${readiness.probes}`,
    `bootstrap-waited-ms:${Math.round(readiness.waitedMs)}`,
    `bootstrap-ready-immediately:${readiness.readyImmediately}`,
  ];
}

/**
 * Judge the fixed-agent stage from the verify step's OWN evidence, never from "nothing threw": the
 * receipt says every agent on its identity was observed ready, so each one must be.
 */
export function workspaceHostFixedAgentInitializationOutcome(input: {
  subject: { workspaceId: string; hostId: string };
  stage: WorkspaceHostReleaseStage;
  receipts: readonly WorkspaceHostInitializationStepReceipt[];
  credentialAdmissions?: readonly WorkspaceHostAgentCredentialAdmissionEvidence[];
}): { outcome: 'committed' | 'refused'; evidenceRefs: string[] } {
  const agents = Array.isArray(input.stage.identity.agents) ? (input.stage.identity.agents as string[]) : [];
  const verify = input.receipts.find((receipt) => receipt.stepId === 'verify');
  const reported = record(record(verify?.publicEvidence)?.agents);
  const evidenceRefs = [
    `initialize-host:${input.subject.workspaceId}/${input.subject.hostId}`,
    `initialize-steps:${input.receipts.length}`,
  ];
  const contract = record(verify?.publicEvidence)?.agentContractVersion;
  if (typeof contract === 'string') evidenceRefs.push(`initialize-agent-contract:${contract}`);
  let allReady = agents.length > 0;
  for (const agent of agents) {
    const evidence = record(reported?.[agent]);
    const ready = evidence?.ready === true;
    allReady &&= ready;
    const kind = typeof evidence?.verificationKind === 'string' ? evidence.verificationKind : 'unreported';
    evidenceRefs.push(`initialize-agent:${agent}:${ready ? 'ready' : 'unready'}:${kind}`);
    if (ready && typeof evidence?.proofDigest === 'string') {
      evidenceRefs.push(`initialize-agent-proof:${agent}:${evidence.proofDigest}`);
    }
  }
  for (const admission of input.credentialAdmissions ?? []) {
    evidenceRefs.push(`credential-admission:${admission.binding.family}:${admission.binding.generation}`);
  }
  return { outcome: allReady ? 'committed' : 'refused', evidenceRefs };
}

export type WorkspaceHostInitializationReleaseRecorder = WorkspaceHostReleaseRecorder<WorkspaceHostInitializationReleaseSlot>;

/** Both R-5 stages, opened read-only before the run touches anything; `root-bootstrap` first. */
export function openWorkspaceHostInitializationRelease(input: {
  releaseTaskId: string;
  workspaceId: string;
  hostId: string;
  operationId: string;
  plan: WorkspaceHostInitializationPlan;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
}): Promise<WorkspaceHostInitializationReleaseRecorder> {
  const { operationId, plan, ...rest } = input;
  return openWorkspaceHostReleaseRecorder<WorkspaceHostInitializationReleaseSlot>({
    ...rest,
    stages: {
      'root-bootstrap': workspaceHostRootBootstrapStage(),
      'fixed-agents': workspaceHostFixedAgentInitializationStage(plan),
    },
    runRef: `initialize-operation:${operationId}`,
  });
}
