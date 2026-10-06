/**
 * Local key custody for a signed desktop BYOC content client.
 *
 * This module is deliberately not an HTTP or portal route. The caller must run
 * in the customer-installed desktop sidecar and must verify the host key over
 * the customer's cloud channel before constructing a sealed content session.
 * A public key identifies one client key; the recovery seed is returned only
 * by explicit creation and must be handed to customer-controlled storage.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import SecretStream from '@hyperswarm/secret-stream';
import { keychainDelete, keychainLoad, keychainStore } from '../identity/keychain';

export const BYOC_CLIENT_KEY_SERVICE = 'papercusp-byoc-client-keypair';

export interface ByocClientKeyScope {
  organizationId: string;
  workspaceId: string;
  hostId: string;
  clientId: string;
}

export interface CreatedByocClientKey {
  publicKeyBase64: string;
  /** Show or export once through a native, customer-controlled recovery flow. */
  recoverySeedBase64: string;
}

export type RotatedByocClientKey = CreatedByocClientKey & {
  status: 'complete' | 'old-key-revocation-pending' | 'old-key-local-deletion-pending';
};

function requireInstalledDesktop(): void {
  if (process.env.PAPERCUSP_DESKTOP !== '1') {
    throw new Error('BYOC client private keys are available only in the customer-installed desktop sidecar');
  }
}

function scopeValue(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256) {
    throw new Error(`BYOC client key ${name} must be a non-empty canonical identifier`);
  }
  return value;
}

function scopeDigest(scope: ByocClientKeyScope): string {
  const fields = [
    scopeValue(scope.organizationId, 'organizationId'),
    scopeValue(scope.workspaceId, 'workspaceId'),
    scopeValue(scope.hostId, 'hostId'),
    scopeValue(scope.clientId, 'clientId'),
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function publicKeyBytes(publicKeyBase64: string): Buffer {
  if (typeof publicKeyBase64 !== 'string') throw new Error('BYOC client public key must be base64');
  const bytes = Buffer.from(publicKeyBase64, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== publicKeyBase64) {
    throw new Error('BYOC client public key must be canonical 32-byte base64');
  }
  return bytes;
}

function keychainId(scope: ByocClientKeyScope, publicKeyBase64: string): string {
  return `byoc-client:${scopeDigest(scope)}:${publicKeyBytes(publicKeyBase64).toString('hex')}`;
}

function recoverySeedBytes(recoverySeedBase64: string): Buffer {
  if (typeof recoverySeedBase64 !== 'string') throw new Error('BYOC recovery seed must be base64');
  const bytes = Buffer.from(recoverySeedBase64, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== recoverySeedBase64) {
    throw new Error('BYOC recovery seed must be canonical 32-byte base64');
  }
  return bytes;
}

/** Generate a Noise static key and persist it only in the local identity store. */
export async function createByocClientKey(scope: ByocClientKeyScope): Promise<CreatedByocClientKey> {
  requireInstalledDesktop();
  const seed = randomBytes(32);
  const pair = SecretStream.keyPair(seed);
  const publicKeyBase64 = pair.publicKey.toString('base64');
  try {
    await keychainStore(keychainId(scope, publicKeyBase64), pair.secretKey, BYOC_CLIENT_KEY_SERVICE);
    return { publicKeyBase64, recoverySeedBase64: seed.toString('base64') };
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}

/**
 * Customer-directed recovery. A seed that derives a different public key is
 * refused before any keychain write; the vendor cannot select a replacement.
 */
export async function restoreByocClientKey(
  scope: ByocClientKeyScope,
  publicKeyBase64: string,
  recoverySeedBase64: string,
): Promise<void> {
  requireInstalledDesktop();
  const expected = publicKeyBytes(publicKeyBase64);
  const seed = recoverySeedBytes(recoverySeedBase64);
  const pair = SecretStream.keyPair(seed);
  try {
    if (!timingSafeEqual(pair.publicKey, expected)) {
      throw new Error('BYOC recovery seed does not match the independently authorized client public key');
    }
    await keychainStore(keychainId(scope, publicKeyBase64), pair.secretKey, BYOC_CLIENT_KEY_SERVICE);
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}

/**
 * Expose private material only to a local, awaited Noise handshake. The
 * callback must finish using the key before it resolves; buffers are zeroed.
 */
export async function withByocClientKey<T>(
  scope: ByocClientKeyScope,
  publicKeyBase64: string,
  use: (pair: { publicKey: Buffer; secretKey: Buffer }) => Promise<T>,
): Promise<T> {
  requireInstalledDesktop();
  const expected = publicKeyBytes(publicKeyBase64);
  const loaded = await keychainLoad(keychainId(scope, publicKeyBase64), BYOC_CLIENT_KEY_SERVICE);
  if (loaded.kind === 'error') {
    throw new Error(`BYOC client key unavailable: ${loaded.error.kind}`);
  }
  const secretKey = loaded.value;
  try {
    if (secretKey.length !== 64) throw new Error('BYOC client key has invalid length');
    const pair = SecretStream.keyPair(secretKey.subarray(0, 32));
    try {
      if (!timingSafeEqual(pair.publicKey, expected) || !timingSafeEqual(pair.secretKey, secretKey)) {
        throw new Error('BYOC client key does not match its authorized public key');
      }
      return await use(pair);
    } finally {
      pair.secretKey.fill(0);
    }
  } finally {
    secretKey.fill(0);
  }
}

/**
 * Remove a local key only after the customer host confirms revocation. The
 * host must close live sessions and reject reconnects; this local deletion is
 * never presented as host-side revocation by itself.
 */
export async function revokeByocClientKey(
  scope: ByocClientKeyScope,
  publicKeyBase64: string,
  revokeOnCustomerHost: (publicKeyBase64: string) => Promise<void>,
): Promise<void> {
  requireInstalledDesktop();
  const id = keychainId(scope, publicKeyBase64);
  await revokeOnCustomerHost(publicKeyBase64);
  await keychainDelete(id, BYOC_CLIENT_KEY_SERVICE);
}

/**
 * Authorize the replacement on the customer host, then revoke the old key.
 * A failed old-key revocation or local deletion is an explicit, distinct
 * pending state. The caller still receives the new recovery material, so a
 * partial rotation cannot strand the customer. Only a failed host revocation
 * requires another host request; a failed local deletion must retry locally.
 */
export async function rotateByocClientKey(
  scope: ByocClientKeyScope,
  oldPublicKeyBase64: string,
  authorizeOnCustomerHost: (publicKeyBase64: string) => Promise<void>,
  revokeOnCustomerHost: (publicKeyBase64: string) => Promise<void>,
): Promise<RotatedByocClientKey> {
  requireInstalledDesktop();
  const replacement = await createByocClientKey(scope);
  try {
    await authorizeOnCustomerHost(replacement.publicKeyBase64);
  } catch (error) {
    await keychainDelete(keychainId(scope, replacement.publicKeyBase64), BYOC_CLIENT_KEY_SERVICE);
    throw error;
  }
  try {
    await revokeOnCustomerHost(oldPublicKeyBase64);
  } catch {
    return { ...replacement, status: 'old-key-revocation-pending' };
  }
  try {
    await keychainDelete(keychainId(scope, oldPublicKeyBase64), BYOC_CLIENT_KEY_SERVICE);
    return { ...replacement, status: 'complete' };
  } catch {
    return { ...replacement, status: 'old-key-local-deletion-pending' };
  }
}
