/**
 * Private artifact access: content encryption and key lifecycle (P-027).
 *
 * P-015 (`./artifact-distribution`) declared the shape of a private listing —
 * the `EncryptionEnvelope`, the `keyVersion` / `revokedKeyVersions` projection,
 * and the `key-revoked` resolution refusal — but nothing computed a ciphertext,
 * wrapped a key, or rotated one. P-025 (`./artifact-package`) then made
 * packaging deliberately BYTE-AGNOSTIC. This module closes the remaining gap:
 * it performs the actual AES-256-GCM encryption, wraps the content key per
 * entitlement through an injected adapter, and governs rotation and revocation.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — the seams it respects:
 *
 *  1. It never re-decides DELIVERABILITY. `resolveDistributionSources` is the
 *     single authority for whether bytes may be handed over (D-040 ruling 4).
 *     This module decides only whether a key may be UNWRAPPED, which is a
 *     different question asked at a different moment: delivery authorization
 *     never decrypts, and decryption never re-authorizes delivery. A caller
 *     that skips the resolver and calls `unwrapContentKey` directly has not
 *     obtained a delivery decision, and this module does not pretend otherwise.
 *
 *  2. It never persists key material. `KeyWrapAdapter` and
 *     `WrappedKeyDeliveryAdapter` are registrations looked up by `providerId`
 *     (D-040 ruling 5), so the content key, the wrapped blobs, and the
 *     recipients' private keys all live outside this layer. No decentralized
 *     provider is deployed (D-024) and P-026 was dropped (D-038), so every seam
 *     here is pure and injected exactly as P-015 and P-025 are.
 *
 *  3. It never re-chunks. A private publication encrypts first and then calls
 *     `buildArtifactPackage(ciphertext)`, so the package's `rootHash` IS the
 *     `encryption.ciphertextHash` by construction rather than by assertion —
 *     which is what `validateDistributionManifest` already enforces for a
 *     `visibility:'private'` manifest (D-035 ruling 4).
 *
 * Prior art considered and rejected, so the next reader need not re-derive it:
 * `sync/hyperbee/hive-epoch-crypto.ts` has the right adapter SHAPE (and this
 * module mirrors its wrap/unwrap seam on purpose) but is keyed by
 * `(potId, epoch)` against a device keychain, which is not a per-release
 * artifact key; `personal-vault/archive-encryption.ts` is a streaming archive
 * format with its own header and chunk framing, which would collide with the
 * P-025 chunking that must produce the manifest's chunk list.
 *
 * THE HONESTY REQUIREMENT. D-035 ruling 3 made yank honest about public copies:
 * bytes peers already hold cannot be recalled by any protocol fact, and
 * `yankOutcome.publicCopiesUnrecallable` says so instead of implying erasure.
 * Revocation owes the same honesty for private listings, and it is the more
 * tempting lie: revoking a key version stops FUTURE unwraps and FUTURE
 * deliveries, but a holder who already unwrapped a key and already holds the
 * ciphertext can still decrypt it forever. `revocationOutcome` reports that as
 * `priorPlaintextUnrecallable` and tells the publisher what actually restores
 * confidentiality — rotating to a new key version and re-encrypting, which is
 * the only thing that denies a revoked holder the NEXT release's bytes.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ArtifactDistributionState, EncryptionEnvelope } from './artifact-distribution';
import { DEFAULT_CHUNK_SIZE_BYTES, type ArtifactPackage, buildArtifactPackage } from './artifact-package';
import type { CupboardReleaseManifest } from '../cupboard/listing-manifest';

/** AES-256 content key length. */
export const CONTENT_KEY_BYTES = 32;
/** GCM nonce length: 96 bits is the size the mode is defined for. */
export const IV_BYTES = 12;
/** GCM authentication tag length. */
export const AUTH_TAG_BYTES = 16;
/** Framing version, so a future scheme is distinguishable rather than ambiguous. */
export const ENCRYPTED_BLOB_VERSION = 1;
/** version(1) || iv(12) || authTag(16) — the fixed prefix of a distributed blob. */
export const ENCRYPTED_BLOB_HEADER_BYTES = 1 + IV_BYTES + AUTH_TAG_BYTES;

