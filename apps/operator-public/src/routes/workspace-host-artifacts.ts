/**
 * D-105/D-107/D-112 workspace-host artifact publication.
 *
 * Operator-authenticated uploads land create-only in the existing Cupboard R2
 * bucket. Public GET/HEAD remain indistinguishable from missing until a
 * create-only finalization marker binds the bundle, detached signature,
 * manifest, signing key, and trust receipts to one verified digest.
 * Large server bundles use a private immutable part plan plus native R2
 * multipart state, keeping every Worker request bounded while preserving the
 * exact content-addressed server.tgz key consumed by finalization and readers.
 */

import { isHexSha256, sha256Hex } from '@papercusp/artifact-registry';
import {
  deriveWorkspaceHostCanonicalArtifactUrls,
  validateWorkspaceHostImageArtifact,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { Env } from '../env.ts';
import { requireOperator } from './admin.ts';

export const WORKSPACE_HOST_ARTIFACT_PREFIX = 'artifacts/workspace-host/sha256';
export const WORKSPACE_HOST_ARTIFACT_FILES = [
  'server.tgz',
  'server.tgz.minisig',
  'manifest.json',
] as const;
export const WORKSPACE_HOST_PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

type WorkspaceHostCoreArtifactFile = (typeof WORKSPACE_HOST_ARTIFACT_FILES)[number];
type WorkspaceHostArtifactFile = WorkspaceHostCoreArtifactFile | 'sbom.cdx.json';

const FINALIZATION_FILE = '.finalized.json';
const PUBLICATION_SCHEMA_VERSION = 1;
const PUBLICATION_KIND = 'papercusp-workspace-host-release';
const FINALIZATION_KIND = 'papercusp-workspace-host-finalization';
const ARTIFACT_TRUST_VERSION = 'artifact-trust-v1';
const MULTIPART_STATE_SCHEMA_VERSION = 1;
const MULTIPART_STATE_KIND = 'papercusp-workspace-host-multipart-upload';
const MULTIPART_STATE_NAMESPACE = 'workspace-host-multipart-v1';
const MULTIPART_PART_RECEIPT_KIND = 'papercusp-workspace-host-multipart-part-receipt';
const MULTIPART_PART_RECEIPT_NAMESPACE = 'workspace-host-multipart-part-v1';
const MULTIPART_MIN_PART_BYTES = 5 * 1024 * 1024;
export const WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES = 32 * 1024 * 1024;
export const WORKSPACE_HOST_MULTIPART_MAX_PARTS = 1024;
export const WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES =
  WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES * WORKSPACE_HOST_MULTIPART_MAX_PARTS;
const MULTIPART_CONTROL_MAX_BYTES = 512 * 1024;
const MAX_BYTES: Readonly<Record<WorkspaceHostArtifactFile, number>> = {
  'server.tgz': 64 * 1024 * 1024,
  'server.tgz.minisig': 64 * 1024,
  'manifest.json': 1024 * 1024,
  'sbom.cdx.json': 16 * 1024 * 1024,
};
const CONTENT_TYPE: Readonly<Record<WorkspaceHostArtifactFile, string>> = {
  'server.tgz': 'application/gzip',
  'server.tgz.minisig': 'text/plain; charset=utf-8',
  'manifest.json': 'application/json; charset=utf-8',
  'sbom.cdx.json': 'application/vnd.cyclonedx+json; charset=utf-8',
};
const REQUIRED_TRUST_EVIDENCE = [
  'signature',
  'sbom',
  'vulnerability-scan',
  'secret-scan',
  'provenance-attestation',
] as const;

interface StoredFileDescriptor {
  sha256: string;
  sizeBytes: number;
}

interface FinalizationRecord {
  schemaVersion: typeof PUBLICATION_SCHEMA_VERSION;
  kind: typeof FINALIZATION_KIND;
  bundleSha256: string;
  manifestSha256: string;
  files: Record<WorkspaceHostCoreArtifactFile, StoredFileDescriptor>;
  finalizedAt: string;
  finalizedByGithubUserId: number;
}

interface MultipartPartPlan {
  partNumber: number;
  sha256: string;
  sizeBytes: number;
}

interface MultipartUploadState {
  schemaVersion: typeof MULTIPART_STATE_SCHEMA_VERSION;
  kind: typeof MULTIPART_STATE_KIND;
  bundleSha256: string;
  /** Short API capability token; never the opaque native R2 upload id. */
  uploadId: string;
  r2UploadId: string;
  sizeBytes: number;
  createdAt: string;
  createdByGithubUserId: number;
  parts: MultipartPartPlan[];
}

interface MultipartPartReceipt {
  schemaVersion: 1;
  kind: typeof MULTIPART_PART_RECEIPT_KIND;
  state: 'intent' | 'committed';
  bundleSha256: string;
  uploadId: string;
  partNumber: number;
  sha256: string;
  sizeBytes: number;
  createdByGithubUserId: number;
  createdAt: string;
  etag?: string;
  committedAt?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isArtifactFile(value: unknown): value is WorkspaceHostArtifactFile {
  return (
    typeof value === 'string' &&
    ((WORKSPACE_HOST_ARTIFACT_FILES as readonly string[]).includes(value) || value === 'sbom.cdx.json')
  );
}

function artifactPrefix(bundleSha256: string): string {
  return `${WORKSPACE_HOST_ARTIFACT_PREFIX}/${bundleSha256}`;
}

function artifactKey(bundleSha256: string, file: WorkspaceHostArtifactFile): string {
  return `${artifactPrefix(bundleSha256)}/${file}`;
}

function finalizationKey(bundleSha256: string): string {
  return `${artifactPrefix(bundleSha256)}/${FINALIZATION_FILE}`;
}

function multipartStateKey(bundleSha256: string, uploadId: string): string {
  return `${artifactPrefix(bundleSha256)}/.multipart/${encodeURIComponent(uploadId)}.json`;
}

function multipartPartReceiptKey(
  bundleSha256: string,
  uploadId: string,
  partNumber: number,
): string {
  return `${artifactPrefix(bundleSha256)}/.multipart/${encodeURIComponent(uploadId)}/parts/${partNumber}.json`;
}

function multipartStateMatches(
  state: MultipartUploadState,
  expected: {
    bundleSha256: string;
    uploadId: string;
    sizeBytes: number;
    createdByGithubUserId: number;
    parts: readonly MultipartPartPlan[];
  },
): boolean {
  return (
    state.bundleSha256 === expected.bundleSha256 &&
    state.uploadId === expected.uploadId &&
    state.sizeBytes === expected.sizeBytes &&
    state.createdByGithubUserId === expected.createdByGithubUserId &&
    state.parts.length === expected.parts.length &&
    state.parts.every((part, index) => {
      const wanted = expected.parts[index];
      return (
        wanted !== undefined &&
        part.partNumber === wanted.partNumber &&
        part.sha256 === wanted.sha256 &&
        part.sizeBytes === wanted.sizeBytes
      );
    })
  );
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isMultipartUploadId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function isR2MultipartUploadId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 8192 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function r2ErrorCode(error: unknown): number | null {
  if (!isRecord(error) && !(error instanceof Error)) return null;
  const explicit = isRecord(error) && typeof error.code === 'number' ? error.code : null;
  if (explicit !== null && Number.isSafeInteger(explicit)) return explicit;
  const message = error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === 'string'
      ? error.message
      : '';
  const match = message.match(/\((\d+)\)\s*$/);
  return match ? Number(match[1]) : null;
}

function multipartStorageFailure(
  c: Context<{ Bindings: Env }>,
  error: unknown,
  phase: 'initiate' | 'part' | 'part-intent' | 'part-reconcile' | 'status' | 'complete' | 'abort',
): Response {
  const code = r2ErrorCode(error);
  if (code === 10024) return c.json({ error: 'multipart_upload_not_found' }, 404);
  if (code === 10025) return c.json({ error: 'multipart_upload_incomplete' }, 409);
  if (code === 10011 || code === 10048) {
    return c.json({ error: 'multipart_parts_invalid' }, 400);
  }
  if (code === 10058) return c.json({ error: 'artifact_storage_rate_limited' }, 429);
  return c.json({ error: 'artifact_storage_unavailable', phase }, 502);
}

async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; error: 'invalid_json' | 'request_too_large' }> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength) {
    const parsedLength = parsePositiveInteger(declaredLength);
    if (parsedLength === null || parsedLength > maxBytes) {
      return { ok: false, error: 'request_too_large' };
    }
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return { ok: false, error: 'invalid_json' };
  if (body.byteLength > maxBytes) return { ok: false, error: 'request_too_large' };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

function parseMultipartPlan(
  value: unknown,
  expectedSizeBytes: number,
): { parts: MultipartPartPlan[]; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    return { parts: [], errors: ['parts must be an array'] };
  }
  for (const key of Object.keys(value)) {
    if (key !== 'parts') errors.push(`unexpected multipart plan field '${key}'`);
  }
  if (value.parts.length === 0 || value.parts.length > WORKSPACE_HOST_MULTIPART_MAX_PARTS) {
    errors.push(`parts must contain 1-${WORKSPACE_HOST_MULTIPART_MAX_PARTS} entries`);
  }

  const parts: MultipartPartPlan[] = [];
  for (let index = 0; index < value.parts.length; index += 1) {
    const candidate = value.parts[index];
    if (!isRecord(candidate)) {
      errors.push(`parts[${index}] must be an object`);
      continue;
    }
    for (const key of Object.keys(candidate)) {
      if (!['partNumber', 'sha256', 'sizeBytes'].includes(key)) {
        errors.push(`unexpected parts[${index}] field '${key}'`);
      }
    }
    const partNumber = Number(candidate.partNumber);
    const sizeBytes = Number(candidate.sizeBytes);
    if (!Number.isSafeInteger(partNumber) || partNumber !== index + 1) {
      errors.push(`parts[${index}].partNumber must equal ${index + 1}`);
    }
    if (!isHexSha256(candidate.sha256)) {
      errors.push(`parts[${index}].sha256 must be a lowercase SHA-256 digest`);
    }
    if (
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES
    ) {
      errors.push(
        `parts[${index}].sizeBytes must be between 1 and ${WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES}`,
      );
    }
    if (
      Number.isSafeInteger(partNumber) &&
      isHexSha256(candidate.sha256) &&
      Number.isSafeInteger(sizeBytes) &&
      sizeBytes > 0 &&
      sizeBytes <= WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES
    ) {
      parts.push({ partNumber, sha256: candidate.sha256, sizeBytes });
    }
  }

  if (parts.length === value.parts.length && parts.length > 0) {
    const regularPartBytes = parts[0].sizeBytes;
    if (parts.length > 1 && regularPartBytes < MULTIPART_MIN_PART_BYTES) {
      errors.push(`every non-final part must be at least ${MULTIPART_MIN_PART_BYTES} bytes`);
    }
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (parts[index].sizeBytes !== regularPartBytes) {
        errors.push('all non-final multipart parts must have identical sizes');
        break;
      }
    }
    if (parts.at(-1)!.sizeBytes > regularPartBytes) {
      errors.push('the final multipart part cannot exceed the regular part size');
    }
    const totalBytes = parts.reduce((sum, part) => sum + part.sizeBytes, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes !== expectedSizeBytes) {
      errors.push('multipart part sizes must sum to x-artifact-size');
    }
  }
  return { parts, errors: [...new Set(errors)] };
}

