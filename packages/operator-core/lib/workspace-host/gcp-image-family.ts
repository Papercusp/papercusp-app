import {
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  workspaceHostBootcPinnedImageRef,
  type WorkspaceHostBootstrapAttestation,
  type WorkspaceHostBuilderKind,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';

import { evaluateImageScanPolicy, GCP_IMAGE_SCAN_POLICY } from './image-scan-policy';
import {
  evaluateWorkspaceHostReleaseGate,
  type WorkspaceHostReleaseGateInput,
  type WorkspaceHostReleaseGateVerdict,
} from './workspace-host-release-gate';
import {
  workspaceHostBootcCloudArtifact,
  workspaceHostReleaseSubjectSha256,
  type WorkspaceHostBootcCloudArtifact,
} from './bootc-bake-manifest';

export const GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION = 'papercusp-gcp-image-family-release-v1';

/**
 * Guest capabilities that must survive the provider-specific image build, named by the RPM
 * the CentOS Stream 10 bootc image (infra/images/bootc/workspace-host.Containerfile)
 * installs. The GCE disk is rendered from that same image (bake-cloud-images.sh), so each
 * name must be checkable with `rpm -q` against it. The Ubuntu-era names never existed
 * there: ufw maps to nftables and unattended-upgrades to dnf-automatic (RPM-EQUIVALENCE.md;
 * WI-10005618, the GCP twin of WI-10005605).
 */
export const GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS = [
  'acl',
  'ca-certificates',
  'curl',
  'dnf-automatic',
  'google-guest-agent',
  'jq',
  'minisign',
  'nftables',
  'openssh-server',
] as const;

export interface GcpImmutableImageCoordinates {
  projectId: string;
  imageName: string;
  imageId: string;
}

export interface GcpImageFamilyPin {
  projectId: string;
  family: string;
  imageId: string;
  version: string;
}

export interface GcpImageScanEvidence {
  imageId: string;
  buildManifestIdentity: string;
  releaseSha256: string;
  trusted: boolean;
  sbomSha256: string;
  /** Total grype matches at any severity. Evidence; the gate acts on the breakdown. */
  vulnerabilityFindings: number;
  /**
   * Per-severity counts keyed by grype's own labels. REQUIRED: the gate ranks these
   * against the ratified policy, and `evaluateImageScanPolicy` reconciles their sum
   * against `vulnerabilityFindings` so an absent breakdown cannot read as a clean one.
   */
  vulnerabilityBySeverity: Readonly<Record<string, number>>;
  secretFindings: number;
  /**
   * What the scan actually COVERED. The guest fails closed at zero, but a count >= 1 is
   * satisfied by any single partition, so this is evidence to be read alongside
   * `candidateRootProof` — not a coverage guarantee on its own (WI-1092039).
   */
  mountedFilesystems?: number;
  /**
   * Proof the mounted tree was the CANDIDATE's root rather than some other partition that
   * happened to mount. This is the field that distinguishes "scanned clean" from
   * "scanned the wrong filesystem and found nothing" (WI-1092039).
   */
  candidateRootProof?: string;
  /**
   * Diagnostics below are measured by the guest on every run at no extra cost. They are
   * carried so a RED release gate arrives WITH its diagnosis instead of forcing a second
   * billable image build to re-derive it (WI-1088331). Optional because the guest emits
   * each one conditionally; absent means "not measured", never "zero".
   */
  vulnerabilityFixable?: number;
  /** Answers "how many of the blocking findings can we actually act on" without a re-scan. */
  vulnerabilityFixableBySeverity?: Readonly<Record<string, number>>;
  /**
   * Which ecosystem each match belongs to — the field that decides whether a given
   * remediation can even reach the findings. This image carries an Ubuntu userland AND
   * npm packages AND python dist-packages, and apt reaches exactly one of the three.
   */
  vulnerabilityByEcosystem?: Readonly<Record<string, number>>;
  vulnerabilityFixableByEcosystem?: Readonly<Record<string, number>>;
  /**
   * Severity x ecosystem, crossed — the field that says whether a red gate is reachable at all.
   * The two marginals above cannot be combined after the fact, which is what left "how many of
   * the DENIED findings are kernel" unanswerable until it existed (WI-1182614 / D-201).
   */
  vulnerabilityBySeverityAndEcosystem?: Readonly<Record<string, number>>;
  /** Findings ranked by artifact, capped — carried WITH its denominator, never alone. */
  vulnerabilityByArtifact?: Readonly<Record<string, number>>;
  vulnerabilityDistinctArtifacts?: number;
  /** The same ranking restricted to the DENIED band — what a remediation actually targets. */
  vulnerabilityCriticalHighByArtifact?: Readonly<Record<string, number>>;
  vulnerabilityCriticalHighDistinctArtifacts?: number;
  /**
   * SCOPE — papercusp-bundled versus inherited base image, the mechanism D-201 left open.
   *
   * The scan deliberately measures the WHOLE mounted image (that is what proves it mounted an
   * OS and cataloged what the OS contains), but the release it reports on is only the content
   * under the bundle path. D-201: linux-kernel alone carries 1054 findings at or above high, so
   * a gate measuring the whole mount can never be greened by any change to the release; D-202:
   * the npm findings under the bundle are ours and every one is fixable. Two populations with
   * opposite remediations, indistinguishable in this document until these fields.
   *
   * NO LONGER EVIDENCE ONLY — `GCP_IMAGE_SCAN_POLICY` is `providerImageScanPolicy('papercusp-bundled')`,
   * so `evaluateImageScanPolicy` READS these fields and the GCP release verdict is scoped to the
   * bundled bucket. D-202 section 4 sequenced the npm remediation BEFORE that flip; the flip has
   * since landed, so a reader planning against "the gate measures the whole mount" is planning
   * against a gate that no longer exists.
   *
   * The scoped verdict is earned, never assumed: image-scan-policy.ts requires the threshold to be
   * exactly 'high' (the bucket measures only critical+high, so any other threshold is refused as
   * `scope-attribution-mismatch`), requires all four of `vulnerabilityByScope`,
   * `vulnerabilityCriticalHighByScope`, `secretsByScope` and `bundleCatalogedArtifacts` to be
   * present (`scope-attribution-missing`), and requires `bundleCatalogedArtifacts >= 1`
   * (`scope-attribution-invalid`) — because the failure mode of scoping is a false GREEN: get the
   * bundle path wrong and everything attributes to 'inherited-base-image' while the bundled bucket
   * reads a vacuous 0.
   */
  vulnerabilityByScope?: Readonly<Record<string, number>>;
  vulnerabilityCriticalHighByScope?: Readonly<Record<string, number>>;
  /**
   * How many SBOM packages attributed to the bundle path — the denominator that makes the split
   * above falsifiable. Without it, "no findings are ours" (the goal state) and "the path matcher
   * matched nothing" (an instrument fault) are the same reading. The guest already fails closed
   * on the latter; this carries the number so a human can check it without a second scan.
   */
  bundleCatalogedArtifacts?: number;
  secretsByRule?: Readonly<Record<string, number>>;
  /**
   * Census of every secret finding by rule x top-level directory. Bounded by distinct
   * (rule, /dir) pairs, so it stays small however many findings there are — unlike
   * `secretSample`, which is capped and classifies only a fraction of them.
   * Location only, never a matched value.
   */
  secretsByArea?: Readonly<Record<string, number>>;
  /**
   * The secrets leg of the scope split. D-201 established both legs are ONE defect: the policy
   * module already concedes in code that gitleaks reads the entire mounted userland, so its
   * count says nothing about papercusp-authored content. This says which findings, if any, are.
   * Location only, never a matched value — same rule as secretsByArea and secretSample.
   */
  secretsByScope?: Readonly<Record<string, number>>;
  /** rule/file/line only — the scanner never emits the matched value, and neither do we. */
  secretSample?: readonly unknown[];
  /**
   * EVERY papercusp-bundled secret finding, enumerated by file.
   *
   * `secretSample` is capped at 50 across the UNSCOPED set in the scanner's own emission order,
   * so on the 0.0.18 candidate it named 2 of the 31 bundled findings and left the other 29
   * unresolvable to a file. `secretsByArea` cannot close that gap either — it answers "how many,
   * under which top-level directory", and triage needs "which file", because judging a finding
   * means opening the file it sits in. This is that field.
   *
   * Small by construction: the release gate requires this population to reach zero, so it is
   * short on a shippable image and empty on a green one. Location only, never a matched value.
   */
  secretBundledSample?: readonly unknown[];
  /**
   * Whether `secretBundledSample` holds the whole bundled population or was cut by the scanner's
   * safety cap. Carried beside the array because a truncated list that cannot say so is
   * indistinguishable from a complete one.
   */
  secretBundledSampleComplete?: boolean;
  evidenceRef: string;
}

export interface GcpImageInspection {
  imageId: string;
  family?: string;
  state: 'ACTIVE' | 'DEPRECATED' | 'OBSOLETE' | 'DELETED';
  architecture: string;
  buildManifestIdentity: string;
  releaseVersion: string;
  releaseSha256: string;
  guestTools: readonly { name: string; version: string }[];
  /** The quarantined candidate from which the family member was published. */
  sourceCandidateImageId?: string;
}

export interface GcpImageCleanBootProof {
  evidenceRef: string;
  projectId: string;
  zone: string;
  imageId: string;
  buildManifestIdentity: string;
  computeRunning: boolean;
  osLoginReady: boolean;
  publicIpv4Assigned: boolean;
  attestation: WorkspaceHostBootstrapAttestation;
  terminated: boolean;
  residualResourceIds: readonly string[];
  observedAt: string;
}

export interface GcpImageFamilyReleaseRequest {
  releaseGate: WorkspaceHostReleaseGateInput;
  projectId: string;
  family: string;
  publishedAt: string;
  previousVersion?: GcpImageFamilyPin;
  /** Older family members to deprecate after promotion. The immediate rollback target is forbidden here. */
  retireVersions?: readonly GcpImageFamilyPin[];
  cleanRoom: {
    zone: string;
    serviceAccountEmail: string;
    subnetwork: string;
  };
  /**
   * WI-10006408: the required guest-tool versions, derived by the request composer from the
   * bake's syft SBOM (installed-rpm rows; `bootc-image-release-request-cli --emit
   * guest-tool-versions --provider gcp`). The image provenance is pinned to exactly these; an
   * operator `--guest-tool-versions-file` may only restate them (resolveSbomGuestToolVersions).
   */
  guestToolVersions?: Readonly<Record<string, string>>;
}

export type GcpImageFamilyReleaseResumePhase = 'scan' | 'publish';

/**
 * Controls a retry that starts with an already-built candidate.
 *
 * A resumed release still re-runs the read-only scan, candidate inspection, and clean-room
 * canary before the irreversible family publication.  The phase is explicit so a caller cannot
 * accidentally turn an image id into an implicit publish-only bypass.
 */
export interface GcpImageFamilyReleaseExecutionOptions {
  candidateImageId?: string;
  resumePhase?: GcpImageFamilyReleaseResumePhase;
}

/** Compatibility alias for callers that use the shorter options name. */
export type GcpImageFamilyReleaseOptions = GcpImageFamilyReleaseExecutionOptions;

/**
 * Full release context supplied to a production adapter before its first operation.
 *
 * The seven-operation adapter methods intentionally carry only the narrow values each provider
 * call needs.  Clean-room execution is different: it must run the canonical bootstrap fixture,
 * which is owned by the complete image artifact and release-gate report.  This optional binding
 * keeps that context on the adapter without widening every method's wire contract or making a
 * provider implementation reconstruct signed-release metadata from partial strings.
 */
export interface GcpImageFamilyReleaseContext {
  readonly request: GcpImageFamilyReleaseRequest;
  readonly artifact: WorkspaceHostImageArtifact;
}

export interface GcpImageFamilyReleaseAdapter {
  /** Bind the complete request before build/scan/clean-room operations (production adapters). */
  bindReleaseContext?(context: GcpImageFamilyReleaseContext): void | Promise<void>;
  /** Build outside the production family so a candidate cannot be selected before it is green. */
  buildCandidate(input: {
    projectId: string;
    candidateImageName: string;
    /** Optional immutable candidate to validate and reuse instead of invoking Packer. */
    candidateImageId?: string;
    /** Explicit post-build retry phase; scan/publish are both re-verified before publication. */
    resumePhase?: GcpImageFamilyReleaseResumePhase;
    builderKind: WorkspaceHostBuilderKind;
    templatePath: string;
    /** Present exactly for bootc builds: the already-rendered GCE disk to import. */
    bootcArtifact?: WorkspaceHostBootcCloudArtifact;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
    architecture: string;
    requiredGuestTools: readonly string[];
  }): Promise<{ imageId: string }>;
  scanImage(input: {
    projectId: string;
    /** The request-bound NAT-backed subnet for the private scanner VM. */
    subnetwork: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
  }): Promise<GcpImageScanEvidence>;
  inspectImage(projectId: string, imageId: string): Promise<GcpImageInspection>;
  launchCleanRoomCanary(input: {
    projectId: string;
    zone: string;
    serviceAccountEmail: string;
    subnetwork: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
  }): Promise<GcpImageCleanBootProof>;
  /** Publish the already-green candidate as a new immutable member of the production family. */
  publishFamilyVersion(input: {
    projectId: string;
    family: string;
    imageName: string;
    sourceCandidateImageId: string;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
  }): Promise<GcpImageFamilyPin & { sourceCandidateImageId: string }>;
  resolveFamily(projectId: string, family: string): Promise<GcpImageFamilyPin>;
  /** GCP deprecation keeps exact image references bootable; this contract intentionally has no delete operation. */
  deprecateImage(input: {
    projectId: string;
    imageId: string;
    replacementImageId: string;
    state: 'DEPRECATED';
  }): Promise<void>;
}

export interface GcpImageFamilyReleaseResult {
  contractVersion: typeof GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION;
  releaseGate: WorkspaceHostReleaseGateVerdict;
  candidateImageId: string;
  scan: GcpImageScanEvidence;
  cleanBootProof: GcpImageCleanBootProof;
  active: GcpImageFamilyPin;
  rollbackTarget?: GcpImageFamilyPin;
  retired: readonly GcpImageFamilyPin[];
}

export interface GcpImageFamilyRollbackRequest {
  projectId: string;
  family: string;
  current: GcpImageFamilyPin;
  rollbackTarget: GcpImageFamilyPin;
}

export interface GcpImageFamilyRollbackResult {
  active: GcpImageFamilyPin;
  deprecated: GcpImageFamilyPin;
}

export class GcpImageFamilyReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GcpImageFamilyReleaseError';
  }
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const RESOURCE_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const IMMUTABLE_IMAGE_ID = /^projects\/([^/]+)\/global\/images\/([^/]+)$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new GcpImageFamilyReleaseError(message);
}