/** The only scheme this module implements; matches `EncryptionEnvelope['scheme']`. */
export const ARTIFACT_ENCRYPTION_SCHEME = 'aes-256-gcm' as const;

const WRAPPED_KEY_ID_TAG = 'papercusp:artifact-wrapped-key:v1';
const AAD_TAG = 'papercusp:artifact-aad:v1';

/** Identity a ciphertext is cryptographically bound to. */
export interface ArtifactKeyBinding {
  /** The PLAINTEXT release content hash, i.e. `CupboardReleaseManifest.contentHash`. */
  readonly releaseContentHash: string;
  readonly keyVersion: number;
}

/**
 * Additional authenticated data binding a ciphertext to one release and one key
 * version. A blob lifted from release A cannot be presented as release B's, and
 * a blob encrypted under key version 3 cannot be replayed as version 4: GCM
 * authentication fails rather than yielding attacker-chosen plaintext.
 */
export function artifactEncryptionAad(binding: ArtifactKeyBinding): Buffer {
  return Buffer.from(
    JSON.stringify({
      tag: AAD_TAG,
      releaseContentHash: binding.releaseContentHash.toLowerCase(),
      keyVersion: binding.keyVersion,
    }),
    'utf8',
  );
}

function assertContentKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== CONTENT_KEY_BYTES) {
    throw new Error(`content key must be exactly ${CONTENT_KEY_BYTES} bytes`);
  }
}

function assertKeyVersion(keyVersion: number): void {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new Error('keyVersion must be an integer >= 1');
  }
}

/** Fresh AES-256 content key. Never persisted by this module. */
export function generateContentKey(): Buffer {
  return randomBytes(CONTENT_KEY_BYTES);
}

/**
 * The content address of some bytes: P-025's MERKLE root over their chunk
 * digests, which is what `CupboardReleaseManifest.contentHash` holds.
 *
 * NOT `sha256(bytes)`. The two never coincide — not even for a single chunk,
 * since `merkleRoot([h]) !== h` — so computing the obvious flat digest here
 * would make every plaintext check below fail against a correctly published
 * release (EI-22433992128803548, measured on the real modules).
 *
 * Chunk size participates in the address, so a caller whose release was
 * packaged at a non-default size must say so. It defaults to
 * `DEFAULT_CHUNK_SIZE_BYTES`, the size a release is packaged at unless a
 * publisher chose otherwise, and is deliberately independent of the chunk size
 * used for the CIPHERTEXT: how a private artifact is chunked for transport must
 * not change the identity of the release it decrypts to.
 */
export function plaintextContentAddress(plaintext: Buffer, chunkSizeBytes: number = DEFAULT_CHUNK_SIZE_BYTES): string {
  return buildArtifactPackage(plaintext, { chunkSizeBytes }).rootHash;
}

export interface EncryptedArtifact {
  /** The distributable blob: version || iv || authTag || ciphertext. */
  readonly bytes: Buffer;
  readonly keyVersion: number;
  readonly scheme: typeof ARTIFACT_ENCRYPTION_SCHEME;
}

/**
 * There is deliberately NO `ciphertextHash` on this type.
 *
 * A content address for the ciphertext exists exactly once, and P-025 owns it:
 * `buildArtifactPackage` computes a MERKLE root over the chunk digests, which
 * is what the manifest's `rootHash` is. `EncryptionEnvelope.ciphertextHash` is
 * that same address — `validateDistributionManifest` requires the two to be
 * equal (D-035 ruling 4) — so it is filled from the package, never from a flat
 * digest computed here. Returning a second, differently-derived "hash of the
 * ciphertext" would produce two addresses for one artifact that agree on
 * nothing, and the manifest invariant would fail for a publication that is in
 * fact correct.
 */