function parseMultipartState(
  value: unknown,
  bundleSha256: string,
  uploadId: string,
): MultipartUploadState | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== MULTIPART_STATE_SCHEMA_VERSION ||
    value.kind !== MULTIPART_STATE_KIND ||
    value.bundleSha256 !== bundleSha256 ||
    value.uploadId !== uploadId ||
    !isR2MultipartUploadId(value.r2UploadId) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0 ||
    Number(value.sizeBytes) > WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isSafeInteger(value.createdByGithubUserId) ||
    Number(value.createdByGithubUserId) <= 0
  ) {
    return null;
  }
  const plan = parseMultipartPlan({ parts: value.parts }, Number(value.sizeBytes));
  if (plan.errors.length > 0) return null;
  return {
    schemaVersion: MULTIPART_STATE_SCHEMA_VERSION,
    kind: MULTIPART_STATE_KIND,
    bundleSha256,
    uploadId,
    r2UploadId: value.r2UploadId,
    sizeBytes: Number(value.sizeBytes),
    createdAt: value.createdAt,
    createdByGithubUserId: Number(value.createdByGithubUserId),
    parts: plan.parts,
  };
}

async function readMultipartState(
  env: Env,
  bundleSha256: string,
  uploadId: string,
): Promise<MultipartUploadState | null> {
  const object = await env.ARTIFACTS.get(multipartStateKey(bundleSha256, uploadId));
  if (!object || object.size > MULTIPART_CONTROL_MAX_BYTES) return null;
  try {
    const state = parseMultipartState(JSON.parse(await object.text()), bundleSha256, uploadId);
    const metadata = object.customMetadata ?? {};
    if (
      !state ||
      metadata.namespace !== MULTIPART_STATE_NAMESPACE ||
      metadata.bundleSha256 !== bundleSha256 ||
      metadata.uploadId !== uploadId ||
      metadata.createdByGithubUserId !== String(state.createdByGithubUserId)
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function parseMultipartPartReceipt(
  value: unknown,
  expected: {
    bundleSha256: string;
    uploadId: string;
    partNumber: number;
  },
): MultipartPartReceipt | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== MULTIPART_PART_RECEIPT_KIND ||
    (value.state !== 'intent' && value.state !== 'committed') ||
    value.bundleSha256 !== expected.bundleSha256 ||
    value.uploadId !== expected.uploadId ||
    value.partNumber !== expected.partNumber ||
    !isHexSha256(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0 ||
    !Number.isSafeInteger(value.createdByGithubUserId) ||
    Number(value.createdByGithubUserId) <= 0 ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) return null;
  if (value.state === 'committed') {
    if (
      typeof value.etag !== 'string' ||
      value.etag.length === 0 ||
      value.etag.length > 512 ||
      typeof value.committedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.committedAt))
    ) return null;
  } else if (value.etag !== undefined || value.committedAt !== undefined) {
    return null;
  }
  return value as unknown as MultipartPartReceipt;
}

async function readMultipartPartReceipt(
  env: Env,
  expected: { bundleSha256: string; uploadId: string; partNumber: number },
): Promise<MultipartPartReceipt | null> {
  const object = await env.ARTIFACTS.get(
    multipartPartReceiptKey(expected.bundleSha256, expected.uploadId, expected.partNumber),
  );
  if (!object || object.size > MULTIPART_CONTROL_MAX_BYTES) return null;
  try {
    const receipt = parseMultipartPartReceipt(JSON.parse(await object.text()), expected);
    const metadata = object.customMetadata ?? {};
    if (
      !receipt ||
      metadata.namespace !== MULTIPART_PART_RECEIPT_NAMESPACE ||
      metadata.bundleSha256 !== expected.bundleSha256 ||
      metadata.uploadId !== expected.uploadId ||
      metadata.partNumber !== String(expected.partNumber) ||
      metadata.createdByGithubUserId !== String(receipt.createdByGithubUserId)
    ) return null;
    return receipt;
  } catch {
    return null;
  }
}

