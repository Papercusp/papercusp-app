/**
 * authority-rpc-envelope — the AUTHENTICATED wire wrapper for an authority RPC
 * (EI-322: close the lying-caller hole on POST /api/authority/rpc).
 *
 * Background. `/api/authority/rpc` is `auth:'public'` and MUTATING: a peer routes
 * a control op (file-lock acquire/release, claim lease acquire/heartbeat/release)
 * to the elected authority over `HttpPeerRpcTransport`. The route's
 * `verifyIsAuthority` guard proves THIS machine should serialize the op (routing
 * correctness), and EI-284 added a revocation gate — but the op's `holderPubkey`
 * was SELF-REPORTED: nothing proved the caller actually controls the device key
 * it claims. A malicious peer could forge another peer's identity to win/extend a
 * lease, or a revoked peer could simply lie about its pubkey to dodge the EI-284
 * gate. Bounded today (the operator binds 127.0.0.1), but the endpoint exists for
 * the cross-machine path — the moment it leaves loopback it is a remote,
 * unauthenticated, mutating surface.
 *
 * The fix mirrors the substrate's already-proven announce wire-format
 * (`sync/hyperbee/announce.ts`): an Ed25519 signature over a canonical body, with
 * a ts-freshness window and an optional nonce for replay resistance. The caller
 * signs with its DEVICE key (the same keychain key the announce signer uses, via
 * `signWithDeviceKey`); the authority verifies the signature against the asserted
 * `device_pubkey`, so the caller has PROVEN control of that key. Binding that
 * proven pubkey to the op payload's `holderPubkey` (done at the route layer) is
 * what shuts the impersonation door: you can only act as the device you can sign
 * for. Revocation (EI-284) then refuses a proven-but-revoked peer.
 *
 * Crypto contract: byte-identical to announce.ts / attest.ts — Node-crypto
 * Ed25519, raw-32-byte-base64 pubkey → SPKI-DER rebuild via the fixed 12-byte
 * prefix, `sign(null,…)` / `verify(null,…)`.
 *
 * Canonicalization: unlike the announce body (all primitives → field-ordered
 * JSON suffices), an authority RPC wraps an ARBITRARY `payload` object, so the
 * signing bytes use a small recursive JCS-style canonicalizer (sorted object
 * keys, array order preserved). The signer signs the payload object it is about
 * to send; the verifier canonicalizes the payload it parsed off the wire — a
 * faithful JSON round-trip of the same value, so sorted-key serialization yields
 * identical bytes on both sides regardless of key insertion order.
 */

import { sign as nodeSign, verify as nodeVerify, createPublicKey, createPrivateKey, randomBytes } from 'node:crypto';

/** Fixed 12-byte Ed25519 SPKI DER prefix (matches announce.ts / attest.ts). */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Default freshness window for a signed authority RPC (±2 min). Tighter than
 *  the announce window (±5 min) — an RPC is a live request/response, not a
 *  replicated frame that may sit in a log, so a smaller replay window is safe. */
export const DEFAULT_AUTHORITY_RPC_WINDOW_MS = 2 * 60 * 1000;

/** The signed-auth wrapper attached to an authority RPC envelope. */
export interface AuthorityRpcAuth {
  /** Raw 32-byte Ed25519 device public key, base64 — the SAME string as the
   *  announce/binding `device_pubkey`, so the authority can cross-check it
   *  against the federated roster + revoked set. */
  device_pubkey: string;
  /** Epoch-ms at sign time. Covered by the signature; freshness-checked. */
  ts: number;
  /** Random nonce for replay resistance. Covered by the signature. */
  nonce: string;
  /** Base64 Ed25519 signature over {@link authorityRpcSigningBytes}. */
  sig: string;
}

/** The fields an authority RPC signature covers (the op + the caller identity). */
export interface AuthorityRpcSignedFields {
  harnessSlug: string;
  kind: string;
  payload: unknown;
  device_pubkey: string;
  ts: number;
  nonce: string;
}

