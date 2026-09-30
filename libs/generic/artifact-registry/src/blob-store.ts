/**
 * Content-addressed blob storage over a pluggable backend.
 *
 * This is the "publish/install over a pluggable storage backend" core: the bytes
 * of a distributable artifact (a snapshot tarball, a package archive, …) live in
 * a `BlobStore`, content-addressed by their SHA-256. The host injects the backend
 * — Cloudflare R2, S3, the local filesystem, an in-memory map — by implementing
 * the four-method `BlobStore` port. The algorithms here own the *policy*
 * (hash-verify on write, idempotent dedupe, visibility-gated read, refcounted
 * GC); the backend owns the *bytes*. HTTP framing / auth stay in the host adapter.
 *
 * PURE w.r.t. transport + backend. Web-Crypto only.
 */

import {
  isHexSha256,
  sha256Hex,
  type ContentAddressing,
} from "./content-address.js";

/** HTTP-ish status codes the helpers surface; the host maps them onto its transport. */
export type ArtifactStatus = 200 | 400 | 401 | 403 | 404 | 409 | 410 | 413 | 500;

export interface BlobPutOptions {
  /** Stored content-type, when the backend records one (e.g. R2 httpMetadata). */
  contentType?: string;
  /** Echo the content hash to a backend that re-validates bytes on write (R2 `sha256`). */
  sha256?: string;
}

/**
 * The pluggable storage backend. Four methods, all the registry needs of a blob
 * store. `TObject` is the backend's native read object (e.g. an `R2ObjectBody`
 * the host streams) — the helpers pass it straight back so the host keeps full
 * access to backend-specific streaming/metadata.
 */
export interface BlobStore<TObject = unknown> {
  /** Metadata probe — null if absent. Used for idempotent-PUT dedupe. */
  head(key: string): Promise<{ size: number } | null>;
  /** Store bytes at `key`. Content-addressed callers pass already-verified bytes. */
  put(key: string, body: ArrayBuffer | Uint8Array, opts?: BlobPutOptions): Promise<void>;
  /** Fetch the backend's native read object, or null if absent. */
  get(key: string): Promise<TObject | null>;
  /** Remove `key`. A no-op if absent. */
  delete(key: string): Promise<void>;
}

export type PutBlobResult =
  | { ok: true; key: string; bytes: number; deduped: boolean }
  | { ok: false; status: ArtifactStatus; error: string; detail?: Record<string, unknown> };

export interface PutBlobInput {
  /** The declared content hash (lowercase hex SHA-256). The key IS this hash. */
  hash: string;
  scheme: ContentAddressing;
  /** Deferred body read — only called after the idempotent-dedupe head check passes,
   *  so an already-stored blob skips buffering entirely. */
  readBody: () => Promise<ArrayBuffer>;
  /** Declared size (e.g. Content-Length) for an early reject before buffering. */
  declaredLength?: number | null;
  maxBytes: number;
  contentType?: string;
}

/**
 * Content-addressed PUT. Validates the hash shape, early-rejects on declared
 * oversize, dedupes against an existing object (idempotent — re-PUT of identical
 * content is a no-op), then buffers, re-verifies the bytes hash to the key, and
 * stores. The bytes MUST hash to `input.hash` or it's rejected (`sha_mismatch`).
 */
export async function putContentAddressed(store: BlobStore, input: PutBlobInput): Promise<PutBlobResult> {
  const { hash, scheme, readBody, declaredLength, maxBytes, contentType } = input;
  if (!isHexSha256(hash)) return { ok: false, status: 400, error: 'invalid_sha' };
  if (declaredLength != null && declaredLength > maxBytes) {
    return { ok: false, status: 413, error: 'too_large', detail: { max_bytes: maxBytes } };
  }
  const key = scheme.key(hash);

  // Idempotent: identical content already stored ⇒ no re-upload. (Content-
  // addressed, so an existing object with this key already hashes to `hash`.)
  const existing = await store.head(key);
  if (existing) return { ok: true, key, bytes: existing.size, deduped: true };

  const body = await readBody();
  const bytes = body.byteLength;
  if (bytes > maxBytes) return { ok: false, status: 413, error: 'too_large', detail: { max_bytes: maxBytes } };
  if (bytes === 0) return { ok: false, status: 400, error: 'empty_body' };

  const actual = await sha256Hex(body);
  if (actual !== hash) return { ok: false, status: 400, error: 'sha_mismatch', detail: { expected: hash, actual } };

  await store.put(key, body, { contentType, sha256: hash });
  return { ok: true, key, bytes, deduped: false };
}

export type GetBlobResult<TObject> =
  | { ok: true; key: string; object: TObject }
  | { ok: false; status: ArtifactStatus; error: string };

export interface GetBlobInput {
  hash: string;
  scheme: ContentAddressing;
  /**
   * Visibility gate: serve the blob only while a live record references the key.
   * Omit for an ungated public-read store. The key is passed so the host's
   * refcount lookup needs no closure over the scheme.
   */
  isReferenced?: (key: string) => Promise<boolean> | boolean;
}

/**
 * Content-addressed GET. Validates the hash shape, applies the optional
 * visibility gate, then returns the backend's native read object for the host to
 * stream. `not_found` covers both "no live reference" and "no stored bytes" — an
 * uploaded-but-unreferenced blob is indistinguishable from a missing one.
 */
export async function getContentAddressed<TObject>(
  store: BlobStore<TObject>,
  input: GetBlobInput,
): Promise<GetBlobResult<TObject>> {
  const { hash, scheme, isReferenced } = input;
  if (!isHexSha256(hash)) return { ok: false, status: 400, error: 'invalid_sha' };
  const key = scheme.key(hash);
  if (isReferenced && !(await isReferenced(key))) return { ok: false, status: 404, error: 'not_found' };
  const object = await store.get(key);
  if (!object) return { ok: false, status: 404, error: 'not_found' };
  return { ok: true, key, object };
}

/**
 * Refcounted blob GC: delete the blob at `key` iff it's no longer referenced.
 * Content-addressed keys are shared by every record that points at identical
 * bytes, so a sibling reference keeps the blob alive. Returns true iff it deleted.
 */
export async function gcIfUnreferenced(
  store: BlobStore,
  key: string,
  isStillReferenced: () => Promise<boolean> | boolean,
): Promise<boolean> {
  if (await isStillReferenced()) return false;
  await store.delete(key);
  return true;
}

/**
 * An in-memory `BlobStore` — the reference backend for tests + local borrows.
 * `data` is exposed so tests can assert on stored keys directly.
 */
export function memoryBlobStore(): BlobStore<{ body: Uint8Array; size: number }> & { data: Map<string, Uint8Array> } {
  const data = new Map<string, Uint8Array>();
  return {
    data,
    head: async (key) => (data.has(key) ? { size: data.get(key)!.byteLength } : null),
    put: async (key, body) => {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
      data.set(key, new Uint8Array(bytes)); // copy — decouple from the caller's buffer
    },
    get: async (key) => {
      const body = data.get(key);
      return body ? { body, size: body.byteLength } : null;
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}