/**
 * Encrypt an artifact for private distribution.
 *
 * The returned `bytes` are self-describing, so a retriever needs only the key
 * and the binding to open them — no out-of-band nonce or tag plumbing, and
 * therefore no way for those to be lost or mismatched in transit.
 */
export function encryptArtifact(
  plaintext: Buffer,
  contentKey: Buffer,
  binding: ArtifactKeyBinding,
  options: { readonly iv?: Buffer } = {},
): EncryptedArtifact {
  assertContentKey(contentKey);
  assertKeyVersion(binding.keyVersion);
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0) {
    throw new Error('encryptArtifact requires at least one plaintext byte');
  }
  const iv = options.iv ?? randomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new Error(`iv must be exactly ${IV_BYTES} bytes`);

  const cipher = createCipheriv('aes-256-gcm', contentKey, iv);
  cipher.setAAD(artifactEncryptionAad(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const version = Buffer.alloc(1);
  version.writeUInt8(ENCRYPTED_BLOB_VERSION, 0);
  const bytes = Buffer.concat([version, iv, authTag, ciphertext]);

  return { bytes, keyVersion: binding.keyVersion, scheme: ARTIFACT_ENCRYPTION_SCHEME };
}

export type ArtifactDecryptCode =
  | 'malformed-blob'
  | 'unsupported-version'
  | 'auth-failed'
  | 'key-revoked'
  | 'plaintext-hash-mismatch';

export type ArtifactDecryption =
  | { readonly ok: true; readonly plaintext: Buffer }
  | { readonly ok: false; readonly code: ArtifactDecryptCode; readonly detail: string };

/**
 * Decrypt retrieved bytes.
 *
 * This runs AFTER `completeRetrieval` has verified the ciphertext against the
 * manifest's chunk hashes — integrity of the transferred bytes is P-025's job,
 * and confidentiality is this one's. The final plaintext-hash check closes the
 * loop the other way: bytes that authenticate under the key but do not hash to
 * the release's declared `contentHash` are refused, so a publisher cannot
 * quietly ship a private payload that differs from the release it signed.
 */
export function decryptArtifact(
  bytes: Buffer,
  contentKey: Buffer,
  binding: ArtifactKeyBinding,
  options: { readonly revokedKeyVersions?: readonly number[]; readonly plaintextChunkSizeBytes?: number } = {},
): ArtifactDecryption {
  assertContentKey(contentKey);
  assertKeyVersion(binding.keyVersion);

  if (options.revokedKeyVersions?.includes(binding.keyVersion)) {
    return { ok: false, code: 'key-revoked', detail: `key version ${binding.keyVersion} is revoked` };
  }
  if (!Buffer.isBuffer(bytes) || bytes.length <= ENCRYPTED_BLOB_HEADER_BYTES) {
    return { ok: false, code: 'malformed-blob', detail: 'blob is shorter than its own header' };
  }
  const version = bytes.readUInt8(0);
  if (version !== ENCRYPTED_BLOB_VERSION) {
    return { ok: false, code: 'unsupported-version', detail: `unsupported blob version ${version}` };
  }

  const iv = bytes.subarray(1, 1 + IV_BYTES);
  const authTag = bytes.subarray(1 + IV_BYTES, ENCRYPTED_BLOB_HEADER_BYTES);
  const ciphertext = bytes.subarray(ENCRYPTED_BLOB_HEADER_BYTES);

  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', contentKey, iv);
    decipher.setAAD(artifactEncryptionAad(binding));
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return { ok: false, code: 'auth-failed', detail: 'ciphertext failed authentication under this key and binding' };
  }

  const actual = plaintextContentAddress(plaintext, options.plaintextChunkSizeBytes);
  if (actual.toLowerCase() !== binding.releaseContentHash.toLowerCase()) {
    return {
      ok: false,
      code: 'plaintext-hash-mismatch',
      detail: `decrypted bytes hash to ${actual}, release declared ${binding.releaseContentHash}`,
    };
  }
  return { ok: true, plaintext };
}

