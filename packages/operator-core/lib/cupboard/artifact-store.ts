/**
 * Provider-neutral Cupboard artifact store seam (P-007).
 *
 * D-024 defers decentralized blob storage but requires that the
 * "signed manifest, content hash, release identity, entitlement check, and
 * provider-neutral ArtifactStore seam required for a later migration" be
 * preserved while the hosted/R2-compatible store remains the delivery path.
 * This module is that seam.
 *
 * Deliberately transport-agnostic. The repo already moves artifact bytes two
 * different ways — the operator-public worker proxies them through an R2
 * binding (`env.ARTIFACTS.put` / `createMultipartUpload`), while a direct
 * client upload needs a presigned URL — so upload is modelled as a TICKET
 * whose `transport` the adapter declares. "Presigned" is therefore an adapter
 * capability, not a property of the interface, and a later IPFS/Filecoin/Storj
 * provider slots in without changing callers.
 *
 * No module-scoped mutable state and no `configure*()` singleton: an
 * `ArtifactStore` is passed in explicitly, matching the `Deps` convention used
 * by `publisher-attestation.ts` and `publish-manifest-check.ts` in this
 * directory.
 */

/** Content-addressed key prefix, mirroring `WORKSPACE_HOST_ARTIFACT_PREFIX`. */
export const CUPBOARD_ARTIFACT_PREFIX = 'artifacts/cupboard/sha256';

/** How the caller must send bytes for a given ticket. */
export type ArtifactUploadTransport =
  | 'presigned-put'
  | 'presigned-multipart'
  | 'proxied-put'
  | 'proxied-multipart';

/** Transports that hand the caller a URL it uploads to directly. */
export function isPresignedTransport(transport: ArtifactUploadTransport): boolean {
  return transport === 'presigned-put' || transport === 'presigned-multipart';
}

export interface ArtifactStoreCapabilities {
  /** Adapter can mint direct-to-storage URLs (S3-compatible signing). */
  readonly presigned: boolean;
  /** Adapter can split an upload into parts. */
  readonly multipart: boolean;
  /** Largest single object the adapter accepts, in bytes. */
  readonly maxObjectBytes: number;
}

