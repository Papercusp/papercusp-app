import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

// Leaf module on purpose: workspace-host-clean-room-executor (where this helper used to live)
// imports THIS file, so importing it from there would be a cycle.
import { excerptDiagnostic, spillDiagnostic } from './diagnostic-excerpt';

import {
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  buildWorkspaceHostCleanRoomInstallFixture,
  validateWorkspaceHostBootstrapAttestation,
  type WorkspaceHostCleanRoomInstallFixture,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import {
  acquireGcpAdcAuth,
  createGcpWorkspaceHostAcquireAuth,
  fetchGcpApiJson,
  type GcpResolvedAuth,
} from '../cloud-workspaces/gcp-preflight';
import {
  GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
  GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  GcpImageFamilyReleaseError,
  assertGcpImmutableImageId,
  parseGcpImmutableImageId,
  type GcpImageCleanBootProof,
  type GcpImageFamilyPin,
  type GcpImageFamilyReleaseAdapter,
  type GcpImageFamilyReleaseContext,
  type GcpImageFamilyReleaseResumePhase,
  type GcpImageInspection,
  type GcpImageScanEvidence,
} from './gcp-image-family';
import { evaluateImageScanPolicy, GCP_IMAGE_SCAN_POLICY } from './image-scan-policy';
import { workspaceHostReleaseSubjectSha256 } from './bootc-bake-manifest';
import { measureGcpBaseImage } from './gcp-base-image-identity';
import {
  IAP_TCP_FORWARDING_SOURCE_RANGE,
  iapSshRuleAdmits,
  // @ts-expect-error — plain .mjs helper has no declaration file; reuse its tested firewall semantics.
} from '../../bin/gcp-clean-room-args.mjs';

/** A shell-free command invocation used by the image, scanner, and clean-room seams. */
export interface GcpImageFamilyCommand {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Stop the process (SIGTERM, then SIGKILL after 10 s) once its stderr matches: the run is already
   * lost and the rest of it is wasted time. WI-10006192: coldsnap kept uploading for 28 min after a
   * block had used its last retry, then exited 1. The result keeps the captured output, notes the
   * early stop, and always carries a non-zero exit code.
   */
  abortOnStderr?: RegExp;
}

export interface GcpImageFamilyCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Injected process boundary. Implementations MUST use an argv array and shell:false.
 * The broad first argument keeps this seam compatible with small test runners that only
 * implement `run(command, args)` while the node implementation also accepts one object.
 */
export interface GcpImageFamilyCommandRunner {
  run(
    command: string | GcpImageFamilyCommand,
    args?: readonly string[],
    options?: Omit<GcpImageFamilyCommand, 'command' | 'args'>,
  ): Promise<GcpImageFamilyCommandResult>;
  execute?(
    command: string | GcpImageFamilyCommand,
    args?: readonly string[],
    options?: Omit<GcpImageFamilyCommand, 'command' | 'args'>,
  ): Promise<GcpImageFamilyCommandResult>;
}

/** Raw, non-secret image metadata returned by Compute Engine. */
export interface GcpImageFamilyComputeImage {
  name: string;
  id?: string | number;
  selfLink?: string;
  family?: string;
  state?: 'ACTIVE' | 'DEPRECATED' | 'OBSOLETE' | 'DELETED' | string;
  architecture?: string;
  description?: string;
  labels?: Readonly<Record<string, string>>;
  creationTimestamp?: string;
  sourceImage?: string;
  deprecated?: {
    state?: 'DEPRECATED' | 'OBSOLETE' | 'DELETED' | string;
    replacement?: string;
  };
}

export interface GcpImageFamilyComputeImageInsert {
  name: string;
  family?: string;
  sourceImage: string;
  description: string;
  labels?: Readonly<Record<string, string>>;
}

export interface GcpImageFamilyComputeApi {
  /** Implement one of getImage/getFamilyImage/getImageFamily; all are accepted for test seams. */
  getImage?(projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage | undefined>;
  getFamilyImage?(projectId: string, family: string): Promise<GcpImageFamilyComputeImage | undefined>;
  getImageFamily?(projectId: string, family: string): Promise<GcpImageFamilyComputeImage | undefined>;
  getImageByName?(projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage | undefined>;
  getFamily?(projectId: string, family: string): Promise<GcpImageFamilyComputeImage | undefined>;
  /** Implement one of insertImage/createImage. The result may be an operation or image receipt. */
  insertImage?(
    projectId: string,
    input: GcpImageFamilyComputeImageInsert,
  ): Promise<GcpImageFamilyComputeImage | GcpImageFamilyComputeOperation>;
  createImage?(
    projectId: string,
    input: GcpImageFamilyComputeImageInsert,
  ): Promise<GcpImageFamilyComputeImage | GcpImageFamilyComputeOperation>;
  publishImage?(
    projectId: string,
    input: GcpImageFamilyComputeImageInsert,
  ): Promise<GcpImageFamilyComputeImage | GcpImageFamilyComputeOperation>;
  deprecateImage?(input: {
    projectId: string;
    imageName: string;
    replacementImageId: string;
    state: 'DEPRECATED';
  }): Promise<void>;
  setImageDeprecation?(input: {
    projectId: string;
    imageName: string;
    replacementImageId: string;
    state: 'DEPRECATED';
  }): Promise<void>;
}

export interface GcpImageFamilyComputeOperation {
  name: string;
  status?: 'PENDING' | 'RUNNING' | 'DONE';
  error?: { errors?: readonly { code?: string; message?: string }[] };
}

export interface GcpImageFamilyScanRunner {
  run?(input: {
    projectId: string;
    subnetwork: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
    artifact?: WorkspaceHostImageArtifact;
  }): Promise<unknown>;
  scan?(input: {
    projectId: string;
    subnetwork: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
    artifact?: WorkspaceHostImageArtifact;
  }): Promise<unknown>;
  scanImage?(input: {
    projectId: string;
    subnetwork: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
    artifact?: WorkspaceHostImageArtifact;
  }): Promise<unknown>;
}

export interface GcpImageFamilyCleanRoomRunInput {
  projectId: string;
  zone: string;
  serviceAccountEmail: string;
  subnetwork: string;
  imageId: string;
  buildManifestIdentity: string;
  releaseVersion: string;
  releaseSha256: string;
  fixture: WorkspaceHostCleanRoomInstallFixture;
}

export interface GcpImageFamilyCleanRoomRunResult extends GcpImageCleanBootProof {
  /** Optional echo used to prove the runner executed the exact deterministic fixture. */
  fixtureId?: string;
  bootstrapScriptSha256?: string;
}

export interface GcpImageFamilyCleanRoomRunner {
  run?(input: GcpImageFamilyCleanRoomRunInput): Promise<unknown>;
  execute?(input: GcpImageFamilyCleanRoomRunInput): Promise<unknown>;
  runCleanRoom?(input: GcpImageFamilyCleanRoomRunInput): Promise<unknown>;
}

export interface GcpImageFamilyReleaseAdapterOptions {
  compute?: GcpImageFamilyComputeApi;
  computeApi?: GcpImageFamilyComputeApi;
  commandRunner?: GcpImageFamilyCommandRunner;
  /** Compatibility alias for callers that name the seam `commands`. */
  commands?: GcpImageFamilyCommandRunner;
  packerRunner?: GcpImageFamilyCommandRunner;
  scanRunner?: GcpImageFamilyScanRunner;
  scanner?: GcpImageFamilyScanRunner;
  scan?: GcpImageFamilyScanRunner;
  cleanRoomRunner?: GcpImageFamilyCleanRoomRunner;
  cleanRoom?: GcpImageFamilyCleanRoomRunner;
  cleanRoomExecutor?: GcpImageFamilyCleanRoomRunner;
  repositoryRoot?: string;
  repoRoot?: string;
  packerExecutable?: string;
  packerPath?: string;
  /**
   * `gcloud` binary, used ONLY to prove Application Default Credentials can still mint a token
   * before a billable build starts. Packer authenticates with ADC rather than with this
   * release's `cloudCredentialRef`, so ADC is the credential that actually has to work.
   */
  gcloudExecutable?: string;
  scanExecutable?: string;
  scannerExecutable?: string;
  cleanRoomExecutable?: string;
  cleanRoomCommand?: string;
  /**
   * PRE-build clean-room acceptance binary. Distinct from `cleanRoomExecutable`, which is the
   * POST-build canary: this one boots stock Ubuntu to prove the signed bundle installs, and its
   * report is the evidence the release gate ratifies before any image is built.
   */
  bootstrapAcceptanceExecutable?: string;
  guestToolVersions?: Readonly<Record<string, string>>;
  sourceImage?: string;
  machineType?: string;
  diskSizeGb?: number;
  omitExternalIp?: boolean;
  useIap?: boolean;
  acquireAuth?: () => Promise<GcpResolvedAuth>;
  credentialRef?: string;
  fetch?: typeof fetch;
  now?: () => string;
}

export interface GcpImageFamilyComputeApiOptions {
  acquireAuth?: () => Promise<GcpResolvedAuth>;
  credentialRef?: string;
  fetch?: typeof fetch;
  now?: () => string;
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const RESOURCE_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_IDENTITY = /^sha256:[a-f0-9]{64}$/;
const SAFE_EXECUTABLE = /^[A-Za-z0-9_./:+-]+$/;
const COMPUTE_API = 'https://compute.googleapis.com/compute/v1';
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function fail(message: string): never {
  throw new GcpImageFamilyReleaseError(message);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${path} must be a non-empty string`);
  return value.trim();
}

function project(value: unknown, path = 'projectId'): string {
  const result = text(value, path);
  if (!PROJECT_ID.test(result)) fail(`${path} must be a GCP project id`);
  return result;
}

function resource(value: unknown, path: string): string {
  const result = text(value, path);
  if (!RESOURCE_NAME.test(result)) fail(`${path} must be a GCP resource name`);
  return result;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!SHA256.test(result)) fail(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function manifest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!MANIFEST_IDENTITY.test(result)) fail(`${path} must be sha256:<64 lowercase hex>`);
  return result;
}

export function safeExecutable(value: string | undefined, fallback: string, path: string): string {
  const result = text(value ?? fallback, path);
  if (!SAFE_EXECUTABLE.test(result) || /\s/.test(result)) fail(`${path} must be a shell-free executable path`);
  return result;
}

/**
 * Redact credential-shaped values before a command's output is quoted into an error.
 */
function redactDiagnostic(stream: unknown): string {
  return typeof stream === 'string'
    ? stream
        .replace(/(authorization|token|secret|private[_ -]?key|password)\s*[:=]\s*[^\s]+/gi, '$1=[redacted]')
        .trim()
    : '';
}

/**
 * Quote a failed command's output into the thrown error.
 *
 * ⚠ BOTH streams, always. `packer build` runs here with `-machine-readable`
 * (see buildCandidate), and in that mode packer writes its ENTIRE event stream — `ui,error`
 * records and template/validation failures included — to STDOUT, leaving stderr empty. This
 * function previously read stderr only, so a failed production release build reported exactly
 * `packer build failed with exit code 1` and nothing else: not truncated-looking, just silent,
 * as though packer had had nothing to say (EI-21762126059344308). Reading only the stream you
 * expect the error on is how a diagnostic disappears.
 *
 * Excerpted head-weighted rather than tail-truncated — a packer failure names its cause at the
 * TOP and then emits a long teardown epilogue, so a tail-only window keeps the consequence and
 * drops the cause. See {@link excerptDiagnostic}.
 */
function assertSuccess(result: GcpImageFamilyCommandResult, operation: string): string {
  if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0) {
    const stderr = redactDiagnostic(result.stderr);
    const stdout = redactDiagnostic(result.stdout);

    // Spill the COMPLETE output before excerpting it, and name the path FIRST. Every excerpt
    // rule is a guess about where the cause sits; this build is billable, so a wrong guess costs
    // another one. With the full text on disk the excerpt only has to be a good preview.
    const spillPath = spillDiagnostic(
      operation,
      `=== ${operation} exit ${String(result.exitCode)} ===\n\n--- stdout ---\n${stdout}\n\n--- stderr ---\n${stderr}\n`,
      'papercusp-image-build-',
    );

    const parts: string[] = [];
    if (stderr) parts.push(`stderr: ${excerptDiagnostic(stderr)}`);
    if (stdout) parts.push(`stdout: ${excerptDiagnostic(stdout)}`);
    fail(
      `${operation} failed with exit code ${String(result.exitCode)}` +
        (spillPath === null ? '' : ` [full output: ${spillPath}]`) +
        // An explicit "no output" is a real finding — it distinguishes a silent command from
        // this function having dropped the stream the failure was written to.
        (parts.length > 0 ? `; ${parts.join('; ')}` : '; the command produced no output on either stream'),
    );
  }
  return result.stdout;
}

function canonicalImageUrl(imageId: string): string {
  return `${COMPUTE_API}/${assertGcpImmutableImageId(imageId)}`;
}

function imageNameFromId(imageId: string): string {
  return parseGcpImmutableImageId(imageId, 'imageId').imageName;
}

function operationError(operation: GcpImageFamilyComputeOperation): string | undefined {
  const errors = operation.error?.errors ?? [];
  if (errors.length === 0) return undefined;
  const codes = errors.map((entry) => entry.code).filter((entry): entry is string => !!entry);
  return codes.length > 0 ? `GCP image operation failed (${codes.join(', ')})` : 'GCP image operation failed';
}

export function parseJsonObject(value: string, operation: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`${operation} returned invalid JSON`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(`${operation} returned a JSON value instead of an object`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function findImageId(value: unknown, expectedProject: string, expectedName: string): string | undefined {
  if (typeof value === 'string') {
    const full = value.match(/projects\/[^\s/'"]+\/global\/images\/[^\s/'"]+/)?.[0];
    if (full) {
      try {
        const parsed = parseGcpImmutableImageId(full);
        if (parsed.projectId === expectedProject) return parsed.imageId;
      } catch {
        // Continue searching output; Packer occasionally prints a URL-like diagnostic token.
      }
    }
    if (value === `${expectedProject}/${expectedName}` || value === expectedName) {
      return `projects/${expectedProject}/global/images/${expectedName}`;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findImageId(entry, expectedProject, expectedName);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Readonly<Record<string, unknown>>)) {
      if (key === 'id' || key === 'imageId' || key === 'selfLink' || key === 'artifactId' || key === 'targetLink') {
        const found = findImageId(entry, expectedProject, expectedName);
        if (found) return found;
      }
      const nested = findImageId(entry, expectedProject, expectedName);
      if (nested) return nested;
    }
  }
  return undefined;
}

function parsePackerImageId(stdout: string, projectId: string, imageName: string): string | undefined {
  const direct = findImageId(stdout, projectId, imageName);
  if (direct) return direct;
  for (const line of stdout.split(/\r?\n/)) {
    const fields = line.split(',');
    if (fields[0] === 'artifact' && fields[2] === 'id') {
      const candidate = fields.slice(3).join(',').trim().replace(/^gce,/, '');
      const found = findImageId(candidate, projectId, imageName);
      if (found) return found;
      const short = candidate.match(
        new RegExp(
          `(?:^|:)${projectId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(${imageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`,
        ),
      );
      if (short) return `projects/${projectId}/global/images/${short[1]}`;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const found = findImageId(JSON.parse(trimmed), projectId, imageName);
        if (found) return found;
      } catch {
        // A non-JSON machine-readable line is ignored; the final Compute read is authoritative.
      }
    }
  }
  return undefined;
}

function parseProvenance(description: string | undefined): Readonly<Record<string, unknown>> {
  if (!description?.trim()) fail('GCP image description is missing the release provenance document');
  const parsed = parseJsonObject(description, 'GCP image provenance');
  if (parsed.contractVersion !== GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION) {
    fail(`GCP image provenance contract must be ${GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION}`);
  }
  return parsed;
}

function architecture(value: unknown): string {
  const normalized = text(value, 'image.architecture').toUpperCase();
  if (normalized === 'X86_64' || normalized === 'AMD64') return 'x86_64';
  if (normalized === 'ARM64' || normalized === 'AARCH64') return 'arm64';
  return normalized.toLowerCase();
}

function imageState(raw: GcpImageFamilyComputeImage): GcpImageInspection['state'] {
  const state = String(raw.deprecated?.state ?? raw.state ?? 'ACTIVE').toUpperCase();
  if (state === 'DEPRECATED' || state === 'OBSOLETE' || state === 'DELETED' || state === 'ACTIVE') return state;
  fail(`GCP image ${raw.name} has unsupported state ${state}`);
}

function guestTools(value: unknown): readonly { name: string; version: string }[] {
  if (!Array.isArray(value)) fail('GCP image provenance is missing guestTools');
  const result = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`guestTools[${index}] is invalid`);
    const item = entry as Readonly<Record<string, unknown>>;
    return {
      name: text(item.name, `guestTools[${index}].name`),
      version: text(item.version, `guestTools[${index}].version`),
    };
  });
  const names = new Set(result.map((entry) => entry.name));
  for (const required of GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS) {
    if (!names.has(required)) fail(`GCP image provenance is missing guest tool ${required}`);
  }
  return result;
}

function cleanProof(value: unknown, input: GcpImageFamilyCleanRoomRunInput): GcpImageFamilyCleanRoomRunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('clean-room runner returned an invalid proof');
  const raw = value as Readonly<Record<string, unknown>>;
  const proof: GcpImageFamilyCleanRoomRunResult = {
    evidenceRef: text(raw.evidenceRef, 'cleanRoomProof.evidenceRef'),
    projectId: text(raw.projectId, 'cleanRoomProof.projectId'),
    zone: text(raw.zone, 'cleanRoomProof.zone'),
    imageId: assertGcpImmutableImageId(text(raw.imageId, 'cleanRoomProof.imageId'), 'cleanRoomProof.imageId'),
    buildManifestIdentity: manifest(raw.buildManifestIdentity, 'cleanRoomProof.buildManifestIdentity'),
    computeRunning: raw.computeRunning === true,
    osLoginReady: raw.osLoginReady === true,
    publicIpv4Assigned: raw.publicIpv4Assigned === true,
    attestation: raw.attestation as GcpImageCleanBootProof['attestation'],
    terminated: raw.terminated === true,
    residualResourceIds: Array.isArray(raw.residualResourceIds)
      ? raw.residualResourceIds.map((entry, index) => text(entry, `cleanRoomProof.residualResourceIds[${index}]`))
      : fail('cleanRoomProof.residualResourceIds must be an array'),
    observedAt: text(raw.observedAt, 'cleanRoomProof.observedAt'),
    ...(typeof raw.fixtureId === 'string' ? { fixtureId: raw.fixtureId } : {}),
    ...(typeof raw.bootstrapScriptSha256 === 'string' ? { bootstrapScriptSha256: raw.bootstrapScriptSha256 } : {}),
  };
  if (
    proof.projectId !== input.projectId ||
    proof.zone !== input.zone ||
    proof.imageId !== input.imageId ||
    proof.buildManifestIdentity !== input.buildManifestIdentity ||
    !Number.isFinite(Date.parse(proof.observedAt))
  ) {
    fail('clean-room proof is not bound to the requested project, zone, image, manifest, and timestamp');
  }
  if (proof.fixtureId && proof.fixtureId !== input.fixture.fixtureId)
    fail('clean-room proof fixtureId does not match the submitted fixture');
  if (proof.bootstrapScriptSha256 && proof.bootstrapScriptSha256 !== input.fixture.bootstrapScriptSha256) {
    fail('clean-room proof bootstrap digest does not match the submitted fixture');
  }
  if (
    !proof.computeRunning ||
    !proof.osLoginReady ||
    proof.publicIpv4Assigned ||
    !proof.terminated ||
    proof.residualResourceIds.length > 0
  ) {
    fail('clean-room runner did not prove private boot, OS Login, and zero-residue teardown');
  }
  if (!proof.attestation || typeof proof.attestation !== 'object' || proof.attestation.status !== 'healthy') {
    fail('clean-room runner did not return a healthy bootstrap attestation');
  }
  const validation = validateWorkspaceHostBootstrapAttestation(proof.attestation, {
    contractVersion: input.fixture.bootstrapInput.contractVersion,
    action: input.fixture.bootstrapInput.action,
    hostId: input.fixture.bootstrapInput.hostId,
    release: input.fixture.bootstrapInput.release,
    migrationId: input.fixture.bootstrapInput.migrationId,
    minimumNodeMajor: input.fixture.bootstrapInput.minimumNodeMajor,
    service: input.fixture.bootstrapInput.service,
    workspaceAuthorizedKeys: input.fixture.bootstrapInput.workspaceAuthorizedKeys,
    ...(input.fixture.bootstrapInput.isolation ? { isolation: input.fixture.bootstrapInput.isolation } : {}),
    ...(input.fixture.bootstrapInput.entrypoints ? { entrypoints: input.fixture.bootstrapInput.entrypoints } : {}),
    ...(input.fixture.bootstrapInput.publicMetadata
      ? { publicMetadata: input.fixture.bootstrapInput.publicMetadata }
      : {}),
  });
  if (!validation.ok) fail(`clean-room bootstrap attestation failed validation: ${validation.errors.join('; ')}`);
  return proof;
}

/**
 * Same predicate the host projection uses (`isPlainObject` in papercusp-image-scan.mjs), kept
 * local rather than imported so the two halves of the scan document stay independently
 * readable. Guards the optional breakdown fields below: a non-object is treated as absent.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scanEvidence(
  value: unknown,
  input: {
    imageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
  },
): GcpImageScanEvidence {
  let raw: unknown = value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'exitCode' in raw) {
    // Route through assertSuccess rather than hand-rolling the exit check: it SPILLS the
    // complete stdout+stderr and names the path first. The hand-rolled check this replaced
    // reported exactly `GCP image scanner failed with exit code 1` and discarded both streams,
    // so a scan failure — which costs a full billable image build to reach — arrived with its
    // diagnosis already thrown away. Same defect, and same fix, as the packer path above.
    const command = raw as GcpImageFamilyCommandResult;
    raw = parseJsonObject(assertSuccess(command, 'GCP image scanner'), 'GCP image scanner');
  } else if (typeof raw === 'string') {
    raw = parseJsonObject(raw, 'GCP image scanner');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('GCP image scanner returned no structured evidence');
  const result = raw as Readonly<Record<string, unknown>>;
  const evidence: GcpImageScanEvidence = {
    imageId: assertGcpImmutableImageId(text(result.imageId, 'scan.imageId'), 'scan.imageId'),
    buildManifestIdentity: manifest(result.buildManifestIdentity, 'scan.buildManifestIdentity'),
    releaseSha256: digest(result.releaseSha256, 'scan.releaseSha256'),
    trusted: result.trusted === true,
    sbomSha256: digest(result.sbomSha256, 'scan.sbomSha256'),
    vulnerabilityFindings: result.vulnerabilityFindings as number,
    // The severity breakdown is now GATE INPUT, not just a diagnostic, so it is
    // carried through unvalidated-but-typed and handed to evaluateImageScanPolicy,
    // which is the single place that decides whether a measurement is usable.
    vulnerabilityBySeverity: result.vulnerabilityBySeverity as Readonly<Record<string, number>>,
    secretFindings: result.secretFindings as number,
    // ---- Everything below is MEASURED ON EVERY RUN and used to be discarded exactly here. ----
    // The guest computes each of these, fail-closed validates them, and serialises them over
    // SSH; the host projects them; and this function dropped nine of them on the floor. The
    // cost is not abstract: reaching a scan result takes a full billable image build, so a
    // diagnostic lost here is re-derived by building the image AGAIN. It forced "how many
    // blockers are actually fixable" to be guessed twice (WI-1088331), and it hid the scan's
    // own coverage, which is what makes a partial mount publishable as clean (WI-1092039).
    //
    // Carried conditionally, mirroring the host projection's idiom, so an ABSENT field stays
    // absent and reads as "not measured" — never as a zero nobody actually took.
    // `image-scan-host-to-adapter.test.ts` derives the expected set from the host projection,
    // so a field added upstream with no reader here fails there instead of vanishing.
    ...(typeof result.mountedFilesystems === 'number'
      ? { mountedFilesystems: result.mountedFilesystems }
      : {}),
    ...(typeof result.candidateRootProof === 'string'
      ? { candidateRootProof: result.candidateRootProof }
      : {}),
    ...(typeof result.vulnerabilityFixable === 'number'
      ? { vulnerabilityFixable: result.vulnerabilityFixable }
      : {}),
    ...(isRecord(result.vulnerabilityFixableBySeverity)
      ? {
          vulnerabilityFixableBySeverity: result.vulnerabilityFixableBySeverity as Readonly<
            Record<string, number>
          >,
        }
      : {}),
    ...(isRecord(result.vulnerabilityByEcosystem)
      ? {
          vulnerabilityByEcosystem: result.vulnerabilityByEcosystem as Readonly<
            Record<string, number>
          >,
        }
      : {}),
    ...(isRecord(result.vulnerabilityFixableByEcosystem)
      ? {
          vulnerabilityFixableByEcosystem: result.vulnerabilityFixableByEcosystem as Readonly<
            Record<string, number>
          >,
        }
      : {}),
    // The cross-tab. The severity and ecosystem marginals beside it are independent totals,
    // so neither can say how many of the DENIED findings sit in an ecosystem no userland
    // remediation reaches. That number decides between "patch the image" and "the scan is
    // measuring the wrong surface and must be scoped" — and the threshold is not the lever,
    // so an unreachable population has to be proven rather than assumed (WI-1182614).
    ...(isRecord(result.vulnerabilityBySeverityAndEcosystem)
      ? {
          vulnerabilityBySeverityAndEcosystem:
            result.vulnerabilityBySeverityAndEcosystem as Readonly<Record<string, number>>,
        }
      : {}),
    // Ranked top-25, carried ONLY as a pair with the distinct-artifact total below: the list
    // is a floor, and a floor read as a total is how a bounded measurement becomes a
    // confident wrong number. If one ever has to be dropped, drop both.
    ...(isRecord(result.vulnerabilityByArtifact)
      ? {
          vulnerabilityByArtifact: result.vulnerabilityByArtifact as Readonly<
            Record<string, number>
          >,
        }
      : {}),
    ...(typeof result.vulnerabilityDistinctArtifacts === 'number'
      ? { vulnerabilityDistinctArtifacts: result.vulnerabilityDistinctArtifacts }
      : {}),
    // The same ranking restricted to the DENIED severities, because the list above is ordered by
    // total and the inherited mass buries what we can act on: on the 0.0.18 candidate every one
    // of the 26 npm findings that are ours to bump fell below its cut or into its tail, so the
    // package names had to be read from a comment instead of measured (D-202). Carried as a pair
    // with its own denominator, on the same rule as the pair above.
    ...(isRecord(result.vulnerabilityCriticalHighByArtifact)
      ? {
          vulnerabilityCriticalHighByArtifact:
            result.vulnerabilityCriticalHighByArtifact as Readonly<Record<string, number>>,
        }
      : {}),
    ...(typeof result.vulnerabilityCriticalHighDistinctArtifacts === 'number'
      ? {
          vulnerabilityCriticalHighDistinctArtifacts:
            result.vulnerabilityCriticalHighDistinctArtifacts,
        }
      : {}),
    // SCOPE — papercusp-bundled versus inherited base image (D-201's open mechanism), carried as
    // evidence only. This hop is where the coverage pair was silently dropped once already
    // (WI-1092039: the guest measured mountedFilesystems and candidateRootProof, nothing carried
    // them, and the gate could not have read them even had it wanted to), so the split and its
    // denominator are wired through together rather than left for the enforcement half to add.
    ...(isRecord(result.vulnerabilityByScope)
      ? { vulnerabilityByScope: result.vulnerabilityByScope as Readonly<Record<string, number>> }
      : {}),
    ...(isRecord(result.vulnerabilityCriticalHighByScope)
      ? {
          vulnerabilityCriticalHighByScope:
            result.vulnerabilityCriticalHighByScope as Readonly<Record<string, number>>,
        }
      : {}),
    ...(typeof result.bundleCatalogedArtifacts === 'number'
      ? { bundleCatalogedArtifacts: result.bundleCatalogedArtifacts }
      : {}),
    ...(isRecord(result.secretsByRule)
      ? { secretsByRule: result.secretsByRule as Readonly<Record<string, number>> }
      : {}),
    ...(isRecord(result.secretsByArea)
      ? { secretsByArea: result.secretsByArea as Readonly<Record<string, number>> }
      : {}),
    ...(isRecord(result.secretsByScope)
      ? { secretsByScope: result.secretsByScope as Readonly<Record<string, number>> }
      : {}),
    ...(Array.isArray(result.secretSample)
      ? { secretSample: result.secretSample as readonly unknown[] }
      : {}),
    // Every bundled finding by file — what makes the scoped population triageable. Carried with
    // its completeness flag so a capped list is never read as the whole population.
    ...(Array.isArray(result.secretBundledSample)
      ? { secretBundledSample: result.secretBundledSample as readonly unknown[] }
      : {}),
    ...(typeof result.secretBundledSampleComplete === 'boolean'
      ? { secretBundledSampleComplete: result.secretBundledSampleComplete }
      : {}),
    evidenceRef: text(result.evidenceRef, 'scan.evidenceRef'),
  };
  if (
    evidence.imageId !== input.imageId ||
    evidence.buildManifestIdentity !== input.buildManifestIdentity ||
    evidence.releaseSha256 !== input.releaseSha256 ||
    !evidence.trusted
  ) {
    fail('GCP image scanner evidence is untrusted or bound to a different subject');
  }
  // Integer/shape validation, the severity threshold, and the coverage proof all
  // live in the policy module, so the adapter and the release gate cannot drift into
  // disagreeing about what a usable measurement is. Every rejection there fails CLOSED.
  //
  // GCP_IMAGE_SCAN_POLICY requires the coverage pair. Note the interaction with the
  // conditional spread above (`typeof result.mountedFilesystems === 'number'`): a
  // guest that emits a malformed value has it DROPPED there, so it arrives here as
  // absent and is denied as missing rather than mis-read. Both roads fail closed.
  const scanPolicy = evaluateImageScanPolicy(evidence, GCP_IMAGE_SCAN_POLICY);
  if (!scanPolicy.accepted) {
    fail(
      `GCP image scanner evidence violates the workspace-host release policy: ${scanPolicy.failures
        .map((failure) => failure.message)
        .join('; ')}`,
    );
  }
  return evidence;
}

function jsonInput(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parseJsonArray(value: string, operation: string): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`${operation} returned invalid JSON`);
  }
  if (!Array.isArray(parsed)) fail(`${operation} returned a JSON value instead of an array`);
  return parsed;
}

/**
 * Read the network tags that the checked-in Packer template will give its builder.
 *
 * The adapter passes these tags explicitly to both `packer validate` and `packer build`, rather
 * than relying on Packer's implicit variable default. That makes the IAP preflight and the
 * billable build operate on one exact tag list, while a template edit that removes or corrupts
 * the declaration fails before any cloud mutation.
 */
export function parseBuilderNetworkTags(template: string): readonly string[] {
  const header = 'variable "builder_network_tags"';
  const start = template.indexOf(header);
  if (start < 0) fail('Packer template is missing variable "builder_network_tags"');
  const nextVariable = template.indexOf('\nvariable "', start + header.length);
  const block = template.slice(start, nextVariable < 0 ? template.length : nextVariable);
  const match = /^\s*default\s*=\s*\[([^\]]*)\]/m.exec(block);
  if (!match) fail('Packer template builder_network_tags must declare a literal default list');
  const tags = [...match[1].matchAll(/"([^"\r\n]*)"/g)].map((entry, index) => {
    const tag = entry[1]?.trim() ?? '';
    return resource(tag, `builder_network_tags[${index}]`);
  });
  if (tags.length === 0) fail('Packer template builder_network_tags must contain at least one tag');
  if (new Set(tags).size !== tags.length) fail('Packer template builder_network_tags must not contain duplicate tags');
  return tags;
}

function regionFromZone(zone: string): string {
  const value = text(zone, 'cleanRoom.zone');
  const region = value.replace(/-[a-z]$/, '');
  if (region === value) fail('cleanRoom.zone must be a zonal GCP location such as us-central1-a');
  return region;
}

/** Node process runner used by the production adapter and by command-protocol runners. */
export class NodeGcpImageFamilyCommandRunner implements GcpImageFamilyCommandRunner {
  async run(
    commandOrObject: string | GcpImageFamilyCommand,
    args: readonly string[] = [],
    options: Omit<GcpImageFamilyCommand, 'command' | 'args'> = {},
  ): Promise<GcpImageFamilyCommandResult> {
    const command = typeof commandOrObject === 'string' ? commandOrObject : commandOrObject.command;
    const actualArgs = typeof commandOrObject === 'string' ? args : commandOrObject.args;
    const actualOptions = typeof commandOrObject === 'string' ? options : commandOrObject;
    if (!SAFE_EXECUTABLE.test(command) || /\s/.test(command)) {
      return { exitCode: 126, stdout: '', stderr: 'executable path is invalid' };
    }
    if (actualArgs.some((entry) => typeof entry !== 'string' || entry.includes('\0'))) {
      return { exitCode: 126, stdout: '', stderr: 'command argument is invalid' };
    }
    const timeoutMs = actualOptions.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const maxOutputBytes = actualOptions.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes <= 0
    ) {
      return { exitCode: 126, stdout: '', stderr: 'command runner limits are invalid' };
    }
    return await new Promise<GcpImageFamilyCommandResult>((resolveResult) => {
      const child = spawn(command, [...actualArgs], {
        cwd: actualOptions.cwd,
        env: actualOptions.env ? { ...process.env, ...actualOptions.env } : process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      // Non-global copy: a /g pattern's lastIndex would make repeated .test() calls skip matches.
      const abortPattern = actualOptions.abortOnStderr
        ? new RegExp(actualOptions.abortOnStderr.source, actualOptions.abortOnStderr.flags.replace(/[gy]/g, ''))
        : undefined;
      let aborted = false;
      let stderrTail = '';
      const finish = (result: GcpImageFamilyCommandResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveResult(result);
      };
      const overLimit = (stream: 'stdout' | 'stderr'): void => {
        child.kill('SIGKILL');
        finish({
          exitCode: 125,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: `${stream} exceeded output limit`,
        });
      };
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxOutputBytes) return overLimit('stdout');
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxOutputBytes) return overLimit('stderr');
        stderr.push(chunk);
        if (!abortPattern || aborted) return;
        // Match against a short tail, so a line split across two chunks is still seen.
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096);
        if (!abortPattern.test(stderrTail)) return;
        aborted = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
      });
      child.once('error', (error) =>
        finish({
          exitCode: 127,
          stdout: '',
          stderr: error instanceof Error ? error.message : 'failed to start command',
        }),
      );
      child.once('close', (code) => {
        const exitCode = typeof code === 'number' ? code : 1;
        const capturedStderr = Buffer.concat(stderr).toString('utf8');
        finish({
          exitCode: aborted && exitCode === 0 ? 1 : exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: aborted ? `${capturedStderr}\nstopped early: stderr matched ${abortPattern}` : capturedStderr,
        });
      });
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({
          exitCode: 124,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: `command timed out after ${timeoutMs}ms`,
        });
      }, timeoutMs);
      timer.unref?.();
      child.stdin.on('error', () => finish({ exitCode: 125, stdout: '', stderr: 'failed to write command input' }));
      child.stdin.end(actualOptions.stdin ?? '', 'utf8');
    });
  }

  execute(
    command: string | GcpImageFamilyCommand,
    args?: readonly string[],
    options?: Omit<GcpImageFamilyCommand, 'command' | 'args'>,
  ): Promise<GcpImageFamilyCommandResult> {
    return this.run(command, args, options);
  }
}

/** Scanner protocol runner. The executable must perform a real image scan; no green fallback exists. */
export class CommandGcpImageFamilyScanRunner implements GcpImageFamilyScanRunner {
  constructor(
    private readonly commandRunner: GcpImageFamilyCommandRunner,
    private readonly executable = 'papercusp-image-scan',
    private readonly cwd?: string,
  ) {}

  run(input: Parameters<NonNullable<GcpImageFamilyScanRunner['run']>>[0]): Promise<unknown> {
    return this.commandRunner.run(this.executable, ['--json-stdin'], {
      cwd: this.cwd,
      stdin: jsonInput({
        projectId: input.projectId,
        subnetwork: input.subnetwork,
        imageId: input.imageId,
        buildManifestIdentity: input.buildManifestIdentity,
        releaseSha256: input.releaseSha256,
      }),
    });
  }
}

/** Clean-room protocol runner. The executable owns VM creation, SSH/IAP boot, and teardown. */
export class CommandGcpImageFamilyCleanRoomRunner implements GcpImageFamilyCleanRoomRunner {
  constructor(
    private readonly commandRunner: GcpImageFamilyCommandRunner,
    private readonly executable = 'papercusp-gcp-clean-room',
    private readonly cwd?: string,
  ) {}

  run(input: GcpImageFamilyCleanRoomRunInput): Promise<unknown> {
    return this.commandRunner.run(this.executable, ['--json-stdin'], {
      cwd: this.cwd,
      stdin: jsonInput(input),
      timeoutMs: 30 * 60 * 1_000,
    });
  }
}

interface RawComputeImage {
  name?: string;
  id?: string | number;
  selfLink?: string;
  family?: string;
  status?: string;
  architecture?: string;
  description?: string;
  labels?: Record<string, string>;
  creationTimestamp?: string;
  sourceImage?: string;
  deprecated?: { state?: string; replacement?: string };
}

interface RawComputeOperation {
  name?: string;
  status?: 'PENDING' | 'RUNNING' | 'DONE';
  error?: { errors?: readonly { code?: string; message?: string }[] };
}

function mapComputeImage(raw: RawComputeImage, path = 'GCP image'): GcpImageFamilyComputeImage {
  const state = raw.deprecated?.state ?? (raw.status === 'READY' ? 'ACTIVE' : raw.status);
  return {
    name: resource(raw.name, `${path}.name`),
    ...(raw.id === undefined ? {} : { id: raw.id }),
    ...(raw.selfLink ? { selfLink: raw.selfLink } : {}),
    ...(raw.family ? { family: raw.family } : {}),
    ...(state ? { state } : {}),
    ...(raw.architecture ? { architecture: raw.architecture } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.labels ? { labels: raw.labels } : {}),
    ...(raw.creationTimestamp ? { creationTimestamp: raw.creationTimestamp } : {}),
    ...(raw.sourceImage ? { sourceImage: raw.sourceImage } : {}),
    ...(raw.deprecated ? { deprecated: raw.deprecated } : {}),
  };
}

/** Authenticated raw-REST Compute seam used when a caller does not inject a fake. */
export class GoogleComputeGcpImageFamilyComputeApi implements GcpImageFamilyComputeApi {
  private readonly acquireAuth: () => Promise<GcpResolvedAuth>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GcpImageFamilyComputeApiOptions = {}) {
    this.acquireAuth =
      options.acquireAuth ??
      (options.credentialRef ? createGcpWorkspaceHostAcquireAuth(options.credentialRef) : acquireGcpAdcAuth);
    this.fetchImpl = options.fetch ?? fetch;
  }

  private imageUrl(projectId: string, imageName: string): string {
    return `${COMPUTE_API}/projects/${encodeURIComponent(project(projectId))}/global/images/${encodeURIComponent(resource(imageName, 'imageName'))}`;
  }

  private async request<T>(url: string, init?: RequestInit): Promise<T> {
    const auth = await this.acquireAuth();
    return fetchGcpApiJson<T>(this.fetchImpl, auth.accessToken, url, init);
  }

  private async readImage(url: string): Promise<GcpImageFamilyComputeImage | undefined> {
    try {
      return mapComputeImage(await this.request<RawComputeImage>(url));
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
  }

  async getImage(projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.readImage(this.imageUrl(projectId, imageName));
  }

  async getFamilyImage(projectId: string, family: string): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.readImage(
      `${COMPUTE_API}/projects/${encodeURIComponent(project(projectId))}/global/images/family/${encodeURIComponent(resource(family, 'family'))}`,
    );
  }

  async getImageFamily(projectId: string, family: string): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.getFamilyImage(projectId, family);
  }

  private async wait(operation: RawComputeOperation, projectId: string): Promise<void> {
    const name = resource(operation.name, 'image operation name');
    const result = await this.request<RawComputeOperation>(
      `${COMPUTE_API}/projects/${encodeURIComponent(project(projectId))}/global/operations/${encodeURIComponent(name)}/wait`,
      { method: 'POST' },
    );
    const error = operationError({ name, status: result.status, error: result.error });
    if (error) fail(error);
  }

  async insertImage(projectId: string, input: GcpImageFamilyComputeImageInsert): Promise<GcpImageFamilyComputeImage> {
    const body = {
      name: resource(input.name, 'image.name'),
      sourceImage: canonicalImageUrl(input.sourceImage),
      description: text(input.description, 'image.description'),
      ...(input.family ? { family: resource(input.family, 'image.family') } : {}),
      ...(input.labels ? { labels: input.labels } : {}),
    };
    const raw = await this.request<RawComputeOperation>(
      `${COMPUTE_API}/projects/${encodeURIComponent(project(projectId))}/global/images`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (raw.name) await this.wait(raw, projectId);
    const result = await this.getImage(projectId, body.name);
    if (!result) fail(`GCP image ${body.name} was not readable after insert`);
    return result;
  }

  async createImage(projectId: string, input: GcpImageFamilyComputeImageInsert): Promise<GcpImageFamilyComputeImage> {
    return this.insertImage(projectId, input);
  }

  async getImageByName(projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.getImage(projectId, imageName);
  }

  async getFamily(projectId: string, family: string): Promise<GcpImageFamilyComputeImage | undefined> {
    return this.getFamilyImage(projectId, family);
  }

  async publishImage(projectId: string, input: GcpImageFamilyComputeImageInsert): Promise<GcpImageFamilyComputeImage> {
    return this.insertImage(projectId, input);
  }

  async deprecateImage(input: {
    projectId: string;
    imageName: string;
    replacementImageId: string;
    state: 'DEPRECATED';
  }): Promise<void> {
    const projectId = project(input.projectId, 'projectId');
    const imageName = resource(input.imageName, 'imageName');
    const replacement = canonicalImageUrl(input.replacementImageId);
    const raw = await this.request<RawComputeOperation>(`${this.imageUrl(projectId, imageName)}/deprecate`, {
      method: 'POST',
      body: JSON.stringify({ state: input.state, replacement }),
    });
    if (raw.name) await this.wait(raw, projectId);
  }

  async setImageDeprecation(input: {
    projectId: string;
    imageName: string;
    replacementImageId: string;
    state: 'DEPRECATED';
  }): Promise<void> {
    return this.deprecateImage(input);
  }
}

function computeApi(options: GcpImageFamilyReleaseAdapterOptions): GcpImageFamilyComputeApi {
  return (
    options.compute ??
    options.computeApi ??
    new GoogleComputeGcpImageFamilyComputeApi({
      acquireAuth: options.acquireAuth,
      credentialRef: options.credentialRef,
      fetch: options.fetch,
    })
  );
}

function commandRunner(options: GcpImageFamilyReleaseAdapterOptions): GcpImageFamilyCommandRunner {
  return options.commandRunner ?? options.commands ?? options.packerRunner ?? new NodeGcpImageFamilyCommandRunner();
}

function ensureVersion(value: unknown, path: string): string {
  return text(value, path);
}

function provenanceDescription(
  artifact: WorkspaceHostImageArtifact,
  guestToolVersions: Readonly<Record<string, string>>,
  sourceCandidateImageId?: string,
): string {
  return JSON.stringify({
    contractVersion: GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
    baseImage: artifact.buildManifest.baseImage,
    architecture: artifact.buildManifest.baseImage.architecture,
    guestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => ({ name, version: guestToolVersions[name] })),
    ...(sourceCandidateImageId ? { sourceCandidateImageId } : {}),
  });
}

function labels(artifact: WorkspaceHostImageArtifact, state: 'candidate' | 'active'): Readonly<Record<string, string>> {
  return {
    'papercusp-artifact': 'workspace-host',
    'papercusp-contract': 'gcp-image-family-v1',
    'papercusp-state': state,
    'papercusp-release': artifact.image.version
      .replace(/[^a-z0-9_-]/gi, '-')
      .toLowerCase()
      .slice(0, 63),
  };
}

function inputMatchesContext(
  input: {
    projectId: string;
    builderKind?: string;
    buildManifestIdentity: string;
    releaseSha256: string;
    releaseVersion?: string;
    architecture?: string;
  },
  context: GcpImageFamilyReleaseContext,
): void {
  const artifact = context.artifact;
  if (
    input.projectId !== context.request.projectId ||
    (input.builderKind !== undefined && input.builderKind !== artifact.buildManifest.builder.kind) ||
    input.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    input.releaseSha256 !== workspaceHostReleaseSubjectSha256(artifact) ||
    (input.releaseVersion !== undefined && input.releaseVersion !== artifact.image.version) ||
    (input.architecture !== undefined && input.architecture !== artifact.buildManifest.baseImage.architecture)
  ) {
    fail('GCP image adapter input is not bound to the release context');
  }
}

async function sha256File(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveHash(hash.digest('hex')));
  });
}

async function verifyBootcGceArtifact(
  artifact: NonNullable<Parameters<GcpImageFamilyReleaseAdapter['buildCandidate']>[0]['bootcArtifact']>,
  repositoryRoot: string,
): Promise<string> {
  if (artifact.cloud !== 'gcp' || artifact.type !== 'gce') {
    fail('bootcArtifact must be the GCP/gce row from the canonical bake manifest');
  }
  const path = isAbsolute(artifact.artifact)
    ? resolve(artifact.artifact)
    : resolve(repositoryRoot, artifact.artifact);
  if (!isAbsolute(artifact.artifact) && relative(repositoryRoot, path).startsWith('..')) {
    fail('bootcArtifact.artifact escapes repositoryRoot');
  }
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    metadata = await stat(path);
  } catch {
    fail(`bootc GCE disk does not exist: ${path}`);
  }
  if (!metadata.isFile() || metadata.size !== artifact.sizeBytes) {
    fail(`bootc GCE disk size does not match the bake manifest: ${path}`);
  }
  if ((await sha256File(path)) !== artifact.sha256) {
    fail(`bootc GCE disk digest does not match the bake manifest: ${path}`);
  }
  return path;
}

/** Concrete seven-operation GCP image-family release adapter. */
export class GoogleComputeGcpImageFamilyReleaseAdapter implements GcpImageFamilyReleaseAdapter {
  private readonly compute: GcpImageFamilyComputeApi;
  private readonly commands: GcpImageFamilyCommandRunner;
  private readonly options: GcpImageFamilyReleaseAdapterOptions;
  private boundContext?: GcpImageFamilyReleaseContext;
  private pinnedGuestToolVersions?: Readonly<Record<string, string>>;

  constructor(options: GcpImageFamilyReleaseAdapterOptions = {}) {
    this.options = options;
    this.compute = computeApi(options);
    this.commands = commandRunner(options);
    if (
      options.guestToolVersions &&
      GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.every((name) => options.guestToolVersions?.[name]?.trim())
    ) {
      this.pinnedGuestToolVersions = Object.fromEntries(
        GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => [name, options.guestToolVersions![name]!.trim()]),
      );
    }
  }

  async bindReleaseContext(context: GcpImageFamilyReleaseContext): Promise<void> {
    if (!context || !context.request || !context.artifact) fail('GCP release context is required');
    this.boundContext = context;
    // Explicit versions supplied at composition time remain valid across a context bind. A
    // successful build below replaces them with the exact normalized values it used.
    this.pinnedGuestToolVersions =
      this.options.guestToolVersions &&
      GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.every((name) => this.options.guestToolVersions?.[name]?.trim())
        ? Object.fromEntries(
            GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => [name, this.options.guestToolVersions![name]!.trim()]),
          )
        : undefined;
  }

  private context(): GcpImageFamilyReleaseContext {
    if (!this.boundContext) fail('GCP image adapter must be bound to a release context before use');
    return this.boundContext;
  }

  private async getImage(projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage> {
    const getter = this.compute.getImage ?? this.compute.getImageByName;
    if (!getter) fail('GCP Compute adapter does not implement getImage');
    const result = await getter.call(this.compute, projectId, imageName);
    if (!result) fail(`GCP image ${projectId}/${imageName} was not found`);
    return result;
  }

  private async findImage(projectId: string, imageName: string): Promise<GcpImageFamilyComputeImage | undefined> {
    const getter = this.compute.getImage ?? this.compute.getImageByName;
    if (!getter) fail('GCP Compute adapter does not implement getImage');
    return getter.call(this.compute, projectId, imageName);
  }

  private pinGuestToolVersions(): Readonly<Record<string, string>> {
    const versions = this.options.guestToolVersions;
    if (!versions || GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.some((name) => !versions[name]?.trim())) {
      fail('guestToolVersions must pin every required GCP guest tool');
    }
    this.pinnedGuestToolVersions = Object.fromEntries(
      GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS.map((name) => [name, versions[name]!.trim()]),
    );
    return this.pinnedGuestToolVersions;
  }

  private async reuseCandidate(
    input: Parameters<GcpImageFamilyReleaseAdapter['buildCandidate']>[0],
    candidateId: string,
    candidateName: string,
    conflictHint: boolean,
  ): Promise<{ imageId: string }> {
    const candidate = parseGcpImmutableImageId(candidateId, 'candidateImageId');
    if (candidate.projectId !== project(input.projectId, 'projectId')) {
      fail('candidateImageId must belong to the publication project');
    }
    if (candidate.imageName !== candidateName) {
      fail(`candidateImageId must name the deterministic candidate ${candidateName}`);
    }
    try {
      const inspection = await this.inspectImage(candidate.projectId, candidate.imageId);
      if (inspection.family) fail('candidate image must not be assigned to a production image family');
      if (
        inspection.buildManifestIdentity !== manifest(input.buildManifestIdentity, 'buildManifestIdentity') ||
        inspection.releaseVersion !== ensureVersion(input.releaseVersion, 'releaseVersion') ||
        inspection.releaseSha256 !== digest(input.releaseSha256, 'releaseSha256') ||
        inspection.architecture !== architecture(input.architecture)
      ) {
        fail('candidate image provenance does not match the requested release');
      }
      return { imageId: candidate.imageId };
    } catch (error) {
      if (!conflictHint) throw error;
      const message = error instanceof Error ? error.message : String(error);
      fail(
        `${message}; delete the conflicting candidate with ` +
          `gcloud compute images delete ${candidateName} --project ${candidate.projectId} --quiet before retrying`,
      );
    }
  }

  private async gcloudJson(args: readonly string[], operation: string): Promise<unknown> {
    const gcloud = safeExecutable(this.options.gcloudExecutable, 'gcloud', 'gcloudExecutable');
    let result: GcpImageFamilyCommandResult;
    try {
      result = await this.commands.run(gcloud, [...args, '--format=json']);
    } catch (error) {
      fail(
        `${operation} could not be executed: ${redactDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
    }
    return assertSuccess(result, operation);
  }

  /**
   * Verify the IAP route before Packer creates its ephemeral builder.
   *
   * The builder is private and uses IAP for SSH, so a firewall rule that targets a different
   * network tag is indistinguishable from a dead guest until Packer's full SSH timeout expires.
   * Resolve the subnet's actual network, read its actual firewall rules, and apply the same
   * `iapSshRuleAdmits` predicate used by the clean-room VM path before ADC, init, validate, or
   * build can start.
   */
  private async assertIapSshCanReachBuilder(
    projectId: string,
    zone: string,
    subnetwork: string,
    builderNetworkTags: readonly string[],
  ): Promise<void> {
    // A non-IAP template path does not depend on the IAP tcp:22 rule. The template defaults to
    // IAP, so the check remains fail-closed for the production path unless explicitly disabled.
    if (this.options.useIap === false) return;

    const region = regionFromZone(zone);
    const subnet = parseJsonObject(
      String(
        await this.gcloudJson(
          [
            'compute',
            'networks',
            'subnets',
            'describe',
            text(subnetwork, 'cleanRoom.subnetwork'),
            `--project=${projectId}`,
            `--region=${region}`,
          ],
          'GCP IAP subnet preflight',
        ),
      ),
      'GCP IAP subnet preflight',
    );
    const networkValue = text(subnet.network, 'GCP IAP subnet preflight network');
    const networkName = resource(networkValue.split('/').at(-1) ?? '', 'GCP IAP subnet preflight network name');
    const rules = parseJsonArray(
      String(
        await this.gcloudJson(
          ['compute', 'firewall-rules', 'list', `--project=${projectId}`, `--filter=network:${networkName}`],
          'GCP IAP firewall preflight',
        ),
      ),
      'GCP IAP firewall preflight',
    );
    const admitted = rules.some((rule) =>
      builderNetworkTags.some((tag) => iapSshRuleAdmits(rule, tag)),
    );
    if (admitted) return;

    const tagList = builderNetworkTags.join(', ');
    fail(
      `GCP IAP firewall preflight found no INGRESS tcp:22 rule on network '${networkName}' ` +
        `that admits builder network tag(s) [${tagList}] from ${IAP_TCP_FORWARDING_SOURCE_RANGE}. ` +
        `Packer would create a private builder and then wait for SSH until its timeout. ` +
        `Create or repair a rule, for example: gcloud compute firewall-rules create ` +
        `${networkName}-builder-iap --project=${projectId} --network=${networkName} ` +
        `--direction=INGRESS --action=allow --rules=tcp:22 ` +
        `--source-ranges=${IAP_TCP_FORWARDING_SOURCE_RANGE} --target-tags=${tagList}`,
    );
  }

  async buildCandidate(
    input: Parameters<GcpImageFamilyReleaseAdapter['buildCandidate']>[0],
  ): Promise<{ imageId: string }> {
    const context = this.context();
    inputMatchesContext(input, context);
    const versions = this.pinGuestToolVersions();
    const candidateName = resource(input.candidateImageName, 'candidateImageName');
    if (input.resumePhase !== undefined && input.resumePhase !== 'scan' && input.resumePhase !== 'publish') {
      fail('resumePhase must be scan or publish');
    }
    if (input.resumePhase !== undefined && !input.candidateImageId) {
      fail('resumePhase requires candidateImageId');
    }
    if (input.candidateImageId) {
      return this.reuseCandidate(
        input,
        assertGcpImmutableImageId(input.candidateImageId, 'candidateImageId'),
        candidateName,
        false,
      );
    }
    const existing = await this.findImage(project(input.projectId, 'projectId'), candidateName);
    if (existing) {
      const existingId = assertGcpImmutableImageId(
        `projects/${project(input.projectId, 'projectId')}/global/images/${resource(existing.name, 'candidate.name')}`,
        'candidateImageId',
      );
      return this.reuseCandidate(input, existingId, candidateName, true);
    }
    const template = text(input.templatePath, 'templatePath');
    if (
      isAbsolute(template) ||
      template.includes('\\') ||
      template.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      fail('templatePath must be a normalized repository-relative POSIX path');
    }
    const root = resolve(this.options.repositoryRoot ?? this.options.repoRoot ?? process.cwd());
    const absoluteTemplate = resolve(root, template);
    if (relative(root, absoluteTemplate).startsWith('..')) fail('templatePath escapes repositoryRoot');
    const bytes = await readFile(absoluteTemplate);
    const templateDigest = createHash('sha256').update(bytes).digest('hex');
    if (templateDigest !== context.artifact.buildManifest.builder.templateSha256) {
      fail(
        `template ${template} digest ${templateDigest} does not match pinned ${context.artifact.buildManifest.builder.templateSha256}`,
      );
    }
    if (input.builderKind === WORKSPACE_HOST_BOOTC_BUILDER_KIND) {
      if (!input.bootcArtifact) fail('bootc-image-builder requires the GCP bake artifact');
      const disk = await verifyBootcGceArtifact(input.bootcArtifact, root);
      const gcloud = safeExecutable(
        this.options.gcloudExecutable,
        'gcloud',
        'gcloudExecutable',
      );
      const imported = await this.commands.run(
        gcloud,
        [
          'compute',
          'images',
          'import',
          candidateName,
          `--project=${project(input.projectId, 'projectId')}`,
          `--source-file=${disk}`,
          '--os=centos-stream-9',
          '--guest-os-features=UEFI_COMPATIBLE',
          `--description=${provenanceDescription(context.artifact, versions)}`,
          '--quiet',
          '--format=json',
        ],
        { cwd: root, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS },
      );
      assertSuccess(imported, 'gcloud compute images import');
      const image = await this.getImage(input.projectId, candidateName);
      if (image.family) fail('bootc candidate must not be assigned to a production image family');
      return {
        imageId: assertGcpImmutableImageId(
          `projects/${input.projectId}/global/images/${image.name}`,
          'buildCandidate.imageId',
        ),
      };
    }
    if (input.bootcArtifact) {
      fail(`bootcArtifact is invalid for builder.kind '${input.builderKind}'`);
    }
    const builderNetworkTags = parseBuilderNetworkTags(bytes.toString('utf8'));
    const sourceImage = assertGcpImmutableImageId(
      text(this.options.sourceImage ?? context.artifact.buildManifest.baseImage.reference, 'baseImage.reference'),
      'baseImage.reference',
    );
    const attestedBaseSha256 = digest(context.artifact.buildManifest.baseImage.sha256, 'baseImage.sha256');
    // ⚠ RE-MEASURE the image Packer will actually boot, not the one the manifest names: the
    // `sourceImage` override can point elsewhere, and the provenance below records
    // `base_image_sha256` as fact (WI-10005746). This is a read, so it runs before anything billable.
    const measuredBase = await measureGcpBaseImage(this.compute, sourceImage);
    if (measuredBase.sha256 !== attestedBaseSha256) {
      fail(
        `base image ${sourceImage} measures ${measuredBase.sha256} (id ${measuredBase.identity.id}, ` +
          `created ${measuredBase.identity.creationTimestamp}), but the build manifest attests ` +
          `baseImage.sha256 ${attestedBaseSha256}; refusing to build from an image the release did not measure`,
      );
    }
    const vars: Readonly<Record<string, string | number | boolean>> = {
      project_id: project(input.projectId, 'projectId'),
      zone: text(context.request.cleanRoom.zone, 'cleanRoom.zone'),
      subnetwork: text(context.request.cleanRoom.subnetwork, 'cleanRoom.subnetwork'),
      service_account_email: text(context.request.cleanRoom.serviceAccountEmail, 'cleanRoom.serviceAccountEmail'),
      candidate_image_name: candidateName,
      build_manifest_identity: manifest(input.buildManifestIdentity, 'buildManifestIdentity'),
      source_image: sourceImage,
      base_image_sha256: measuredBase.sha256,
      architecture: text(input.architecture, 'architecture'),
      release_version: ensureVersion(input.releaseVersion, 'releaseVersion'),
      release_bundle_url: text(context.artifact.release.bundleUrl, 'release.bundleUrl'),
      release_bundle_sha256: digest(context.artifact.release.bundleSha256, 'release.bundleSha256'),
      release_signature_url: text(context.artifact.release.signatureUrl, 'release.signatureUrl'),
      release_signing_public_key: text(context.artifact.release.signingPublicKey, 'release.signingPublicKey'),
      release_signing_key_sha256: digest(context.artifact.release.signingKeySha256, 'release.signingKeySha256'),
      builder_network_tags: JSON.stringify(builderNetworkTags),
      guest_tool_versions: JSON.stringify(versions),
      ...(this.options.machineType ? { machine_type: this.options.machineType } : {}),
      ...(this.options.diskSizeGb === undefined ? {} : { disk_size_gb: this.options.diskSizeGb }),
      ...(this.options.omitExternalIp === undefined ? {} : { omit_external_ip: this.options.omitExternalIp }),
      ...(this.options.useIap === undefined ? {} : { use_iap: this.options.useIap }),
    };
    const packer = safeExecutable(
      this.options.packerExecutable ?? this.options.packerPath,
      'packer',
      'packerExecutable',
    );
    // ⚠ Verify the actual network and firewall admission before even probing ADC. The IAP
    // preflight is read-only, while `packer init`/`validate` are the final free checks before the
    // billable builder VM is created.
    await this.assertIapSshCanReachBuilder(
      input.projectId,
      text(context.request.cleanRoom.zone, 'cleanRoom.zone'),
      text(context.request.cleanRoom.subnetwork, 'cleanRoom.subnetwork'),
      builderNetworkTags,
    );
    // ⚠ PROVE THE CREDENTIAL PACKER WILL ACTUALLY USE, before anything billable runs. Same
    // motivation as the `packer validate` call below: fail in a second, not after a builder VM
    // exists. See assertAdcCanMintForPacker for why this is not covered by the release preflight.
    await this.assertAdcCanMintForPacker();
    const init = await this.commands.run(packer, ['init', '--upgrade=false', template], { cwd: root });
    assertSuccess(init, 'packer init');
    const varArgs: string[] = [];
    for (const [key, value] of Object.entries(vars)) varArgs.push('-var', `${key}=${String(value)}`);
    // ⚠ EVALUATE the template — with these exact variables — before anything billable runs.
    // This is not redundant with the release preflight, which runs `packer validate
    // -syntax-only`: syntax-only PARSES the file without evaluating expressions, so it
    // cannot see a call to a function Packer does not have, nor a `validation` block whose
    // condition is false for the variables we are about to build with. A production release
    // spent a full `packer build` to discover `setsubtract` does not exist in Packer
    // (EI-21762126059344308); this call finds that class in about a second, for free, and
    // fails BEFORE a builder VM is created.
    const validated = await this.commands.run(packer, ['validate', ...varArgs, template], { cwd: root });
    assertSuccess(validated, 'packer validate');
    const buildArgs: string[] = ['build', '-machine-readable', '-color=false', ...varArgs, template];
    const built = await this.commands.run(packer, buildArgs, { cwd: root, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
    const stdout = assertSuccess(built, 'packer build');
    const parsedId = parsePackerImageId(stdout, input.projectId, candidateName);
    const image = await this.getImage(input.projectId, parsedId ? imageNameFromId(parsedId) : candidateName);
    const imageId = assertGcpImmutableImageId(
      `projects/${input.projectId}/global/images/${image.name}`,
      'buildCandidate.imageId',
    );
    if (image.family) fail('Packer candidate must not be assigned to a production image family');
    return { imageId };
  }

  /**
   * Prove the credential PACKER will use can still mint a token, before anything billable runs.
   *
   * ⚠ Packer does NOT use this release's `cloudCredentialRef`. The release resolves that ref
   * (typically `gcloud://active-user`) for its own API calls, while `packer build` is a
   * subprocess that authenticates with Application Default Credentials. They are two different
   * credentials and only the unused one was ever checked: a perfectly healthy active-user
   * credential passed the release preflight while ADC was reauth-dead, so the build was
   * certified green and then died ~6s in with "All options for deriving the OSLogin user have
   * been exhausted" — an error that reads as an OS Login/IAM misconfiguration and points away
   * from the credential entirely. A preflight that validates a credential the build does not
   * use is worse than no preflight: it converts "unauthenticated" into a green light plus a
   * confusing error minutes later (EI-21847008443626335).
   *
   * ⚠ THE PROBE MUST RUN THROUGH `this.commands`, AND THAT IS LOAD-BEARING, NOT STYLE. That
   * runner strips GOOGLE_APPLICATION_CREDENTIALS / GOOGLE_OAUTH_ACCESS_TOKEN /
   * CLOUDSDK_AUTH_ACCESS_TOKEN exactly as the packer invocation does, so the probe resolves the
   * same credential the build will. Run the identical gcloud command against an unsanitised
   * environment and it answers from whatever service-account key those variables select,
   * reporting a healthy ADC while ADC is dead — reproducing the very false green this exists to
   * prevent. That is not hypothetical: the operator-facing re-check command recorded on this
   * bug did precisely that and a build was launched on its say-so.
   */
  private async assertAdcCanMintForPacker(): Promise<void> {
    const gcloud = safeExecutable(this.options.gcloudExecutable, 'gcloud', 'gcloudExecutable');
    const remedy = 'Refresh it with: gcloud auth application-default login';
    let result: GcpImageFamilyCommandResult;
    try {
      result = await this.commands.run(gcloud, ['auth', 'application-default', 'print-access-token', '--quiet']);
    } catch (error) {
      fail(
        'Application Default Credentials could not be probed before the build. Packer ' +
          "authenticates with ADC, not with this release's cloudCredentialRef. " +
          `${redactDiagnostic(error instanceof Error ? error.message : String(error))} ${remedy}`,
      );
      return;
    }
    if (!Number.isSafeInteger(result.exitCode) || result.exitCode !== 0 || !result.stdout.trim()) {
      const diagnostic = redactDiagnostic(result.stderr) || `exit ${String(result.exitCode)}`;
      fail(
        'Application Default Credentials cannot mint an access token, so `packer build` would ' +
          "fail after a builder VM had already been created. Packer authenticates with ADC — NOT " +
          "this release's cloudCredentialRef, which may itself be perfectly healthy. " +
          `${remedy}. Probe: ${diagnostic}`,
      );
    }
  }

  async scanImage(input: Parameters<GcpImageFamilyReleaseAdapter['scanImage']>[0]): Promise<GcpImageScanEvidence> {
    const context = this.context();
    inputMatchesContext(input, context);
    const runner =
      this.options.scanRunner ??
      this.options.scanner ??
      this.options.scan ??
      new CommandGcpImageFamilyScanRunner(
        this.commands,
        safeExecutable(
          this.options.scanExecutable ?? this.options.scannerExecutable,
          'papercusp-image-scan',
          'scanExecutable',
        ),
        resolve(this.options.repositoryRoot ?? this.options.repoRoot ?? process.cwd()),
      );
    const fn = runner.run
      ? runner.run.bind(runner)
      : 'scan' in runner && runner.scan
        ? runner.scan.bind(runner)
        : 'scanImage' in runner && runner.scanImage
          ? runner.scanImage.bind(runner)
          : undefined;
    if (!fn) fail('GCP image scanner has no run/scan implementation');
    const result = await fn({ ...input, artifact: context.artifact });
    return scanEvidence(result, input);
  }

  async inspectImage(projectId: string, imageId: string): Promise<GcpImageInspection> {
    const coordinates = parseGcpImmutableImageId(imageId, 'imageId');
    if (coordinates.projectId !== project(projectId)) fail('imageId project does not match projectId');
    const raw = await this.getImage(projectId, coordinates.imageName);
    const provenance = parseProvenance(raw.description);
    const tools = guestTools(provenance.guestTools);
    if (this.pinnedGuestToolVersions) {
      for (const tool of tools) {
        const expected = this.pinnedGuestToolVersions[tool.name];
        if (expected && expected !== tool.version) {
          fail(`GCP image guest tool ${tool.name} is ${tool.version}, not the pinned ${expected}`);
        }
      }
    }
    return {
      imageId: coordinates.imageId,
      ...(raw.family ? { family: raw.family } : {}),
      state: imageState(raw),
      architecture: architecture(provenance.architecture ?? raw.architecture),
      buildManifestIdentity: manifest(provenance.buildManifestIdentity, 'image.buildManifestIdentity'),
      releaseVersion: text(provenance.releaseVersion, 'image.releaseVersion'),
      releaseSha256: digest(provenance.releaseSha256, 'image.releaseSha256'),
      guestTools: tools,
      ...(typeof provenance.sourceCandidateImageId === 'string'
        ? {
            sourceCandidateImageId: assertGcpImmutableImageId(
              provenance.sourceCandidateImageId,
              'image.sourceCandidateImageId',
            ),
          }
        : {}),
    };
  }

  async launchCleanRoomCanary(
    input: Parameters<GcpImageFamilyReleaseAdapter['launchCleanRoomCanary']>[0],
  ): Promise<GcpImageCleanBootProof> {
    const context = this.context();
    inputMatchesContext(input, context);
    const attestation = context.request.releaseGate.cleanRoomReport.attestation;
    if (!attestation) fail('release gate clean-room attestation is required to build the canonical fixture');
    const observedAt = this.options.now?.() ?? new Date().toISOString();
    const fixture = buildWorkspaceHostCleanRoomInstallFixture(context.artifact, {
      fixtureId: `gcp-image-family-${input.releaseVersion}-${input.imageId.slice(-24)}`,
      action: 'install',
      provider: 'gcp',
      architecture: context.artifact.buildManifest.baseImage.architecture,
      observedAt,
      hostId: `gcp-clean-${input.imageId.slice(-32)}`,
      migrationId: attestation.migration.id,
      minimumNodeMajor: attestation.runtime.minimumNodeMajor,
      service: {
        name: attestation.service.name,
        port: attestation.service.port,
        user: attestation.service.user,
        group: attestation.service.group,
      },
      isolation: {
        workspaceUser: attestation.isolation.workspaceUser,
        workspaceGroup: attestation.isolation.workspaceGroup,
      },
    });
    const runInput: GcpImageFamilyCleanRoomRunInput = { ...input, fixture };
    const runner =
      this.options.cleanRoomRunner ??
      this.options.cleanRoom ??
      this.options.cleanRoomExecutor ??
      new CommandGcpImageFamilyCleanRoomRunner(
        this.commands,
        safeExecutable(
          this.options.cleanRoomExecutable ?? this.options.cleanRoomCommand,
          'papercusp-gcp-clean-room',
          'cleanRoomExecutable',
        ),
        resolve(this.options.repositoryRoot ?? this.options.repoRoot ?? process.cwd()),
      );
    const fn = runner.run
      ? runner.run.bind(runner)
      : 'execute' in runner && runner.execute
        ? runner.execute.bind(runner)
        : 'runCleanRoom' in runner && runner.runCleanRoom
          ? runner.runCleanRoom.bind(runner)
          : undefined;
    if (!fn) fail('GCP clean-room runner has no run/execute implementation');
    const result = await fn(runInput);
    let value = result;
    if (
      value &&
      typeof value === 'object' &&
      'stdout' in value &&
      typeof (value as { stdout?: unknown }).stdout === 'string'
    ) {
      // Same spill-before-excerpt contract as the packer and scanner paths — see assertSuccess.
      const command = value as GcpImageFamilyCommandResult;
      value = parseJsonObject(assertSuccess(command, 'GCP clean-room runner'), 'GCP clean-room runner');
    }
    return cleanProof(value, runInput);
  }

  async publishFamilyVersion(
    input: Parameters<GcpImageFamilyReleaseAdapter['publishFamilyVersion']>[0],
  ): Promise<GcpImageFamilyPin & { sourceCandidateImageId: string }> {
    const context = this.context();
    inputMatchesContext(input, context);
    const target = parseGcpImmutableImageId(context.artifact.image.id, 'artifact.image.id');
    if (
      input.projectId !== target.projectId ||
      input.imageName !== target.imageName ||
      input.family !== context.request.family
    )
      fail('publication image identity does not match the release context');
    const sourceCandidateImageId = assertGcpImmutableImageId(input.sourceCandidateImageId, 'sourceCandidateImageId');
    if (parseGcpImmutableImageId(sourceCandidateImageId).projectId !== input.projectId)
      fail('candidate image must belong to the publication project');
    const insert = this.compute.insertImage ?? this.compute.createImage ?? this.compute.publishImage;
    if (!insert) fail('GCP Compute adapter does not implement insertImage/createImage');
    if (!this.pinnedGuestToolVersions) fail('publish requires pinned guest-tool versions from the verified build');
    const result = await insert.call(this.compute, input.projectId, {
      name: target.imageName,
      family: resource(input.family, 'family'),
      sourceImage: sourceCandidateImageId,
      description: provenanceDescription(context.artifact, this.pinnedGuestToolVersions, sourceCandidateImageId),
      labels: labels(context.artifact, 'active'),
    });
    const returnedName = 'status' in result || 'error' in result ? target.imageName : result.name;
    if (returnedName !== target.imageName) fail('Compute publication receipt named a different image');
    const published = await this.getImage(input.projectId, target.imageName);
    if (published.family !== input.family) fail(`published image is not a member of family ${input.family}`);
    return {
      projectId: input.projectId,
      family: input.family,
      imageId: target.imageId,
      version: input.releaseVersion,
      sourceCandidateImageId,
    };
  }

  async resolveFamily(projectId: string, family: string): Promise<GcpImageFamilyPin> {
    const getter = this.compute.getFamilyImage ?? this.compute.getImageFamily ?? this.compute.getFamily;
    if (!getter) fail('GCP Compute adapter does not implement family resolution');
    const raw = await getter.call(this.compute, project(projectId), resource(family, 'family'));
    if (!raw) fail(`GCP image family ${projectId}/${family} was not found`);
    if (raw.family && raw.family !== family)
      fail(`GCP family resolver returned member of ${raw.family}, expected ${family}`);
    const imageId = assertGcpImmutableImageId(
      `projects/${projectId}/global/images/${raw.name}`,
      'resolvedFamily.imageId',
    );
    const provenance = parseProvenance(raw.description);
    return {
      projectId,
      family,
      imageId,
      version: text(provenance.releaseVersion ?? raw.name, 'resolvedFamily.version'),
    };
  }

  async deprecateImage(input: Parameters<GcpImageFamilyReleaseAdapter['deprecateImage']>[0]): Promise<void> {
    if (input.state !== 'DEPRECATED') fail('GCP image deprecation only supports the DEPRECATED state');
    const projectId = project(input.projectId, 'projectId');
    const imageId = parseGcpImmutableImageId(input.imageId, 'imageId');
    const replacement = parseGcpImmutableImageId(input.replacementImageId, 'replacementImageId');
    if (imageId.projectId !== projectId || replacement.projectId !== projectId)
      fail('deprecation images must belong to projectId');
    if (imageId.imageId === replacement.imageId) fail('deprecation replacement must differ from imageId');
    const deprecate = this.compute.deprecateImage ?? this.compute.setImageDeprecation;
    if (!deprecate) fail('GCP Compute adapter does not implement image deprecation');
    await deprecate.call(this.compute, {
      projectId,
      imageName: imageId.imageName,
      replacementImageId: replacement.imageId,
      state: input.state,
    });
  }
}

export function createGcpImageFamilyReleaseAdapter(
  options: GcpImageFamilyReleaseAdapterOptions = {},
): GoogleComputeGcpImageFamilyReleaseAdapter {
  return new GoogleComputeGcpImageFamilyReleaseAdapter(options);
}

/** Public probes used by focused adapter tests and release diagnostics. */
export function parseGcpImageFamilyPackerOutput(
  stdout: string,
  projectId: string,
  imageName: string,
): string | undefined {
  return parsePackerImageId(stdout, project(projectId), resource(imageName, 'imageName'));
}

export function parseGcpImageFamilyProvenance(description: string): Readonly<Record<string, unknown>> {
  return parseProvenance(description);
}
