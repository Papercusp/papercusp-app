/**
 * Tenant-secret hashing for D1 storage (§15.4).
 *
 * `tenantSecret` is high-entropy (32 bytes from CSPRNG) so argon2's
 * slow-hash advantage doesn't apply. We use HMAC-SHA256(secret, HASH_PEPPER)
 * for ~µs verification per request.
 *
 * `HASH_PEPPER` is a server-side Worker secret separate from JWT_SECRET.
 */

import { toHex, fromHex, constantTimeEq } from './hex';

export async function hashTenantSecret(
  tenantSecret: string,
  pepper: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    pepper as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(tenantSecret),
  );
  return toHex(new Uint8Array(sig));
}

export async function verifyTenantSecret(
  tenantSecret: string,
  pepper: Uint8Array,
  storedHashHex: string,
): Promise<boolean> {
  const computed = fromHex(await hashTenantSecret(tenantSecret, pepper));
  let stored: Uint8Array;
  try {
    stored = fromHex(storedHashHex);
  } catch {
    return false;
  }
  return constantTimeEq(computed, stored);
}
