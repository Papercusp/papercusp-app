/**
 * P2P artifact distribution protocol (P-015).
 *
 * This is the DEFINITION layer that P-025 (IPFS/IPLD/libp2p content
 * distribution), P-027 (private encrypted access) and P-019 (the pilot) build
 * on. It is pure and provider-neutral by construction:
 *
 *  - D-025 forbids any commerce/governance/distribution fact from depending on
 *    R2 URLs, gateway URLs, or a particular blob provider. A source is
 *    therefore a `{ providerId, class, locator }` descriptor whose `locator` is
 *    OPAQUE here — this module never parses, fetches, or ranks it by shape. A
 *    later libp2p/IPFS provider is a new `providerId`, not a protocol change.
 *  - D-024 keeps the hosted/R2-compatible store as today's delivery path while
 *    the signed manifest, content hash and release identity are preserved for a
 *    later migration. That store shows up here as an ordinary source whose
 *    class is `origin`, and a CDN in front of it as class `cache`. A `cache`
 *    source is NEVER authoritative (`isAuthoritativeSource`) — it may only ever
 *    accelerate bytes whose hash an authoritative source already committed to.
 *
 * The event log mirrors `./commerce-events` deliberately: the same signed,
 * canonically-digested envelope, the same idempotent/quarantining fold. Facts
 * are append-only, so yank and revoke ADD a fact rather than mutating one, and
 * the reducer refuses to un-yank a release.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { validateListingManifest, type CupboardReleaseManifest } from '../cupboard/listing-manifest';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;

export const DISTRIBUTION_EVENT_KINDS = [
  'release-published',
  'peer-advertised',
  'peer-withdrawn',
  'pin-committed',
  'pin-released',
  'cache-mirrored',
  'key-rotated',
  'yanked',
  'revoked',
] as const;
export type DistributionEventKind = (typeof DISTRIBUTION_EVENT_KINDS)[number];

/** Where bytes may come from. `cache` is an accelerator, never an authority. */
export const DISTRIBUTION_SOURCE_CLASSES = ['pinner', 'peer', 'origin', 'cache'] as const;
export type DistributionSourceClass = (typeof DISTRIBUTION_SOURCE_CLASSES)[number];

/** Preference order used when resolving sources; lower sorts first. */
const SOURCE_CLASS_RANK: Readonly<Record<DistributionSourceClass, number>> = {
  pinner: 0,
  peer: 1,
  origin: 2,
  cache: 3,
};

export function isAuthoritativeSource(source: { readonly class: DistributionSourceClass }): boolean {
  return source.class !== 'cache';
}

export interface DistributionSource {
  readonly sourceId: string;
  readonly class: DistributionSourceClass;
  /** Adapter id (`libp2p`, `r2`, `memory`, …). Opaque routing key, not a URL. */
  readonly providerId: string;
  /** Provider-specific address. Opaque to this protocol — never parsed here. */
  readonly locator: string;
  readonly advertisedAtMs: number;
  /** `null` = no self-declared expiry; the policy TTL still applies. */
  readonly expiresAtMs: number | null;
}

