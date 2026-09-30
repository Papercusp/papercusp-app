/**
 * `release:byoc_readiness` — computed, read-only BYOC acceptance evidence.
 *
 * Unregistered draft. The exact task-ledger journal supplies identity and
 * negative evidence only: committed receipts cannot prove acceptance outcomes.
 * Until the source observation joins are implemented this reader reports the
 * unresolved proof obligations and can never return a positive verdict.
 */
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import type { Sql } from 'postgres';
import {
  deriveWorkspaceHostCanonicalArtifactUrls,
  DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS,
} from '@papercusp/deployment-driver';
import { taskReleaseJournalFromDetail, type TaskReleaseJournal } from '../../task-manager/store';
import { releaseStageInputHash } from '../../../../../scripts/lib/release-task-journal.mjs';
import {
  projectByocReleaseCarry,
  type ByocReleaseCarrySnapshot,
  type ByocReleaseMilestoneKey,
} from '../../byoc-release-carry';
import {
  workspaceHostPublicationManifestFailures,
  WORKSPACE_HOST_PUBLICATION_KIND,
  WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION,
  WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS,
  WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME,
  WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME,
  type WorkspaceHostPublicationManifest,
  type WorkspaceHostPublicationManifestInput,
} from '../../workspace-host/publication-manifest';

export type ByocAcceptanceBar = 'R-4' | 'R-5' | 'R-6';
export type ByocReadinessVerdict = 'pass' | 'fail' | 'unknown';

const BAR_MILESTONES: Record<ByocAcceptanceBar, readonly ByocReleaseMilestoneKey[]> = {
  'R-4': ['build', 'publication'],
  'R-5': ['root-bootstrap', 'fixed-agent-initialization', 'customer-acceptance'],
  // Shipment consumes acceptance; it cannot be a prerequisite for grading it.
  'R-6': ['soak', 'resource-census', 'billing-closure', 'cleanup'],
};

/**
 * Open proof obligations, NOT a schema agents can populate with `verified:true`.
 * A release receipt proves a driver transition, not any of these outcomes.
 * Keep this draft incapable of passing until maintained readers actually join
 * and validate the source observations. Do not register it as a grading probe.
 */
const UNJOINED_EVIDENCE: Record<ByocAcceptanceBar, readonly string[]> = {
  'R-4': ['public-bytes', 'manifest-archive-digest', 'signature', 'sbom', 'executable-identity'],
  'R-5': ['clean-gcp-controller', 'claude-execution', 'omp-execution', 'credentials', 'acl', 'data', 'customer-desktop'],
  'R-6': ['five-live-journeys', '24h-soak', 'budget', 'billing', 'destroy', 'provider-absence', 'eight-kind-residue'],
};

export interface ByocPublicationProbeInput {
  bundleSha256: string;
  manifestSha256: string;
  taskId?: string;
  operationId?: string;
  expectedArtifactIdentity?: {
    sourceSha?: string;
    version?: string;
  };
}

export interface ByocPublicationProbeResult {
  verdict: 'pass' | 'fail' | 'unknown';
  /** Only checks actually discharged by this reader, never claims copied from the manifest. */
  verified: string[];
  missing: string[];
  failed: string[];
  evidenceRefs: string[];
}

type PublicationProbeResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'body'>;

