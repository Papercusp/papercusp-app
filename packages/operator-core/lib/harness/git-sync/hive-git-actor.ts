/**
 * P514: Git publication follows the current serving owner's capability.
 * Bare announce identities, historical devices and gh logins are diagnostic
 * facts; none is a substitute for current authority over this repository.
 */
import { validateGitServingState, type GitServingCapability, type GitServingRequest } from '../../sync/pot-git/serving-capability';

export interface HiveGitActor {
  githubUserId: number;
  devicePubkey: string;
  keychainId: string;
  source: 'serving-owner';
  capability: GitServingCapability;
}

export function pickHiveGitActor(state: unknown, request: GitServingRequest): HiveGitActor | null {
  const resolved = validateGitServingState(state, request);
  if (resolved.status !== 'ready') return null;
  const capability = resolved.capability;
  return {
    githubUserId: capability.identity.githubUserId,
    devicePubkey: capability.identity.devicePubkeyBase64,
    keychainId: capability.identity.keychainId,
    source: 'serving-owner',
    capability,
  };
}