/** One chunk of a CAR/chunked package (P-025 materializes these). */
export interface ArtifactChunk {
  readonly index: number;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

/**
 * Private-listing envelope (P-027 implements the crypto).
 *
 * Only key IDENTIFIERS travel in the log: wrapped key material is delivered
 * per-entitlement out of band, so replicating the event log to a peer never
 * leaks the ability to decrypt.
 */
export interface EncryptionEnvelope {
  readonly scheme: 'aes-256-gcm';
  readonly keyVersion: number;
  /** Hash of the CIPHERTEXT actually distributed (differs from the plaintext release hash). */
  readonly ciphertextHash: string;
  readonly wrappedKeyIds: readonly string[];
}

export interface PinningPolicy {
  /** Replicas required across AUTHORITATIVE sources before a release is healthy. */
  readonly minReplicas: number;
  /** How long an advertisement is trusted without refresh. */
  readonly advertisementTtlMs: number;
  /** How long a pinned client may serve offline without re-reading the log. */
  readonly offlineGraceMs: number;
  /** Bytes are retained this long after a yank so in-flight installs converge. */
  readonly yankRetentionMs: number;
}

export const DEFAULT_PINNING_POLICY: PinningPolicy = {
  minReplicas: 2,
  advertisementTtlMs: 24 * 60 * 60 * 1000,
  offlineGraceMs: 7 * 24 * 60 * 60 * 1000,
  yankRetentionMs: 72 * 60 * 60 * 1000,
};

/**
 * The signed, content-addressed distribution manifest.
 *
 * It EMBEDS the P-006 release manifest rather than restating version,
 * dependency, permission or publisher metadata, so the two can never disagree.
 */
export interface ArtifactDistributionManifest {
  readonly schemaVersion: 1;
  readonly release: CupboardReleaseManifest;
  /**
   * Root hash of the bytes that are actually distributed: the release
   * contentHash for a public listing, the ciphertext hash for a private one.
   */
  readonly rootHash: string;
  readonly totalSizeBytes: number;
  readonly chunks: readonly ArtifactChunk[];
  readonly visibility: 'public' | 'private';
  readonly encryption: EncryptionEnvelope | null;
  readonly pinning: PinningPolicy;
  readonly signature: string;
}

export interface DistributionEvent {
  readonly eventId: string;
  readonly streamId: string;
  readonly kind: DistributionEventKind;
  readonly version: 1;
  readonly issuer: string;
  readonly sequence: number;
  readonly occurredAtMs: number;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Base64 signature over `distributionEventSigningBytes` (added by the caller). */
  readonly signature: string;
}

/** Release identity → stream identity. Deterministic, so peers agree without coordination. */
export function distributionStreamId(release: {
  readonly listingKind: string;
  readonly listingRef: string;
  readonly releaseVersion: string;
}): string {
  return `dist:${release.listingKind}:${release.listingRef}@${release.releaseVersion}`;
}

export function distributionEventSigningBytes(event: Omit<DistributionEvent, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(event), 'utf8');
}

export function distributionEventDigest(event: Omit<DistributionEvent, 'signature'>): string {
  return createHash('sha256').update(distributionEventSigningBytes(event)).digest('hex');
}

/** Strip the signature so a signed event can be re-digested. */
export function unsignedDistributionEvent(event: DistributionEvent): Omit<DistributionEvent, 'signature'> {
  const { signature: _signature, ...unsigned } = event;
  void _signature;
  return unsigned;
}

export function distributionManifestSigningBytes(manifest: Omit<ArtifactDistributionManifest, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

export function distributionManifestDigest(manifest: Omit<ArtifactDistributionManifest, 'signature'>): string {
  return createHash('sha256').update(distributionManifestSigningBytes(manifest)).digest('hex');
}

export type DistributionManifestErrorCode =
  | 'invalid-shape'
  | 'unsupported-version'
  | 'invalid-release'
  | 'invalid-hash'
  | 'invalid-chunks'
  | 'chunk-size-mismatch'
  | 'invalid-visibility'
  | 'encryption-mismatch'
  | 'invalid-policy'
  | 'missing-signature';

export function validateDistributionManifest(
  raw: unknown,
): { ok: true; manifest: ArtifactDistributionManifest } | { ok: false; code: DistributionManifestErrorCode; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid-shape', detail: 'manifest must be an object' };
  const m = raw as Partial<ArtifactDistributionManifest>;
  if (m.schemaVersion !== 1) return { ok: false, code: 'unsupported-version', detail: 'schemaVersion must be 1' };
  const release = validateListingManifest(m.release);
  if (!release.ok) return { ok: false, code: 'invalid-release', detail: `embedded release manifest is invalid: ${release.detail}` };
  if (typeof m.rootHash !== 'string' || !SHA256_RE.test(m.rootHash)) return { ok: false, code: 'invalid-hash', detail: 'rootHash must be sha256:<64 hex characters>' };
  if (!Number.isSafeInteger(m.totalSizeBytes) || (m.totalSizeBytes as number) <= 0) return { ok: false, code: 'invalid-chunks', detail: 'totalSizeBytes must be a positive integer' };
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) return { ok: false, code: 'invalid-chunks', detail: 'chunks must be a non-empty array' };
  let summed = 0;
  for (const [index, chunk] of m.chunks.entries()) {
    if (!chunk || typeof chunk !== 'object' || chunk.index !== index) return { ok: false, code: 'invalid-chunks', detail: `chunk ${index} must be an object whose index equals its position` };
    if (typeof chunk.contentHash !== 'string' || !SHA256_RE.test(chunk.contentHash)) return { ok: false, code: 'invalid-hash', detail: `chunk ${index} contentHash must be sha256:<64 hex characters>` };
    if (!Number.isSafeInteger(chunk.sizeBytes) || chunk.sizeBytes <= 0) return { ok: false, code: 'invalid-chunks', detail: `chunk ${index} sizeBytes must be a positive integer` };
    summed += chunk.sizeBytes;
  }
  if (summed !== m.totalSizeBytes) return { ok: false, code: 'chunk-size-mismatch', detail: `chunk sizes sum to ${summed}, manifest declared ${m.totalSizeBytes}` };
  if (m.visibility !== 'public' && m.visibility !== 'private') return { ok: false, code: 'invalid-visibility', detail: 'visibility must be public or private' };
  const encryptionError = validateEncryption(m.visibility, m.encryption ?? null, m.rootHash, release.manifest.contentHash);
  if (encryptionError) return { ok: false, code: 'encryption-mismatch', detail: encryptionError };
  const policyError = validatePinningPolicy(m.pinning);
  if (policyError) return { ok: false, code: 'invalid-policy', detail: policyError };
  if (typeof m.signature !== 'string' || !m.signature.trim()) return { ok: false, code: 'missing-signature', detail: 'signature is required' };
  return { ok: true, manifest: m as ArtifactDistributionManifest };
}