function multipartPartReceiptMatches(
  receipt: MultipartPartReceipt,
  expected: MultipartPartPlan & { createdByGithubUserId: number },
): boolean {
  return (
    receipt.partNumber === expected.partNumber &&
    receipt.sha256 === expected.sha256 &&
    receipt.sizeBytes === expected.sizeBytes &&
    receipt.createdByGithubUserId === expected.createdByGithubUserId
  );
}

function parseCompletionParts(
  value: unknown,
  plan: readonly MultipartPartPlan[],
): { parts: R2UploadedPart[]; error: string | null } {
  if (!isRecord(value) || !Array.isArray(value.parts)) {
    return { parts: [], error: 'parts must be an array' };
  }
  for (const key of Object.keys(value)) {
    if (key !== 'parts') return { parts: [], error: `unexpected completion field '${key}'` };
  }
  if (value.parts.length !== plan.length) {
    return { parts: [], error: 'completion must include every planned part exactly once' };
  }
  const parts: R2UploadedPart[] = [];
  for (let index = 0; index < value.parts.length; index += 1) {
    const candidate = value.parts[index];
    if (!isRecord(candidate)) return { parts: [], error: `parts[${index}] must be an object` };
    for (const key of Object.keys(candidate)) {
      if (!['partNumber', 'etag'].includes(key)) {
        return { parts: [], error: `unexpected parts[${index}] field '${key}'` };
      }
    }
    if (candidate.partNumber !== plan[index].partNumber) {
      return { parts: [], error: `parts[${index}].partNumber must equal ${plan[index].partNumber}` };
    }
    if (typeof candidate.etag !== 'string' || candidate.etag.length === 0 || candidate.etag.length > 512) {
      return { parts: [], error: `parts[${index}].etag is invalid` };
    }
    parts.push({ partNumber: plan[index].partNumber, etag: candidate.etag });
  }
  return { parts, error: null };
}

function metadataFor(
  file: WorkspaceHostArtifactFile,
  bundleSha256: string,
  fileSha256: string,
  sizeBytes: number,
  githubUserId: number,
): Record<string, string> {
  return {
    namespace: 'workspace-host-v1',
    bundleSha256,
    file,
    fileSha256,
    sizeBytes: String(sizeBytes),
    uploadedByGithubUserId: String(githubUserId),
  };
}

function descriptorFromObject(
  object: Pick<R2Object, 'size' | 'customMetadata'> | null,
  file: WorkspaceHostArtifactFile,
  bundleSha256: string,
): StoredFileDescriptor | null {
  if (!object) return null;
  const metadata = object.customMetadata ?? {};
  const sizeBytes = Number(metadata.sizeBytes);
  if (
    metadata.namespace !== 'workspace-host-v1' ||
    metadata.bundleSha256 !== bundleSha256 ||
    metadata.file !== file ||
    !isHexSha256(metadata.fileSha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes !== object.size
  ) {
    return null;
  }
  if (file === 'server.tgz' && metadata.fileSha256 !== bundleSha256) return null;
  return { sha256: metadata.fileSha256, sizeBytes };
}

function descriptorMatches(
  object: Pick<R2Object, 'size' | 'customMetadata'> | null,
  file: WorkspaceHostArtifactFile,
  bundleSha256: string,
  expected: StoredFileDescriptor,
): boolean {
  const actual = descriptorFromObject(object, file, bundleSha256);
  return actual?.sha256 === expected.sha256 && actual.sizeBytes === expected.sizeBytes;
}

async function putCreateOnly(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
  options: R2PutOptions,
): Promise<'created' | 'exists'> {
  try {
    // The installed Workers types model conditional PUT as R2Object, while the
    // runtime may surface an unsatisfied precondition as null or an exception.
    // Handle both and adjudicate the race from a fresh HEAD.
    const result = (await bucket.put(key, body, {
      ...options,
      onlyIf: { etagDoesNotMatch: '*' },
    })) as R2Object | null;
    return result ? 'created' : 'exists';
  } catch (error) {
    if (await bucket.head(key)) return 'exists';
    throw error;
  }
}

const SAFE_SECRET_FIELD_NAMES = new Set([
  'maxSecretFindings',
  'signingPublicKey',
  'signingKeySha256',
]);
const SECRET_FIELD = /(?:^|[-_.])(password|passwd|credential|credentials|secret|token|private[-_]?key|api[-_]?key)(?:$|[-_.])/i;
const SECRET_VALUE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,})\b/;

function secretMaterialError(value: unknown, path = 'manifest'): string | null {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) return `${path} contains secret-shaped material`;
    try {
      const url = new URL(value);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && (url.username || url.password)) {
        return `${path} contains URL credentials`;
      }
    } catch {
      // Most manifest strings are not URLs; only successfully parsed HTTP(S)
      // values participate in the userinfo guard.
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const error = secretMaterialError(value[index], `${path}[${index}]`);
      if (error) return error;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
    if (!SAFE_SECRET_FIELD_NAMES.has(key) && SECRET_FIELD.test(normalized)) {
      return `${path}.${key} is a secret-shaped field`;
    }
    const error = secretMaterialError(nested, `${path}.${key}`);
    if (error) return error;
  }
  return null;
}

function validTool(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.trim().length > 0 &&
    typeof value.version === 'string' &&
    value.version.trim().length > 0
  );
}

