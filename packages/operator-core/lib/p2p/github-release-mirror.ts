/**
 * GitHub Releases as the PUBLIC MIRROR provider for public Cupboard releases
 * (P-045, D-056; replaces IPFS as the optional mirror named in D-053).
 *
 * D-056 permits GitHub for three things and no others — identity, AVAILABILITY
 * of public bytes, and a later public catalog mirror — and forbids it for
 * governance state, the commerce record and money. This module is the
 * availability half: it publishes an already-content-addressed package as a
 * Release asset and serves its chunks back by Merkle root.
 *
 * Four properties are load-bearing, each for a different reason:
 *
 *   1. THE ADDRESS DOES NOT CHANGE. The artifact is still addressed by the
 *      P-025 Merkle root (D-040 ruling 1, D-041); the GitHub coordinates are a
 *      `locator`, which the distribution protocol never parses (D-035 ruling 1,
 *      D-040 ruling 5). Adding this mirror is a `providerId` + an adapter, not
 *      a protocol change — no `github.com` URL enters a manifest, a
 *      distribution event, a commerce event or a governance fact (D-025/D-055).
 *
 *   2. IT IS A CACHE, NEVER AN AUTHORITY. The published source carries class
 *      `cache`, so `isAuthoritativeSource` excludes it from pin-health replica
 *      counting (D-035 ruling 2) and a `cache-mirrored` event accepts it. R2
 *      remains the hot copy; counting a third party's copy as a replica would
 *      report a single-origin release as replicated.
 *
 *   3. A PRIVATE RELEASE IS NEVER MIRRORED. D-022 encrypts private artifacts
 *      before publication, so mirroring one would leak only ciphertext — but a
 *      public Release asset cannot be recalled once copied (D-035 ruling 3's
 *      `publicCopiesUnrecallable`), and revocation works by withholding keys,
 *      not by deleting bytes. The refusal therefore runs FIRST, before the
 *      token check and before any network call, so no configuration and no
 *      credential can route a private artifact onto this path.
 *
 *   4. THE TOKEN IS AN OWNER-INSTALLED DEPLOY INPUT. A repo-scoped GitHub token
 *      is passed in by the caller (the hosted door reads it from an
 *      owner-installed secret, exactly like `STRIPE_SECRET_KEY` in P-038/P-010).
 *      This module never reads an environment variable and holds no default, so
 *      an unconfigured deployment fails CLOSED with `missing-token` instead of
 *      attempting an unauthenticated write.
 *
 * `fetchImpl` is injected rather than taken from the runtime so the whole
 * publish/fetch/verify path is exercisable without network access — the same
 * convention `buildApi({ fetchImpl })` already uses at the hosted door.
 */

import type { ArtifactStore, ArtifactStoreCapabilities, ArtifactUploadTicket, ArtifactRef, StoredArtifact } from '../cupboard/artifact-store';
import { contentHashHex, cupboardArtifactKey } from '../cupboard/artifact-store';
import type { ArtifactDistributionManifest, DistributionSource } from './artifact-distribution';
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  buildArtifactPackage,
  packageMatchesManifest,
  sha256Prefixed,
  validatePublishableRelease,
  type ArtifactProviderAdapter,
  type ChunkFetchRequest,
} from './artifact-package';

/** Routing key recorded on a `DistributionSource`. Opaque to the protocol. */
export const GITHUB_RELEASE_MIRROR_PROVIDER_ID = 'github-releases';

/** GitHub's per-asset ceiling on every plan, free included (D-056). */
export const GITHUB_RELEASE_ASSET_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_UPLOAD_BASE_URL = 'https://uploads.github.com';
const DEFAULT_DOWNLOAD_BASE_URL = 'https://github.com';
const DEFAULT_USER_AGENT = 'papercusp-cupboard-release-mirror';
const GITHUB_API_VERSION = '2022-11-28';

// ---------------------------------------------------------------------------
// Locator grammar (understood by THIS adapter and nothing else)
// ---------------------------------------------------------------------------