function validateEncryption(
  visibility: 'public' | 'private',
  encryption: EncryptionEnvelope | null,
  rootHash: string,
  releaseContentHash: string,
): string | null {
  if (visibility === 'public') {
    if (encryption) return 'a public listing must not carry an encryption envelope';
    if (rootHash.toLowerCase() !== releaseContentHash.toLowerCase()) return 'a public rootHash must equal the release contentHash';
    return null;
  }
  if (!encryption || typeof encryption !== 'object') return 'a private listing requires an encryption envelope';
  if (encryption.scheme !== 'aes-256-gcm') return `unsupported encryption scheme '${String(encryption.scheme)}'`;
  if (!Number.isSafeInteger(encryption.keyVersion) || encryption.keyVersion < 1) return 'encryption.keyVersion must be an integer >= 1';
  if (typeof encryption.ciphertextHash !== 'string' || !SHA256_RE.test(encryption.ciphertextHash)) return 'encryption.ciphertextHash must be sha256:<64 hex characters>';
  if (!Array.isArray(encryption.wrappedKeyIds) || encryption.wrappedKeyIds.some((id) => typeof id !== 'string' || !id.trim())) return 'encryption.wrappedKeyIds must be a string[]';
  if (rootHash.toLowerCase() !== encryption.ciphertextHash.toLowerCase()) return 'a private rootHash must equal encryption.ciphertextHash';
  if (rootHash.toLowerCase() === releaseContentHash.toLowerCase()) return 'a private rootHash must differ from the plaintext release contentHash';
  return null;
}

function validatePinningPolicy(policy: unknown): string | null {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return 'pinning must be an object';
  const p = policy as Partial<PinningPolicy>;
  for (const key of ['minReplicas', 'advertisementTtlMs', 'offlineGraceMs', 'yankRetentionMs'] as const) {
    const value = p[key];
    if (!Number.isSafeInteger(value) || (value as number) < 0) return `pinning.${key} must be a non-negative integer`;
  }
  if ((p.minReplicas as number) < 1) return 'pinning.minReplicas must be at least 1';
  return null;
}

export type DistributionEventValidationCode =
  | 'invalid-shape'
  | 'invalid-kind'
  | 'invalid-sequence'
  | 'invalid-time'
  | 'missing-idempotency-key'
  | 'missing-signature';

