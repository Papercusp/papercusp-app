/**
 * Which census profile judges a host's provider population (plan aws-byoc-gcp-parity-2026-10-01
 * P-003). The census reconciliation itself is shared (`censusManagedWorkspaceHostResources` in
 * gcp-safety.ts); a profile carries only what differs per provider: target, resource kinds, managed
 * label/tag keys and label-value normalization. Every destroy, legacy-population check and release
 * census stage resolves its profile here, so a provider without one is refused, never judged by
 * another provider's rules.
 */
import { AWS_WORKSPACE_HOST_CENSUS_PROFILE } from './aws-safety';
import { GCP_WORKSPACE_HOST_CENSUS_PROFILE, type WorkspaceHostCensusProfile } from './gcp-safety';

export const WORKSPACE_HOST_CENSUS_PROFILES: readonly WorkspaceHostCensusProfile[] = [
  GCP_WORKSPACE_HOST_CENSUS_PROFILE,
  AWS_WORKSPACE_HOST_CENSUS_PROFILE,
];

/** The profile for `target`, or null when no census exists for that provider. */
export function findWorkspaceHostCensusProfile(target: string): WorkspaceHostCensusProfile | null {
  return WORKSPACE_HOST_CENSUS_PROFILES.find((profile) => profile.target === target) ?? null;
}

/** The profile for `target`; throws for a provider that has no controller-independent census. */
export function workspaceHostCensusProfile(target: string): WorkspaceHostCensusProfile {
  const profile = findWorkspaceHostCensusProfile(target);
  if (!profile) {
    throw new Error(`no controller-independent workspace-host census exists for provider '${target}'`);
  }
  return profile;
}