/** The artifact a release manifest points at. */
export interface ArtifactRef {
  /** `sha256:<64 hex>` — the SAME value carried by `CupboardReleaseManifest.contentHash`. */
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface ArtifactUploadTicket {
  readonly transport: ArtifactUploadTransport;
  readonly storageKey: string;
  readonly contentHash: string;
  /** Absent for proxied transports, where the caller posts to the operator instead. */
  readonly url?: string;
  readonly method?: 'PUT' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAtMs: number;
  /** Present only for multipart transports. */
  readonly maxPartBytes?: number;
}

export interface StoredArtifact {
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly contentType: string;
}

export interface ArtifactStore {
  /** Stable adapter id recorded in audit rows (e.g. `r2`, `memory`, `ipfs`). */
  readonly providerId: string;
  readonly capabilities: ArtifactStoreCapabilities;
  createUploadTicket(ref: ArtifactRef, nowMs: number): Promise<ArtifactUploadTicket>;
  head(storageKey: string): Promise<StoredArtifact | null>;
  delete(storageKey: string): Promise<void>;
}

export type ArtifactRefErrorCode =
  | 'invalid-hash'
  | 'invalid-size'
  | 'invalid-content-type'
  | 'too-large';

/**
 * Validate an artifact reference against an adapter's limits.
 *
 * The hash grammar is deliberately identical to
 * `validateListingManifest`'s `contentHash` rule so a ref and the manifest
 * that points at it can never disagree about what a content hash looks like.
 */
export function validateArtifactRef(
  raw: unknown,
  capabilities: ArtifactStoreCapabilities,
): { ok: true; ref: ArtifactRef } | { ok: false; code: ArtifactRefErrorCode; detail: string } {
  const r = (raw ?? {}) as Partial<ArtifactRef>;
  if (typeof r.contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/i.test(r.contentHash)) {
    return { ok: false, code: 'invalid-hash', detail: 'contentHash must be sha256:<64 hex characters>' };
  }
  if (!Number.isSafeInteger(r.sizeBytes) || (r.sizeBytes as number) <= 0) {
    return { ok: false, code: 'invalid-size', detail: 'sizeBytes must be a positive integer' };
  }
  if (typeof r.contentType !== 'string' || !r.contentType.trim()) {
    return { ok: false, code: 'invalid-content-type', detail: 'contentType is required' };
  }
  if ((r.sizeBytes as number) > capabilities.maxObjectBytes) {
    return {
      ok: false,
      code: 'too-large',
      detail: `sizeBytes ${r.sizeBytes} exceeds provider limit ${capabilities.maxObjectBytes}`,
    };
  }
  return {
    ok: true,
    ref: { contentHash: r.contentHash.toLowerCase(), sizeBytes: r.sizeBytes as number, contentType: r.contentType },
  };
}

/** Strip the `sha256:` scheme, lowercased. Assumes a validated hash. */
export function contentHashHex(contentHash: string): string {
  return contentHash.slice('sha256:'.length).toLowerCase();
}

/**
 * Derive the content-addressed storage key.
 *
 * Content addressing is what makes the seam migratable: the key is a pure
 * function of the bytes, so a later provider can be populated from the current
 * one without rewriting any manifest.
 */
export function cupboardArtifactKey(contentHash: string): string {
  return `${CUPBOARD_ARTIFACT_PREFIX}/${contentHashHex(contentHash)}`;
}

/** A ticket is unusable once it expires; callers must re-mint rather than retry. */
export function isTicketExpired(ticket: ArtifactUploadTicket, nowMs: number): boolean {
  return nowMs >= ticket.expiresAtMs;
}

export type ReleaseArtifactErrorCode =
  | 'missing-artifact'
  | 'hash-mismatch'
  | 'size-mismatch'
  | 'ticket-expired';

/**
 * Bind a signed manifest to bytes that are actually in the store.
 *
 * This is the integrity join P-007 exists to protect: the manifest DECLARES a
 * content hash, the store holds bytes at a content-addressed key, and publish
 * must not proceed unless the object the key resolves to is really present.
 * Without this check a manifest could be signed over a hash no artifact backs.
 */
export async function resolveReleaseArtifact(
  deps: { readonly store: ArtifactStore },
  manifest: { readonly contentHash: string },
  expectedSizeBytes?: number,
): Promise<
  | { ok: true; artifact: StoredArtifact; providerId: string }
  | { ok: false; code: ReleaseArtifactErrorCode; detail: string }
> {
  const storageKey = cupboardArtifactKey(manifest.contentHash);
  const artifact = await deps.store.head(storageKey);
  if (!artifact) {
    return { ok: false, code: 'missing-artifact', detail: `no artifact stored at ${storageKey}` };
  }
  if (artifact.storageKey !== storageKey) {
    return {
      ok: false,
      code: 'hash-mismatch',
      detail: `store returned ${artifact.storageKey} for ${storageKey}`,
    };
  }
  if (expectedSizeBytes !== undefined && artifact.sizeBytes !== expectedSizeBytes) {
    return {
      ok: false,
      code: 'size-mismatch',
      detail: `stored ${artifact.sizeBytes} bytes, manifest declared ${expectedSizeBytes}`,
    };
  }
  return { ok: true, artifact, providerId: deps.store.providerId };
}

export interface MemoryArtifactStoreOptions {
  readonly capabilities?: Partial<ArtifactStoreCapabilities>;
  readonly ticketTtlMs?: number;
  readonly providerId?: string;
}

/**
 * In-memory adapter for tests and for exercising the seam without a provider.
 * Not a production store: it keeps objects in a Map for the process lifetime.
 */
export function memoryArtifactStore(options: MemoryArtifactStoreOptions = {}): ArtifactStore & {
  put(ref: ArtifactRef): StoredArtifact;
  readonly objects: Map<string, StoredArtifact>;
} {
  const capabilities: ArtifactStoreCapabilities = {
    presigned: options.capabilities?.presigned ?? false,
    multipart: options.capabilities?.multipart ?? false,
    maxObjectBytes: options.capabilities?.maxObjectBytes ?? 512 * 1024 * 1024,
  };
  const ttl = options.ticketTtlMs ?? 15 * 60 * 1000;
  const objects = new Map<string, StoredArtifact>();
  return {
    providerId: options.providerId ?? 'memory',
    capabilities,
    objects,
    put(ref: ArtifactRef): StoredArtifact {
      const stored: StoredArtifact = {
        storageKey: cupboardArtifactKey(ref.contentHash),
        sizeBytes: ref.sizeBytes,
        contentType: ref.contentType,
      };
      objects.set(stored.storageKey, stored);
      return stored;
    },
    async createUploadTicket(ref: ArtifactRef, nowMs: number): Promise<ArtifactUploadTicket> {
      const storageKey = cupboardArtifactKey(ref.contentHash);
      const transport: ArtifactUploadTransport = capabilities.presigned
        ? capabilities.multipart
          ? 'presigned-multipart'
          : 'presigned-put'
        : capabilities.multipart
          ? 'proxied-multipart'
          : 'proxied-put';
      return {
        transport,
        storageKey,
        contentHash: ref.contentHash,
        url: isPresignedTransport(transport) ? `memory://${storageKey}` : undefined,
        method: 'PUT',
        headers: { 'content-type': ref.contentType },
        expiresAtMs: nowMs + ttl,
        maxPartBytes: capabilities.multipart ? 32 * 1024 * 1024 : undefined,
      };
    },
    async head(storageKey: string): Promise<StoredArtifact | null> {
      return objects.get(storageKey) ?? null;
    },
    async delete(storageKey: string): Promise<void> {
      objects.delete(storageKey);
    },
  };
}