export function validateDistributionEvent(
  event: unknown,
): { ok: true; event: DistributionEvent } | { ok: false; code: DistributionEventValidationCode; detail: string } {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { ok: false, code: 'invalid-shape', detail: 'event must be an object' };
  const e = event as Partial<DistributionEvent>;
  if (typeof e.eventId !== 'string' || !e.eventId.trim() || typeof e.streamId !== 'string' || !e.streamId.trim() || typeof e.issuer !== 'string' || !e.issuer.trim() || !e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) {
    return { ok: false, code: 'invalid-shape', detail: 'eventId, streamId, issuer, and object payload are required' };
  }
  if (!DISTRIBUTION_EVENT_KINDS.includes(e.kind as DistributionEventKind)) return { ok: false, code: 'invalid-kind', detail: `unsupported distribution event kind '${String(e.kind)}'` };
  if (e.version !== 1 || !Number.isSafeInteger(e.sequence) || (e.sequence as number) < 0) return { ok: false, code: 'invalid-sequence', detail: 'version must be 1 and sequence must be a non-negative safe integer' };
  if (!Number.isFinite(e.occurredAtMs) || (e.occurredAtMs as number) < 0) return { ok: false, code: 'invalid-time', detail: 'occurredAtMs must be a non-negative finite number' };
  if (typeof e.idempotencyKey !== 'string' || !e.idempotencyKey.trim()) return { ok: false, code: 'missing-idempotency-key', detail: 'idempotencyKey is required' };
  if (typeof e.signature !== 'string' || !e.signature.trim()) return { ok: false, code: 'missing-signature', detail: 'signature is required' };
  return { ok: true, event: e as DistributionEvent };
}

export interface DistributionConflict {
  readonly streamId: string;
  readonly sequence: number;
  readonly eventIds: string[];
  readonly reason: 'sequence-conflict' | 'idempotency-conflict';
}

export interface ArtifactDistributionState {
  readonly streamId: string;
  readonly manifest: ArtifactDistributionManifest | null;
  readonly sources: readonly DistributionSource[];
  /** Source ids that committed to hold a pin (a superset relation with `sources`). */
  readonly pins: readonly string[];
  readonly keyVersion: number;
  readonly revokedKeyVersions: readonly number[];
  readonly yankedAtMs: number | null;
  readonly yankReason: string | null;
  readonly lastSequence: number;
}

export interface DistributionReduction {
  readonly states: readonly ArtifactDistributionState[];
  readonly accepted: readonly DistributionEvent[];
  readonly duplicates: readonly string[];
  readonly conflicts: readonly DistributionConflict[];
  readonly invalid: ReadonlyArray<{ eventId: string | null; code: DistributionEventValidationCode }>;
  /** Accepted facts the projection could not apply (e.g. an un-yank attempt). */
  readonly ignored: ReadonlyArray<{ eventId: string; reason: 'immutable-yank' | 'unknown-source' | 'malformed-payload' }>;
}

/**
 * Deterministically fold an unordered batch of distribution facts.
 *
 * Exact event ids are idempotent retries. Two different facts claiming the same
 * stream sequence, or the same issuer idempotency key, are QUARANTINED rather
 * than merged — a peer replicating a conflicting log cannot silently rewrite
 * another peer's history.
 */