/**
 * The published identifier for one recipient's wrapped key.
 *
 * Blinded on purpose. It is derived from the release, the key version and the
 * recipient, so an entitled holder can compute their OWN id and confirm the
 * manifest lists it, while a reader of the log learns neither who is entitled
 * nor whether the same recipient appears on another release: changing either
 * the release or the key version changes every id. Only these identifiers ever
 * reach the event log; the wrapped material is delivered out of band.
 */
export function wrappedKeyId(input: {
  readonly releaseContentHash: string;
  readonly keyVersion: number;
  readonly recipientId: string;
}): string {
  assertKeyVersion(input.keyVersion);
  if (!input.recipientId.trim()) throw new Error('recipientId must be a non-empty string');
  const preimage = JSON.stringify({
    tag: WRAPPED_KEY_ID_TAG,
    releaseContentHash: input.releaseContentHash.toLowerCase(),
    keyVersion: input.keyVersion,
    recipientId: input.recipientId,
  });
  return `wk_${createHash('sha256').update(preimage, 'utf8').digest('hex')}`;
}

/** One recipient's wrapped content key. `wrapped` is MATERIAL — never log or persist it here. */
export interface WrappedKey {
  readonly wrappedKeyId: string;
  readonly recipientId: string;
  readonly keyVersion: number;
  readonly wrapped: Buffer;
}

/**
 * Injected key-wrapping provider (mirrors the `HiveEpochCrypto` seam).
 *
 * A registration looked up by `providerId`, never a branch on the recipient's
 * shape, so adding an HSM or a device-keychain provider changes nothing here.
 */
export interface KeyWrapAdapter {
  readonly providerId: string;
  wrap(input: { readonly contentKey: Buffer; readonly recipientId: string; readonly keyVersion: number }): Promise<Buffer>;
  unwrap(input: { readonly wrapped: Buffer; readonly recipientId: string; readonly keyVersion: number }): Promise<Buffer>;
}

/** Out-of-band delivery of wrapped key material, per entitlement. */
export interface WrappedKeyDeliveryAdapter {
  readonly providerId: string;
  deliver(key: WrappedKey): Promise<void>;
  fetch(input: { readonly wrappedKeyId: string; readonly recipientId: string }): Promise<Buffer | null>;
}

export interface AdapterRegistry<T extends { readonly providerId: string }> {
  readonly providerIds: readonly string[];
  get(providerId: string): T | null;
}

function createRegistry<T extends { readonly providerId: string }>(adapters: readonly T[], label: string): AdapterRegistry<T> {
  const byId = new Map<string, T>();
  for (const adapter of adapters) {
    if (!adapter.providerId.trim()) throw new Error(`${label} providerId must be a non-empty string`);
    if (byId.has(adapter.providerId)) throw new Error(`duplicate ${label} providerId '${adapter.providerId}'`);
    byId.set(adapter.providerId, adapter);
  }
  return {
    providerIds: [...byId.keys()].sort(),
    get: (providerId: string) => byId.get(providerId) ?? null,
  };
}

export function createKeyWrapRegistry(adapters: readonly KeyWrapAdapter[] = []): AdapterRegistry<KeyWrapAdapter> {
  return createRegistry(adapters, 'key wrap adapter');
}

export function createWrappedKeyDeliveryRegistry(
  adapters: readonly WrappedKeyDeliveryAdapter[] = [],
): AdapterRegistry<WrappedKeyDeliveryAdapter> {
  return createRegistry(adapters, 'wrapped key delivery adapter');
}

/** Wrap one content key for each entitled recipient. */
export async function wrapContentKeyForRecipients(input: {
  readonly contentKey: Buffer;
  readonly recipientIds: readonly string[];
  readonly releaseContentHash: string;
  readonly keyVersion: number;
  readonly adapter: KeyWrapAdapter;
}): Promise<readonly WrappedKey[]> {
  assertContentKey(input.contentKey);
  assertKeyVersion(input.keyVersion);
  const seen = new Set<string>();
  const wrappedKeys: WrappedKey[] = [];
  for (const recipientId of input.recipientIds) {
    if (seen.has(recipientId)) throw new Error(`duplicate recipientId '${recipientId}'`);
    seen.add(recipientId);
    const wrapped = await input.adapter.wrap({ contentKey: input.contentKey, recipientId, keyVersion: input.keyVersion });
    wrappedKeys.push({
      wrappedKeyId: wrappedKeyId({ releaseContentHash: input.releaseContentHash, keyVersion: input.keyVersion, recipientId }),
      recipientId,
      keyVersion: input.keyVersion,
      wrapped,
    });
  }
  return wrappedKeys;
}

