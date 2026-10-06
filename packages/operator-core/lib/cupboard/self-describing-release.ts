/**
 * Self-describing kinds (recipe / plan / goal / template / rubric) through the release gate —
 * cupboard-release-pipeline-content-trust-2026-09-16 P-011.
 *
 * Before P-011 these kinds were a GitHub pointer only: the Worker pinned a git tree digest
 * (P-001) and the installer re-derived it (P-002), but no signed release existed and the
 * bytes had no origin other than the mutable mirror. This module gives them the SAME
 * release shape the blueprint kind already ships:
 *
 *   dir on disk ──pack──▶ canonical archive bytes ──buildArtifactPackage──▶ Merkle root
 *        └──▶ signed CupboardReleaseManifest(contentHash = root) ──▶ ReleaseGateInput
 *
 * `publishListingToCupboard` hands the `ReleaseGateInput` to `prepareReleaseForPublish`, PUTs
 * the bytes to the Worker's R2 origin (`PUT /artifacts/sha256/<hex>`), then POSTs the listing
 * with `release_content_hash` pinned. GitHub is left as the mirror.
 *
 * The archive is deliberately a plain canonical JSON envelope (sorted paths, per-file sha256),
 * not a tarball: it is byte-deterministic for a given dir, needs no extractor, and
 * `unpackSelfDescribingArchive` can refuse a hostile path (`..`, absolute, duplicate) BEFORE
 * anything touches the user layer.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import {
  DEFAULT_PINNING_POLICY,
  distributionManifestSigningBytes,
  type ArtifactDistributionManifest,
} from '../p2p/artifact-distribution';
import { buildArtifactPackage } from '../p2p/artifact-package';
// The leaf, never './blueprint-release': even a type-only or dynamic import compiles that file,
// and its lifecycle graph reaches agent-tools (WI-10004876).
import type { BlueprintReleaseSigner } from './blueprint-release-signer';
import { listingManifestSigningBytes, type CupboardReleaseManifest } from './listing-manifest';
import type { ReleaseGateInput } from './publish-release-gate';
import type { ListingKind } from './types';

export const SELF_DESCRIBING_ARCHIVE_SCHEMA = 'papercusp.self-describing-archive/v1' as const;
/** Mirrors the Worker's PUT cap (apps/operator-public routes/self-describing-artifacts.ts). */
export const MAX_SELF_DESCRIBING_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_SELF_DESCRIBING_ARCHIVE_FILES = 2000;

export class SelfDescribingArchiveError extends Error {
  constructor(
    message: string,
    readonly code: 'archive-too-large' | 'archive-malformed' | 'archive-unsafe-path' | 'archive-digest-mismatch',
  ) {
    super(message);
    this.name = 'SelfDescribingArchiveError';
  }
}

export interface SelfDescribingArchiveFile {
  /** POSIX path relative to the listing's dir. */
  path: string;
  bytes: Buffer;
}

function walk(dir: string, prefix: string, out: SelfDescribingArchiveFile[]): void {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = lstatSync(abs);
    // A symlink would let a publisher smuggle a file that is not in the dir they reviewed.
    if (st.isSymbolicLink()) {
      throw new SelfDescribingArchiveError(`refusing symlink "${rel}" in a self-describing listing`, 'archive-unsafe-path');
    }
    if (st.isDirectory()) walk(abs, rel, out);
    else if (st.isFile()) out.push({ path: rel, bytes: readFileSync(abs) });
    if (out.length > MAX_SELF_DESCRIBING_ARCHIVE_FILES) {
      throw new SelfDescribingArchiveError(
        `listing dir has more than ${MAX_SELF_DESCRIBING_ARCHIVE_FILES} files`,
        'archive-too-large',
      );
    }
  }
}

