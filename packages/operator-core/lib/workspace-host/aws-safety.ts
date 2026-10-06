/**
 * AWS workspace-host managed-resource census (aws-byoc-gcp-parity-2026-10-01 P-003).
 *
 * The census reconciliation itself is provider-neutral and lives in `gcp-safety.ts`
 * (`censusManagedWorkspaceHostResources`); this module supplies the AWS profile: which kinds a
 * complete AWS inventory must cover, and the EC2 tag keys that carry Papercusp's managed identity.
 *
 * AWS has no deterministic-name kinds: every resource the AWS provider creates (EC2 instance, EBS
 * volume, EBS snapshot) carries the three managed tags, so each kind is enumerated by tag filter.
 *
 * P-007 adds AWS ambiguous-operation recovery over the same shared rules
 * (`createManagedWorkspaceHostAmbiguousOperationRecoveryRecord`), keyed by the AWS tag identity.
 */
import {
  censusManagedWorkspaceHostResources,
  createManagedWorkspaceHostAmbiguousOperationRecoveryRecord,
  type ManagedWorkspaceHostResourceObservation,
  type WorkspaceHostAmbiguousOperationRecoveryInput,
  type WorkspaceHostAmbiguousOperationRecoveryProfile,
  type WorkspaceHostAmbiguousOperationRecoveryRecord,
  type WorkspaceHostCensusProfile,
  type WorkspaceHostInventoryEvidence,
  type WorkspaceHostResourceCensus,
  type WorkspaceHostResourceCensusInput,
} from './gcp-safety';

/** EC2 tag keys stamped on every AWS resource the provider creates. AWS tag values are verbatim. */
export const AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS = {
  managed: 'papercusp:managed',
  hostId: 'papercusp:host-id',
  workspaceId: 'papercusp:workspace-id',
} as const;

/**
 * `spot-request` (WI-10005454): a spot host is launched by a PERSISTENT spot request tagged with the
 * host's managed tags. While that request is open it relaunches the host after a terminate, so a
 * teardown is only proven clean once the census also reads no live request for the host. Only live
 * requests (open, active, disabled) are enumerated; a cancelled, closed or failed one cannot launch
 * anything and is absent, the same way a terminated instance is.
 */
export const AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS = ['vm', 'disk', 'snapshot', 'spot-request'] as const;
export type AwsWorkspaceHostCensusResourceKind = (typeof AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS)[number];

export const AWS_WORKSPACE_HOST_CENSUS_PROFILE: WorkspaceHostCensusProfile<AwsWorkspaceHostCensusResourceKind> = {
  target: 'aws',
  providerLabel: 'AWS',
  kinds: AWS_WORKSPACE_HOST_CENSUS_RESOURCE_KINDS,
  deterministicKinds: new Set<AwsWorkspaceHostCensusResourceKind>(),
  managedLabelKeys: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS,
  labelValue: (value) => value,
};

/**
 * A controller-independent inventory request. It is the same shape the provisioning runner
 * builds for every provider: `projectId` is the scope the census runs in, which for AWS is the
 * account id. GCP-only fields (deterministic network names) are accepted and ignored.
 */
export interface AwsWorkspaceHostInventoryRequest {
  projectId: string;
  region: string;
  workspaceId: string;
}

export interface AwsWorkspaceHostInventorySnapshot {
  complete: true;
  observed: readonly ManagedWorkspaceHostResourceObservation[];
  inventoryEvidence: readonly WorkspaceHostInventoryEvidence<AwsWorkspaceHostCensusResourceKind>[];
}

export type AwsWorkspaceHostResourceCensusInput = WorkspaceHostResourceCensusInput<AwsWorkspaceHostCensusResourceKind>;
export type AwsWorkspaceHostResourceCensus = WorkspaceHostResourceCensus<AwsWorkspaceHostCensusResourceKind>;

export function censusAwsWorkspaceHostResources(input: AwsWorkspaceHostResourceCensusInput): AwsWorkspaceHostResourceCensus {
  return censusManagedWorkspaceHostResources(input, AWS_WORKSPACE_HOST_CENSUS_PROFILE);
}

export const AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF =
  'runbook://workspace-host/aws/ambiguous-operation-recovery-v1';

/**
 * How an operator settles an EC2 call whose outcome is unknown (timeout, dropped connection).
 * Every step names a mechanism the AWS client actually has: RunInstances and CreateVolume reuse the
 * caller's ClientToken, CreateSnapshot (which has none) is found by its `papercusp:client-token` tag.
 */
export const AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK = {
  ref: AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
  steps: [
    'Find the resource by the original ClientToken (find*ByClientToken reads the papercusp:client-token tag); do not issue an uncorrelated retry with a new token.',
    'Read the resource directly from EC2 by id (DescribeInstances / DescribeVolumes / DescribeSnapshots) and verify its exact papercusp:* managed tags.',
    'Map EC2 state onto the neutral vocabulary (running, stopped; terminated or not-found reads as absent) and record it with the EC2 request id as provider evidence.',
    'Close the durable step only when the fresh observed state proves the attempted action completed.',
    'Otherwise resume reconciliation with the original operation id and the same ClientToken.',
  ],
} as const;

export type AwsWorkspaceHostAmbiguousOperationRecoveryRecord = WorkspaceHostAmbiguousOperationRecoveryRecord<
  'aws-workspace-host-ambiguous-operation-recovery',
  typeof AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF
>;

const AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RECOVERY_PROFILE: WorkspaceHostAmbiguousOperationRecoveryProfile<
  'aws-workspace-host-ambiguous-operation-recovery',
  typeof AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF
> = {
  census: AWS_WORKSPACE_HOST_CENSUS_PROFILE,
  kind: 'aws-workspace-host-ambiguous-operation-recovery',
  runbookRef: AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RUNBOOK_REF,
};

/** Produce the only typed evidence that may manually close an ambiguous AWS operation. */
export function createAwsWorkspaceHostAmbiguousOperationRecoveryRecord(
  input: WorkspaceHostAmbiguousOperationRecoveryInput,
): AwsWorkspaceHostAmbiguousOperationRecoveryRecord {
  return createManagedWorkspaceHostAmbiguousOperationRecoveryRecord(
    input,
    AWS_WORKSPACE_HOST_AMBIGUOUS_OPERATION_RECOVERY_PROFILE,
  );
}

/** EC2 `Filters` that select one workspace's Papercusp-managed resources. */
export function awsWorkspaceHostManagedFilters(workspaceId: string): { Name: string; Values: string[] }[] {
  return [
    { Name: `tag:${AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed}`, Values: ['true'] },
    { Name: `tag:${AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId}`, Values: [workspaceId] },
  ];
}