export type UnwrapFailureCode = 'key-revoked' | 'not-entitled' | 'unwrap-failed' | 'wrong-key-length';

export type UnwrapResult =
  | { readonly ok: true; readonly contentKey: Buffer }
  | { readonly ok: false; readonly code: UnwrapFailureCode; readonly detail: string };

/**
 * Recover the content key from a recipient's wrapped blob.
 *
 * Refuses a revoked key version, and refuses a blob whose identifier is not the
 * one this release/version/recipient triple derives — a holder cannot present
 * another listing's wrapped key here. This is a DECRYPTION decision only; it
 * says nothing about whether the bytes may be delivered, which remains
 * `resolveDistributionSources`' sole call.
 */
export async function unwrapContentKey(input: {
  readonly wrapped: Buffer;
  readonly recipientId: string;
  readonly keyVersion: number;
  readonly releaseContentHash: string;
  readonly envelope: Pick<EncryptionEnvelope, 'wrappedKeyIds'>;
  readonly adapter: KeyWrapAdapter;
  readonly revokedKeyVersions?: readonly number[];
}): Promise<UnwrapResult> {
  assertKeyVersion(input.keyVersion);
  if (input.revokedKeyVersions?.includes(input.keyVersion)) {
    return { ok: false, code: 'key-revoked', detail: `key version ${input.keyVersion} is revoked` };
  }
  const expectedId = wrappedKeyId({
    releaseContentHash: input.releaseContentHash,
    keyVersion: input.keyVersion,
    recipientId: input.recipientId,
  });
  if (!input.envelope.wrappedKeyIds.includes(expectedId)) {
    return { ok: false, code: 'not-entitled', detail: 'no wrapped key for this recipient at this key version' };
  }

  let contentKey: Buffer;
  try {
    contentKey = await input.adapter.unwrap({ wrapped: input.wrapped, recipientId: input.recipientId, keyVersion: input.keyVersion });
  } catch (error) {
    return { ok: false, code: 'unwrap-failed', detail: error instanceof Error ? error.message : 'unwrap threw' };
  }
  if (!Buffer.isBuffer(contentKey) || contentKey.length !== CONTENT_KEY_BYTES) {
    return { ok: false, code: 'wrong-key-length', detail: `adapter returned ${Buffer.isBuffer(contentKey) ? contentKey.length : 0} bytes` };
  }
  return { ok: true, contentKey };
}

/** Constant-time content-key comparison, for callers verifying a rotation actually changed the key. */
export function contentKeysEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type KeyRotationCode = 'ok' | 'not-forward' | 'revoked-target';

export type KeyRotationPlan =
  | { readonly ok: true; readonly nextKeyVersion: number; readonly supersedes: number }
  | { readonly ok: false; readonly code: Exclude<KeyRotationCode, 'ok'>; readonly detail: string };

/**
 * Plan a FORWARD-ONLY key rotation.
 *
 * Key versions only ever increase. Reusing or rewinding one would let a revoked
 * holder's still-valid wrapped key match a fresh ciphertext, which is precisely
 * what revocation is supposed to prevent — so it is refused here rather than
 * left to a caller to remember.
 */
