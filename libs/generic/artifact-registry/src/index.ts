/**
 * @papercusp/artifact-registry — a generic artifact registry: publish/install
 * distributable artifacts (plugins, snapshots, blueprints, package versions…)
 * over a pluggable storage backend.
 *
 * Two composable layers, each behind a small port so the host injects its own
 * backend + domain (the documented `configure*()`/seam convention):
 *
 *   • Content-addressed blob store — the bytes. `BlobStore` port (head/put/get/
 *     delete) over R2 / S3 / fs / memory; `putContentAddressed` (hash-verified,
 *     idempotent), `getContentAddressed` (visibility-gated), `gcIfUnreferenced`
 *     (refcounted GC). This is the "publish/install over a pluggable storage
 *     backend" core.
 *
 *   • Artifact registry — the metadata. `ListingStore` port over Postgres /
 *     SQLite / memory; `ArtifactRegistry` runs the listing lifecycle (publish +
 *     dedupe, get, list, unlist + blob GC, claim) with the domain — kinds,
 *     identity/trust, validation, dedupe key — injected as policies.
 *
 * Zero coupling: no Cloudflare, no SQL, no HTTP framework, no auth provider.
 * Web-Crypto only — runs in Node 18+, Workers, Deno, browsers. The first host is
 * the Papercusp "Cupboard" worker (D1 + R2 + GitHub mapped onto these seams).
 */

// Content addressing
export {
  HEX_SHA256_RE,
  isHexSha256,
  sha256Hex,
  contentAddressing,
  canonicalTreeDigest,
  GIT_OBJECT_ID_RE,
  type ContentAddressing,
  type TreeDigestEntry,
} from "./content-address.js";

// Content-defined chunking — split bytes so shared runs dedupe under a chunk-hash store
export {
  contentDefinedChunkBoundaries,
  contentDefinedChunks,
  DEFAULT_CDC_AVG_SIZE,
  type ContentDefinedChunkOptions,
} from "./content-defined-chunks.js";

// Content-addressed blob store (Layer A — the storage backend)
export {
  putContentAddressed,
  getContentAddressed,
  gcIfUnreferenced,
  memoryBlobStore,
  type BlobStore,
  type BlobPutOptions,
  type ArtifactStatus,
  type PutBlobInput,
  type PutBlobResult,
  type GetBlobInput,
  type GetBlobResult,
} from "./blob-store.js";

// Artifact registry (Layer B — the metadata + lifecycle)
export {
  ArtifactRegistry,
  type ListingStore,
  type PrincipalRef,
  type ValidationResult,
  type ArtifactRegistryPolicies,
  type ArtifactRegistryOptions,
  type PublishResult,
  type UnlistResult,
  type ClaimResult,
} from "./registry.js";

// Runtime-neutral content identity gate (Worker + operator publish paths).
export {
  collectIdentityValues,
  isIdentityFieldName,
  scanIdentityLeaks,
  type ContentIdentityLeakHit,
  type ContentIdentityLeakKind,
  type ContentIdentityScanOptions,
} from "./content-identity.js";