/** A path is safe iff it is already in normal form, relative, and stays inside the dir. */
export function isSafeArchivePath(path: unknown): path is string {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0')) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  return posix.normalize(path) === path && !path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}

/** Pack the on-disk dir into the canonical archive bytes (sorted, deterministic). */
export function packSelfDescribingArchive(files: readonly SelfDescribingArchiveFile[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  for (const f of sorted) {
    if (!isSafeArchivePath(f.path) || seen.has(f.path)) {
      throw new SelfDescribingArchiveError(`unsafe or duplicate archive path ${JSON.stringify(f.path)}`, 'archive-unsafe-path');
    }
    seen.add(f.path);
  }
  const archive = Buffer.from(
    canonicalJson({
      schema: SELF_DESCRIBING_ARCHIVE_SCHEMA,
      files: sorted.map((f) => ({
        path: f.path,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        contentBase64: f.bytes.toString('base64'),
      })),
    }),
    'utf8',
  );
  if (archive.length > MAX_SELF_DESCRIBING_ARTIFACT_BYTES) {
    throw new SelfDescribingArchiveError(
      `archive is ${archive.length} bytes; the Cupboard origin accepts at most ${MAX_SELF_DESCRIBING_ARTIFACT_BYTES}`,
      'archive-too-large',
    );
  }
  return archive;
}

export function packSelfDescribingDir(dir: string): Buffer {
  const files: SelfDescribingArchiveFile[] = [];
  walk(dir, '', files);
  return packSelfDescribingArchive(files);
}

/**
 * Parse + fully validate archive bytes. Throws `SelfDescribingArchiveError` on a malformed
 * envelope, a hostile path, a duplicate, or a per-file digest that does not match — never
 * returns partially-validated content.
 */
export function unpackSelfDescribingArchive(bytes: Buffer): SelfDescribingArchiveFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new SelfDescribingArchiveError('archive is not valid JSON', 'archive-malformed');
  }
  const doc = parsed as { schema?: unknown; files?: unknown };
  if (doc?.schema !== SELF_DESCRIBING_ARCHIVE_SCHEMA || !Array.isArray(doc.files)) {
    throw new SelfDescribingArchiveError('archive has an unknown schema', 'archive-malformed');
  }
  if (doc.files.length > MAX_SELF_DESCRIBING_ARCHIVE_FILES) {
    throw new SelfDescribingArchiveError('archive declares too many files', 'archive-too-large');
  }
  const out: SelfDescribingArchiveFile[] = [];
  const seen = new Set<string>();
  for (const entry of doc.files as Array<{ path?: unknown; sha256?: unknown; contentBase64?: unknown }>) {
    if (!isSafeArchivePath(entry?.path) || seen.has(entry.path)) {
      throw new SelfDescribingArchiveError(`unsafe or duplicate archive path ${JSON.stringify(entry?.path)}`, 'archive-unsafe-path');
    }
    if (typeof entry.contentBase64 !== 'string' || typeof entry.sha256 !== 'string') {
      throw new SelfDescribingArchiveError(`archive entry "${entry.path}" is malformed`, 'archive-malformed');
    }
    const fileBytes = Buffer.from(entry.contentBase64, 'base64');
    if (createHash('sha256').update(fileBytes).digest('hex') !== entry.sha256) {
      throw new SelfDescribingArchiveError(`archive entry "${entry.path}" does not match its digest`, 'archive-digest-mismatch');
    }
    seen.add(entry.path);
    out.push({ path: entry.path, bytes: fileBytes });
  }
  return out;
}

export interface BuildSelfDescribingReleaseInput {
  listingKind: ListingKind;
  listingRef: string;
  releaseVersion: string;
  /** The materialized `<ref>/` dir the publisher is about to push to the mirror. */
  dir: string;
  license?: string;
  /** Defaults to the local-device signer (the one blueprint releases use). */
  signer?: BlueprintReleaseSigner;
}

export interface BuiltSelfDescribingRelease {
  manifest: ArtifactDistributionManifest;
  /** Ready for `publishListingToCupboard({ release })`. */
  release: ReleaseGateInput;
  /** The exact bytes whose Merkle root is `contentHash` — what gets PUT to the origin. */
  bytes: Buffer;
  /** `sha256:<hex>` Merkle root; the value the Worker pins as `release_content_hash`. */
  contentHash: string;
}

