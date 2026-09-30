/**
 * F6/D-022: exclusive Git effects belong to the hive's owning Swarm.
 *
 * This extends the existing hive identity; it is not an election or a lease.
 * The private key must remain on ONE owning Swarm. Peers keep publishing their
 * own heads while the owner is unavailable, but cannot promote or egress them.
 * Copying that private key to another writer invalidates this safety contract.
 */
import { randomBytes } from 'node:crypto';
import { verifyEd25519 } from '../../identity/ed25519';
import type { SignedProtocolScope } from './signed-context';

export interface HiveEffectAuthority extends SignedProtocolScope {
  /** Live owner-key signer, not a cached transferable bearer proof. */
  sign(bytes: Buffer): Promise<Buffer>;
}

export class HiveEffectAuthorityError extends Error {
  constructor() {
    super('hive-effect-authority: exclusive effect requires the owning hive key; automatic failover is disabled');
    this.name = 'HiveEffectAuthorityError';
  }
}

/** The sink challenges the live signer for THIS operation immediately before
 * mutating. A device signature, missing key or captured proof cannot authorize
 * another operation. The caller supplies scope from its verified runtime, never
 * from a peer's unverified announcement. */
export async function requireHiveEffectAuthority(
  authority: HiveEffectAuthority | null | undefined,
  scope: SignedProtocolScope,
  effect: readonly string[],
): Promise<void> {
  if (!authority || !scope.hive_id || !scope.repo_key ||
      authority.hive_id !== scope.hive_id || authority.repo_key !== scope.repo_key) {
    throw new HiveEffectAuthorityError();
  }
  const bytes = Buffer.from('papercusp-hive-exclusive-effect-v1\n' + JSON.stringify({
    hive_id: scope.hive_id, repo_key: scope.repo_key,
    effect, nonce: randomBytes(32).toString('hex'),
  }));
  try {
    const signature = await authority.sign(bytes);
    if (!verifyEd25519(bytes, scope.hive_id, signature)) {
      throw new HiveEffectAuthorityError();
    }
  } catch {
    throw new HiveEffectAuthorityError();
  }
}

/** Load only the EXISTING owner key. Never mint a key on a joined view. */
export async function loadHiveEffectAuthority(
  workspaceId: string,
  potHomeSlug: string,
  scope: SignedProtocolScope,
): Promise<HiveEffectAuthority | null> {
  const { loadHiveKeyStatus, signWithHiveKey } = await import('../../identity/hive-keypair');
  const status = await loadHiveKeyStatus(workspaceId, potHomeSlug);
  if (status.kind !== 'ok' || status.pubkeyBase64 !== scope.hive_id) return null;
  return { ...scope, sign: bytes => signWithHiveKey(workspaceId, potHomeSlug, bytes) };
}

/** Owner-local publication term, independent of advisory membership epochs.
 * Persist with the existing integrator metadata under the git-sync lease. */
export function nextHivePublicationTerm(
  prior: { epoch: number; seq: number; authorityDevice?: string; storeGeneration?: string } | null,
  device: string,
  generation: string,
  acceptedEpoch = 0,
): { epoch: number; priorSeq: number } {
  if (prior && (!Number.isSafeInteger(prior.epoch) || prior.epoch < 0 ||
      !Number.isSafeInteger(prior.seq) || prior.seq < 0)) throw new HiveEffectAuthorityError();
  if (!Number.isSafeInteger(acceptedEpoch) || acceptedEpoch < 0) throw new HiveEffectAuthorityError();
  const same = prior?.authorityDevice === device && prior.storeGeneration === generation && prior.epoch >= acceptedEpoch;
  const epoch = same ? prior!.epoch : Math.max(prior?.epoch ?? 0, acceptedEpoch) + 1;
  if (!Number.isSafeInteger(epoch) || (same && prior!.seq === Number.MAX_SAFE_INTEGER)) {
    throw new HiveEffectAuthorityError();
  }
  return { epoch, priorSeq: same ? prior!.seq : 0 };
}
