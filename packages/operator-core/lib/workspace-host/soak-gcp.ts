/**
 * Production GCP seams for the workspace-host soak (D-391).
 *
 * Both readings are READ-ONLY. The instance read is one Compute `instances.get`. The reach probe
 * is the WI-10002499 bootstrap-readiness probe (`test -x <conduit>`) over the controller's own IAP
 * SSH transport, bound to the PINNED incarnation's host-key alias and — unlike initialization — it
 * enrolls nothing, so a machine recreated mid-soak fails StrictHostKeyChecking instead of being
 * quietly re-trusted. A quiesced snapshot is never used as a probe: it stops the VM for ~75s
 * (EI-24005526609432424).
 */
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { describeFetchError, isTransientNetworkError } from '../loopback-fetch';
import {
  GcpIapWorkspaceHostBootstrapNotReadyError,
  GcpIapWorkspaceHostInitializationOperations,
  NodeGcpIapWorkspaceHostInitializationCommandRunner,
  type GcpIapWorkspaceHostInitializationCommandRunner,
} from './gcp-iap-initialization-operations';
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
import type {
  WorkspaceHostSoakInstanceReading,
  WorkspaceHostSoakProbe,
  WorkspaceHostSoakReachOutcome,
  WorkspaceHostSoakSubject,
} from './soak';

/** Bound on one ssh attempt; a hung IAP tunnel must not eat the sample interval. */
export const WORKSPACE_HOST_SOAK_REACH_ATTEMPT_TIMEOUT_MS = 45_000;
/** Budget for one sample's reach check: up to ~3 attempts, absorbing a single dropped tunnel. */
export const WORKSPACE_HOST_SOAK_REACH_BUDGET_MS = 45_000;
export const WORKSPACE_HOST_SOAK_REACH_RETRY_MS = 15_000;
/**
 * Attempts for one sample's instance read. A transport failure (`fetch failed`) leaves all three
 * strict checks unmeasured, and the evaluator needs 95% of samples measured: the r39 soak lost 15
 * samples to single dropped requests with zero host failures, and could not pass (WI-10002796).
 */
export const WORKSPACE_HOST_SOAK_READ_ATTEMPTS = 3;
export const WORKSPACE_HOST_SOAK_READ_RETRY_MS = 5_000;

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
  timing?: { now?: () => number; sleep?: (ms: number) => Promise<void> };
  now?: () => Date;
}

export interface GcpWorkspaceHostSoakSeams {
  desired: WorkspaceHostDesiredSpec;
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  probeFor(subject: WorkspaceHostSoakSubject): WorkspaceHostSoakProbe;
}

function detailOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export async function resolveGcpWorkspaceHostSoakSeams(
  input: GcpWorkspaceHostSoakSeamsInput,
): Promise<GcpWorkspaceHostSoakSeams> {
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
  const sleep = input.timing?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  // Only a TRANSPORT failure is asked again: an absent or observed instance is an answer, and a
  // non-transient error (auth, quota) would fail the same way on every attempt.
  const readInstance = async (): Promise<WorkspaceHostSoakInstanceReading> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const instance = await client.getInstance(identity.projectId, identity.zone, identity.instanceName);
        if (!instance) return { kind: 'absent' };
        return {
          kind: 'observed',
          status: instance.status,
          ...(instance.instanceId ? { instanceId: instance.instanceId } : {}),
          ...(instance.sourceImage ? { sourceImage: instance.sourceImage } : {}),
        };
      } catch (error) {
        if (attempt >= WORKSPACE_HOST_SOAK_READ_ATTEMPTS || !isTransientNetworkError(error)) {
          // describeFetchError keeps undici's hidden cause code: r39 persisted a blind "fetch failed".
          const tries = attempt > 1 ? ` (after ${attempt} attempts)` : '';
          return { kind: 'unreadable', detail: `${describeFetchError(error).slice(0, 500)}${tries}` };
        }
        await sleep(WORKSPACE_HOST_SOAK_READ_RETRY_MS);
      }
    }
  };

  const probeFor = (subject: WorkspaceHostSoakSubject): WorkspaceHostSoakProbe => ({
    readInstance,
    now,
    async probeReach(): Promise<WorkspaceHostSoakReachOutcome> {
      const operations = new GcpIapWorkspaceHostInitializationOperations(
        resolveGcpIapWorkspaceHostInitializationProfile(
          desired,
          input.controller ?? resolveWorkspaceHostInitializationControllerProfile(),
          { instanceId: subject.instanceId },
        ),
        input.runner ??
          new NodeGcpIapWorkspaceHostInitializationCommandRunner({
            timeoutMs: WORKSPACE_HOST_SOAK_REACH_ATTEMPT_TIMEOUT_MS,
          }),
        input.timing ?? {},
      );
      try {
        await operations.awaitBootstrapReady({
          timeoutMs: WORKSPACE_HOST_SOAK_REACH_BUDGET_MS,
          pollIntervalMs: WORKSPACE_HOST_SOAK_REACH_RETRY_MS,
        });
        return { kind: 'reached' };
      } catch (error) {
        // Matched by name as well as prototype: DBOS serialization erases prototypes elsewhere
        // in this subsystem, and a misclassified outcome here would blur the two failure kinds.
        if (
          error instanceof GcpIapWorkspaceHostBootstrapNotReadyError ||
          (error instanceof Error && error.name === 'GcpIapWorkspaceHostBootstrapNotReadyError')
        ) {
          const typed = error as GcpIapWorkspaceHostBootstrapNotReadyError;
          return typed.answered
            ? { kind: 'conduit-missing', detail: detailOf(error) }
            : { kind: 'transport-failure', detail: detailOf(error) };
        }
        return { kind: 'transport-failure', detail: detailOf(error) };
      }
    },
  });

  return { desired, readInstance, probeFor };
}