/** Build + sign the public release for a self-describing listing dir. */
export async function buildSelfDescribingRelease(
  input: BuildSelfDescribingReleaseInput,
): Promise<BuiltSelfDescribingRelease> {
  const bytes = packSelfDescribingDir(input.dir);
  const pkg = buildArtifactPackage(bytes);
  const signer = input.signer ?? (await (await import('./blueprint-release-signer')).defaultReleaseSigner());
  const unsignedRelease: Omit<CupboardReleaseManifest, 'signature'> = {
    schemaVersion: 1,
    listingKind: input.listingKind,
    listingRef: input.listingRef,
    releaseVersion: input.releaseVersion,
    contentHash: pkg.rootHash,
    dependencies: [],
    compatibility: {},
    permissions: [],
    capabilities: [],
    license: input.license?.trim() || 'NOASSERTION',
    publisher: { githubUserId: signer.githubUserId, login: signer.githubLogin, devicePubkey: signer.devicePubkey },
    reviewStatus: 'pending',
  };
  const release: CupboardReleaseManifest = {
    ...unsignedRelease,
    signature: (await signer.sign(listingManifestSigningBytes(unsignedRelease))).toString('base64'),
  };
  const unsignedDistribution: Omit<ArtifactDistributionManifest, 'signature'> = {
    schemaVersion: 1,
    release,
    rootHash: pkg.rootHash,
    totalSizeBytes: pkg.totalSizeBytes,
    chunks: pkg.chunks,
    visibility: 'public',
    encryption: null,
    pinning: DEFAULT_PINNING_POLICY,
  };
  const manifest: ArtifactDistributionManifest = {
    ...unsignedDistribution,
    signature: (await signer.sign(distributionManifestSigningBytes(unsignedDistribution))).toString('base64'),
  };
  return { manifest, release: { visibility: 'public', manifest, bytes }, bytes, contentHash: pkg.rootHash };
}

export type ArtifactUploadResult =
  | { ok: true; contentHash: string }
  | { ok: false; status: number; error: string; detail?: unknown };

const HEX64_RE = /^[0-9a-f]{64}$/;

/** `sha256:<hex>` → `<hex>`, or null when it is not a well-formed content hash. */
export function contentHashHexOf(contentHash: string): string | null {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(contentHash.trim());
  return m ? (m[1] as string).toLowerCase() : HEX64_RE.test(contentHash) ? contentHash : null;
}

/** PUT the release bytes to the Worker's R2 origin. The Worker re-derives the Merkle root and
 *  refuses `content-address-mismatch`, so a lying client cannot occupy an address. */
