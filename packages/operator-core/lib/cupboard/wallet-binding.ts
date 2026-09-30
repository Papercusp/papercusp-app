/**
 * Pure EVM wallet-binding primitives (shared-pot DAO plan P-029).
 *
 * A wallet address is never an identity lookup. The authenticated Papercusp
 * principal is embedded in a short-lived, server-issued SIWE-style message,
 * and the recovered EVM address must match the address embedded in that exact
 * challenge. Persistence owns expiry and one-time consumption; this module
 * owns the cryptographic and message-format boundary shared by the Worker and
 * its tests.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const encoder = new TextEncoder();

export const WALLET_BINDING_TTL_MS = 5 * 60_000;
export const WALLET_BINDING_STATEMENT =
  'Bind this wallet to the authenticated Papercusp principal. This signature authorizes wallet binding only and does not authorize a transaction.';

export interface WalletBindingChallenge {
  readonly challengeId: string;
  readonly principalId: string;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly domain: string;
  readonly uri: string;
  readonly message: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export type WalletSignatureVerdict =
  | { readonly ok: true; readonly recoveredAddress: string }
  | {
      readonly ok: false;
      readonly code: 'invalid_signature' | 'address_mismatch';
      readonly detail: string;
      readonly recoveredAddress?: string;
    };

export function normalizeEvmAddress(value: string): string | null {
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]{40}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomHex(length: number, randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error(`wallet-binding random source returned ${bytes?.length ?? 'no'} bytes; expected ${length}`);
  }
  return bytesToHex(bytes);
}

function normalizedDomain(value: string): string {
  const raw = value.trim();
  if (!raw || /[\r\n]/.test(raw)) throw new Error('wallet-binding domain must be a non-empty single line');
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host;
  } catch {
    throw new Error('wallet-binding domain is invalid');
  }
}

export function buildWalletBindingMessage(input: {
  domain: string;
  uri: string;
  principalId: string;
  walletAddress: string;
  chainId: number;
  nonce: string;
  challengeId: string;
  issuedAtMs: number;
  expiresAtMs: number;
}): string {
  return [
    `${input.domain} wants you to sign in with your Ethereum account:`,
    input.walletAddress,
    '',
    WALLET_BINDING_STATEMENT,
    '',
    `URI: ${input.uri}`,
    'Version: 1',
    `Chain ID: ${input.chainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${new Date(input.issuedAtMs).toISOString()}`,
    `Expiration Time: ${new Date(input.expiresAtMs).toISOString()}`,
    `Request ID: ${input.challengeId}`,
    'Resources:',
    `- urn:papercusp:principal:${input.principalId}`,
  ].join('\n');
}

export function createWalletBindingChallenge(input: {
  principalId: string;
  walletAddress: string;
  domain: string;
  chainId?: number;
  nowMs?: number;
  ttlMs?: number;
  randomBytes?: (length: number) => Uint8Array;
}): WalletBindingChallenge {
  const principalId = input.principalId.trim();
  if (!principalId || /[\r\n]/.test(principalId)) {
    throw new Error('wallet-binding principalId must be a non-empty single line');
  }
  const walletAddress = normalizeEvmAddress(input.walletAddress);
  if (!walletAddress) throw new Error('wallet-binding address must be 20-byte 0x-prefixed hex');

  const domain = normalizedDomain(input.domain);
  const chainId = input.chainId ?? 1;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error('wallet-binding chainId must be a positive safe integer');
  }
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? WALLET_BINDING_TTL_MS;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('wallet-binding nowMs is invalid');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > WALLET_BINDING_TTL_MS) {
    throw new Error(`wallet-binding ttlMs must be between 1 and ${WALLET_BINDING_TTL_MS}`);
  }
  const randomBytes =
    input.randomBytes ??
    ((length: number) => {
      const out = new Uint8Array(length);
      crypto.getRandomValues(out);
      return out;
    });
  const challengeId = `wbc_${randomHex(16, randomBytes)}`;
  const nonce = randomHex(16, randomBytes);
  const issuedAtMs = nowMs;
  const expiresAtMs = nowMs + ttlMs;
  const uri = `https://${domain}/commerce/wallet-bindings`;
  return {
    challengeId,
    principalId,
    walletAddress,
    chainId,
    nonce,
    domain,
    uri,
    issuedAtMs,
    expiresAtMs,
    message: buildWalletBindingMessage({
      domain,
      uri,
      principalId,
      walletAddress,
      chainId,
      nonce,
      challengeId,
      issuedAtMs,
      expiresAtMs,
    }),
  };
}

/** EIP-191 `personal_sign` digest for the exact UTF-8 message bytes. */
export function ethereumPersonalMessageDigest(message: string): Uint8Array {
  const messageBytes = encoder.encode(message);
  const prefix = encoder.encode(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const bytes = new Uint8Array(prefix.length + messageBytes.length);
  bytes.set(prefix);
  bytes.set(messageBytes, prefix.length);
  return keccak_256(bytes);
}

function parseEthereumSignature(signature: string): Uint8Array | null {
  const hex = signature.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) return null;
  const bytes = Uint8Array.from(hex.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
  const rawV = bytes[64];
  const recovery = rawV >= 27 ? rawV - 27 : rawV;
  if (recovery !== 0 && recovery !== 1) return null;
  const recovered = new Uint8Array(65);
  recovered[0] = recovery;
  recovered.set(bytes.subarray(0, 64), 1);
  return recovered;
}

export function recoverEthereumAddress(message: string, signature: string): string | null {
  const parsed = parseEthereumSignature(signature);
  if (!parsed) return null;
  try {
    const digest = ethereumPersonalMessageDigest(message);
    const compressed = secp256k1.recoverPublicKey(parsed, digest, { prehash: false });
    const publicKey = secp256k1.Point.fromBytes(compressed).toBytes(false);
    return `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;
  } catch {
    return null;
  }
}

export function verifyWalletBindingSignature(input: {
  message: string;
  signature: string;
  expectedAddress: string;
}): WalletSignatureVerdict {
  const expected = normalizeEvmAddress(input.expectedAddress);
  const recovered = recoverEthereumAddress(input.message, input.signature);
  if (!expected || !recovered) {
    return {
      ok: false,
      code: 'invalid_signature',
      detail: 'signature must be a valid 65-byte EIP-191 personal_sign signature',
    };
  }
  if (recovered !== expected) {
    return {
      ok: false,
      code: 'address_mismatch',
      detail: 'signature recovered a different wallet than the server-issued challenge',
      recoveredAddress: recovered,
    };
  }
  return { ok: true, recoveredAddress: recovered };
}