interface PublicationProbeFetcher {
  (
    input: string,
    init?: {
      method?: string;
      redirect?: 'error';
      credentials?: 'omit';
      signal?: AbortSignal;
    },
  ): Promise<PublicationProbeResponse>;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isPublicationManifestShape(value: unknown): value is WorkspaceHostPublicationManifest {
  if (!isRecord(value)) return false;
  const files = value.files;
  const artifact = value.artifact;
  const trustReport = value.trustReport;
  return (
    isRecord(artifact) &&
    isRecord(artifact.release) &&
    isRecord(files) &&
    isRecord(files.bundle) &&
    isRecord(files.signature) &&
    isRecord(trustReport) &&
    isRecord(trustReport.subject) &&
    isRecord(trustReport.policy) &&
    Array.isArray(trustReport.evidence) &&
    trustReport.evidence.every(isRecord) &&
    Array.isArray(trustReport.failures)
  );
}

// Match the publisher's object limits. In particular, real bundles use multipart (up to
// 1024 * 32 MiB), not its much smaller direct-PUT limit. Bundle bytes are hashed, never retained.
const MAX_PUBLICATION_MANIFEST_BYTES = 1024 * 1024;
const MAX_PUBLICATION_BUNDLE_BYTES = 1024 * 32 * 1024 * 1024;
const MAX_PUBLICATION_SIGNATURE_BYTES = 64 * 1024;
const PUBLICATION_FETCH_TIMEOUT_MS = 300_000;

interface ArchiveIdentityResult {
  readonly failures: string[];
  readonly entries: Array<{ name: string; size: number; mode: number }>;
}

/**
 * Inspect the gzip tar stream used by the publisher in the same pass as the bundle hash.
 * Manifest material declarations are intentionally not used here: they describe what the
 * producer meant to publish, while this parser proves the required executable files are present
 * as regular, non-empty, executable archive members in the bytes fetched by the reader.
 */
async function inspectWorkspaceHostArchive(
  body: ReadableStream<Uint8Array>,
): Promise<ArchiveIdentityResult> {
  const required = new Set(Object.values(DEFAULT_WORKSPACE_HOST_BOOTSTRAP_ENTRYPOINTS));
  const seen = new Set<string>();
  const failures: string[] = [];
  const entries: Array<{ name: string; size: number; mode: number }> = [];
  const parseOctal = (header: Buffer, offset: number, length: number): number => {
    const text = header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/u, '').trim();
    const value = Number.parseInt(text, 8);
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  };
  const gunzip = createGunzip();
  const source = Readable.fromWeb(body as any).pipe(gunzip);
  let buffered = Buffer.alloc(0);
  let skipBytes = 0;
  let ended = false;
  try {
    for await (const chunk of source) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk as Uint8Array)]);
      while (!ended) {
        if (skipBytes > 0) {
          const skipped = Math.min(skipBytes, buffered.length);
          buffered = buffered.subarray(skipped);
          skipBytes -= skipped;
          if (skipBytes > 0) break;
        }
        if (buffered.length < 512) break;
        const header = buffered.subarray(0, 512);
        buffered = buffered.subarray(512);
        if (header.every((byte) => byte === 0)) {
          ended = true;
          break;
        }
        const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '').replace(/^(?:\.\/)+/u, '');
        const size = parseOctal(header, 124, 12);
        const mode = parseOctal(header, 100, 8);
        const type = header[156] === 0 || header[156] === 0x30 ? 'file' : String.fromCharCode(header[156]!);
        if (size < 0 || mode < 0) {
          failures.push('archive:invalid-header');
          break;
        }
        if (required.has(name)) {
          if (seen.has(name)) failures.push(`${name}:duplicate`);
          seen.add(name);
          entries.push({ name, size, mode });
          if (type !== 'file' || size <= 0 || (mode & 0o111) === 0) {
            failures.push(`${name}:not-executable-file`);
          }
        }
        skipBytes = Math.ceil(size / 512) * 512;
      }
    }
    if (!ended) failures.push('archive:missing-end-of-archive');
  } catch (error) {
    failures.push(`archive:${error instanceof Error ? error.message : String(error)}`);
  }
  for (const name of required) {
    if (!seen.has(name)) failures.push(`${name}:missing`);
  }
  return { failures: [...new Set(failures)], entries };
}

