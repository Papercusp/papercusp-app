/**
 * Signed-URL HMAC tokens for per-file PUT routes (§15.6).
 *
 *   token = b64u( HMAC-SHA256(JWT_SECRET, deploymentId + ":" + sha256 + ":" + exp) )
 *
 * The Worker hands these out at /publish/start; the substrate sends each
 * file body to PUT /publish/file/<id>?token=<...>. Decouples per-file
 * uploads from the per-publish JWT (which is bound to the canonical
 * manifest and not reusable per file).
 */

import { b64uEncode, b64uDecode } from './base64url';
import { constantTimeEq } from './hex';

export interface SignedFileTokenInput {
  deploymentId: string;
  sha256: string;
  exp: number;
}

export async function mintFileToken(
  key: CryptoKey | Uint8Array,
  input: SignedFileTokenInput,
): Promise<string> {
  const sig = await sign(await asKey(key), serialize(input));
  return b64uEncode(sig) + '.' + input.exp.toString(36);
}

export async function verifyFileToken(
  key: CryptoKey | Uint8Array,
  token: string,
  bound: { deploymentId: string; sha256: string },
  now = Date.now(),
): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [sigSeg, expSeg] = parts as [string, string];
  const exp = parseInt(expSeg, 36);
  if (!Number.isFinite(exp) || now > exp * 1000) return false;
  const expected = await sign(
    await asKey(key),
    serialize({ deploymentId: bound.deploymentId, sha256: bound.sha256, exp }),
  );
  let provided: Uint8Array;
  try {
    provided = b64uDecode(sigSeg);
  } catch {
    return false;
  }
  return constantTimeEq(expected, provided);
}

function serialize(i: SignedFileTokenInput): string {
  return i.deploymentId + ':' + i.sha256 + ':' + i.exp.toString();
}

async function asKey(key: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (key instanceof Uint8Array) {
    return crypto.subtle.importKey(
      'raw',
      key as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }
  return key;
}

async function sign(key: CryptoKey, input: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(input),
  );
  return new Uint8Array(sig);
}
