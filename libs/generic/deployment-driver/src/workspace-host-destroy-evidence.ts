import {
  WORKSPACE_HOST_CREDENTIAL_CHANNELS,
  validateWorkspaceHostInitializationCanary,
  type WorkspaceHostCredentialChannel,
  type WorkspaceHostInitializationCanaryEvidence,
} from "./workspace-host-initialization";
import type { WorkspaceHostDestroyConfirmation } from "./workspace-host-types";
import type {
  WorkspaceHostCanaryCostEvidence,
  WorkspaceHostCanaryOrphanCensus,
  WorkspaceHostContractApproval,
  WorkspaceHostFailedRunTeardown,
  WorkspaceHostSpendSettlement,
} from "./workspace-host-test-harness";

interface WorkspaceHostDestroyCanaryEvidenceContractBase {
  runId: string;
  workspaceId: string;
  maxSpendCents?: number;
  teardownDeadlineAt: string;
  budgetEvidenceRef: string;
  preRunZeroBaseline: WorkspaceHostCanaryCostEvidence;
  costEvidence: readonly WorkspaceHostCanaryCostEvidence[];
  lateObservedSpend?: readonly WorkspaceHostCanaryCostEvidence[];
  /**
   * SETTLEMENT (D-274), orthogonal to the authorization below. Absent means the provider's billing
   * has settled and both cost fields above must be populated; present means it has not, so they may
   * be empty and a dated reconciliation obligation is recorded instead.
   */
  spendSettlement?: WorkspaceHostSpendSettlement;
}

/**
 * Structurally matches the operator destroy route's external-evidence input.
 *
 * Authorization follows the ledger's: an approved contract report for a run that completed, or an
 * audited failed-run teardown for one that did not. Only the economic evidence differs between the
 * two; the identity evidence the adapter validates below is required either way.
 */
export type WorkspaceHostDestroyCanaryEvidenceContract =
  | (WorkspaceHostDestroyCanaryEvidenceContractBase & {
      contractApproval: WorkspaceHostContractApproval;
      failedRunTeardown?: undefined;
    })
  | (WorkspaceHostDestroyCanaryEvidenceContractBase & {
      contractApproval?: undefined;
      failedRunTeardown: WorkspaceHostFailedRunTeardown;
    });

export interface WorkspaceHostCredentialTeardownObservation {
  channel: WorkspaceHostCredentialChannel;
  previousBindingRevoked: boolean;
  credentialReferenceExcluded: boolean;
}

export interface WorkspaceHostDestroyOperationObservation {
  operationId: string;
  workspaceId: string;
  hostId: string;
  startedAt: string;
  observedAt: string;
  confirmations: readonly WorkspaceHostDestroyConfirmation[];
  orphanCensus: WorkspaceHostCanaryOrphanCensus;
}

export interface AdaptWorkspaceHostDestroyEvidenceInput {
  expected: {
    runId: string;
    workspaceId: string;
    hostId: string;
    operationId: string;
  };
  initialization: WorkspaceHostInitializationCanaryEvidence;
  credentialTeardown: readonly WorkspaceHostCredentialTeardownObservation[];
  teardown: WorkspaceHostDestroyOperationObservation;
  destroyEvidence: WorkspaceHostDestroyCanaryEvidenceContract;
}

export class WorkspaceHostDestroyEvidenceError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Workspace-host destroy evidence is not usable: ${problems.join("; ")}`,
    );
    this.name = "WorkspaceHostDestroyEvidenceError";
    this.problems = problems;
  }
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * Bind validated initialization/lifecycle proof to independently observed teardown evidence.
 * This adapter only validates and projects caller-supplied evidence; it never creates an
 * absence confirmation, an orphan-census result, or a successful credential observation.
 */
export function adaptWorkspaceHostDestroyCanaryEvidence(
  input: AdaptWorkspaceHostDestroyEvidenceInput,
): WorkspaceHostDestroyCanaryEvidenceContract {
  const problems = [
    ...validateWorkspaceHostInitializationCanary(input.initialization).errors,
  ];
  const { expected, initialization, teardown, destroyEvidence } = input;

  if (initialization.runId !== expected.runId)
    problems.push("initialization runId does not match expected run");
  if (initialization.workspaceId !== expected.workspaceId)
    problems.push(
      "initialization workspaceId does not match expected workspace",
    );
  if (initialization.hostId !== expected.hostId)
    problems.push("initialization hostId does not match expected host");
  if (teardown.operationId !== expected.operationId)
    problems.push("teardown operationId does not match expected operation");
  if (teardown.workspaceId !== expected.workspaceId)
    problems.push("teardown workspaceId does not match expected workspace");
  if (teardown.hostId !== expected.hostId)
    problems.push("teardown hostId does not match expected host");
  if (destroyEvidence.runId !== expected.runId)
    problems.push("destroy runId does not match expected run");
  if (destroyEvidence.workspaceId !== expected.workspaceId)
    problems.push("destroy workspaceId does not match expected workspace");

  if (!isTimestamp(teardown.startedAt) || !isTimestamp(teardown.observedAt)) {
    problems.push("teardown operation timestamps must be valid ISO timestamps");
  } else if (Date.parse(teardown.observedAt) < Date.parse(teardown.startedAt)) {
    problems.push("teardown observation predates the operation");
  }

  const channelObservations = new Map(
    input.credentialTeardown.map(
      (observation) => [observation.channel, observation] as const,
    ),
  );
  if (channelObservations.size !== input.credentialTeardown.length)
    problems.push(
      "credential teardown contains duplicate channel observations",
    );
  for (const channel of WORKSPACE_HOST_CREDENTIAL_CHANNELS) {
    const observation = channelObservations.get(channel);
    if (
      !observation?.previousBindingRevoked ||
      !observation.credentialReferenceExcluded
    )
      problems.push(`${channel} credential teardown is incomplete`);
  }

  if (teardown.confirmations.length === 0)
    problems.push("provider absence confirmations are missing");
  for (const confirmation of teardown.confirmations) {
    if (confirmation.hostId !== expected.hostId)
      problems.push(
        `provider absence confirmation for '${confirmation.providerResourceId}' has the wrong host`,
      );
    if (confirmation.source !== "provider-read")
      problems.push(
        `provider absence confirmation for '${confirmation.providerResourceId}' is not provider-read`,
      );
    if (!isTimestamp(confirmation.confirmedAbsentAt))
      problems.push(
        `provider absence confirmation for '${confirmation.providerResourceId}' has an invalid timestamp`,
      );
    else if (
      isTimestamp(teardown.startedAt) &&
      Date.parse(confirmation.confirmedAbsentAt) <
        Date.parse(teardown.startedAt)
    )
      problems.push(
        `provider absence confirmation for '${confirmation.providerResourceId}' predates the operation`,
      );
  }

  const census = teardown.orphanCensus;
  if (
    !census.clean ||
    census.observedTagged.length > 0 ||
    census.untracked.length > 0 ||
    census.stillLive.length > 0 ||
    census.missingWithoutReceipt.length > 0
  ) {
    problems.push("provider teardown orphan census is not clean");
  }

  if (problems.length > 0)
    throw new WorkspaceHostDestroyEvidenceError(problems);
  return { ...destroyEvidence };
}