export interface GithubReleaseLocator {
  readonly owner: string;
  readonly repo: string;
  readonly tag: string;
  readonly asset: string;
}

export type GithubReleaseLocatorErrorCode = 'malformed-locator' | 'invalid-segment';

/**
 * `owner/repo/tag/asset`, exactly four segments.
 *
 * The protocol never parses this (D-040 ruling 5) — but the adapter must, so
 * the grammar is deliberately unambiguous: a segment may not contain `/`, which
 * is why the tag and asset names below are derived rather than free-form.
 */
export function formatGithubReleaseLocator(locator: GithubReleaseLocator): string {
  return `${locator.owner}/${locator.repo}/${locator.tag}/${locator.asset}`;
}

export function parseGithubReleaseLocator(
  raw: string,
): { ok: true; locator: GithubReleaseLocator } | { ok: false; code: GithubReleaseLocatorErrorCode; detail: string } {
  const segments = raw.split('/');
  if (segments.length !== 4) {
    return { ok: false, code: 'malformed-locator', detail: `expected owner/repo/tag/asset, received ${segments.length} segment(s)` };
  }
  const [owner, repo, tag, asset] = segments as [string, string, string, string];
  for (const [name, value] of [['owner', owner], ['repo', repo], ['tag', tag], ['asset', asset]] as const) {
    if (!value.trim()) return { ok: false, code: 'invalid-segment', detail: `${name} segment is empty` };
  }
  return { ok: true, locator: { owner, repo, tag, asset } };
}

/** Git tags cannot carry `:`, so the `sha256:` scheme becomes a `-`. */
export function githubReleaseTagForRoot(rootHash: string): string {
  return `cupboard-sha256-${contentHashHex(rootHash)}`;
}