function validateTrustReport(
  value: unknown,
  bundleSha256: string,
  bundle: StoredFileDescriptor,
  signature: StoredFileDescriptor,
  signingKeySha256: string,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['trustReport must be an object'];
  if (value.version !== ARTIFACT_TRUST_VERSION) {
    errors.push(`trustReport.version must be '${ARTIFACT_TRUST_VERSION}'`);
  }
  if (value.trusted !== true) errors.push('trustReport.trusted must be true');
  if (!Array.isArray(value.failures) || value.failures.length !== 0) {
    errors.push('trustReport.failures must be an empty array');
  }

  const subject = value.subject;
  if (
    !isRecord(subject) ||
    subject.sha256 !== bundleSha256 ||
    subject.bytes !== bundle.sizeBytes ||
    subject.signed !== true ||
    typeof subject.path !== 'string' ||
    subject.path.trim().length === 0 ||
    typeof subject.name !== 'string' ||
    subject.name.trim().length === 0
  ) {
    errors.push('trustReport.subject must bind the signed bundle digest and exact byte count');
  }

  const policy = value.policy;
  let maxAttestationAgeMs: number | null = null;
  if (
    !isRecord(policy) ||
    policy.maxSecretFindings !== 0 ||
    !['low', 'medium', 'high', 'critical'].includes(String(policy.denyVulnerabilitiesAtOrAbove)) ||
    !Number.isSafeInteger(policy.maxAttestationAgeMs) ||
    Number(policy.maxAttestationAgeMs) <= 0
  ) {
    errors.push('trustReport.policy must be explicit and require zero secret findings');
  } else {
    maxAttestationAgeMs = Number(policy.maxAttestationAgeMs);
  }

  if (!Array.isArray(value.evidence)) {
    errors.push('trustReport.evidence must contain every required evidence class');
    return errors;
  }
  const seen = new Set<string>();
  let sbomSha256: string | null = null;
  let scannedSbomSha256: string | null = null;
  for (const candidate of value.evidence) {
    if (!isRecord(candidate) || typeof candidate.kind !== 'string') {
      errors.push('every trust evidence entry must be an object with a kind');
      continue;
    }
    const kind = candidate.kind;
    if (seen.has(kind)) errors.push(`trustReport.evidence contains duplicate '${kind}'`);
    seen.add(kind);
    if (candidate.subjectSha256 !== bundleSha256) {
      errors.push(`${kind} evidence is not bound to the bundle digest`);
    }
    if (!validTool(candidate.tool)) errors.push(`${kind} evidence lacks exact tool metadata`);

    if (kind === 'signature') {
      if (
        candidate.valid !== true ||
        candidate.signatureSha256 !== signature.sha256 ||
        candidate.signingKeySha256 !== signingKeySha256
      ) {
        errors.push('signature evidence must verify the uploaded signature and pinned signing key');
      }
    } else if (kind === 'sbom') {
      if (
        typeof candidate.format !== 'string' ||
        !isHexSha256(candidate.documentSha256) ||
        !Number.isSafeInteger(candidate.componentCount) ||
        Number(candidate.componentCount) < 0
      ) {
        errors.push('sbom evidence is malformed');
      } else {
        sbomSha256 = candidate.documentSha256;
      }
    } else if (kind === 'vulnerability-scan') {
      if (!isHexSha256(candidate.sbomSha256) || !Array.isArray(candidate.findings)) {
        errors.push('vulnerability-scan evidence is malformed');
      } else {
        scannedSbomSha256 = candidate.sbomSha256;
      }
    } else if (kind === 'secret-scan') {
      if (!Array.isArray(candidate.findings) || candidate.findings.length !== 0) {
        errors.push('secret-scan evidence must report zero findings');
      }
    } else if (kind === 'provenance-attestation') {
      if (
        candidate.valid !== true ||
        typeof candidate.predicateType !== 'string' ||
        candidate.predicateType.trim().length === 0 ||
        !isHexSha256(candidate.attestationSha256) ||
        typeof candidate.issuedAt !== 'string' ||
        !Number.isFinite(Date.parse(candidate.issuedAt))
      ) {
        errors.push('provenance-attestation evidence is malformed or invalid');
      } else if (maxAttestationAgeMs !== null) {
        const ageMs = Date.now() - Date.parse(candidate.issuedAt);
        if (ageMs < 0 || ageMs > maxAttestationAgeMs) {
          errors.push('provenance-attestation evidence is outside the declared freshness policy');
        }
      }
    }
  }
  for (const kind of REQUIRED_TRUST_EVIDENCE) {
    if (!seen.has(kind)) errors.push(`trustReport.evidence is missing '${kind}'`);
  }
  if (value.evidence.length !== REQUIRED_TRUST_EVIDENCE.length) {
    errors.push('trustReport.evidence must contain exactly the five required evidence classes');
  }
  if (sbomSha256 && scannedSbomSha256 && sbomSha256 !== scannedSbomSha256) {
    errors.push('vulnerability-scan evidence is bound to a different SBOM');
  }
  return errors;
}

function fileDescriptor(value: unknown, expectedName: string): StoredFileDescriptor | null {
  if (
    !isRecord(value) ||
    value.name !== expectedName ||
    !isHexSha256(value.sha256) ||
    !Number.isSafeInteger(value.sizeBytes) ||
    Number(value.sizeBytes) <= 0
  ) {
    return null;
  }
  return { sha256: value.sha256, sizeBytes: Number(value.sizeBytes) };
}

function validatePublicationManifest(
  value: unknown,
  bundleSha256: string,
  stored: Record<WorkspaceHostCoreArtifactFile, StoredFileDescriptor>,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['manifest must be a JSON object'];
  const allowedTopLevel = new Set(['schemaVersion', 'kind', 'artifact', 'files', 'trustReport']);
  for (const key of Object.keys(value)) {
    if (!allowedTopLevel.has(key)) errors.push(`unexpected manifest field '${key}'`);
  }
  if (value.schemaVersion !== PUBLICATION_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PUBLICATION_SCHEMA_VERSION}`);
  }
  if (value.kind !== PUBLICATION_KIND) errors.push(`kind must be '${PUBLICATION_KIND}'`);

  const secretError = secretMaterialError(value);
  if (secretError) errors.push(secretError);

  const files = value.files;
  const bundle = isRecord(files) ? fileDescriptor(files.bundle, 'server.tgz') : null;
  const signature = isRecord(files) ? fileDescriptor(files.signature, 'server.tgz.minisig') : null;
  if (!bundle) errors.push('files.bundle must describe server.tgz with a digest and positive size');
  if (!signature) {
    errors.push('files.signature must describe server.tgz.minisig with a digest and positive size');
  }
  if (bundle && (bundle.sha256 !== bundleSha256 || bundle.sizeBytes !== stored['server.tgz'].sizeBytes)) {
    errors.push('files.bundle does not match the uploaded content-addressed bundle');
  }
  if (
    signature &&
    (signature.sha256 !== stored['server.tgz.minisig'].sha256 ||
      signature.sizeBytes !== stored['server.tgz.minisig'].sizeBytes)
  ) {
    errors.push('files.signature does not match the uploaded detached signature');
  }

  let artifact: WorkspaceHostImageArtifact | null = null;
  if (!isRecord(value.artifact)) {
    errors.push('artifact must be a WorkspaceHostImageArtifact object');
  } else {
    artifact = value.artifact as unknown as WorkspaceHostImageArtifact;
    try {
      errors.push(...validateWorkspaceHostImageArtifact(artifact).map((error) => `artifact: ${error}`));
    } catch (error) {
      errors.push(`artifact validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (artifact) {
    const canonical = deriveWorkspaceHostCanonicalArtifactUrls(bundleSha256);
    if (
      artifact.release.bundleSha256 !== bundleSha256 ||
      artifact.buildManifest.releaseArtifact.sha256 !== bundleSha256
    ) {
      errors.push('artifact release/build digests must equal the addressed bundle digest');
    }
    if (artifact.buildManifest.releaseArtifact.sizeBytes !== stored['server.tgz'].sizeBytes) {
      errors.push('artifact build manifest size does not equal the uploaded bundle size');
    }
    if (
      artifact.release.bundleUrl !== canonical.bundleUrl ||
      artifact.release.signatureUrl !== canonical.signatureUrl
    ) {
      errors.push('artifact release URLs must equal the D-105 digest-derived Cupboard URLs');
    }
    if (artifact.lifecycle.state !== 'active') errors.push('artifact lifecycle must be active at publication');
    if (bundle && signature) {
      errors.push(
        ...validateTrustReport(
          value.trustReport,
          bundleSha256,
          bundle,
          signature,
          artifact.release.signingKeySha256,
        ),
      );
    }
  }
  return [...new Set(errors)];
}

function parseFinalizationRecord(value: unknown, bundleSha256: string): FinalizationRecord | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PUBLICATION_SCHEMA_VERSION ||
    value.kind !== FINALIZATION_KIND ||
    value.bundleSha256 !== bundleSha256 ||
    !isHexSha256(value.manifestSha256) ||
    typeof value.finalizedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.finalizedAt)) ||
    !Number.isSafeInteger(value.finalizedByGithubUserId) ||
    Number(value.finalizedByGithubUserId) <= 0 ||
    !isRecord(value.files)
  ) {
    return null;
  }
  const files = {} as Record<WorkspaceHostCoreArtifactFile, StoredFileDescriptor>;
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const raw = value.files[file];
    if (!isRecord(raw) || !isHexSha256(raw.sha256) || !Number.isSafeInteger(raw.sizeBytes) || Number(raw.sizeBytes) <= 0) {
      return null;
    }
    files[file] = { sha256: raw.sha256, sizeBytes: Number(raw.sizeBytes) };
  }
  if (files['server.tgz'].sha256 !== bundleSha256 || files['manifest.json'].sha256 !== value.manifestSha256) {
    return null;
  }
  return {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    kind: FINALIZATION_KIND,
    bundleSha256,
    manifestSha256: value.manifestSha256,
    files,
    finalizedAt: value.finalizedAt,
    finalizedByGithubUserId: Number(value.finalizedByGithubUserId),
  };
}