export function reduceDistributionEvents(events: readonly unknown[]): DistributionReduction {
  const valid: DistributionEvent[] = [];
  const invalid: Array<{ eventId: string | null; code: DistributionEventValidationCode }> = [];
  for (const raw of events) {
    const result = validateDistributionEvent(raw);
    if (result.ok) valid.push(result.event);
    else invalid.push({ eventId: raw && typeof raw === 'object' && 'eventId' in raw ? String((raw as { eventId?: unknown }).eventId ?? '') || null : null, code: result.code });
  }

  const byId = new Map<string, DistributionEvent>();
  const bySequence = new Map<string, DistributionEvent>();
  const byIdempotency = new Map<string, DistributionEvent>();
  const duplicates: string[] = [];
  const conflicts: DistributionConflict[] = [];
  const conflicted = new Set<string>();

  for (const event of valid) {
    const prior = byId.get(event.eventId);
    if (prior) {
      if (distributionEventDigest(unsignedDistributionEvent(prior)) === distributionEventDigest(unsignedDistributionEvent(event))) duplicates.push(event.eventId);
      else {
        conflicts.push({ streamId: event.streamId, sequence: event.sequence, eventIds: [prior.eventId, event.eventId].sort(), reason: 'sequence-conflict' });
        conflicted.add(event.eventId);
        conflicted.add(prior.eventId);
      }
      continue;
    }
    byId.set(event.eventId, event);
    const sequenceKey = `${event.streamId}\0${event.sequence}`;
    const priorSequence = bySequence.get(sequenceKey);
    if (priorSequence && priorSequence.eventId !== event.eventId) {
      conflicts.push({ streamId: event.streamId, sequence: event.sequence, eventIds: [priorSequence.eventId, event.eventId].sort(), reason: 'sequence-conflict' });
      conflicted.add(event.eventId);
      conflicted.add(priorSequence.eventId);
    } else bySequence.set(sequenceKey, event);
    const idemKey = `${event.issuer}\0${event.idempotencyKey}`;
    const priorIdem = byIdempotency.get(idemKey);
    if (priorIdem && priorIdem.eventId !== event.eventId) {
      conflicts.push({ streamId: event.streamId, sequence: event.sequence, eventIds: [priorIdem.eventId, event.eventId].sort(), reason: 'idempotency-conflict' });
      conflicted.add(event.eventId);
      conflicted.add(priorIdem.eventId);
    } else byIdempotency.set(idemKey, event);
  }

  const accepted = [...byId.values()]
    .filter((event) => !conflicted.has(event.eventId))
    .sort((a, b) => a.streamId.localeCompare(b.streamId) || a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));

  const ignored: Array<{ eventId: string; reason: 'immutable-yank' | 'unknown-source' | 'malformed-payload' }> = [];
  const projections = new Map<string, MutableState>();
  for (const event of accepted) {
    let state = projections.get(event.streamId);
    if (!state) {
      state = emptyState(event.streamId);
      projections.set(event.streamId, state);
    }
    applyEvent(state, event, ignored);
    state.lastSequence = Math.max(state.lastSequence, event.sequence);
  }

  const states = [...projections.values()]
    .map(freezeState)
    .sort((a, b) => a.streamId.localeCompare(b.streamId));
  return { states, accepted, duplicates, conflicts, invalid, ignored };
}

interface MutableState {
  streamId: string;
  manifest: ArtifactDistributionManifest | null;
  sources: Map<string, DistributionSource>;
  pins: Set<string>;
  keyVersion: number;
  revokedKeyVersions: Set<number>;
  yankedAtMs: number | null;
  yankReason: string | null;
  lastSequence: number;
}

function emptyState(streamId: string): MutableState {
  return { streamId, manifest: null, sources: new Map(), pins: new Set(), keyVersion: 0, revokedKeyVersions: new Set(), yankedAtMs: null, yankReason: null, lastSequence: -1 };
}