export function githubReleaseAssetNameForRoot(rootHash: string): string {
  return `${contentHashHex(rootHash)}.cupboard-package`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface GithubReleaseMirrorDeps {
  readonly fetchImpl: typeof fetch;
  /** Repo-scoped token, installed by the OWNER at the hosted door. Never defaulted. */
  readonly token: string;
  readonly apiBaseUrl?: string;
  readonly uploadBaseUrl?: string;
  /** Where public bytes are read from — tokenless on purpose (D-056: peers read with their own credentials or none). */
  readonly downloadBaseUrl?: string;
  readonly userAgent?: string;
}

interface GithubReleaseRecord {
  readonly id: number;
  readonly assets: readonly { readonly id: number; readonly name: string; readonly size: number; readonly browser_download_url?: string }[];
}

function apiHeaders(deps: GithubReleaseMirrorDeps): Record<string, string> {
  return {
    authorization: `Bearer ${deps.token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': GITHUB_API_VERSION,
    'user-agent': deps.userAgent ?? DEFAULT_USER_AGENT,
  };
}

async function readErrorDetail(response: Response): Promise<string> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 500);
  } catch {
    body = '';
  }
  return `github responded ${response.status}${body ? `: ${body}` : ''}`;
}

async function findReleaseByTag(
  deps: GithubReleaseMirrorDeps,
  repo: { readonly owner: string; readonly repo: string },
  tag: string,
): Promise<{ ok: true; release: GithubReleaseRecord | null } | { ok: false; detail: string }> {
  const url = `${deps.apiBaseUrl ?? DEFAULT_API_BASE_URL}/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await deps.fetchImpl(url, { method: 'GET', headers: apiHeaders(deps) });
  if (response.status === 404) return { ok: true, release: null };
  if (!response.ok) return { ok: false, detail: await readErrorDetail(response) };
  const record = (await response.json()) as Partial<GithubReleaseRecord>;
  if (typeof record?.id !== 'number') return { ok: false, detail: 'github returned a release without a numeric id' };
  return { ok: true, release: { id: record.id, assets: Array.isArray(record.assets) ? record.assets : [] } };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export type GithubMirrorPublishCode =
  | 'private-not-mirrored'
  | 'missing-token'
  | 'invalid-repo'
  | 'invalid-manifest'
  | 'content-address-mismatch'
  | 'too-large'
  | 'github-error';

export interface GithubMirrorPublication {
  readonly ok: true;
  /** Ready to record on a `cache-mirrored` distribution event (D-035 ruling 2). */
  readonly source: DistributionSource;
  readonly locator: string;
  readonly tag: string;
  readonly assetName: string;
  /** True when the asset was already present — publication is idempotent. */
  readonly reused: boolean;
  readonly assetId: number | null;
  readonly downloadUrl: string | null;
}

export type GithubMirrorPublishResult =
  | GithubMirrorPublication
  | { readonly ok: false; readonly code: GithubMirrorPublishCode; readonly detail: string };

export interface GithubMirrorPublishInput {
  readonly manifest: ArtifactDistributionManifest;
  /** The distributed bytes, exactly as the manifest chunks them. */
  readonly bytes: Buffer;
  readonly repo: { readonly owner: string; readonly repo: string };
  readonly nowMs: number;
  /** Defaults to the P-025 protocol constant; must match how the manifest was chunked. */
  readonly chunkSizeBytes?: number;
  readonly sourceId?: string;
  readonly expiresAtMs?: number | null;
}

/**
 * Mirror one PUBLIC release's bytes to a GitHub Release asset.
 *
 * Every refusal that can be decided locally is decided BEFORE the first network
 * call, in this order: private (never mirrored, whatever the configuration),
 * token (fail closed), repo shape, size ceiling, then the content-address
 * agreement. `validatePublishableRelease` is reused rather than reimplemented so
 * this door cannot drift from the sanctioned publish check — and passing the
 * bytes makes a flat-digest address a PROVEN diagnosis rather than a guess.
 */
export async function publishGithubReleaseMirror(
  deps: GithubReleaseMirrorDeps,
  input: GithubMirrorPublishInput,
): Promise<GithubMirrorPublishResult> {
  if (input.manifest?.visibility === 'private') {
    return {
      ok: false,
      code: 'private-not-mirrored',
      detail: 'a private listing is never published to the public mirror (D-022/D-056); public copies cannot be recalled once taken',
    };
  }
  if (!deps.token?.trim()) {
    return { ok: false, code: 'missing-token', detail: 'no repo-scoped GitHub token is configured for the release mirror' };
  }
  if (!input.repo?.owner?.trim() || !input.repo?.repo?.trim() || input.repo.owner.includes('/') || input.repo.repo.includes('/')) {
    return { ok: false, code: 'invalid-repo', detail: 'repo must be { owner, repo }, neither containing a slash' };
  }
  if (input.bytes.length > GITHUB_RELEASE_ASSET_MAX_BYTES) {
    return {
      ok: false,
      code: 'too-large',
      detail: `${input.bytes.length} bytes exceeds the ${GITHUB_RELEASE_ASSET_MAX_BYTES}-byte Release asset limit`,
    };
  }

  const publishable = validatePublishableRelease(input.manifest, { bytes: input.bytes });
  if (!publishable.ok) {
    const code: GithubMirrorPublishCode =
      publishable.code === 'root-hash-mismatch' || publishable.code === 'total-size-mismatch' || publishable.code === 'chunk-hash-mismatch' || publishable.code === 'chunk-size-mismatch' || publishable.code === 'chunk-count-mismatch'
        ? 'content-address-mismatch'
        : 'invalid-manifest';
    return { ok: false, code, detail: `${publishable.code}: ${publishable.detail}` };
  }
  const manifest = publishable.manifest;

  // `validatePublishableRelease` proves the manifest is INTERNALLY consistent —
  // its root commits to its own chunk list. It cannot prove the chunk list
  // describes THESE bytes, because it never rebuilds them: a manifest and a
  // same-length payload it does not describe passes it (found by this suite's
  // 'lazy-cat!' case, which differs from 'lazy-dog!' in three bytes and not in
  // length). Rebuilding here is what makes the mirror content-addressed rather
  // than merely well-formed — otherwise the wrong bytes are published under a
  // correct address and every client rejects them at retrieval instead.
  const rebuilt = buildArtifactPackage(input.bytes, { chunkSizeBytes: input.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES });
  const agreement = packageMatchesManifest(rebuilt, manifest);
  if (!agreement.ok) {
    return { ok: false, code: 'content-address-mismatch', detail: `${agreement.code}: ${agreement.detail}` };
  }

  const tag = githubReleaseTagForRoot(manifest.rootHash);
  const assetName = githubReleaseAssetNameForRoot(manifest.rootHash);
  const locator = formatGithubReleaseLocator({ owner: input.repo.owner, repo: input.repo.repo, tag, asset: assetName });
  const finish = (reused: boolean, assetId: number | null, downloadUrl: string | null): GithubMirrorPublication => ({
    ok: true,
    source: githubReleaseMirrorSource({
      locator,
      advertisedAtMs: input.nowMs,
      expiresAtMs: input.expiresAtMs ?? null,
      sourceId: input.sourceId,
      rootHash: manifest.rootHash,
    }),
    locator,
    tag,
    assetName,
    reused,
    assetId,
    downloadUrl,
  });

  const existing = await findReleaseByTag(deps, input.repo, tag);
  if (!existing.ok) return { ok: false, code: 'github-error', detail: existing.detail };

  let release = existing.release;
  if (release) {
    const already = release.assets.find((asset) => asset.name === assetName);
    // Content-addressed: the tag names these bytes, so an existing asset of the
    // right size IS this artifact. Re-uploading would only churn.
    if (already && already.size === input.bytes.length) {
      return finish(true, already.id, already.browser_download_url ?? null);
    }
    if (already) {
      // Same name, WRONG size — a truncated or abandoned upload. GitHub refuses
      // a duplicate asset name, so leaving it would wedge this artifact's mirror
      // permanently behind a 422 that reads like a permissions problem.
      const stale = `${deps.apiBaseUrl ?? DEFAULT_API_BASE_URL}/repos/${input.repo.owner}/${input.repo.repo}/releases/assets/${already.id}`;
      const removed = await deps.fetchImpl(stale, { method: 'DELETE', headers: apiHeaders(deps) });
      if (!removed.ok && removed.status !== 404) {
        return { ok: false, code: 'github-error', detail: `could not replace a partial asset: ${await readErrorDetail(removed)}` };
      }
    }
  } else {
    const createUrl = `${deps.apiBaseUrl ?? DEFAULT_API_BASE_URL}/repos/${input.repo.owner}/${input.repo.repo}/releases`;
    const created = await deps.fetchImpl(createUrl, {
      method: 'POST',
      headers: { ...apiHeaders(deps), 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: tag,
        // The Merkle root, not a URL: the release page states the address the
        // bytes answer to, so a human can verify the mirror the same way a peer does.
        body: `Cupboard public release mirror.\n\nContent address (P-025 Merkle root): \`${manifest.rootHash}\`\nTotal size: ${manifest.totalSizeBytes} bytes in ${manifest.chunks.length} chunk(s).`,
        draft: false,
        prerelease: false,
      }),
    });
    if (!created.ok) return { ok: false, code: 'github-error', detail: await readErrorDetail(created) };
    const record = (await created.json()) as Partial<GithubReleaseRecord>;
    if (typeof record?.id !== 'number') return { ok: false, code: 'github-error', detail: 'github created a release without a numeric id' };
    release = { id: record.id, assets: Array.isArray(record.assets) ? record.assets : [] };
  }

  const uploadUrl = `${deps.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE_URL}/repos/${input.repo.owner}/${input.repo.repo}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`;
  const uploaded = await deps.fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      ...apiHeaders(deps),
      'content-type': 'application/octet-stream',
      'content-length': String(input.bytes.length),
    },
    // A fresh view rather than the Buffer itself: a Buffer is a Uint8Array over
    // a POOLED ArrayBuffer, so handing it straight to fetch can send the pool's
    // neighbouring bytes on some runtimes.
    body: new Uint8Array(input.bytes),
  });
  if (!uploaded.ok) return { ok: false, code: 'github-error', detail: await readErrorDetail(uploaded) };
  const asset = (await uploaded.json()) as { id?: number; browser_download_url?: string };
  return finish(false, typeof asset?.id === 'number' ? asset.id : null, asset?.browser_download_url ?? null);
}

