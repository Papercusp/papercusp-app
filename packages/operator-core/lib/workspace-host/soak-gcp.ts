/**
 * Production GCP seams for the workspace-host soak (D-391).
 *
 * Both readings are READ-ONLY. The instance read is one Compute `instances.get`. The reach probe
 * is the WI-10002499 bootstrap-readiness probe (`test -x <conduit>`) over the controller's own IAP
 * SSH transport, bound to the PINNED incarnation's host-key alias and — unlike initialization — it
 * enrolls nothing, so a machine recreated mid-soak fails StrictHostKeyChecking instead of being
 * quietly re-trusted. A quiesced snapshot is never used as a probe: it stops the VM for ~75s
 * (EI-24005526609432424). The cloud-neutral probe half lives in `soak-ssh-probe.ts`, shared with
 * `soak-aws.ts`.
 */
import { isTransientNetworkError } from '../loopback-fetch';
import type { GcpIapWorkspaceHostInitializationCommandRunner } from './gcp-iap-initialization-operations';
import { resolveGcpWorkspaceHostInstanceIdentity, type GcpWorkspaceHostApiClient } from './gcp-provider';
import { isHostedProviderCredentialRef, resolveHostedGcpAuth } from './hosted-gcp-auth';
import {
  WorkspaceHostDesiredSpecUnavailableError,
  createGcpWorkspaceHostApiClientForDesired,
  resolveGcpIapWorkspaceHostInitializationProfile,
  resolveWorkspaceHostInitializationControllerProfile,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import { readWorkspaceHostConnection, readWorkspaceHostDesiredSpec } from './observability-store';
import type { WorkspaceHostSoakInstanceReading, WorkspaceHostSoakSubject } from './soak';
import {
  buildWorkspaceHostSshSoakProbe,
  defaultSoakSleep,
  retryingWorkspaceHostSoakInstanceRead,
  type WorkspaceHostSoakSeams,
  type WorkspaceHostSoakTiming,
} from './soak-ssh-probe';

export interface GcpWorkspaceHostSoakSeamsInput {
  workspaceId: string;
  hostId: string;
  /** Test seams; production reads the durable host record, the controller env and real Compute. */
  readDesiredSpec?: typeof readWorkspaceHostDesiredSpec;
  readConnection?: typeof readWorkspaceHostConnection;
  controller?: WorkspaceHostInitializationControllerProfile;
  gcpClient?: Pick<GcpWorkspaceHostApiClient, 'getInstance'>;
  resolveHostedAuth?: typeof resolveHostedGcpAuth;
  gcpFetch?: typeof fetch;
  runner?: GcpIapWorkspaceHostInitializationCommandRunner;
  timing?: WorkspaceHostSoakTiming;
  now?: () => Date;
}

export async function resolveGcpWorkspaceHostSoakSeams(
  input: GcpWorkspaceHostSoakSeamsInput,
): Promise<WorkspaceHostSoakSeams> {
  const lookup = await (input.readDesiredSpec ?? readWorkspaceHostDesiredSpec)(input.workspaceId, input.hostId);
  if (!lookup.desired) {
    throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, lookup.miss ?? 'no-recorded-spec');
  }
  const desired = lookup.desired;
  const identity = resolveGcpWorkspaceHostInstanceIdentity(desired);
  let connectionProvider: Readonly<Record<string, unknown>> | undefined;
  if (!input.gcpClient && isHostedProviderCredentialRef(desired.credentials.cloudCredentialRef.ref)) {
    const stored = lookup.connectionId
      ? await (input.readConnection ?? readWorkspaceHostConnection)(input.workspaceId, lookup.connectionId)
      : null;
    if (!stored) throw new Error('gcp_workspace_host_hosted_connection_missing');
    connectionProvider = stored.connection.provider ?? {};
  }
  const client = input.gcpClient ?? createGcpWorkspaceHostApiClientForDesired(desired, {
    ...(connectionProvider ? { connectionProvider } : {}),
    ...(input.resolveHostedAuth ? { resolveHostedAuth: input.resolveHostedAuth } : {}),
    ...(input.gcpFetch ? { gcpFetch: input.gcpFetch } : {}),
  });
  const now = input.now ?? (() => new Date());

  const readInstance = retryingWorkspaceHostSoakInstanceRead(
    async (): Promise<WorkspaceHostSoakInstanceReading> => {
      const instance = await client.getInstance(identity.projectId, identity.zone, identity.instanceName);
      if (!instance) return { kind: 'absent' };
      return {
        kind: 'observed',
        status: instance.status,
        ...(instance.instanceId ? { instanceId: instance.instanceId } : {}),
        ...(instance.sourceImage ? { sourceImage: instance.sourceImage } : {}),
        ...(instance.provisioningModel === 'SPOT' ? { preemptible: true } : {}),
      };
    },
    { isTransient: isTransientNetworkError, sleep: defaultSoakSleep(input.timing) },
  );

  const probeFor = (subject: WorkspaceHostSoakSubject) =>
    buildWorkspaceHostSshSoakProbe({
      subject,
      profile: resolveGcpIapWorkspaceHostInitializationProfile(
        desired,
        input.controller ?? resolveWorkspaceHostInitializationControllerProfile(),
        { instanceId: subject.instanceId },
      ),
      readInstance,
      now,
      ...(input.runner ? { runner: input.runner } : {}),
      ...(input.timing ? { timing: input.timing } : {}),
    });

  return { desired, readInstance, probeFor };
}
