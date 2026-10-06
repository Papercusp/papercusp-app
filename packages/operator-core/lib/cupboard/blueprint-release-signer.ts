/**
 * blueprint-release-signer — the local-device release signer and the lifecycle error it
 * throws, as a leaf that does not import the blueprint lifecycle.
 *
 * Split out of `blueprint-release.ts` (WI-10004876). The self-describing kinds
 * (`self-describing-release.ts`, P-011) sign with this same identity path, and naming the
 * signer through `blueprint-release` (even as `import type`, even behind a dynamic
 * `import()`) compiled that file into every program that packs a self-describing release —
 * and from there `blueprint/compile-packages` reaches most of operator-core, including the
 * agent-tools graph. The Cupboard Worker's stricter typecheck then failed in hundreds of
 * files it never meant to compile. Keep this file's static imports to nothing; the identity
 * helpers below are loaded lazily and are themselves leaves.
 */

export class BlueprintLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BlueprintLifecycleError';
  }
}

export interface BlueprintReleaseSigner {
  githubUserId: number;
  githubLogin: string;
  devicePubkey: string;
  sign(bytes: Buffer): Promise<Buffer>;
}

/** The local-device release signer. Exported so the self-describing kinds (P-011) sign their
 * release manifests with the SAME identity path the blueprint kind already uses. */
export async function defaultReleaseSigner(): Promise<BlueprintReleaseSigner> {
  const { resolveLocalGithubIdentity } = await import('../identity/resolve-local-github-identity');
  const identity = await resolveLocalGithubIdentity();
  if (identity.kind !== 'ok')
    throw new BlueprintLifecycleError('GitHub authentication is required to sign a blueprint release', 401);
  const { resolveDeviceKeychainId } = await import('../identity/device-keychain-id');
  const keychainId = resolveDeviceKeychainId(identity.githubUserId);
  const { loadOrGenerateDeviceKeypair } = await import('../identity/attest');
  const keypair = await loadOrGenerateDeviceKeypair(keychainId);
  const { signWithDeviceKey } = await import('../identity/sign-with-device-key');
  return {
    githubUserId: identity.githubUserId,
    githubLogin: identity.githubLogin,
    devicePubkey: keypair.pubkeyBase64,
    sign: (bytes) => signWithDeviceKey(keychainId, bytes),
  };
}
