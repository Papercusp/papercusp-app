/**
 * Per-connection workspace-host instance cap (aws-byoc-gcp-parity-2026-10-01 P-007 / D-001,
 * extending byoc-cloud-workspaces-gcp-aws-azure-2026-08-22#D-397: "each sign up is only able to
 * spin up a single instance").
 *
 * PROVIDER-NEUTRAL: the cap is a property of the CONNECTION, not of the cloud, so GCP and AWS are
 * capped identically. A hosted connection — one whose credential reference is a hosted-control-plane
 * reference (`delegation://`, `encrypted://`, `resolver://`), minted one per sign-up by hosted
 * first-workspace — may carry at most ONE live host. A local-control-plane connection (the
 * operator's own SSO profile / ADC, desktop BYOC) belongs to the operator's own account and is not
 * capped here; that account's own cloud quotas govern it.
 *
 * This complements the hosted surface's host BINDING (`authorizeHost` in hosted-browser.ts), which
 * refuses a host id the selected workspace is not bound to. The cap refuses a second LIVE host on
 * the connection however its id was obtained — the operator's loopback surface, a rebound workspace,
 * or a binding that changed while the old host still held resources.
 */
import type { WorkspaceHostProviderConnection } from '@papercusp/deployment-driver';
import { isHostedProviderCredentialRef } from './hosted-gcp-auth';

/** One live host per hosted sign-up (D-397 / D-001). */
export const WORKSPACE_HOST_HOSTED_CONNECTION_INSTANCE_CAP = 1;

/** The named refusal a capped provision returns (HTTP 409). */
export const WORKSPACE_HOST_INSTANCE_CAP_ERROR = 'workspace_host_instance_cap_exceeded' as const;

/** The cap that applies to `connection`, or `null` when the connection is uncapped. */
export function workspaceHostConnectionInstanceCap(
  connection: Pick<WorkspaceHostProviderConnection, 'cloudCredentialRef'>,
): number | null {
  return isHostedProviderCredentialRef(connection.cloudCredentialRef.ref)
    ? WORKSPACE_HOST_HOSTED_CONNECTION_INSTANCE_CAP
    : null;
}

export type WorkspaceHostInstanceCapDecision =
  | { admitted: true; cap: number | null }
  | {
      admitted: false;
      error: typeof WORKSPACE_HOST_INSTANCE_CAP_ERROR;
      cap: number;
      /** The OTHER live hosts that already fill the cap. */
      liveHostIds: string[];
    };

/**
 * Decide whether provisioning `requestedHostId` stays within `cap`. Re-provisioning (resuming) a
 * host that is already live is never a second instance, so the requested host is never counted
 * against itself.
 */
export function decideWorkspaceHostInstanceCap(input: {
  cap: number | null;
  requestedHostId: string;
  liveHostIds: readonly string[];
}): WorkspaceHostInstanceCapDecision {
  if (input.cap === null) return { admitted: true, cap: null };
  if (!Number.isSafeInteger(input.cap) || input.cap < 1) {
    throw new Error(`workspace-host instance cap must be a positive integer, got ${input.cap}`);
  }
  const others = [...new Set(input.liveHostIds)].filter((hostId) => hostId !== input.requestedHostId);
  if (others.length < input.cap) return { admitted: true, cap: input.cap };
  return { admitted: false, error: WORKSPACE_HOST_INSTANCE_CAP_ERROR, cap: input.cap, liveHostIds: others };
}
