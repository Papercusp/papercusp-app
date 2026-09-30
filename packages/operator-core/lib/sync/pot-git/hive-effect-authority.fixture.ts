/** Test-only owning-hive identity; no keychain or shared datastore access. */
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';

const owner = generateEd25519KeypairDer();
export function hiveEffectFixture(repoKey = 'repo') {
  const scope = { hive_id: owner.pubkeyBase64, repo_key: repoKey };
  return {
    scope,
    hiveId: scope.hive_id,
    context: { ...scope, store_generation: 'sg2-1-' + 'a'.repeat(40) },
    authority: { ...scope, sign: async (bytes: Buffer) => signWithPrivateKeyDer(owner.privateKeyDer, bytes) },
  };
}