/**
 * The mirror's source descriptor. `class: 'cache'` is the whole point: a mirror
 * accelerates delivery and is EXCLUDED from replica counting (D-035 ruling 2).
 */
export function githubReleaseMirrorSource(input: {
  readonly locator: string;
  readonly advertisedAtMs: number;
  readonly expiresAtMs?: number | null;
  readonly sourceId?: string;
  readonly rootHash?: string;
}): DistributionSource {
  return {
    sourceId: input.sourceId ?? `github-releases:${input.rootHash ? contentHashHex(input.rootHash) : input.locator}`,
    class: 'cache',
    providerId: GITHUB_RELEASE_MIRROR_PROVIDER_ID,
    locator: input.locator,
    advertisedAtMs: input.advertisedAtMs,
    expiresAtMs: input.expiresAtMs ?? null,
  };
}

// ---------------------------------------------------------------------------
// Retrieval adapter
// ---------------------------------------------------------------------------

export interface GithubReleaseMirrorAdapterOptions {
  /** Must match how the manifest was chunked; defaults to the P-025 constant. */
  readonly chunkSizeBytes?: number;
  /**
   * Byte offset of a chunk within the asset. Supply one when a package was
   * chunked non-uniformly; the default is the uniform layout
   * `buildArtifactPackage` produces. Getting this wrong is SAFE but not silent:
   * the bytes fail their digest below and the source is skipped (D-040 ruling 6).
   */
  readonly chunkOffset?: (request: ChunkFetchRequest) => number;
}