async function readFinalizationRecord(env: Env, bundleSha256: string): Promise<FinalizationRecord | null> {
  const object = await env.ARTIFACTS.get(finalizationKey(bundleSha256));
  if (!object) return null;
  try {
    const record = parseFinalizationRecord(JSON.parse(await object.text()), bundleSha256);
    const metadata = object.customMetadata ?? {};
    if (
      !record ||
      metadata.namespace !== 'workspace-host-v1' ||
      metadata.bundleSha256 !== bundleSha256 ||
      metadata.manifestSha256 !== record.manifestSha256 ||
      metadata.finalizedByGithubUserId !== String(record.finalizedByGithubUserId)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function finalizationObjectsMatch(env: Env, record: FinalizationRecord): Promise<boolean> {
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const object = await env.ARTIFACTS.head(artifactKey(record.bundleSha256, file));
    if (!descriptorMatches(object, file, record.bundleSha256, record.files[file])) return false;
  }
  return true;
}

/** Supplementary evidence is already pinned by the immutable manifest. Attaching
 * its exact bytes must never replace that manifest or its three-object marker. */
async function finalizedSbomDigest(env: Env, bundleSha256: string): Promise<string | null> {
  const record = await readFinalizationRecord(env, bundleSha256);
  if (!record) return null;
  const object = await env.ARTIFACTS.get(artifactKey(bundleSha256, 'manifest.json'));
  if (!descriptorMatches(object, 'manifest.json', bundleSha256, record.files['manifest.json'])) return null;
  const bytes = await object!.arrayBuffer();
  if (bytes.byteLength !== record.files['manifest.json'].sizeBytes ||
      await sha256Hex(bytes) !== record.manifestSha256) return null;
  try {
    const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(manifest) || !isRecord(manifest.trustReport) ||
        !Array.isArray(manifest.trustReport.evidence)) return null;
    const sboms = manifest.trustReport.evidence.filter((entry) => isRecord(entry) && entry.kind === 'sbom');
    const sbom = sboms[0];
    return sboms.length === 1 && isRecord(sbom) && sbom.subjectSha256 === bundleSha256 &&
      sbom.format === 'cyclonedx-json' && isHexSha256(sbom.documentSha256) ? sbom.documentSha256 : null;
  } catch {
    return null;
  }
}

async function uploadArtifact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;

  const bundleSha256 = c.req.param('bundleSha256');
  const rawFile = c.req.param('file');
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);
  if (!isArtifactFile(rawFile)) return c.json({ error: 'not_found' }, 404);
  const file = rawFile;

  const declaredSha256 = c.req.header('x-artifact-sha256') ?? '';
  const declaredSize = parsePositiveInteger(c.req.header('x-artifact-size'));
  if (!isHexSha256(declaredSha256)) return c.json({ error: 'invalid_artifact_sha256' }, 400);
  if (declaredSize === null) return c.json({ error: 'invalid_artifact_size' }, 400);
  if (file === 'server.tgz' && declaredSha256 !== bundleSha256) {
    return c.json({ error: 'bundle_digest_mismatch' }, 400);
  }
  if (declaredSize > MAX_BYTES[file]) {
    if (file === 'server.tgz') {
      return c.json(
        {
          error: 'artifact_too_large',
          maxBytes: MAX_BYTES[file],
          multipart: {
            endpoint: `/admin/artifacts/workspace-host/sha256/${bundleSha256}/server.tgz/multipart`,
            maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
            maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
            maxBundleBytes: WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES,
          },
        },
        413,
      );
    }
    return c.json({ error: 'artifact_too_large', maxBytes: MAX_BYTES[file] }, 413);
  }
  const contentLength = c.req.header('content-length');
  if (contentLength) {
    const parsedContentLength = parsePositiveInteger(contentLength);
    if (parsedContentLength === null || parsedContentLength !== declaredSize) {
      return c.json({ error: 'content_length_mismatch' }, 400);
    }
  }

  if (file === 'sbom.cdx.json') {
    const boundDigest = await finalizedSbomDigest(c.env, bundleSha256);
    if (!boundDigest) return c.json({ error: 'finalized_sbom_binding_required' }, 409);
    if (declaredSha256 !== boundDigest) return c.json({ error: 'sbom_binding_mismatch' }, 409);
  }
  const key = artifactKey(bundleSha256, file);
  const expected = { sha256: declaredSha256, sizeBytes: declaredSize };
  const existing = await c.env.ARTIFACTS.head(key);
  if (existing) {
    if (descriptorMatches(existing, file, bundleSha256, expected)) {
      return c.json({ ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: true });
    }
    return c.json({ error: 'artifact_conflict', file }, 409);
  }
  if (file !== 'sbom.cdx.json' && await c.env.ARTIFACTS.head(finalizationKey(bundleSha256))) {
    return c.json({ error: 'artifact_finalized' }, 409);
  }

  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength !== declaredSize) return c.json({ error: 'artifact_size_mismatch' }, 400);
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== declaredSha256) {
    return c.json({ error: 'artifact_sha256_mismatch', expected: declaredSha256, actual: actualSha256 }, 400);
  }

  const outcome = await putCreateOnly(c.env.ARTIFACTS, key, body, {
    httpMetadata: { contentType: CONTENT_TYPE[file] },
    customMetadata: metadataFor(file, bundleSha256, declaredSha256, declaredSize, operator.id),
    sha256: declaredSha256,
  });
  if (outcome === 'exists') {
    const raced = await c.env.ARTIFACTS.head(key);
    if (descriptorMatches(raced, file, bundleSha256, expected)) {
      return c.json({ ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: true });
    }
    return c.json({ error: 'artifact_conflict', file }, 409);
  }
  return c.json(
    { ok: true, file, sha256: declaredSha256, bytes: declaredSize, deduped: false },
    201,
  );
}

