/** Canonical immutable Cupboard listing/release manifest (P-006). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import type { ListingKind } from './types';

export interface ListingCompatibility {
  readonly runtime?: string;
  readonly platforms?: readonly string[];
  readonly architectures?: readonly string[];
}

export interface ListingPublisher {
  readonly githubUserId: number;
  readonly login?: string;
  readonly devicePubkey?: string;
}

export interface CupboardReleaseManifest {
  readonly schemaVersion: 1;
  readonly listingKind: ListingKind;
  readonly listingRef: string;
  readonly releaseVersion: string;
  readonly contentHash: string;
  readonly signature: string;
  readonly dependencies: readonly string[];
  readonly compatibility: ListingCompatibility;
  readonly permissions: readonly string[];
  readonly capabilities: readonly string[];
  readonly license: string;
  readonly publisher: ListingPublisher;
  readonly reviewStatus: 'pending' | 'approved' | 'rejected';
}

export function listingManifestSigningBytes(manifest: Omit<CupboardReleaseManifest, 'signature'>): Buffer {
  return Buffer.from(canonicalJson(manifest), 'utf8');
}

export function listingManifestDigest(manifest: Omit<CupboardReleaseManifest, 'signature'>): string {
  return createHash('sha256').update(listingManifestSigningBytes(manifest)).digest('hex');
}

/** Strip the signature so a signed manifest can be re-digested (TS6 rejects the `signature: undefined as never` spread). */
export function unsignedListingManifest(manifest: CupboardReleaseManifest): Omit<CupboardReleaseManifest, 'signature'> {
  const { signature: _signature, ...unsigned } = manifest;
  void _signature;
  return unsigned;
}

export type ListingManifestErrorCode =
  | 'invalid-shape'
  | 'unsupported-version'
  | 'invalid-kind'
  | 'invalid-hash'
  | 'missing-signature'
  | 'invalid-publisher'
  | 'invalid-review-status'
  | 'invalid-array';

export function validateListingManifest(raw: unknown): { ok: true; manifest: CupboardReleaseManifest } | { ok: false; code: ListingManifestErrorCode; detail: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid-shape', detail: 'manifest must be an object' };
  const m = raw as Partial<CupboardReleaseManifest>;
  if (m.schemaVersion !== 1) return { ok: false, code: 'unsupported-version', detail: 'schemaVersion must be 1' };
  if (typeof m.listingKind !== 'string' || !m.listingKind || typeof m.listingRef !== 'string' || !m.listingRef.trim() || typeof m.releaseVersion !== 'string' || !m.releaseVersion.trim()) {
    return { ok: false, code: 'invalid-shape', detail: 'listingKind, listingRef, and releaseVersion are required' };
  }
  if (typeof m.contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(m.contentHash)) return { ok: false, code: 'invalid-hash', detail: 'contentHash must be sha256:<64 hex characters>' };
  if (typeof m.signature !== 'string' || !m.signature.trim()) return { ok: false, code: 'missing-signature', detail: 'signature is required' };
  if (!Array.isArray(m.dependencies) || !m.dependencies.every((v) => typeof v === 'string' && v.trim())) return { ok: false, code: 'invalid-array', detail: 'dependencies must be a string[]' };
  if (!Array.isArray(m.permissions) || !m.permissions.every((v) => typeof v === 'string' && v.trim()) || !Array.isArray(m.capabilities) || !m.capabilities.every((v) => typeof v === 'string' && v.trim())) return { ok: false, code: 'invalid-array', detail: 'permissions and capabilities must be string[]' };
  if (!m.compatibility || typeof m.compatibility !== 'object' || Array.isArray(m.compatibility)) return { ok: false, code: 'invalid-shape', detail: 'compatibility must be an object' };
  if (typeof m.license !== 'string' || !m.license.trim()) return { ok: false, code: 'invalid-shape', detail: 'license is required' };
  if (!m.publisher || typeof m.publisher !== 'object' || Array.isArray(m.publisher) || !Number.isSafeInteger(m.publisher.githubUserId) || m.publisher.githubUserId <= 0) return { ok: false, code: 'invalid-publisher', detail: 'publisher.githubUserId must be a positive integer' };
  if (m.reviewStatus !== 'pending' && m.reviewStatus !== 'approved' && m.reviewStatus !== 'rejected') return { ok: false, code: 'invalid-review-status', detail: 'reviewStatus must be pending, approved, or rejected' };
  return { ok: true, manifest: m as CupboardReleaseManifest };
}

/** Compare two manifests for immutable release identity. */
export function sameListingRelease(a: CupboardReleaseManifest, b: CupboardReleaseManifest): boolean {
  return a.listingKind === b.listingKind && a.listingRef === b.listingRef && a.releaseVersion === b.releaseVersion && a.contentHash.toLowerCase() === b.contentHash.toLowerCase();
}