export function planKeyRotation(
  state: Pick<ArtifactDistributionState, 'keyVersion' | 'revokedKeyVersions'>,
  options: { readonly requestedKeyVersion?: number } = {},
): KeyRotationPlan {
  const current = state.keyVersion;
  const next = options.requestedKeyVersion ?? current + 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    return { ok: false, code: 'not-forward', detail: 'requested key version must be an integer >= 1' };
  }
  if (next <= current) {
    return { ok: false, code: 'not-forward', detail: `key version ${next} does not advance past the current ${current}` };
  }
  if (state.revokedKeyVersions.includes(next)) {
    return { ok: false, code: 'revoked-target', detail: `key version ${next} is revoked and cannot be reused` };
  }
  return { ok: true, nextKeyVersion: next, supersedes: current };
}

export interface RevocationOutcome {
  readonly revoked: boolean;
  /** No further wrapped keys may be unwrapped at a revoked version. */
  readonly futureUnwrapStopped: boolean;
  /**
   * True when the CURRENT key version was revoked: the listing cannot serve a
   * new entitlement until a rotation issues a fresh version.
   */
  readonly requiresRotation: boolean;
  /** The version a rotation would produce, or null when no rotation is required. */
  readonly rotateToKeyVersion: number | null;
  /**
   * Honest counterpart of `yankOutcome.publicCopiesUnrecallable`.
   *
   * A holder who already unwrapped a key and already holds the ciphertext can
   * decrypt it forever; no protocol fact takes that back. Revocation denies
   * FUTURE access — including to bytes published under the next key version —
   * and this field refuses to imply otherwise.
   */
  readonly priorPlaintextUnrecallable: boolean;
  readonly revokedKeyVersions: readonly number[];
}

export function revocationOutcome(
  state: Pick<ArtifactDistributionState, 'keyVersion' | 'revokedKeyVersions'>,
): RevocationOutcome {
  const revokedKeyVersions = [...state.revokedKeyVersions].sort((a, b) => a - b);
  if (revokedKeyVersions.length === 0) {
    return {
      revoked: false,
      futureUnwrapStopped: false,
      requiresRotation: false,
      rotateToKeyVersion: null,
      priorPlaintextUnrecallable: false,
      revokedKeyVersions,
    };
  }
  const currentRevoked = revokedKeyVersions.includes(state.keyVersion);
  const rotation = currentRevoked ? planKeyRotation(state) : null;
  return {
    revoked: true,
    futureUnwrapStopped: true,
    requiresRotation: currentRevoked,
    rotateToKeyVersion: rotation?.ok ? rotation.nextKeyVersion : null,
    priorPlaintextUnrecallable: true,
    revokedKeyVersions,
  };
}

export interface PrivateArtifactPublication {
  /** Chunked over the CIPHERTEXT, so `package.rootHash === encryption.ciphertextHash`. */
  readonly package: ArtifactPackage;
  readonly encryption: EncryptionEnvelope;
  readonly ciphertext: Buffer;
  /** Material for out-of-band delivery. Deliberately NOT part of the manifest. */
  readonly wrappedKeys: readonly WrappedKey[];
}

/**
 * Encrypt, package and wrap in one pass.
 *
 * The composition is the point: because the package is built from the very
 * bytes that were encrypted, the private-manifest invariants
 * `validateDistributionManifest` enforces (`rootHash === ciphertextHash`, and
 * `rootHash !== release.contentHash`) hold by construction, and a caller cannot
 * assemble a manifest whose declared root disagrees with the bytes it ships.
 */