async function readPublicationObject(
  response: PublicationProbeResponse,
  maxBytes: number,
  retain = false,
  inspectArchive = false,
): Promise<{
  sha256: string;
  blake2b512: Uint8Array;
  bytes: number;
  payload: Uint8Array | null;
  archiveIdentity?: ArchiveIdentityResult;
}> {
  const rawSize = response.headers.get('content-length');
  const declaredBytes = rawSize === null ? null : Number(rawSize);
  if (declaredBytes !== null && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes)) {
    await response.body?.cancel();
    throw new Error('invalid-or-excessive-content-length');
  }
  if (!response.body) throw new Error('missing-body');
  const [hashBody, archiveBody] = inspectArchive ? response.body.tee() : [response.body, null];
  const reader = hashBody.getReader();
  const archivePromise = archiveBody ? inspectWorkspaceHostArchive(archiveBody) : null;
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  const prehash = createHash('blake2b512');
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error('bytes-exceed-bound');
      hash.update(next.value);
      prehash.update(next.value);
      if (retain) chunks.push(next.value);
    }
  } catch (error) {
    // Stop a rejected transfer rather than leave a multi-GB body downloading in the background.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error('empty-body');
  // Fetch may decode Content-Encoding; only compare wire length for an identity transfer.
  if (!response.headers.get('content-encoding') && declaredBytes !== null && total !== declaredBytes) {
    throw new Error('content-length-mismatch');
  }
  let payload: Uint8Array | null = null;
  if (retain) {
    payload = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }
  return {
    sha256: hash.digest('hex'),
    blake2b512: prehash.digest(),
    bytes: total,
    payload,
    ...(archivePromise ? { archiveIdentity: await archivePromise } : {}),
  };
}

function decodeCanonicalBase64(value: string, expectedBytes: number): Uint8Array | null {
  const encoded = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  const decoded = Buffer.from(encoded, 'base64');
  if (
    decoded.byteLength !== expectedBytes ||
    decoded.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')
  ) return null;
  return decoded;
}

/**
 * Verify the exact detached minisign file the workspace-host bootstrap consumes.
 *
 * This deliberately implements only minisign's modern prehashed `ED` form. The
 * bootstrap signs multi-gigabyte release bundles in that form, so accepting the
 * legacy raw-message `Ed` form would either require retaining the whole bundle or
 * quietly verify a different protocol. Both the bundle signature and minisign's
 * global signature over `signature || trusted-comment` are required.
 */
export function verifyPrehashedMinisign(
  signingPublicKey: string,
  signatureFile: Uint8Array,
  bundleBlake2b512: Uint8Array,
): { valid: true; keyId: string } | { valid: false; reason: string } {
  let signatureText: string;
  try {
    signatureText = new TextDecoder('utf-8', { fatal: true }).decode(signatureFile);
  } catch {
    return { valid: false, reason: 'invalid-utf8' };
  }
  const keyLines = signingPublicKey.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const signatureLines = signatureText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (
    keyLines.length !== 2 ||
    !keyLines[0]?.startsWith('untrusted comment:') ||
    signatureLines.length !== 4 ||
    !signatureLines[0]?.startsWith('untrusted comment:') ||
    !signatureLines[2]?.startsWith('trusted comment: ')
  ) return { valid: false, reason: 'invalid-envelope' };

  const keyBlock = decodeCanonicalBase64(keyLines[1]!, 42);
  const signatureBlock = decodeCanonicalBase64(signatureLines[1]!, 74);
  const globalSignature = decodeCanonicalBase64(signatureLines[3]!, 64);
  if (!keyBlock || !signatureBlock || !globalSignature) {
    return { valid: false, reason: 'invalid-base64-block' };
  }
  const keyAlgorithm = Buffer.from(keyBlock.subarray(0, 2)).toString('latin1');
  const signatureAlgorithm = Buffer.from(signatureBlock.subarray(0, 2)).toString('latin1');
  if (!['Ed', 'ED'].includes(keyAlgorithm) || signatureAlgorithm !== 'ED') {
    return { valid: false, reason: 'unsupported-algorithm' };
  }
  const keyId = keyBlock.subarray(2, 10);
  if (!Buffer.from(keyId).equals(Buffer.from(signatureBlock.subarray(2, 10)))) {
    return { valid: false, reason: 'key-id-mismatch' };
  }
  if (bundleBlake2b512.byteLength !== 64) {
    return { valid: false, reason: 'invalid-bundle-prehash' };
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(keyBlock.subarray(10, 42)),
      ]),
      format: 'der',
      type: 'spki',
    });
    const signature = signatureBlock.subarray(10, 74);
    if (!verifyEd25519(null, bundleBlake2b512, publicKey, signature)) {
      return { valid: false, reason: 'bundle-signature-invalid' };
    }
    const trustedComment = signatureLines[2]!.slice('trusted comment: '.length);
    const globalMessage = Buffer.concat([
      Buffer.from(signature),
      Buffer.from(trustedComment, 'utf8'),
    ]);
    if (!verifyEd25519(null, globalMessage, publicKey, globalSignature)) {
      return { valid: false, reason: 'global-signature-invalid' };
    }
  } catch {
    return { valid: false, reason: 'verification-error' };
  }
  return { valid: true, keyId: Buffer.from(keyId).toString('hex') };
}