function freezeState(state: MutableState): ArtifactDistributionState {
  return {
    streamId: state.streamId,
    manifest: state.manifest,
    sources: [...state.sources.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    pins: [...state.pins].sort(),
    keyVersion: state.keyVersion,
    revokedKeyVersions: [...state.revokedKeyVersions].sort((a, b) => a - b),
    yankedAtMs: state.yankedAtMs,
    yankReason: state.yankReason,
    lastSequence: state.lastSequence,
  };
}

function readSource(payload: Readonly<Record<string, unknown>>, occurredAtMs: number): DistributionSource | null {
  const raw = (payload.source ?? payload) as Partial<DistributionSource>;
  if (typeof raw.sourceId !== 'string' || !raw.sourceId.trim()) return null;
  if (!DISTRIBUTION_SOURCE_CLASSES.includes(raw.class as DistributionSourceClass)) return null;
  if (typeof raw.providerId !== 'string' || !raw.providerId.trim() || typeof raw.locator !== 'string' || !raw.locator.trim()) return null;
  const expiresAtMs = raw.expiresAtMs;
  return {
    sourceId: raw.sourceId,
    class: raw.class as DistributionSourceClass,
    providerId: raw.providerId,
    locator: raw.locator,
    advertisedAtMs: Number.isSafeInteger(raw.advertisedAtMs) ? (raw.advertisedAtMs as number) : occurredAtMs,
    expiresAtMs: Number.isSafeInteger(expiresAtMs) ? (expiresAtMs as number) : null,
  };
}

function applyEvent(state: MutableState, event: DistributionEvent, ignored: Array<{ eventId: string; reason: 'immutable-yank' | 'unknown-source' | 'malformed-payload' }>): void {
  // A yank is terminal for OFFICIAL delivery: once recorded, no later fact may
  // re-advertise, re-mirror or otherwise resume it. Revocation of a key version
  // is still permitted so a yanked private release can be locked down further.
  if (state.yankedAtMs !== null && event.kind !== 'revoked' && event.kind !== 'yanked') {
    ignored.push({ eventId: event.eventId, reason: 'immutable-yank' });
    return;
  }
  switch (event.kind) {
    case 'release-published': {
      const result = validateDistributionManifest(event.payload.manifest);
      if (!result.ok) {
        ignored.push({ eventId: event.eventId, reason: 'malformed-payload' });
        return;
      }
      state.manifest = result.manifest;
      state.keyVersion = result.manifest.encryption?.keyVersion ?? 0;
      return;
    }
    case 'peer-advertised':
    case 'cache-mirrored':
    case 'pin-committed': {
      const source = readSource(event.payload, event.occurredAtMs);
      if (!source) {
        ignored.push({ eventId: event.eventId, reason: 'malformed-payload' });
        return;
      }
      if (event.kind === 'cache-mirrored' && source.class !== 'cache') {
        ignored.push({ eventId: event.eventId, reason: 'malformed-payload' });
        return;
      }
      state.sources.set(source.sourceId, source);
      if (event.kind === 'pin-committed') state.pins.add(source.sourceId);
      return;
    }
    case 'peer-withdrawn':
    case 'pin-released': {
      const sourceId = typeof event.payload.sourceId === 'string' ? event.payload.sourceId : null;
      if (!sourceId) {
        ignored.push({ eventId: event.eventId, reason: 'malformed-payload' });
        return;
      }
      if (!state.sources.has(sourceId) && !state.pins.has(sourceId)) {
        ignored.push({ eventId: event.eventId, reason: 'unknown-source' });
        return;
      }
      state.pins.delete(sourceId);
      if (event.kind === 'peer-withdrawn') state.sources.delete(sourceId);
      return;
    }
    case 'key-rotated': {
      const keyVersion = event.payload.keyVersion;
      if (!Number.isSafeInteger(keyVersion) || (keyVersion as number) <= state.keyVersion) {
        ignored.push({ eventId: event.eventId, reason: 'malformed-payload' });
        return;
      }
      state.keyVersion = keyVersion as number;
      return;
    }
    case 'revoked': {
      const keyVersion = event.payload.keyVersion;
      if (!Number.isSafeInteger(keyVersion) || (keyVersion as number) < 1) {
        ignored.push({ eventId: event.eventId, reason: 'malformed-payload' });
        return;
      }
      state.revokedKeyVersions.add(keyVersion as number);
      return;
    }
    case 'yanked': {
      if (state.yankedAtMs !== null) return; // idempotent; the first yank stands
      state.yankedAtMs = event.occurredAtMs;
      state.yankReason = typeof event.payload.reason === 'string' && event.payload.reason.trim() ? event.payload.reason : null;
      return;
    }
  }
}

export interface PinHealth {
  readonly replicas: number;
  readonly minReplicas: number;
  readonly healthy: boolean;
  readonly deficit: number;
}

/**
 * Pin health counts AUTHORITATIVE, unexpired replicas only: a CDN mirror can
 * make a release fast but can never make it durable, so counting caches would
 * report a single-origin release as replicated.
 */
export function evaluatePinHealth(state: ArtifactDistributionState, nowMs: number): PinHealth {
  const policy = state.manifest?.pinning ?? DEFAULT_PINNING_POLICY;
  const replicas = state.sources.filter((source) => isAuthoritativeSource(source) && !isSourceExpired(source, policy, nowMs)).length;
  return { replicas, minReplicas: policy.minReplicas, healthy: replicas >= policy.minReplicas, deficit: Math.max(0, policy.minReplicas - replicas) };
}

export function isSourceExpired(source: DistributionSource, policy: PinningPolicy, nowMs: number): boolean {
  if (source.expiresAtMs !== null && nowMs >= source.expiresAtMs) return true;
  return nowMs >= source.advertisedAtMs + policy.advertisementTtlMs;
}

export type DistributionResolutionReason =
  | 'ok'
  | 'no-manifest'
  | 'yanked'
  | 'yank-retention-expired'
  | 'no-sources'
  | 'offline-no-pin'
  | 'key-revoked';

/**
 * Why a caller wants these bytes.
 *
 * Lives here, beside the yank rule it selects, rather than in the Cupboard
 * layer: a yank refuses a NEW acquisition but must keep serving a `repair` of
 * a version already on disk (D-007), and that decision has to be made in the
 * one place deliverability is decided (D-040 ruling 4) or the two answers drift.
 */
export const DELIVERY_INTENTS = ['install', 'update', 'repair'] as const;
export type DeliveryIntent = (typeof DELIVERY_INTENTS)[number];

export interface DistributionResolution {
  readonly deliverable: boolean;
  readonly reason: DistributionResolutionReason;
  /** Ordered best-first: pinner, peer, origin, then cache. */
  readonly sources: readonly DistributionSource[];
  readonly pinHealth: PinHealth;
}

export interface ResolveOptions {
  readonly nowMs: number;
  /** Offline clients may only use sources they already pin. */
  readonly offline?: boolean;
  /** Entitlement key version held by the caller, for private listings. */
  readonly keyVersion?: number;
  /**
   * Why the bytes are wanted. Defaults to `'install'` — fail-closed, so a
   * caller who does not say is treated as making a new acquisition and is
   * refused by a yank, rather than slipping past one by omission.
   */
  readonly intent?: DeliveryIntent;
}

/**
 * Decide whether — and from where — a release may be delivered right now.
 *
 * Provider-neutral by construction: ordering is by source CLASS and freshness,
 * never by locator shape, so adding an IPFS provider changes nothing here.
 */
export function resolveDistributionSources(state: ArtifactDistributionState, options: ResolveOptions): DistributionResolution {
  const { nowMs, offline = false, keyVersion, intent = 'install' } = options;
  const policy = state.manifest?.pinning ?? DEFAULT_PINNING_POLICY;
  const pinHealth = evaluatePinHealth(state, nowMs);

  let candidates = state.sources.filter((source) => !isSourceExpired(source, policy, nowMs));
  if (offline) candidates = candidates.filter((source) => state.pins.includes(source.sourceId));
  const sources = [...candidates].sort(
    (a, b) => SOURCE_CLASS_RANK[a.class] - SOURCE_CLASS_RANK[b.class] || b.advertisedAtMs - a.advertisedAtMs || a.sourceId.localeCompare(b.sourceId),
  );

  const refuse = (reason: DistributionResolutionReason): DistributionResolution => ({ deliverable: false, reason, sources, pinHealth });
  if (!state.manifest) return refuse('no-manifest');
  if (state.yankedAtMs !== null) {
    // A yank withdraws the version from NEW acquisition, but must not brick an
    // install that already works: a `repair` keeps resolving until the
    // retention window closes. Key revocation below is deliberately NOT
    // relaxed the same way — a yank is the publisher withdrawing a version,
    // a revocation is the buyer's right ending, which is terminal for every
    // intent.
    const yank = yankOutcome(state);
    if (intent !== 'repair') return refuse('yanked');
    if (yank.retainUntilMs !== null && nowMs > yank.retainUntilMs) return refuse('yank-retention-expired');
  }
  if (keyVersion !== undefined && state.revokedKeyVersions.includes(keyVersion)) return refuse('key-revoked');
  if (sources.length === 0) return refuse(offline ? 'offline-no-pin' : 'no-sources');
  return { deliverable: true, reason: 'ok', sources, pinHealth };
}

export interface YankOutcome {
  readonly yanked: boolean;
  readonly officialDeliveryStopped: boolean;
  /** Pinners keep bytes until this instant so in-flight installs converge. */
  readonly retainUntilMs: number | null;
  /**
   * A public content-addressed artifact that peers already copied cannot be
   * deleted by any protocol fact. A yank stops OFFICIAL delivery and says so
   * honestly rather than implying erasure.
   */
  readonly publicCopiesUnrecallable: boolean;
  readonly reason: string | null;
}

export function yankOutcome(state: ArtifactDistributionState): YankOutcome {
  const policy = state.manifest?.pinning ?? DEFAULT_PINNING_POLICY;
  if (state.yankedAtMs === null) {
    return { yanked: false, officialDeliveryStopped: false, retainUntilMs: null, publicCopiesUnrecallable: false, reason: null };
  }
  return {
    yanked: true,
    officialDeliveryStopped: true,
    retainUntilMs: state.yankedAtMs + policy.yankRetentionMs,
    publicCopiesUnrecallable: state.manifest?.visibility !== 'private',
    reason: state.yankReason,
  };
}