export async function publishPrivateArtifact(input: {
  readonly plaintext: Buffer;
  readonly release: Pick<CupboardReleaseManifest, 'contentHash'>;
  readonly contentKey: Buffer;
  readonly keyVersion: number;
  readonly recipientIds: readonly string[];
  readonly adapter: KeyWrapAdapter;
  readonly chunkSizeBytes?: number;
  readonly plaintextChunkSizeBytes?: number;
  readonly iv?: Buffer;
}): Promise<PrivateArtifactPublication> {
  const binding: ArtifactKeyBinding = { releaseContentHash: input.release.contentHash, keyVersion: input.keyVersion };
  const plaintextAddress = plaintextContentAddress(input.plaintext, input.plaintextChunkSizeBytes);
  if (plaintextAddress.toLowerCase() !== input.release.contentHash.toLowerCase()) {
    throw new Error(`plaintext addresses to ${plaintextAddress}, release manifest declared ${input.release.contentHash}`);
  }
  const encrypted = encryptArtifact(input.plaintext, input.contentKey, binding, { iv: input.iv });

  const pkg = buildArtifactPackage(encrypted.bytes, { chunkSizeBytes: input.chunkSizeBytes });
  const wrappedKeys = await wrapContentKeyForRecipients({
    contentKey: input.contentKey,
    recipientIds: input.recipientIds,
    releaseContentHash: input.release.contentHash,
    keyVersion: input.keyVersion,
    adapter: input.adapter,
  });

  return {
    package: pkg,
    encryption: {
      scheme: ARTIFACT_ENCRYPTION_SCHEME,
      keyVersion: input.keyVersion,
      // The ONE content address, taken from the package rather than recomputed:
      // this is what makes `rootHash === ciphertextHash` true by construction.
      ciphertextHash: pkg.rootHash,
      wrappedKeyIds: wrappedKeys.map((key) => key.wrappedKeyId),
    },
    ciphertext: encrypted.bytes,
    wrappedKeys,
  };
}

/** Deliver wrapped keys out of band. Returns the identifiers delivered, never the material. */
export async function deliverWrappedKeys(input: {
  readonly wrappedKeys: readonly WrappedKey[];
  readonly adapter: WrappedKeyDeliveryAdapter;
}): Promise<readonly string[]> {
  const delivered: string[] = [];
  for (const key of input.wrappedKeys) {
    await input.adapter.deliver(key);
    delivered.push(key.wrappedKeyId);
  }
  return delivered;
}

export type OpenArtifactCode = UnwrapFailureCode | ArtifactDecryptCode | 'no-wrapped-key';

export type OpenArtifactResult =
  | { readonly ok: true; readonly plaintext: Buffer }
  | { readonly ok: false; readonly code: OpenArtifactCode; readonly detail: string };

/**
 * The recipient's end-to-end path, run AFTER `completeRetrieval` returned bytes.
 *
 * Fetches the wrapped key out of band, unwraps it, and decrypts — refusing at
 * whichever step the entitlement actually fails, so a caller gets the real
 * reason rather than an undifferentiated failure.
 */
export async function openRetrievedArtifact(input: {
  readonly ciphertext: Buffer;
  readonly recipientId: string;
  readonly keyVersion: number;
  readonly release: Pick<CupboardReleaseManifest, 'contentHash'>;
  readonly envelope: Pick<EncryptionEnvelope, 'wrappedKeyIds'>;
  readonly wrapAdapter: KeyWrapAdapter;
  readonly deliveryAdapter: WrappedKeyDeliveryAdapter;
  readonly revokedKeyVersions?: readonly number[];
}): Promise<OpenArtifactResult> {
  const releaseContentHash = input.release.contentHash;
  if (input.revokedKeyVersions?.includes(input.keyVersion)) {
    return { ok: false, code: 'key-revoked', detail: `key version ${input.keyVersion} is revoked` };
  }

  const id = wrappedKeyId({ releaseContentHash, keyVersion: input.keyVersion, recipientId: input.recipientId });
  const wrapped = await input.deliveryAdapter.fetch({ wrappedKeyId: id, recipientId: input.recipientId });
  if (!wrapped) return { ok: false, code: 'no-wrapped-key', detail: 'no wrapped key was delivered to this recipient' };

  const unwrap = await unwrapContentKey({
    wrapped,
    recipientId: input.recipientId,
    keyVersion: input.keyVersion,
    releaseContentHash,
    envelope: input.envelope,
    adapter: input.wrapAdapter,
    revokedKeyVersions: input.revokedKeyVersions,
  });
  if (!unwrap.ok) return unwrap;

  return decryptArtifact(
    input.ciphertext,
    unwrap.contentKey,
    { releaseContentHash, keyVersion: input.keyVersion },
    { revokedKeyVersions: input.revokedKeyVersions },
  );
}
