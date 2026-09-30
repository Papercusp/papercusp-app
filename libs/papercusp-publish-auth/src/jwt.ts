/**
 * HS256 JWT minting + verification.
 *
 * Spec'd in §15.4 (publishing) and §15.8 (snapshots, with HKDF subkeys).
 * Claims: { sub, iat, exp, jti, sha256, aud }.
 *
 * Verification order (caller-driven; this module exposes the primitives):
 *   1. parseJwt → checks structure
 *   2. verifyHmac → constant-time signature check
 *   3. caller checks exp/iat skew
 *   4. caller atomic-inserts jti into D1 (replay guard)
 *   5. caller checks claims.sha256 matches recomputed manifest
 *   6. caller checks claims.aud matches the route
 */

import { b64uEncode, b64uDecode, b64uEncodeString, b64uDecodeString } from './base64url';
import { constantTimeEq } from './hex';
import type { JwtClaims, JwtAudience } from './types';

const HEADER_HS256 = b64uEncodeString('{"alg":"HS256","typ":"JWT"}');

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

export interface MintInput {
  sub: string;
  jti: string;
  sha256: string;
  aud: JwtAudience;
  ttlSeconds?: number;
  now?: number;
}

export async function mintJwt(
  key: CryptoKey | Uint8Array,
  input: MintInput,
): Promise<string> {
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  const claims: JwtClaims = {
    sub: input.sub,
    iat: nowSec,
    exp: nowSec + (input.ttlSeconds ?? 60),
    jti: input.jti,
    sha256: input.sha256,
    aud: input.aud,
  };
  const payload = b64uEncodeString(JSON.stringify(claims));
  const signingInput = HEADER_HS256 + '.' + payload;
  const sig = await hmacSha256(await asKey(key), signingInput);
  return signingInput + '.' + b64uEncode(sig);
}

export interface ParsedJwt {
  header: { alg: string; typ?: string };
  claims: JwtClaims;
  signingInput: string;
  signature: Uint8Array;
}

export function parseJwt(token: string): ParsedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('jwt must have 3 segments');
  const [headerSeg, claimsSeg, sigSeg] = parts as [string, string, string];
  let header: ParsedJwt['header'];
  let claims: JwtClaims;
  try {
    header = JSON.parse(b64uDecodeString(headerSeg));
    claims = JSON.parse(b64uDecodeString(claimsSeg)) as JwtClaims;
  } catch {
    throw new JwtError('jwt segment is not valid JSON');
  }
  if (header.alg !== 'HS256') throw new JwtError('alg must be HS256');
  return {
    header,
    claims,
    signingInput: headerSeg + '.' + claimsSeg,
    signature: b64uDecode(sigSeg),
  };
}

export async function verifyJwtSignature(
  key: CryptoKey | Uint8Array,
  parsed: ParsedJwt,
): Promise<boolean> {
  const expected = await hmacSha256(await asKey(key), parsed.signingInput);
  return constantTimeEq(expected, parsed.signature);
}

export interface VerifyOptions {
  audience: JwtAudience;
  expectedSub?: string;
  expectedSha256?: string;
  now?: number;
  clockSkewSec?: number;
}

export async function verifyJwt(
  key: CryptoKey | Uint8Array,
  token: string,
  opts: VerifyOptions,
): Promise<JwtClaims> {
  const parsed = parseJwt(token);
  if (!(await verifyJwtSignature(key, parsed)))
    throw new JwtError('signature mismatch');

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.clockSkewSec ?? 5;
  const c = parsed.claims;
  if (now > c.exp) throw new JwtError('jwt expired');
  if (now < c.iat - skew) throw new JwtError('jwt iat in the future');
  if (c.aud !== opts.audience) throw new JwtError('jwt aud mismatch');
  if (opts.expectedSub && c.sub !== opts.expectedSub)
    throw new JwtError('jwt sub mismatch');
  if (opts.expectedSha256 && c.sha256 !== opts.expectedSha256)
    throw new JwtError('jwt sha256 mismatch');
  return c;
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

async function hmacSha256(key: CryptoKey, input: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(input),
  );
  return new Uint8Array(sig);
}
