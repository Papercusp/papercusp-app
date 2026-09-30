/**
 * sign-with-device-key — Ed25519 signing with the device private key that
 * lives in the keychain (Model B substrate, Stage 3).
 *
 * `loadOrGenerateDeviceKeypair` (attest.ts) deliberately returns ONLY the
 * public key — the PKCS8 private key never leaves the identity layer. The
 * announce signer (`lib/sync/hyperbee/announce.ts`) must therefore sign
 * through this thin helper rather than reaching into the keychain itself.
 *
 * This mirrors attest.ts's private `signPayload`: load the PKCS8 DER from the
 * keychain, reconstruct the private key, and `nodeSign(null, bytes, key)`
 * (algorithm MUST be null for Ed25519). The 64-byte signature Buffer is
 * returned raw; the caller base64-encodes it for the wire.
 *
 * attest.ts does not export a reusable signer (its `signPayload` is private
 * and bound to the AttestationGistBody schema), so we re-use the same
 * primitive + keychain accessor here. The crypto is byte-compatible: same
 * Node-crypto Ed25519, same PKCS8/SPKI-DER key shapes.
 */

import { sign as nodeSign, createPrivateKey } from 'node:crypto';
import { keychainLoad } from './keychain';

/**
 * Sign `bytes` with the device Ed25519 private key stored under `keychainId`.
 * Throws if no key is present (caller must have run
 * `loadOrGenerateDeviceKeypair` first).
 *
 * @returns the raw 64-byte Ed25519 signature Buffer.
 */
export async function signWithDeviceKey(keychainId: string, bytes: Buffer): Promise<Buffer> {
  const loaded = await keychainLoad(keychainId);
  if (loaded.kind !== 'ok') {
    const detail = loaded.error.kind === 'not_found'
      ? loaded.error.kind
      : `${loaded.error.kind}: ${loaded.error.reason}`;
    throw new Error(
      `signWithDeviceKey: device private key unavailable ` +
        `(${detail}) for id: ${keychainId}`,
    );
  }
  const privateKey = createPrivateKey({ key: loaded.value, format: 'der', type: 'pkcs8' });
  return nodeSign(null, bytes, privateKey);
}
