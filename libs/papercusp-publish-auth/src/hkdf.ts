/**
 * HKDF-SHA256 per RFC 5869, used to derive per-feature subkeys from
 * tenantSecret (§15.8).
 *
 *   publish_key  = HKDF(tenantSecret, info="papercusp-publish-v1")
 *   snapshot_key = HKDF(tenantSecret, info="papercusp-snapshot-v1")
 *
 * No salt is used (RFC 5869 permits empty salt; tenantSecret is already
 * high-entropy machine-generated).
 */

export const PUBLISH_INFO = 'papercusp-publish-v1';
export const SNAPSHOT_INFO = 'papercusp-snapshot-v1';

export async function deriveSubkey(
  tenantSecret: Uint8Array,
  info: string,
  length = 32,
): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey(
    'raw',
    tenantSecret as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    ikm,
    length * 8,
  );
  return new Uint8Array(bits);
}

export function derivePublishKey(tenantSecret: Uint8Array): Promise<Uint8Array> {
  return deriveSubkey(tenantSecret, PUBLISH_INFO);
}

export function deriveSnapshotKey(tenantSecret: Uint8Array): Promise<Uint8Array> {
  return deriveSubkey(tenantSecret, SNAPSHOT_INFO);
}