async function initiateMultipartArtifact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;

  const bundleSha256 = c.req.param('bundleSha256');
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);
  const declaredSha256 = c.req.header('x-artifact-sha256') ?? '';
  const declaredSize = parsePositiveInteger(c.req.header('x-artifact-size'));
  if (!isHexSha256(declaredSha256)) return c.json({ error: 'invalid_artifact_sha256' }, 400);
  if (declaredSha256 !== bundleSha256) return c.json({ error: 'bundle_digest_mismatch' }, 400);
  if (declaredSize === null) return c.json({ error: 'invalid_artifact_size' }, 400);
  if (declaredSize > WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES) {
    return c.json(
      { error: 'artifact_too_large', maxBytes: WORKSPACE_HOST_MULTIPART_MAX_BUNDLE_BYTES },
      413,
    );
  }
  // The caller persists this one-use identity in its task/operation journal
  // BEFORE issuing the mutation. It is also the public multipart capability,
  // which makes a lost response recoverable without exposing the opaque native
  // R2 upload id or creating a second provider upload.
  const uploadId = c.req.header('x-operation-id');
  if (!isMultipartUploadId(uploadId)) {
    return c.json({ error: 'invalid_multipart_operation_id' }, 400);
  }

  const key = artifactKey(bundleSha256, 'server.tgz');
  const expected = { sha256: bundleSha256, sizeBytes: declaredSize };
  const existing = await c.env.ARTIFACTS.head(key);
  if (existing) {
    if (descriptorMatches(existing, 'server.tgz', bundleSha256, expected)) {
      return c.json({
        ok: true,
        file: 'server.tgz',
        sha256: bundleSha256,
        bytes: declaredSize,
        deduped: true,
      });
    }
    return c.json({ error: 'artifact_conflict', file: 'server.tgz' }, 409);
  }
  if (await c.env.ARTIFACTS.head(finalizationKey(bundleSha256))) {
    return c.json({ error: 'artifact_finalized' }, 409);
  }

  const body = await readBoundedJson(c.req.raw, MULTIPART_CONTROL_MAX_BYTES);
  if (!body.ok) {
    return c.json(
      { error: body.error },
      body.error === 'request_too_large' ? 413 : 400,
    );
  }
  const plan = parseMultipartPlan(body.value, declaredSize);
  if (plan.errors.length > 0) {
    return c.json({ error: 'invalid_multipart_plan', errors: plan.errors }, 400);
  }

  const expectedState = {
    bundleSha256,
    uploadId,
    sizeBytes: declaredSize,
    createdByGithubUserId: operator.id,
    parts: plan.parts,
  };
  let prior: MultipartUploadState | null;
  try {
    prior = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, 'initiate');
  }
  if (prior) {
    if (prior.createdByGithubUserId !== operator.id) {
      return c.json({ error: 'multipart_upload_owner_mismatch' }, 403);
    }
    if (!multipartStateMatches(prior, expectedState)) {
      return c.json({ error: 'multipart_operation_conflict' }, 409);
    }
    return c.json({
      ok: true,
      file: 'server.tgz',
      uploadId,
      operationId: uploadId,
      sha256: bundleSha256,
      bytes: declaredSize,
      partSizeBytes: plan.parts[0].sizeBytes,
      partCount: plan.parts.length,
      maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
      maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
      deduped: false,
      resumed: true,
    });
  }

  let upload: R2MultipartUpload;
  try {
    upload = await c.env.ARTIFACTS.createMultipartUpload(key, {
      httpMetadata: { contentType: CONTENT_TYPE['server.tgz'] },
      customMetadata: {
        ...metadataFor('server.tgz', bundleSha256, bundleSha256, declaredSize, operator.id),
        uploadMode: 'multipart',
      },
    });
  } catch (error) {
    return multipartStorageFailure(c, error, 'initiate');
  }
  if (!isR2MultipartUploadId(upload.uploadId)) {
    await upload.abort().catch(() => undefined);
    return c.json({ error: 'invalid_storage_upload_id' }, 502);
  }
  const state: MultipartUploadState = {
    schemaVersion: MULTIPART_STATE_SCHEMA_VERSION,
    kind: MULTIPART_STATE_KIND,
    bundleSha256,
    uploadId,
    r2UploadId: upload.uploadId,
    sizeBytes: declaredSize,
    createdAt: new Date().toISOString(),
    createdByGithubUserId: operator.id,
    parts: plan.parts,
  };
  try {
    const stateOutcome = await putCreateOnly(
      c.env.ARTIFACTS,
      multipartStateKey(bundleSha256, uploadId),
      JSON.stringify(state),
      {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          namespace: MULTIPART_STATE_NAMESPACE,
          bundleSha256,
          uploadId,
          createdByGithubUserId: String(operator.id),
        },
      },
    );
    if (stateOutcome === 'exists') {
      await upload.abort().catch(() => undefined);
      let raced: MultipartUploadState | null;
      try {
        raced = await readMultipartState(c.env, bundleSha256, uploadId);
      } catch (error) {
        return multipartStorageFailure(c, error, 'initiate');
      }
      if (!raced || !multipartStateMatches(raced, expectedState)) {
        return c.json({ error: 'multipart_operation_conflict' }, 409);
      }
      return c.json({
        ok: true,
        file: 'server.tgz',
        uploadId,
        operationId: uploadId,
        sha256: bundleSha256,
        bytes: declaredSize,
        partSizeBytes: plan.parts[0].sizeBytes,
        partCount: plan.parts.length,
        maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
        maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
        deduped: false,
        resumed: true,
      });
    }
  } catch (error) {
    await upload.abort().catch(() => undefined);
    return multipartStorageFailure(c, error, 'initiate');
  }

  return c.json(
    {
      ok: true,
      file: 'server.tgz',
      uploadId,
      operationId: uploadId,
      sha256: bundleSha256,
      bytes: declaredSize,
      partSizeBytes: plan.parts[0].sizeBytes,
      partCount: plan.parts.length,
      maxPartBytes: WORKSPACE_HOST_MULTIPART_MAX_PART_BYTES,
      maxParts: WORKSPACE_HOST_MULTIPART_MAX_PARTS,
      deduped: false,
      resumed: false,
    },
    201,
  );
}

async function uploadMultipartPart(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param('bundleSha256');
  const uploadId = c.req.query('uploadId');
  const partNumber = parsePositiveInteger(c.req.param('partNumber'));
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: 'invalid_multipart_upload_id' }, 400);
  if (
    partNumber === null ||
    partNumber > WORKSPACE_HOST_MULTIPART_MAX_PARTS
  ) {
    return c.json({ error: 'invalid_multipart_part_number' }, 400);
  }

  let state: MultipartUploadState | null;
  try {
    state = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, 'part');
  }
  if (!state) return c.json({ error: 'multipart_upload_not_found' }, 404);
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: 'multipart_upload_owner_mismatch' }, 403);
  }
  const expected = state.parts[partNumber - 1];
  if (!expected || expected.partNumber !== partNumber) {
    return c.json({ error: 'multipart_part_not_planned' }, 400);
  }

  const declaredSha256 = c.req.header('x-part-sha256') ?? '';
  const declaredSize = parsePositiveInteger(c.req.header('x-part-size'));
  if (!isHexSha256(declaredSha256) || declaredSha256 !== expected.sha256) {
    return c.json({ error: 'multipart_part_digest_mismatch' }, 400);
  }
  if (declaredSize === null || declaredSize !== expected.sizeBytes) {
    return c.json({ error: 'multipart_part_size_mismatch' }, 400);
  }
  const contentLength = parsePositiveInteger(c.req.header('content-length'));
  if (contentLength === null) return c.json({ error: 'content_length_required' }, 411);
  if (contentLength !== expected.sizeBytes) {
    return c.json({ error: 'content_length_mismatch' }, 400);
  }

  const body = await c.req.raw.arrayBuffer();
  if (body.byteLength !== expected.sizeBytes) {
    return c.json({ error: 'multipart_part_size_mismatch' }, 400);
  }
  const actualSha256 = await sha256Hex(body);
  if (actualSha256 !== expected.sha256) {
    return c.json(
      { error: 'multipart_part_sha256_mismatch', expected: expected.sha256, actual: actualSha256 },
      400,
    );
  }

  const receiptIdentity = { bundleSha256, uploadId, partNumber };
  const receiptExpected = { ...expected, createdByGithubUserId: operator.id };
  let priorReceipt: MultipartPartReceipt | null;
  try {
    priorReceipt = await readMultipartPartReceipt(c.env, receiptIdentity);
  } catch (error) {
    return multipartStorageFailure(c, error, 'part-reconcile');
  }
  if (priorReceipt) {
    if (!multipartPartReceiptMatches(priorReceipt, receiptExpected)) {
      return c.json({ error: 'multipart_part_operation_conflict' }, 409);
    }
    if (priorReceipt.state === 'intent') {
      return c.json({ error: 'multipart_part_outcome_unknown', uploadId, partNumber }, 409);
    }
    return c.json({
      ok: true,
      uploadId,
      partNumber,
      etag: priorReceipt.etag,
      sha256: priorReceipt.sha256,
      bytes: priorReceipt.sizeBytes,
      deduped: true,
      resumed: true,
    });
  }

  const receiptKey = multipartPartReceiptKey(bundleSha256, uploadId, partNumber);
  const receiptMetadata = {
    namespace: MULTIPART_PART_RECEIPT_NAMESPACE,
    bundleSha256,
    uploadId,
    partNumber: String(partNumber),
    createdByGithubUserId: String(operator.id),
  };
  const intent: MultipartPartReceipt = {
    schemaVersion: 1,
    kind: MULTIPART_PART_RECEIPT_KIND,
    state: 'intent',
    bundleSha256,
    uploadId,
    partNumber,
    sha256: actualSha256,
    sizeBytes: body.byteLength,
    createdByGithubUserId: operator.id,
    createdAt: new Date().toISOString(),
  };
  try {
    const claimed = await putCreateOnly(c.env.ARTIFACTS, receiptKey, JSON.stringify(intent), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: receiptMetadata,
    });
    if (claimed === 'exists') {
      const raced = await readMultipartPartReceipt(c.env, receiptIdentity);
      if (!raced || !multipartPartReceiptMatches(raced, receiptExpected)) {
        return c.json({ error: 'multipart_part_operation_conflict' }, 409);
      }
      if (raced.state === 'intent') {
        return c.json({ error: 'multipart_part_outcome_unknown', uploadId, partNumber }, 409);
      }
      return c.json({
        ok: true,
        uploadId,
        partNumber,
        etag: raced.etag,
        sha256: raced.sha256,
        bytes: raced.sizeBytes,
        deduped: true,
        resumed: true,
      });
    }
  } catch (error) {
    return multipartStorageFailure(c, error, 'part-intent');
  }

  try {
    const part = await c.env.ARTIFACTS
      .resumeMultipartUpload(artifactKey(bundleSha256, 'server.tgz'), state.r2UploadId)
      .uploadPart(partNumber, body);
    const committed: MultipartPartReceipt = {
      ...intent,
      state: 'committed',
      etag: part.etag,
      committedAt: new Date().toISOString(),
    };
    await c.env.ARTIFACTS.put(receiptKey, JSON.stringify(committed), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: receiptMetadata,
    });
    return c.json({
      ok: true,
      uploadId,
      partNumber: part.partNumber,
      etag: part.etag,
      sha256: actualSha256,
      bytes: body.byteLength,
      deduped: false,
      resumed: false,
    });
  } catch (error) {
    return multipartStorageFailure(c, error, 'part');
  }
}

