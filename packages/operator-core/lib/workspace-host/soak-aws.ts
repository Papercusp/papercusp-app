/**
 * Production AWS seams for the workspace-host soak and standing health (P-007 of
 * aws-byoc-gcp-parity-2026-10-01), the counterpart of `soak-gcp.ts`.
 *
 * Both readings are READ-ONLY. The instance read is one EC2 `DescribeInstances` of the instance
 * id the provisioner registered for the host. The reach probe is the same bootstrap-readiness
 * probe GCP uses, carried over the controller's `aws-ssm-ssh` transport (Session Manager, no
 * inbound port) and bound to the PINNED incarnation's host-key alias. Like GCP it enrolls nothing:
 * the soak never calls `establishAwsSsmHostKeyTrust`, so an instance recreated mid-soak fails
 * StrictHostKeyChecking instead of being re-trusted from its new console output.
 *
 * EC2 vocabulary is mapped onto the soak's provider-neutral one: `running` reads as `RUNNING`
 * (the value the compute check and the pin require), and `terminated` reads as ABSENT — EC2 keeps
 * a terminated instance describable for about an hour, but it is gone and cannot come back.
 */
import { isTransientNetworkError } from '../loopback-fetch';
import { AWS_WORKSPACE_HOST_TARGET } from './aws-connection';
import type { AwsInstanceObservation, AwsWorkspaceHostSdkClient } from './aws-provider';
import { AwsWorkspaceHostSdkError } from './aws-sdk-client';
import type { GcpIapWorkspaceHostInitializationCommandRunner } from './gcp-iap-initialization-operations';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  resolveAwsSsmWorkspaceHostInitializationProfile,
  resolveWorkspaceHostInitializationControllerProfile,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import {
  readWorkspaceHostConnection,
  readWorkspaceHostDesiredSpec,
  readWorkspaceHostDestroyTarget,
} from './observability-store';
import type { WorkspaceHostSoakInstanceReading, WorkspaceHostSoakSubject } from './soak';
import {
  buildWorkspaceHostSshSoakProbe,
  defaultSoakSleep,
  retryingWorkspaceHostSoakInstanceRead,
  type WorkspaceHostSoakSeams,
  type WorkspaceHostSoakTiming,
} from './soak-ssh-probe';

export interface AwsWorkspaceHostSoakSeamsInput {
  workspaceId: string;
  hostId: string;
  /** Test seams; production reads the durable host record, the controller env and real EC2. */
  readDesiredSpec?: typeof readWorkspaceHostDesiredSpec;
  readConnection?: typeof readWorkspaceHostConnection;
  readInstanceId?: (workspaceId: string, hostId: string) => Promise<string | null>;
  controller?: WorkspaceHostInitializationControllerProfile;
  awsClient?: Pick<AwsWorkspaceHostSdkClient, 'describeInstance'>;
  runner?: GcpIapWorkspaceHostInitializationCommandRunner;
  timing?: WorkspaceHostSoakTiming;
  now?: () => Date;
}

/** Map one EC2 observation onto the soak's provider-neutral reading. */
export function awsWorkspaceHostSoakReading(
  observation: AwsInstanceObservation | undefined,
): WorkspaceHostSoakInstanceReading {
  if (!observation || observation.state === 'terminated') return { kind: 'absent' };
  return {
    kind: 'observed',
    status: observation.state === 'running' ? 'RUNNING' : observation.state.toUpperCase().replace(/-/g, '_'),
    instanceId: observation.instanceId,
    ...(observation.imageId ? { sourceImage: observation.imageId } : {}),
    // EC2 names a spot instance's request on the instance itself (WI-10005389).
    ...(observation.spotInstanceRequestId ? { preemptible: true } : {}),
  };
}

/** A transport failure, or an SDK error AWS itself marks retryable (throttling, 5xx). */
export function isTransientAwsSoakReadError(error: unknown): boolean {
  if (error instanceof AwsWorkspaceHostSdkError) return error.retryable;
  return isTransientNetworkError(error);
}

/** The EC2 instance id the provisioner registered for a host, or null when none is applied. */
async function readRegisteredAwsInstanceId(workspaceId: string, hostId: string): Promise<string | null> {
  const target = await readWorkspaceHostDestroyTarget(workspaceId, hostId);
  const vm = target?.resources.find(
    (entry) => entry.resource.target === AWS_WORKSPACE_HOST_TARGET && entry.resource.kind === 'vm',
  );
  return vm?.resource.providerId ?? null;
}

export async function resolveAwsWorkspaceHostSoakSeams(
  input: AwsWorkspaceHostSoakSeamsInput,
): Promise<WorkspaceHostSoakSeams> {
  const lookup = await (input.readDesiredSpec ?? readWorkspaceHostDesiredSpec)(input.workspaceId, input.hostId);
  if (!lookup.desired) {
    throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, lookup.miss ?? 'no-recorded-spec');
  }
  const desired = lookup.desired;
  if (desired.target !== AWS_WORKSPACE_HOST_TARGET) {
    throw new UnsupportedWorkspaceHostInitializationTargetError(desired.target);
  }
  const instanceId = await (input.readInstanceId ?? readRegisteredAwsInstanceId)(input.workspaceId, input.hostId);
  if (!instanceId) throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, 'no-recorded-spec');

  // The SSM ProxyCommand's CLI profile and the SDK client both come from the host's own
  // connection; without it there is no credential to read or reach the instance with.
  const stored = lookup.connectionId
    ? await (input.readConnection ?? readWorkspaceHostConnection)(input.workspaceId, lookup.connectionId)
    : null;
  const provider = (stored?.connection.provider ?? {}) as Record<string, unknown>;
  const source = provider.credentialSource as { method?: unknown; profile?: unknown } | undefined;
  const awsProfile =
    source?.method === 'shared-profile' && typeof source.profile === 'string' ? source.profile : undefined;
  let client = input.awsClient;
  if (!client) {
    if (!stored) throw new Error('aws_workspace_host_connection_missing');
    client = (await import('./aws-connection-inspection')).createConfiguredAwsWorkspaceHostClient(stored.connection);
  }
  const awsClient = client;
  const now = input.now ?? (() => new Date());

  const readInstance = retryingWorkspaceHostSoakInstanceRead(
    async () => awsWorkspaceHostSoakReading(await awsClient.describeInstance(instanceId)),
    { isTransient: isTransientAwsSoakReadError, sleep: defaultSoakSleep(input.timing) },
  );

  const probeFor = (subject: WorkspaceHostSoakSubject) =>
    buildWorkspaceHostSshSoakProbe({
      subject,
      profile: resolveAwsSsmWorkspaceHostInitializationProfile(
        desired,
        input.controller ?? resolveWorkspaceHostInitializationControllerProfile(),
        { instanceId: subject.instanceId, ...(awsProfile ? { awsProfile } : {}) },
      ),
      readInstance,
      now,
      ...(input.runner ? { runner: input.runner } : {}),
      ...(input.timing ? { timing: input.timing } : {}),
    });

  return { desired, readInstance, probeFor };
}