function requireText(value: string, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value.trim();
}

function requireProjectId(value: string, path: string): string {
  const projectId = requireText(value, path);
  if (!PROJECT_ID.test(projectId)) fail(`${path} must be a GCP project id`);
  return projectId;
}

function requireResourceName(value: string, path: string): string {
  const name = requireText(value, path);
  if (!RESOURCE_NAME.test(name)) fail(`${path} must be a GCP resource name`);
  return name;
}

function requireTimestamp(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${path} must be an ISO timestamp`);
  return parsed;
}

/** Parse and normalize the only image reference accepted by workspace operations. */
export function parseGcpImmutableImageId(value: string, path = 'imageId'): GcpImmutableImageCoordinates {
  const imageId = requireText(value, path);
  const match = imageId.match(IMMUTABLE_IMAGE_ID);
  if (!match) {
    fail(
      `${path} must be an immutable projects/{project}/global/images/{name} reference; family aliases are forbidden`,
    );
  }
  const projectId = requireProjectId(match[1], `${path}.project`);
  const imageName = requireResourceName(match[2], `${path}.name`);
  return { projectId, imageName, imageId: `projects/${projectId}/global/images/${imageName}` };
}

export function assertGcpImmutableImageId(value: string, path = 'imageId'): string {
  return parseGcpImmutableImageId(value, path).imageId;
}

function normalizePin(pin: GcpImageFamilyPin, path: string, projectId: string, family: string): GcpImageFamilyPin {
  const pinProject = requireProjectId(pin.projectId, `${path}.projectId`);
  const pinFamily = requireResourceName(pin.family, `${path}.family`);
  const image = parseGcpImmutableImageId(pin.imageId, `${path}.imageId`);
  const version = requireText(pin.version, `${path}.version`);
  if (pinProject !== projectId || image.projectId !== projectId || pinFamily !== family) {
    fail(`${path} must belong to ${projectId}/${family}`);
  }
  return { projectId, family, imageId: image.imageId, version };
}

function candidateName(imageName: string): string {
  const prefix = imageName.slice(0, 53).replace(/-+$/g, '') || 'image';
  return `${prefix}-candidate`;
}

function validateScan(scan: GcpImageScanEvidence, artifact: WorkspaceHostImageArtifact, imageId: string): void {
  if (
    scan.imageId !== imageId ||
    scan.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    scan.releaseSha256 !== workspaceHostReleaseSubjectSha256(artifact)
  ) {
    fail('GCP image scan is not bound to the exact candidate, build manifest, and release digest');
  }
  if (!scan.trusted) {
    fail('GCP image scan must be trusted');
  }
  // GCP_IMAGE_SCAN_POLICY, not the shared default: the GCP scanner measures its own
  // filesystem coverage, so it is held to proving it (WI-1092039 / D-196). AWS and
  // Azure use equivalent provider-scoped policies in their release modules.
  const policy = evaluateImageScanPolicy(scan, GCP_IMAGE_SCAN_POLICY);
  if (!policy.accepted) {
    fail(
      `GCP image scan violates the workspace-host release policy: ${policy.failures
        .map((failure) => failure.message)
        .join('; ')}`,
    );
  }
  if (!SHA256.test(scan.sbomSha256) || !scan.evidenceRef.trim()) {
    fail('GCP image scan must carry an immutable SBOM digest and evidence reference');
  }
}

function validateInspection(
  inspection: GcpImageInspection,
  artifact: WorkspaceHostImageArtifact,
  expectedImageId: string,
  expectedFamily: string | undefined,
  sourceCandidateImageId?: string,
): void {
  if (
    inspection.imageId !== expectedImageId ||
    inspection.state !== 'ACTIVE' ||
    inspection.architecture !== artifact.buildManifest.baseImage.architecture ||
    inspection.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    inspection.releaseVersion !== artifact.image.version ||
    inspection.releaseSha256 !== workspaceHostReleaseSubjectSha256(artifact)
  ) {
    fail(`${expectedImageId} is not an active image bound to the canonical build and release`);
  }
  if (inspection.family !== expectedFamily) {
    fail(
      expectedFamily
        ? `${expectedImageId} is not an active member of family ${expectedFamily}`
        : `${expectedImageId} candidate must not be discoverable through an image family`,
    );
  }
  if (sourceCandidateImageId && inspection.sourceCandidateImageId !== sourceCandidateImageId) {
    fail(`${expectedImageId} is not derived from the green candidate ${sourceCandidateImageId}`);
  }
  const installed = new Map(inspection.guestTools.map((tool) => [tool.name, tool.version]));
  for (const tool of GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS) {
    if (!installed.get(tool)?.trim()) fail(`${expectedImageId} is missing guest tool ${tool}`);
  }
}

function validateCleanBootProof(
  proof: GcpImageCleanBootProof,
  request: GcpImageFamilyReleaseRequest,
  artifact: WorkspaceHostImageArtifact,
  candidateImageId: string,
): void {
  const expectedAttestation = request.releaseGate.cleanRoomReport.attestation;
  if (
    proof.projectId !== request.projectId ||
    proof.zone !== request.cleanRoom.zone ||
    proof.imageId !== candidateImageId ||
    proof.buildManifestIdentity !== artifact.buildManifest.manifestIdentity
  ) {
    fail('GCP clean-room boot proof is not bound to the exact project, zone, candidate, and manifest');
  }
  if (
    !proof.computeRunning ||
    !proof.osLoginReady ||
    proof.publicIpv4Assigned ||
    !proof.terminated ||
    proof.residualResourceIds.length > 0 ||
    !proof.evidenceRef.trim()
  ) {
    fail('GCP clean-room boot must prove private boot, OS Login, confirmed teardown, and zero residue');
  }
  if (
    !expectedAttestation ||
    proof.attestation.hostModel !== (artifact.hostModel ?? 'ubuntu-release-bundle') ||
    proof.attestation.status !== 'healthy' ||
    !proof.attestation.release.signatureVerified ||
    proof.attestation.release.version !== artifact.image.version ||
    proof.attestation.migration.applied !== true ||
    proof.attestation.migration.id !== expectedAttestation.migration.id ||
    proof.attestation.service.active !== true
  ) {
    fail('GCP clean-room attestation must prove the exact signed release, migration, and healthy service');
  }
  if (proof.attestation.hostModel === 'bootc-image') {
    if (
      artifact.hostModel !== 'bootc-image' ||
      proof.attestation.bootcBaseImage !== artifact.bootc.baseImage ||
      proof.attestation.release.source !== workspaceHostBootcPinnedImageRef(artifact.bootc) ||
      proof.attestation.release.imageDigest !== artifact.bootc.imageDigest ||
      proof.attestation.release.signaturePolicyPath !== artifact.bootc.signaturePolicyPath
    ) {
      fail('GCP clean-room attestation must prove the exact bootc image identity and signature policy');
    }
  } else if (
    proof.attestation.release.bundleSha256 !== artifact.release.bundleSha256 ||
    proof.attestation.release.signingKeySha256 !== artifact.release.signingKeySha256
  ) {
    fail('GCP clean-room attestation must prove the exact signed bundle identity');
  }
  requireTimestamp(proof.observedAt, 'cleanBootProof.observedAt');
}

function samePin(left: GcpImageFamilyPin, right: GcpImageFamilyPin): boolean {
  return (
    left.projectId === right.projectId &&
    left.family === right.family &&
    left.imageId === right.imageId &&
    left.version === right.version
  );
}

function validateResolvedPin(
  resolved: GcpImageFamilyPin,
  expected: GcpImageFamilyPin,
  projectId: string,
  family: string,
): GcpImageFamilyPin {
  const normalized = normalizePin(resolved, 'resolvedFamily', projectId, family);
  if (!samePin(normalized, expected)) {
    fail(`GCP family ${projectId}/${family} did not resolve to the expected immutable image ${expected.imageId}`);
  }
  return normalized;
}

/**
 * Build and test a quarantined candidate, then make it family-discoverable.
 * The irreversible family mutation is deliberately after scan, inspection,
 * exact boot attestation, migration proof, and teardown.
 */
export async function executeGcpImageFamilyRelease(
  request: GcpImageFamilyReleaseRequest,
  adapter: GcpImageFamilyReleaseAdapter,
  execution: GcpImageFamilyReleaseExecutionOptions = {},
): Promise<GcpImageFamilyReleaseResult> {
  const gate = evaluateWorkspaceHostReleaseGate(request.releaseGate);
  if (!gate.accepted) {
    fail(`workspace-host release gate rejected: ${gate.failures.map((item) => item.message).join('; ')}`);
  }
  if (request.releaseGate.compatibilityRequest.provider !== 'gcp') {
    fail('GCP image-family publication requires a GCP compatibility verdict');
  }

  const projectId = requireProjectId(request.projectId, 'projectId');
  const family = requireResourceName(request.family, 'family');
  requireTimestamp(request.publishedAt, 'publishedAt');
  const artifact = request.releaseGate.artifact;
  if (artifact.lifecycle.state !== 'active' || artifact.lifecycle.publishedAt !== request.publishedAt) {
    fail('GCP image-family publication requires an active artifact whose publishedAt matches the request');
  }
  const artifactImage = parseGcpImmutableImageId(artifact.image.id, 'releaseGate.artifact.image.id');
  if (artifactImage.projectId !== projectId) fail('artifact image project must match projectId');
  const gcpTarget = artifact.buildManifest.targets.find((target) => target.provider === 'gcp');
  if (!gcpTarget) fail('canonical build manifest does not contain a GCP target');
  if (gcpTarget.locations.length > 0 && !gcpTarget.locations.includes(projectId)) {
    fail(`GCP project ${projectId} is absent from the canonical build manifest`);
  }

  // Production adapters need the complete artifact to construct the exact clean-room fixture.
  // Keep this optional so the pure contract fakes (and any external adapter implementation) do
  // not have to carry context they never use.
  await adapter.bindReleaseContext?.({ request, artifact });

  const previous = request.previousVersion
    ? normalizePin(request.previousVersion, 'previousVersion', projectId, family)
    : undefined;
  if (previous?.imageId === artifactImage.imageId) fail('previousVersion must differ from the candidate version');
  const retired = (request.retireVersions ?? []).map((pin, index) =>
    normalizePin(pin, `retireVersions[${index}]`, projectId, family),
  );
  if (new Set(retired.map((pin) => pin.imageId)).size !== retired.length) {
    fail('retireVersions must not contain duplicate image ids');
  }
  if (retired.some((pin) => pin.imageId === artifactImage.imageId || pin.imageId === previous?.imageId)) {
    fail('retireVersions cannot include the new active image or its immediate rollback target');
  }

  const candidateImageId = execution.candidateImageId
    ? assertGcpImmutableImageId(execution.candidateImageId, 'candidateImageId')
    : undefined;
  const resumePhase = execution.resumePhase;
  if (resumePhase !== undefined && resumePhase !== 'scan' && resumePhase !== 'publish') {
    fail('resumePhase must be scan or publish');
  }
  if (candidateImageId === undefined && resumePhase !== undefined) {
    fail('resumePhase requires candidateImageId');
  }
  if (candidateImageId !== undefined && resumePhase === undefined) {
    fail('candidateImageId requires an explicit resumePhase');
  }
  if (candidateImageId) {
    const candidateCoordinates = parseGcpImmutableImageId(candidateImageId, 'candidateImageId');
    const expectedCandidateName = candidateName(artifactImage.imageName);
    if (candidateCoordinates.projectId !== projectId || candidateCoordinates.imageName !== expectedCandidateName) {
      fail(`candidateImageId must be the immutable ${projectId}/${expectedCandidateName} candidate`);
    }
  }

  const built = await adapter.buildCandidate({
    projectId,
    candidateImageName: candidateName(artifactImage.imageName),
    ...(candidateImageId ? { candidateImageId } : {}),
    ...(resumePhase ? { resumePhase } : {}),
    builderKind: artifact.buildManifest.builder.kind,
    templatePath: artifact.buildManifest.builder.templatePath,
    ...(artifact.buildManifest.builder.kind === WORKSPACE_HOST_BOOTC_BUILDER_KIND
      ? {
          bootcArtifact: workspaceHostBootcCloudArtifact(
            request.releaseGate.bootcBakeManifest!,
            'gcp',
          ),
        }
      : {}),
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
    architecture: artifact.buildManifest.baseImage.architecture,
    requiredGuestTools: GCP_IMAGE_FAMILY_REQUIRED_GUEST_TOOLS,
  });
  const candidate = parseGcpImmutableImageId(built.imageId, 'buildCandidate.imageId');
  if (candidate.projectId !== projectId || candidate.imageId === artifactImage.imageId) {
    fail('buildCandidate must return a distinct immutable image in the publication project');
  }
  const scan = await adapter.scanImage({
    projectId,
    subnetwork: request.cleanRoom.subnetwork,
    imageId: candidate.imageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
  });
  validateScan(scan, artifact, candidate.imageId);
  validateInspection(await adapter.inspectImage(projectId, candidate.imageId), artifact, candidate.imageId, undefined);

  const cleanBootProof = await adapter.launchCleanRoomCanary({
    projectId,
    ...request.cleanRoom,
    imageId: candidate.imageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
  });
  validateCleanBootProof(cleanBootProof, request, artifact, candidate.imageId);

  const published = await adapter.publishFamilyVersion({
    projectId,
    family,
    imageName: artifactImage.imageName,
    sourceCandidateImageId: candidate.imageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
  });
  const active = normalizePin(published, 'publishFamilyVersion', projectId, family);
  if (
    active.imageId !== artifactImage.imageId ||
    active.version !== artifact.image.version ||
    published.sourceCandidateImageId !== candidate.imageId
  ) {
    fail('published family receipt is not bound to the exact artifact and green candidate');
  }
  validateInspection(
    await adapter.inspectImage(projectId, active.imageId),
    artifact,
    active.imageId,
    family,
    candidate.imageId,
  );
  validateResolvedPin(await adapter.resolveFamily(projectId, family), active, projectId, family);

  for (const pin of retired) {
    const inspection = await adapter.inspectImage(projectId, pin.imageId);
    if (inspection.imageId !== pin.imageId || inspection.family !== family || inspection.state !== 'ACTIVE') {
      fail(`retireVersions image ${pin.imageId} is not an active member of family ${family}`);
    }
    await adapter.deprecateImage({
      projectId,
      imageId: pin.imageId,
      replacementImageId: active.imageId,
      state: 'DEPRECATED',
    });
  }

  return {
    contractVersion: GCP_IMAGE_FAMILY_RELEASE_CONTRACT_VERSION,
    releaseGate: gate,
    candidateImageId: candidate.imageId,
    scan,
    cleanBootProof,
    active,
    ...(previous ? { rollbackTarget: previous } : {}),
    retired,
  };
}

/**
 * Roll back a family without mutating the previous image. GCP deprecation is
 * irreversible, so the target must still be ACTIVE; deprecating the current
 * member makes the family resolve to that already-green predecessor while
 * exact references to the deprecated image continue to boot.
 */
export async function rollbackGcpImageFamily(
  request: GcpImageFamilyRollbackRequest,
  adapter: GcpImageFamilyReleaseAdapter,
): Promise<GcpImageFamilyRollbackResult> {
  const projectId = requireProjectId(request.projectId, 'projectId');
  const family = requireResourceName(request.family, 'family');
  const current = normalizePin(request.current, 'current', projectId, family);
  const rollbackTarget = normalizePin(request.rollbackTarget, 'rollbackTarget', projectId, family);
  if (current.imageId === rollbackTarget.imageId) fail('rollbackTarget must differ from current');

  validateResolvedPin(await adapter.resolveFamily(projectId, family), current, projectId, family);
  for (const [path, pin] of [
    ['current', current],
    ['rollbackTarget', rollbackTarget],
  ] as const) {
    const inspection = await adapter.inspectImage(projectId, pin.imageId);
    if (inspection.imageId !== pin.imageId || inspection.family !== family || inspection.state !== 'ACTIVE') {
      fail(`${path} must be an ACTIVE member of family ${family}`);
    }
  }
  await adapter.deprecateImage({
    projectId,
    imageId: current.imageId,
    replacementImageId: rollbackTarget.imageId,
    state: 'DEPRECATED',
  });
  const active = validateResolvedPin(await adapter.resolveFamily(projectId, family), rollbackTarget, projectId, family);
  return { active, deprecated: current };
}

// Keep the production composition discoverable from the contract module while allowing the
// implementation to live in its own file (and to depend on this module's types/constants).
export {
  GoogleComputeGcpImageFamilyReleaseAdapter,
  createGcpImageFamilyReleaseAdapter,
  NodeGcpImageFamilyCommandRunner,
  CommandGcpImageFamilyScanRunner,
  CommandGcpImageFamilyCleanRoomRunner,
  GoogleComputeGcpImageFamilyComputeApi,
  type GcpImageFamilyCommand,
  type GcpImageFamilyReleaseAdapterOptions,
  type GcpImageFamilyCommandResult,
  type GcpImageFamilyCommandRunner,
  type GcpImageFamilyComputeApi,
  type GcpImageFamilyComputeApiOptions,
  type GcpImageFamilyComputeImage,
  type GcpImageFamilyComputeImageInsert,
  type GcpImageFamilyComputeOperation,
  type GcpImageFamilyScanRunner,
  type GcpImageFamilyCleanRoomRunner,
  type GcpImageFamilyCleanRoomRunInput,
  type GcpImageFamilyCleanRoomRunResult,
} from './gcp-image-family-adapter';