async function getMultipartStatus(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param('bundleSha256');
  const uploadId = c.req.query('uploadId');
  const partNumber = parsePositiveInteger(c.req.query('partNumber'));
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: 'invalid_multipart_upload_id' }, 400);
  if (partNumber === null || partNumber > WORKSPACE_HOST_MULTIPART_MAX_PARTS) {
    return c.json({ error: 'invalid_multipart_part_number' }, 400);
  }
  let state: MultipartUploadState | null;
  let receipt: MultipartPartReceipt | null;
  try {
    [state, receipt] = await Promise.all([
      readMultipartState(c.env, bundleSha256, uploadId),
      readMultipartPartReceipt(c.env, { bundleSha256, uploadId, partNumber }),
    ]);
  } catch (error) {
    return multipartStorageFailure(c, error, 'status');
  }
  if (!state) {
    const object = await c.env.ARTIFACTS.head(artifactKey(bundleSha256, 'server.tgz'));
    const descriptor = descriptorFromObject(object, 'server.tgz', bundleSha256);
    return descriptor
      ? c.json({ ok: true, uploadId, completed: true, bundle: descriptor })
      : c.json({ error: 'multipart_upload_not_found' }, 404);
  }
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: 'multipart_upload_owner_mismatch' }, 403);
  }
  const expected = state.parts[partNumber - 1];
  if (!expected || expected.partNumber !== partNumber) {
    return c.json({ error: 'multipart_part_not_planned' }, 400);
  }
  if (!receipt) return c.json({ ok: true, uploadId, partNumber, state: 'absent' });
  if (!multipartPartReceiptMatches(receipt, { ...expected, createdByGithubUserId: operator.id })) {
    return c.json({ error: 'multipart_part_operation_conflict' }, 409);
  }
  return c.json({
    ok: true,
    uploadId,
    partNumber,
    state: receipt.state,
    sha256: receipt.sha256,
    bytes: receipt.sizeBytes,
    ...(receipt.state === 'committed' ? { etag: receipt.etag } : {}),
  });
}

async function completeMultipartArtifact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param('bundleSha256');
  const uploadId = c.req.query('uploadId');
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: 'invalid_multipart_upload_id' }, 400);

  const key = artifactKey(bundleSha256, 'server.tgz');
  let state: MultipartUploadState | null;
  try {
    state = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, 'complete');
  }
  if (!state) {
    const existing = await c.env.ARTIFACTS.head(key);
    const descriptor = descriptorFromObject(existing, 'server.tgz', bundleSha256);
    if (descriptor) {
      return c.json({
        ok: true,
        file: 'server.tgz',
        sha256: bundleSha256,
        bytes: descriptor.sizeBytes,
        deduped: true,
      });
    }
    if (existing) return c.json({ error: 'artifact_conflict', file: 'server.tgz' }, 409);
    return c.json({ error: 'multipart_upload_not_found' }, 404);
  }
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: 'multipart_upload_owner_mismatch' }, 403);
  }

  const expected = { sha256: bundleSha256, sizeBytes: state.sizeBytes };
  const existing = await c.env.ARTIFACTS.head(key);
  if (existing) {
    if (!descriptorMatches(existing, 'server.tgz', bundleSha256, expected)) {
      return c.json({ error: 'artifact_conflict', file: 'server.tgz' }, 409);
    }
    await c.env.ARTIFACTS
      .resumeMultipartUpload(key, state.r2UploadId)
      .abort()
      .catch(() => undefined);
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
    return c.json({
      ok: true,
      file: 'server.tgz',
      sha256: bundleSha256,
      bytes: state.sizeBytes,
      deduped: true,
    });
  }
  if (await c.env.ARTIFACTS.head(finalizationKey(bundleSha256))) {
    return c.json({ error: 'artifact_finalized' }, 409);
  }

  const body = await readBoundedJson(c.req.raw, MULTIPART_CONTROL_MAX_BYTES);
  if (!body.ok) {
    return c.json(
      { error: body.error },
      body.error === 'request_too_large' ? 413 : 400,
    );
  }
  const completion = parseCompletionParts(body.value, state.parts);
  if (completion.error) {
    return c.json({ error: 'invalid_multipart_completion', detail: completion.error }, 400);
  }

  try {
    await c.env.ARTIFACTS
      .resumeMultipartUpload(key, state.r2UploadId)
      .complete(completion.parts);
  } catch (error) {
    if (r2ErrorCode(error) === 10024) {
      const raced = await c.env.ARTIFACTS.head(key);
      if (descriptorMatches(raced, 'server.tgz', bundleSha256, expected)) {
        await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
        return c.json({
          ok: true,
          file: 'server.tgz',
          sha256: bundleSha256,
          bytes: state.sizeBytes,
          deduped: true,
        });
      }
      await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId)).catch(() => undefined);
    }
    return multipartStorageFailure(c, error, 'complete');
  }

  // Production R2 may return an immediate completion object without the custom
  // metadata that is already durable on the stored object. A fresh HEAD is the
  // authoritative post-commit view and is also what every replay/finalization
  // path adjudicates. Validating the transient return object produced a false
  // `multipart_completed_object_mismatch` after all parts had committed green.
  let completed: R2Object | null;
  try {
    completed = await c.env.ARTIFACTS.head(key);
  } catch (error) {
    return multipartStorageFailure(c, error, 'complete');
  }
  if (!completed || !descriptorMatches(completed, 'server.tgz', bundleSha256, expected)) {
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId)).catch(() => undefined);
    return c.json({ error: 'multipart_completed_object_mismatch' }, 409);
  }
  try {
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
  } catch (error) {
    return multipartStorageFailure(c, error, 'complete');
  }
  return c.json(
    {
      ok: true,
      file: 'server.tgz',
      sha256: bundleSha256,
      bytes: state.sizeBytes,
      etag: completed.httpEtag,
      deduped: false,
    },
    201,
  );
}