/**
 * Independently read the immutable public publication named by the selected release receipt.
 * The task journal contributes only the expected digest; public bytes and descriptors come from
 * the consumer-facing artifact origin. A manifest's own `files` object is not trusted until its
 * bytes, bundle bytes and signature bytes all agree.
 */
export async function probeByocPublication(
  input: ByocPublicationProbeInput,
  fetcher: PublicationProbeFetcher = globalThis.fetch,
): Promise<ByocPublicationProbeResult> {
  // Hashing signature bytes is not cryptographic verification; a trust report is not an SBOM.
  const missing: string[] = ['signature', 'sbom', 'executable-identity'];
  const failed: string[] = [];
  const refs: string[] = [];
  const verified: string[] = [];
  const result = (): ByocPublicationProbeResult => ({
    verdict: failed.length > 0 ? 'fail' : 'unknown',
    verified,
    missing: [...new Set(missing)],
    failed: [...new Set(failed)],
    evidenceRefs: [...new Set(refs)],
  });
  if (!/^[a-f0-9]{64}$/.test(input.bundleSha256) || !/^[a-f0-9]{64}$/.test(input.manifestSha256)) {
    failed.push('publication:invalid-digest');
    return result();
  }
  let urls: ReturnType<typeof deriveWorkspaceHostCanonicalArtifactUrls>;
  try {
    urls = deriveWorkspaceHostCanonicalArtifactUrls(input.bundleSha256);
  } catch (error) {
    failed.push(`publication-url:${error instanceof Error ? error.message : String(error)}`);
    return result();
  }

  const requestInit = (): Parameters<PublicationProbeFetcher>[1] => ({
    method: 'GET',
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(PUBLICATION_FETCH_TIMEOUT_MS),
  });
  if (input.taskId) refs.push(`publication:task:${input.taskId}`);
  if (input.operationId) refs.push(`publication:operation:${input.operationId}`);

  const manifestResponse = await fetcher(urls.manifestUrl, requestInit()).catch(() => null);
  if (!manifestResponse || !manifestResponse.ok) {
    await manifestResponse?.body?.cancel().catch(() => undefined);
    missing.push('public-manifest', 'manifest-archive-digest', 'public-bytes');
    return result();
  }
  let manifestBytes: Uint8Array;
  try {
    const observed = await readPublicationObject(manifestResponse, MAX_PUBLICATION_MANIFEST_BYTES, true);
    manifestBytes = observed.payload!;
  } catch (error) {
    failed.push(`public-manifest:${error instanceof Error ? error.message : String(error)}`);
    return result();
  }
  const observedManifestSha = sha256(manifestBytes);
  if (observedManifestSha !== input.manifestSha256) {
    failed.push('manifest-archive-digest:mismatch');
  } else {
    refs.push(`publication:manifest:${observedManifestSha}`);
  }

  let manifest: unknown = null;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    failed.push('manifest:invalid-json');
  }
  if (!isPublicationManifestShape(manifest)) {
    failed.push('manifest:incomplete');
    return result();
  }
  if (
    manifest.schemaVersion !== WORKSPACE_HOST_PUBLICATION_SCHEMA_VERSION ||
    manifest.kind !== WORKSPACE_HOST_PUBLICATION_KIND ||
    Object.keys(manifest).some((key) => !(WORKSPACE_HOST_PUBLICATION_MANIFEST_KEYS as readonly string[]).includes(key)) ||
    manifest.files.bundle.name !== WORKSPACE_HOST_PUBLISHED_BUNDLE_NAME ||
    manifest.files.signature.name !== WORKSPACE_HOST_PUBLISHED_SIGNATURE_NAME
  ) {
    failed.push('manifest:invalid-envelope');
    return result();
  }
  if (failed.length > 0) return result();

  // The bootstrap pins the exact public-key file bytes, not a trimmed key or a
  // digest copied from the trust report. Check that same identity before fetching
  // the large bundle. This is a prerequisite, NOT signature verification: even a
  // perfectly matching key pin cannot discharge the `signature` obligation.
  const signingPublicKey = manifest.artifact.release.signingPublicKey;
  const signingKeySha256 = manifest.artifact.release.signingKeySha256;
  if (typeof signingPublicKey !== 'string' || signingPublicKey.trim().length === 0) {
    failed.push('signature:invalid-signing-key');
    return result();
  }
  if (
    typeof signingKeySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(signingKeySha256) ||
    sha256(new TextEncoder().encode(signingPublicKey)) !== signingKeySha256
  ) {
    failed.push('signature:key-pin-mismatch');
    return result();
  }
  refs.push(`publication:signing-key:${signingKeySha256}`);

  const fetchObject = async (url: string, maxBytes: number, label: string, retain = false) => {
    try {
      const response = await fetcher(url, requestInit());
      if (!response.ok) {
        await response.body?.cancel();
        missing.push(label);
        return null;
      }
      return await readPublicationObject(response, maxBytes, retain, label === 'public-bytes');
    } catch (error) {
      missing.push(label);
      failed.push(`${label}:${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const [bundle, signature] = await Promise.all([
    fetchObject(urls.bundleUrl, MAX_PUBLICATION_BUNDLE_BYTES, 'public-bytes'),
    fetchObject(urls.signatureUrl, MAX_PUBLICATION_SIGNATURE_BYTES, 'signature', true),
  ]);
  if (bundle && signature) {
    const publicationInput: WorkspaceHostPublicationManifestInput = {
      artifact: manifest.artifact,
      trustReport: manifest.trustReport,
      bundle,
      signature,
    };
    try {
      const failures = workspaceHostPublicationManifestFailures(publicationInput);
      failed.push(...failures.map(({ code }) => `publication:${code}`));
    } catch {
      failed.push('publication:malformed-manifest');
      return result();
    }
    if (manifest.files.bundle.sha256 !== input.bundleSha256 || manifest.artifact.release.bundleSha256 !== input.bundleSha256) {
      failed.push('public-bytes:digest-mismatch');
    }
    const expectedSourceSha = input.expectedArtifactIdentity?.sourceSha;
    const expectedVersion = input.expectedArtifactIdentity?.version;
    if (expectedSourceSha && manifest.artifact.buildManifest?.source?.revision !== expectedSourceSha) {
      failed.push('publication:source-identity-mismatch');
    }
    if (
      expectedVersion &&
      (manifest.artifact.release.version !== expectedVersion ||
        manifest.artifact.image?.version !== expectedVersion)
    ) {
      failed.push('publication:version-identity-mismatch');
    }
    if (bundle.sha256 !== input.bundleSha256) {
      failed.push('public-bytes:content-digest-mismatch');
    }
    if (signature.sha256 !== manifest.files.signature.sha256) {
      failed.push('signature:content-digest-mismatch');
    }
    if (manifest.files.bundle.sizeBytes !== bundle.bytes) failed.push('public-bytes:size-mismatch');
    if (manifest.files.signature.sizeBytes !== signature.bytes) failed.push('signature:size-mismatch');
    refs.push(`publication:bundle:${bundle.sha256}:${bundle.bytes}`);
    refs.push(`publication:signature:${signature.sha256}:${signature.bytes}`);
    if (failed.length === 0) verified.push('public-bytes', 'manifest-archive-digest');
    if (bundle.archiveIdentity) {
      if (bundle.archiveIdentity.failures.length > 0) {
        failed.push(...bundle.archiveIdentity.failures.map((failure) => `executable-identity:${failure}`));
      } else {
        const identityIndex = missing.indexOf('executable-identity');
        if (identityIndex >= 0) missing.splice(identityIndex, 1);
        verified.push('executable-identity');
        refs.push(
          `publication:archive-identity:${bundle.archiveIdentity.entries
            .map(({ name, size, mode }) => `${name}:${size}:${mode.toString(8)}`)
            .join(',')}`,
        );
      }
    }

    // Re-measure the trust decision the guest bootstrap makes. The manifest's
    // `trustReport.signature.valid` is producer-authored evidence; it cannot
    // substitute for verifying these independently fetched bytes now.
    const minisign = verifyPrehashedMinisign(
      signingPublicKey,
      signature.payload!,
      bundle.blake2b512,
    );
    if (minisign.valid) {
      const signatureIndex = missing.indexOf('signature');
      if (signatureIndex >= 0) missing.splice(signatureIndex, 1);
      verified.push('signature');
      refs.push(`publication:minisign-key-id:${minisign.keyId}`);
    } else {
      failed.push(`signature:${minisign.reason}`);
    }
  }

  return result();
}

function nonEmptyObject(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' && value[key].trim().length > 0
    ? value[key] as string
    : undefined;
}

/**
 * Receipt strings locate an input tuple; they are NOT acceptance proof. Bind that tuple to
 * publish.finalize's actual input hash before using it for independent public reads.
 * The publisher currently permits logical source/version identity before bundle bytes exist.
 */
export function publicationProbeInputFromJournal(
  journal: TaskReleaseJournal,
): ByocPublicationProbeInput | null {
  const finalizations = journal.receipts.filter(({ stage }) => stage === 'publish.finalize');
  const finalized = finalizations.at(-1);
  if (
    !finalized || finalized.state !== 'committed' ||
    journal.receipts.some(({ operationId }) => operationId !== journal.operationId) ||
    finalizations.some(({ inputHash }) => inputHash !== finalized.inputHash)
  ) return null;
  const manifestDigests = new Set(finalized.evidenceRefs.flatMap((ref) => {
    const match = /^provider:finalization:([a-f0-9]{64})$/.exec(ref);
    return match ? [match[1]] : [];
  }));
  const bundleDigests = new Set(journal.receipts.flatMap((receipt) =>
    receipt.stage === 'publish.multipart.complete' && receipt.state === 'committed'
      ? receipt.evidenceRefs.flatMap((ref) => {
        const match = /^provider:bundle:([a-f0-9]{64})$/.exec(ref);
        return match ? [match[1]] : [];
      })
      : [],
  ));
  const pinnedBundle = stringField(journal.artifactIdentity, 'bundleSha256');
  if (pinnedBundle) {
    if (!/^[a-f0-9]{64}$/.test(pinnedBundle)) return null;
    bundleDigests.add(pinnedBundle);
  }
  // A deduplicated multipart initiation has no separate completion stage.
  for (const receipt of journal.receipts) {
    if (receipt.stage !== 'publish.multipart.initiate' || receipt.state !== 'committed') continue;
    for (const ref of receipt.evidenceRefs) {
      const match = /^provider:bundle:([a-f0-9]{64})$/.exec(ref);
      if (match) bundleDigests.add(match[1]);
    }
  }
  if (bundleDigests.size !== 1 || manifestDigests.size !== 1) return null;
  const bundleSha256 = [...bundleDigests][0];
  const manifestSha256 = [...manifestDigests][0];
  if (releaseStageInputHash({ bundleSha256, manifestSha256 }) !== finalized.inputHash) return null;
  const sourceSha = stringField(journal.source, 'sha');
  const version = stringField(journal.artifactIdentity, 'version');
  if (!sourceSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceSha)) return null;
  if (!pinnedBundle && (!version || stringField(journal.artifactIdentity, 'sourceSha') !== sourceSha)) return null;
  return {
    bundleSha256,
    manifestSha256,
    operationId: journal.operationId,
    expectedArtifactIdentity: { sourceSha, version },
  };
}

function milestoneFor(snapshot: ByocReleaseCarrySnapshot, key: ByocReleaseMilestoneKey) {
  return snapshot.milestoneProjection.milestones.find((milestone) => milestone.key === key) ?? null;
}

export interface ByocReadinessResult {
  verdict: ByocReadinessVerdict;
  bar: ByocAcceptanceBar;
  workItemId: string;
  measuredAt: string;
  taskIds: string[];
  evidenceRefs: string[];
  missingMilestones: string[];
  failedMilestones: string[];
  contradictions: string[];
  unverifiedEvidence: string[];
  artifactIdentityPresent: boolean;
  releaseTaskSelection: 'explicit' | 'ambiguous' | 'absent';
}

export interface ByocReleaseSubject {
  workspaceId: string;
  workItemId: string;
  taskId: string;
}

export interface ByocReleaseSubjectSnapshot extends ByocReleaseCarrySnapshot {
  publicationInput: ByocPublicationProbeInput | null;
}

/**
 * Acceptance is about one explicitly selected task, not a recent carry window.
 * Scope the SQL itself: an exact task belonging to another workspace or work
 * item must neither supply evidence nor disclose its journal.
 */
export async function readByocReleaseSubject(
  input: ByocReleaseSubject,
  sql: Sql,
): Promise<ByocReleaseSubjectSnapshot | null> {
  if (![input.workspaceId, input.workItemId, input.taskId].every((value) => value.trim().length > 0)) {
    throw new Error('BYOC acceptance requires a non-empty workspace, work item, and explicit task');
  }
  const rows = await sql<Array<{
    task_id: string;
    workspace_id: string;
    work_item_id: string;
    class: string;
    detail: Record<string, unknown> | null;
  }>>`
    SELECT task_id, workspace_id, work_item_id, class, detail
      FROM harness_shared.task_ledger
     WHERE task_id = ${input.taskId}
       AND workspace_id = ${input.workspaceId}
       AND work_item_id = ${input.workItemId}
       AND class = 'deploy'
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.task_id !== input.taskId ||
    row.workspace_id !== input.workspaceId ||
    row.work_item_id !== input.workItemId ||
    row.class !== 'deploy'
  ) return null;
  const journal = taskReleaseJournalFromDetail(row.detail);
  if (!journal || !journal.operationId.trim()) return null;
  // The carry parser validates shape/sequence, not receipt-to-operation identity.
  if (journal.receipts.some((receipt) => receipt.operationId !== journal.operationId)) return null;
  const publicationInput = publicationProbeInputFromJournal(journal);
  return {
    ...projectByocReleaseCarry(row.task_id, row.work_item_id, journal),
    publicationInput: publicationInput ? { ...publicationInput, taskId: row.task_id } : null,
  };
}

export function evaluateByocReadiness(
  bar: ByocAcceptanceBar,
  workItemId: string,
  snapshots: readonly ByocReleaseCarrySnapshot[],
  measuredAt = new Date().toISOString(),
): ByocReadinessResult {
  const taskIds = snapshots.map((snapshot) => snapshot.taskId);
  const evidenceRefs = [...new Set(snapshots.flatMap((snapshot) => snapshot.evidenceRefs))];
  const contradictions = [...new Set(snapshots.flatMap((snapshot) => snapshot.milestoneProjection.contradictions))];
  const missingMilestones: string[] = [];
  const failedMilestones: string[] = [];
  const unverifiedEvidence = [...UNJOINED_EVIDENCE[bar]];
  let artifactIdentityPresent = false;

  for (const snapshot of snapshots) {
    if (snapshot.workItemId !== workItemId) contradictions.push(`${snapshot.taskId}:work-item-identity-mismatch`);
    artifactIdentityPresent ||= nonEmptyObject(snapshot.artifactIdentity);
    for (const key of BAR_MILESTONES[bar]) {
      const milestone = milestoneFor(snapshot, key);
      if (!milestone || milestone.status === 'pending' || milestone.status === 'blocked') {
        missingMilestones.push(`${snapshot.taskId}:${key}`);
      } else if (milestone.status === 'failed') {
        failedMilestones.push(`${snapshot.taskId}:${key}`);
      }
      if (milestone && milestone.status === 'verified' && milestone.evidenceRefs.length === 0) {
        missingMilestones.push(`${snapshot.taskId}:${key}:evidence`);
      }
    }
  }

  if (snapshots.length === 0) {
    return {
      verdict: 'unknown',
      bar,
      workItemId,
      measuredAt,
      taskIds,
      evidenceRefs,
      missingMilestones: ['release-task'],
      failedMilestones,
      contradictions,
      unverifiedEvidence,
      artifactIdentityPresent,
      releaseTaskSelection: 'absent',
    };
  }

  // A work-item can retain multiple historical release tasks. Treating "any of
  // the latest three" as the acceptance subject would let an older successful
  // receipt launder a newer failed attempt. The caller must narrow to one task
  // before this reader can produce a positive verdict.
  if (snapshots.length !== 1) {
    return {
      verdict: 'unknown',
      bar,
      workItemId,
      measuredAt,
      taskIds,
      evidenceRefs,
      missingMilestones: ['release-task-selection'],
      failedMilestones,
      contradictions,
      unverifiedEvidence,
      artifactIdentityPresent,
      releaseTaskSelection: 'ambiguous',
    };
  }

  if (bar === 'R-4' && !artifactIdentityPresent) missingMilestones.push('artifact-identity');
  const verdict: ByocReadinessVerdict =
    failedMilestones.length > 0 || contradictions.length > 0
      ? 'fail'
      : missingMilestones.length > 0 || unverifiedEvidence.length > 0
        ? 'unknown'
        : 'pass';

  return {
    verdict,
    bar,
    workItemId,
    measuredAt,
    taskIds,
    evidenceRefs,
    missingMilestones: [...new Set(missingMilestones)],
    failedMilestones: [...new Set(failedMilestones)],
    contradictions,
    unverifiedEvidence,
    artifactIdentityPresent,
    releaseTaskSelection: 'explicit',
  };
}

export async function readByocReadiness(
  input: ByocReleaseSubject & { bar: ByocAcceptanceBar },
  sql: Sql,
  fetcher: PublicationProbeFetcher = globalThis.fetch,
): Promise<ByocReadinessResult> {
  const selected = await readByocReleaseSubject(input, sql);
  const readiness = evaluateByocReadiness(input.bar, input.workItemId, selected ? [selected] : []);
  if (input.bar === 'R-4' && selected?.publicationInput) {
    const publication = await probeByocPublication(selected.publicationInput, fetcher);
    readiness.evidenceRefs = [...new Set([...readiness.evidenceRefs, ...publication.evidenceRefs])];
    if (publication.failed.length > 0) {
      readiness.failedMilestones = [
        ...new Set([...readiness.failedMilestones, ...publication.failed.map((failure) => `publication:${failure}`)]),
      ];
      readiness.verdict = 'fail';
    } else {
      const joined = new Set(publication.verified);
      readiness.unverifiedEvidence = readiness.unverifiedEvidence.filter(
        (evidence) => !joined.has(evidence) || publication.missing.includes(evidence),
      );
      if (readiness.failedMilestones.length === 0 && readiness.contradictions.length === 0) {
        readiness.verdict =
          readiness.missingMilestones.length > 0 || readiness.unverifiedEvidence.length > 0
            ? 'unknown'
            : 'pass';
      }
    }
  }
  return readiness;
}

export default defineTool({
  name: 'release:byoc_readiness',
  description:
    'Unregistered BYOC diagnostic draft: read one exactly scoped task journal and independently inspect its public bytes. ' +
    'Receipt presence never produces a pass; detached minisign bytes are reverified, while SBOM, executable and live operational joins remain unresolved.',
  guidance: {
    when: 'Developing the BYOC acceptance reader against an explicitly identified release task.',
    notWhen: 'Grading or shipping: this draft is incomplete, unregistered, and not an acceptance probe.',
    chaining:
      'Supply bar, workItemId, and taskId; inspect unverifiedEvidence. Do not bind this draft into a rubric.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer'],
  args: z.object({
    bar: z.enum(['R-4', 'R-5', 'R-6']),
    workItemId: z.string().trim().min(1).max(120),
    taskId: z.string().trim().min(1).max(120),
  }),
  async handler(args) {
    const readiness = await readByocReadiness({ ...args, workspaceId: activeWorkspaceId() }, getOrgPg().sql);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(readiness),
        },
      ],
    };
  },
});