/**
 * Serve chunks of a mirrored package by Merkle root.
 *
 * Reads are tokenless against the public download host: a mirror exists so that
 * anyone can fetch public bytes, and requiring the owner's repo-scoped token to
 * READ would defeat that while spending an owner credential on every install.
 *
 * A ranged GET is an optimisation, not a requirement — a host that ignores
 * `Range` and returns the whole asset is handled by slicing locally, so the
 * adapter is correct under both behaviours. Every returned buffer is verified
 * against the chunk digest before it leaves this function; a mismatch THROWS so
 * `retrieveArtifact` records `fetch-failed` and falls through to the next
 * source in class order rather than corrupting an assembly.
 */
export function githubReleaseMirrorAdapter(
  deps: Pick<GithubReleaseMirrorDeps, 'fetchImpl' | 'downloadBaseUrl' | 'userAgent'>,
  options: GithubReleaseMirrorAdapterOptions = {},
): ArtifactProviderAdapter {
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  return {
    providerId: GITHUB_RELEASE_MIRROR_PROVIDER_ID,
    async fetchChunk(request: ChunkFetchRequest): Promise<Buffer> {
      const parsed = parseGithubReleaseLocator(request.source.locator);
      if (!parsed.ok) throw new Error(`${parsed.code}: ${parsed.detail}`);
      const { owner, repo, tag, asset } = parsed.locator;

      const offset = options.chunkOffset ? options.chunkOffset(request) : request.chunk.index * chunkSizeBytes;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`chunk ${request.chunk.index} resolved to an invalid offset ${offset}`);
      const end = offset + request.chunk.sizeBytes - 1;

      const url = `${deps.downloadBaseUrl ?? DEFAULT_DOWNLOAD_BASE_URL}/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
      const response = await deps.fetchImpl(url, {
        method: 'GET',
        headers: { range: `bytes=${offset}-${end}`, 'user-agent': deps.userAgent ?? DEFAULT_USER_AGENT },
      });
      if (!response.ok) throw new Error(await readErrorDetail(response));

      const body = Buffer.from(await response.arrayBuffer());
      // 206 means the range was honoured; anything else may be the whole asset.
      const bytes = response.status === 206 ? body : body.subarray(offset, offset + request.chunk.sizeBytes);

      if (bytes.length !== request.chunk.sizeBytes) {
        throw new Error(`chunk ${request.chunk.index} came back ${bytes.length} bytes, manifest declares ${request.chunk.sizeBytes}`);
      }
      const digest = sha256Prefixed(bytes);
      if (digest.toLowerCase() !== request.chunk.contentHash.toLowerCase()) {
        throw new Error(`chunk ${request.chunk.index} hashes to ${digest}, manifest declares ${request.chunk.contentHash}`);
      }
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// ArtifactStore view of the same mirror
// ---------------------------------------------------------------------------

const MIRROR_CAPABILITIES: ArtifactStoreCapabilities = {
  // GitHub asset uploads are authenticated with the owner's token, so bytes are
  // proxied through the operator; there is no URL to hand a client.
  presigned: false,
  multipart: false,
  maxObjectBytes: GITHUB_RELEASE_ASSET_MAX_BYTES,
};

/**
 * The mirror as an `ArtifactStore` (P-007 seam), so `resolveReleaseArtifact` can
 * bind a signed manifest to bytes that are actually on the mirror.
 *
 * The seam's content-addressed `storageKey` and the mirror's tag/asset names are
 * both derived from the SAME hash, so the two addressing schemes cannot drift:
 * for a public listing the release `contentHash` IS the Merkle root
 * (`validatePublishableRelease`'s convention), which is what both sides hash.
 */
export function githubReleaseMirrorStore(
  deps: GithubReleaseMirrorDeps,
  repo: { readonly owner: string; readonly repo: string },
  options: { readonly ticketTtlMs?: number } = {},
): ArtifactStore {
  const ttl = options.ticketTtlMs ?? 15 * 60 * 1000;
  const hexOf = (storageKey: string): string | null => {
    const hex = storageKey.split('/').pop() ?? '';
    return /^[0-9a-f]{64}$/i.test(hex) ? hex.toLowerCase() : null;
  };
  const lookupAsset = async (storageKey: string) => {
    const hex = hexOf(storageKey);
    if (!hex) return null;
    const prefixed = `sha256:${hex}`;
    const found = await findReleaseByTag(deps, repo, githubReleaseTagForRoot(prefixed));
    if (!found.ok || !found.release) return null;
    const assetName = githubReleaseAssetNameForRoot(prefixed);
    const asset = found.release.assets.find((candidate) => candidate.name === assetName);
    return asset ? { asset, storageKey: cupboardArtifactKey(prefixed) } : null;
  };

  return {
    providerId: GITHUB_RELEASE_MIRROR_PROVIDER_ID,
    capabilities: MIRROR_CAPABILITIES,
    async createUploadTicket(ref: ArtifactRef, nowMs: number): Promise<ArtifactUploadTicket> {
      return {
        transport: 'proxied-put',
        storageKey: cupboardArtifactKey(ref.contentHash),
        contentHash: ref.contentHash,
        method: 'PUT',
        headers: { 'content-type': ref.contentType },
        expiresAtMs: nowMs + ttl,
      };
    },
    async head(storageKey: string): Promise<StoredArtifact | null> {
      const hit = await lookupAsset(storageKey);
      if (!hit) return null;
      return { storageKey: hit.storageKey, sizeBytes: hit.asset.size, contentType: 'application/octet-stream' };
    },
    async delete(storageKey: string): Promise<void> {
      const hit = await lookupAsset(storageKey);
      if (!hit) return;
      const url = `${deps.apiBaseUrl ?? DEFAULT_API_BASE_URL}/repos/${repo.owner}/${repo.repo}/releases/assets/${hit.asset.id}`;
      const response = await deps.fetchImpl(url, { method: 'DELETE', headers: apiHeaders(deps) });
      // A yank cannot recall copies already taken (D-035 ruling 3); removing the
      // official asset is the most the mirror can do, and failing to do it is an
      // error the caller must see rather than a silent no-op.
      if (!response.ok && response.status !== 404) throw new Error(await readErrorDetail(response));
    },
  };
}