async function abortMultipartArtifact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param('bundleSha256');
  const uploadId = c.req.query('uploadId');
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);
  if (!isMultipartUploadId(uploadId)) return c.json({ error: 'invalid_multipart_upload_id' }, 400);

  let state: MultipartUploadState | null;
  try {
    state = await readMultipartState(c.env, bundleSha256, uploadId);
  } catch (error) {
    return multipartStorageFailure(c, error, 'abort');
  }
  if (!state) return new Response(null, { status: 204 });
  if (state.createdByGithubUserId !== operator.id) {
    return c.json({ error: 'multipart_upload_owner_mismatch' }, 403);
  }
  try {
    await c.env.ARTIFACTS
      .resumeMultipartUpload(artifactKey(bundleSha256, 'server.tgz'), state.r2UploadId)
      .abort();
  } catch (error) {
    if (r2ErrorCode(error) !== 10024) return multipartStorageFailure(c, error, 'abort');
  }
  try {
    await c.env.ARTIFACTS.delete(multipartStateKey(bundleSha256, uploadId));
  } catch (error) {
    return multipartStorageFailure(c, error, 'abort');
  }
  return new Response(null, { status: 204 });
}

async function finalizeArtifact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const operator = await requireOperator(c);
  if (operator instanceof Response) return operator;
  const bundleSha256 = c.req.param('bundleSha256');
  if (!isHexSha256(bundleSha256)) return c.json({ error: 'invalid_bundle_sha256' }, 400);

  const markerHead = await c.env.ARTIFACTS.head(finalizationKey(bundleSha256));
  if (markerHead) {
    const existing = await readFinalizationRecord(c.env, bundleSha256);
    if (!existing || !(await finalizationObjectsMatch(c.env, existing))) {
      return c.json({ error: 'finalization_conflict' }, 409);
    }
    return c.json({ ok: true, bundleSha256, manifestSha256: existing.manifestSha256, deduped: true });
  }

  const stored = {} as Record<WorkspaceHostCoreArtifactFile, StoredFileDescriptor>;
  const missing: WorkspaceHostArtifactFile[] = [];
  for (const file of WORKSPACE_HOST_ARTIFACT_FILES) {
    const descriptor = descriptorFromObject(await c.env.ARTIFACTS.head(artifactKey(bundleSha256, file)), file, bundleSha256);
    if (!descriptor) missing.push(file);
    else stored[file] = descriptor;
  }
  if (missing.length > 0) return c.json({ error: 'uploads_incomplete', missing }, 409);

  const manifestObject = await c.env.ARTIFACTS.get(artifactKey(bundleSha256, 'manifest.json'));
  if (!manifestObject) return c.json({ error: 'uploads_incomplete', missing: ['manifest.json'] }, 409);
  const manifestBody = await manifestObject.arrayBuffer();
  const actualManifestSha256 = await sha256Hex(manifestBody);
  if (
    actualManifestSha256 !== stored['manifest.json'].sha256 ||
    manifestBody.byteLength !== stored['manifest.json'].sizeBytes
  ) {
    return c.json({ error: 'manifest_storage_mismatch' }, 409);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBody));
  } catch {
    return c.json({ error: 'invalid_manifest_json' }, 400);
  }
  const errors = validatePublicationManifest(manifest, bundleSha256, stored);
  if (errors.length > 0) return c.json({ error: 'invalid_manifest', errors }, 400);

  const record: FinalizationRecord = {
    schemaVersion: PUBLICATION_SCHEMA_VERSION,
    kind: FINALIZATION_KIND,
    bundleSha256,
    manifestSha256: actualManifestSha256,
    files: stored,
    finalizedAt: new Date().toISOString(),
    finalizedByGithubUserId: operator.id,
  };
  const markerBody = JSON.stringify(record);
  const outcome = await putCreateOnly(c.env.ARTIFACTS, finalizationKey(bundleSha256), markerBody, {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: {
      namespace: 'workspace-host-v1',
      bundleSha256,
      manifestSha256: actualManifestSha256,
      finalizedByGithubUserId: String(operator.id),
    },
  });
  if (outcome === 'exists') {
    const raced = await readFinalizationRecord(c.env, bundleSha256);
    if (!raced || raced.manifestSha256 !== actualManifestSha256) {
      return c.json({ error: 'finalization_conflict' }, 409);
    }
    return c.json({ ok: true, bundleSha256, manifestSha256: actualManifestSha256, deduped: true });
  }
  return c.json({ ok: true, bundleSha256, manifestSha256: actualManifestSha256, deduped: false }, 201);
}

async function serveArtifact(
  c: Context<{ Bindings: Env }>,
  headOnly: boolean,
): Promise<Response> {
  const bundleSha256 = c.req.param('bundleSha256');
  const rawFile = c.req.param('file');
  if (!isHexSha256(bundleSha256) || !isArtifactFile(rawFile)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const record = await readFinalizationRecord(c.env, bundleSha256);
  if (!record) return c.json({ error: 'not_found' }, 404);

  const key = artifactKey(bundleSha256, rawFile);
  const object = headOnly ? await c.env.ARTIFACTS.head(key) : await c.env.ARTIFACTS.get(key);
  const sbomDigest = rawFile === 'sbom.cdx.json' ? await finalizedSbomDigest(c.env, bundleSha256) : null;
  const descriptor = rawFile === 'sbom.cdx.json'
    ? (sbomDigest && object ? { sha256: sbomDigest, sizeBytes: object.size } : null)
    : record.files[rawFile];
  if (!descriptor || !descriptorMatches(object, rawFile, bundleSha256, descriptor)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const headers = new Headers();
  object!.writeHttpMetadata(headers);
  headers.set('cache-control', WORKSPACE_HOST_PUBLIC_CACHE_CONTROL);
  headers.set('content-type', CONTENT_TYPE[rawFile]);
  headers.set('content-length', String(descriptor.sizeBytes));
  headers.set('content-disposition', `attachment; filename="${rawFile}"`);
  headers.set('x-artifact-sha256', descriptor.sha256);
  headers.set('x-content-type-options', 'nosniff');
  if (object!.httpEtag) headers.set('etag', object!.httpEtag);

  const body = !headOnly && 'body' in object! ? (object as R2ObjectBody).body : null;
  return new Response(body, { status: 200, headers });
}

export function workspaceHostArtifactsRoute(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  const adminPath = '/admin/artifacts/workspace-host/sha256/:bundleSha256/:file';
  const publicPath = '/artifacts/workspace-host/sha256/:bundleSha256/:file';
  const multipartPath =
    '/admin/artifacts/workspace-host/sha256/:bundleSha256/server.tgz/multipart';

  app.post(multipartPath, initiateMultipartArtifact);
  app.get(multipartPath, getMultipartStatus);
  app.put(`${multipartPath}/parts/:partNumber`, uploadMultipartPart);
  app.post(`${multipartPath}/complete`, completeMultipartArtifact);
  app.delete(multipartPath, abortMultipartArtifact);
  app.put(adminPath, uploadArtifact);
  app.post('/admin/artifacts/workspace-host/sha256/:bundleSha256/finalize', finalizeArtifact);
  app.get(publicPath, (c) => serveArtifact(c, false));
  app.on('HEAD', publicPath, (c) => serveArtifact(c, true));
  return app;
}
