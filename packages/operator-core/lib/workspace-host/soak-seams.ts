/**
 * Provider dispatch for the workspace-host soak and standing-health seams (P-007 of
 * aws-byoc-gcp-parity-2026-10-01). The soak route, the soak workflow and the standing-health
 * workflow all resolve their seams here, so a host is read and reached through the cloud its own
 * recorded desired spec names — before this, all three were hard-wired to the GCP seams and an
 * AWS host could not be soaked at all.
 */
import { AWS_WORKSPACE_HOST_TARGET } from './aws-connection';
import { GCP_WORKSPACE_HOST_TARGET } from './gcp-provider';
import { UnsupportedWorkspaceHostInitializationTargetError } from './initialization-operations-resolver';
import { readWorkspaceHostDesiredSpec } from './observability-store';
import { resolveAwsWorkspaceHostSoakSeams } from './soak-aws';
import { resolveGcpWorkspaceHostSoakSeams } from './soak-gcp';
import type { WorkspaceHostSoakSeams } from './soak-ssh-probe';

export interface WorkspaceHostSoakSeamsInput {
  workspaceId: string;
  hostId: string;
  /** Test seams; production reads the durable host record and each cloud's own resolver. */
  readDesiredSpec?: typeof readWorkspaceHostDesiredSpec;
  resolveGcp?: typeof resolveGcpWorkspaceHostSoakSeams;
  resolveAws?: typeof resolveAwsWorkspaceHostSoakSeams;
}

export async function resolveWorkspaceHostSoakSeams(input: WorkspaceHostSoakSeamsInput): Promise<WorkspaceHostSoakSeams> {
  const lookup = await (input.readDesiredSpec ?? readWorkspaceHostDesiredSpec)(input.workspaceId, input.hostId);
  // The per-cloud resolver re-reads the spec; hand it this one so both decisions see the same row.
  const readDesiredSpec: typeof readWorkspaceHostDesiredSpec = async () => lookup;
  const target = lookup.desired?.target;
  if (target === AWS_WORKSPACE_HOST_TARGET) {
    return (input.resolveAws ?? resolveAwsWorkspaceHostSoakSeams)({ ...input, readDesiredSpec });
  }
  // A missing spec routes to the GCP resolver, which raises the canonical "unavailable" error.
  if (target === undefined || target === GCP_WORKSPACE_HOST_TARGET) {
    return (input.resolveGcp ?? resolveGcpWorkspaceHostSoakSeams)({ ...input, readDesiredSpec });
  }
  throw new UnsupportedWorkspaceHostInitializationTargetError(target);
}