/**
 * Recursive JCS-style canonicalization: objects emit their keys in sorted order,
 * arrays preserve order, primitives serialize as ordinary JSON. Deterministic
 * for any JSON-round-trippable value — the property the signer/verifier rely on.
 * `undefined` object values are dropped (JSON.stringify parity); `undefined` in
 * an array becomes `null` (again JSON parity).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) continue; // JSON.stringify drops undefined object values
    parts.push(JSON.stringify(k) + ':' + canonicalJson(v));
  }
  return '{' + parts.join(',') + '}';
}

/** Canonical signing bytes for an authority RPC: the JCS-canonical form of the
 *  signed fields. Both sign + verify call this. */
export function authorityRpcSigningBytes(fields: AuthorityRpcSignedFields): Buffer {
  return Buffer.from(
    canonicalJson({
      harnessSlug: fields.harnessSlug,
      kind: fields.kind,
      payload: fields.payload,
      device_pubkey: fields.device_pubkey,
      ts: fields.ts,
      nonce: fields.nonce,
    }),
    'utf8',
  );
}

/**
 * Build the signed-auth wrapper for an authority RPC. The signer is INJECTED
 * (tests pass a generated keypair; production passes
 * `bytes => signWithDeviceKey(keychainId, bytes)`). The signer returns the raw
 * 64-byte Ed25519 signature; it is base64-encoded here.
 *
 * `opts.nowMs` / `opts.nonce` override the clock / nonce for deterministic tests.
 */
export async function signAuthorityRpc(
  fields: { harnessSlug: string; kind: string; payload: unknown; device_pubkey: string },
  sign: (bytes: Buffer) => Promise<Buffer>,
  opts?: { nowMs?: number; nonce?: string },
): Promise<AuthorityRpcAuth> {
  const ts = opts?.nowMs ?? Date.now();
  const nonce = opts?.nonce ?? randomNonce();
  const signed: AuthorityRpcSignedFields = { ...fields, ts, nonce };
  const sig = (await sign(authorityRpcSigningBytes(signed))).toString('base64');
  return { device_pubkey: fields.device_pubkey, ts, nonce, sig };
}

/**
 * Verify a signed authority RPC: the `auth.sig` verifies against
 * `auth.device_pubkey` over the canonical signing bytes of (env op fields +
 * auth identity fields), AND `auth.ts` is within `windowMs` of `nowMs`. Returns
 * false on any tamper, stale/future ts, malformed input, or missing auth —
 * NEVER throws.
 *
 * NOTE this proves only that the caller controls `device_pubkey` and that the op
 * fields are unmodified + fresh. AUTHORIZATION (is this pubkey admitted, not
 * revoked, and does it match the op's holderPubkey?) is the caller's job — see
 * the route's `verifyCaller`.
 */
export function verifyAuthorityRpc(
  env: { harnessSlug: string; kind: string; payload: unknown },
  auth: AuthorityRpcAuth | undefined,
  opts?: { nowMs?: number; windowMs?: number },
): boolean {
  try {
    if (!auth || typeof auth !== 'object') return false;
    if (
      typeof auth.device_pubkey !== 'string' ||
      typeof auth.ts !== 'number' ||
      typeof auth.nonce !== 'string' ||
      typeof auth.sig !== 'string'
    ) {
      return false;
    }

    const nowMs = opts?.nowMs ?? Date.now();
    const windowMs = opts?.windowMs ?? DEFAULT_AUTHORITY_RPC_WINDOW_MS;
    if (Math.abs(nowMs - auth.ts) > windowMs) return false;

    const rawPubkey = Buffer.from(auth.device_pubkey, 'base64');
    if (rawPubkey.length !== 32) return false;
    const spkiDer = Buffer.concat([SPKI_PREFIX, rawPubkey]);
    const publicKey = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

    const bytes = authorityRpcSigningBytes({
      harnessSlug: env.harnessSlug,
      kind: env.kind,
      payload: env.payload,
      device_pubkey: auth.device_pubkey,
      ts: auth.ts,
      nonce: auth.nonce,
    });
    return nodeVerify(null, bytes, publicKey, Buffer.from(auth.sig, 'base64'));
  } catch {
    return false;
  }
}

/** Sign with a raw PKCS8 private-key DER — convenience for tests + rigs that
 *  hold the keypair directly (production uses the injected keychain signer). */
export function signAuthorityRpcWithPrivateKeyDer(privateKeyDer: Buffer, bytes: Buffer): Buffer {
  const key = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  return nodeSign(null, bytes, key);
}

function randomNonce(): string {
  return randomBytes(12).toString('base64');
}