export async function putSelfDescribingArtifact(args: {
  baseUrl: string;
  token: string;
  contentHash: string;
  bytes: Buffer;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ArtifactUploadResult> {
  const hex = contentHashHexOf(args.contentHash);
  if (!hex) return { ok: false, status: 400, error: 'invalid_content_hash' };
  try {
    const res = await (args.fetchImpl ?? fetch)(`${args.baseUrl}/artifacts/sha256/${hex}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${args.token}`,
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'papercusp-operator-cupboard-proxy',
      },
      body: new Uint8Array(args.bytes),
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (res.ok) return { ok: true, contentHash: `sha256:${hex}` };
    const text = await res.text();
    let detail: unknown = text.slice(0, 300);
    try {
      detail = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    return { ok: false, status: res.status, error: 'artifact_upload_refused', detail };
  } catch (e) {
    return { ok: false, status: 502, error: 'artifact_upload_unreachable', detail: (e as Error).message.slice(0, 200) };
  }
}

/** GET the release bytes from the Worker's R2 origin. `null` ⇒ unavailable (404, network, 5xx) —
 *  the caller falls back to the GitHub mirror; it never treats absence as an error. */
export async function fetchSelfDescribingArtifact(args: {
  baseUrl: string;
  contentHash: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<Buffer | null> {
  const hex = contentHashHexOf(args.contentHash);
  if (!hex) return null;
  try {
    const res = await (args.fetchImpl ?? fetch)(`${args.baseUrl}/artifacts/sha256/${hex}`, {
      headers: { 'User-Agent': 'papercusp-operator-cupboard-proxy' },
      ...(args.signal ? { signal: args.signal } : {}),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > MAX_SELF_DESCRIBING_ARTIFACT_BYTES ? null : buf;
  } catch {
    return null;
  }
}

/**
 * Fetch the release bytes from the origin and return their files ONLY when they verify: the bytes'
 * Merkle root must equal the listing's pinned `release_content_hash` and the archive must unpack
 * (digests + safe paths). Anything else — absent, oversized, a root that differs, a hostile or
 * malformed archive — is `null`: the caller treats the origin as unavailable and falls back to the
 * GitHub mirror, whose own pin check (P-002) still gates the install. It never throws.
 */
export async function fetchVerifiedReleaseFiles(
  contentHash: string,
  fetchArtifact: (contentHash: string) => Promise<Buffer | null>,
): Promise<SelfDescribingArchiveFile[] | null> {
  const expected = contentHashHexOf(contentHash);
  if (!expected) return null;
  try {
    const bytes = await fetchArtifact(contentHash);
    if (!bytes || bytes.length > MAX_SELF_DESCRIBING_ARTIFACT_BYTES) return null;
    if (contentHashHexOf(buildArtifactPackage(bytes).rootHash) !== expected) return null;
    return unpackSelfDescribingArchive(bytes);
  } catch {
    return null;
  }
}

/** The release version a self-describing dir is published at when the publisher names none —
 *  the same default the `write*Dir` helpers stamp into `listing.json`. */
export const DEFAULT_SELF_DESCRIBING_RELEASE_VERSION = '0.1.0';

/** What a publish core spreads into `publishListingToCupboard({ ... })` to route a self-describing
 *  kind through the release gate and ship its bytes to the R2 origin. */
export interface SelfDescribingPublishExtras {
  release: ReleaseGateInput;
  uploadReleaseBytes: true;
}

export type SelfDescribingPublishExtrasResult =
  | { ok: true; extras: SelfDescribingPublishExtras; contentHash: string }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * The ONE call every self-describing publish core makes (recipe/plan/goal/template/rubric):
 * pack the materialized dir, build + sign the release, and hand back the fields that make
 * `publishListingToCupboard` run the release gate, upload the bytes, and pin
 * `release_content_hash`. Never throws — a build failure is a publisher-visible 500 naming the
 * code, not an opaque crash after the dir was already written.
 */
export async function buildSelfDescribingPublishExtras(input: {
  listingKind: ListingKind;
  listingRef: string;
  dir: string;
  version?: string;
  license?: string;
  signer?: BlueprintReleaseSigner;
}): Promise<SelfDescribingPublishExtrasResult> {
  try {
    const built = await buildSelfDescribingRelease({
      listingKind: input.listingKind,
      listingRef: input.listingRef,
      releaseVersion: input.version?.trim() || DEFAULT_SELF_DESCRIBING_RELEASE_VERSION,
      dir: input.dir,
      ...(input.license ? { license: input.license } : {}),
      ...(input.signer ? { signer: input.signer } : {}),
    });
    return {
      ok: true,
      extras: { release: built.release, uploadReleaseBytes: true },
      contentHash: built.contentHash,
    };
  } catch (e) {
    const code = e instanceof SelfDescribingArchiveError ? e.code : 'release_build_failed';
    return {
      ok: false,
      status: e instanceof SelfDescribingArchiveError ? 422 : 500,
      error: `could not build the ${input.listingKind} release (${code})`,
      detail: e instanceof Error ? e.message.slice(0, 300) : String(e),
    };
  }
}
