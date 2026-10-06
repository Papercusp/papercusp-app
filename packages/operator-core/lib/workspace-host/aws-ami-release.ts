import { createHash } from 'node:crypto';

import { canonicalize } from '@papercusp/publish-auth/jcs';
import {
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  buildWorkspaceHostCleanRoomInstallFixture,
  validateWorkspaceHostBootstrapAttestation,
  type WorkspaceHostBootstrapAttestation,
  type WorkspaceHostBuilderKind,
  type WorkspaceHostCleanRoomInstallFixture,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';

import { AWS_IMAGE_SCAN_POLICY, evaluateImageScanPolicy } from './image-scan-policy';
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

export const AWS_AMI_RELEASE_CONTRACT_VERSION = 'papercusp-aws-ami-release-v1';
export const AWS_AMI_VERSION_MANIFEST_SCHEMA_VERSION = 1;

/** Every released AMI is named `<prefix><release version>`. */
export const AWS_AMI_NAME_PREFIX = 'papercusp-workspace-host-';

/**
 * AWS accounts whose shared AMIs a customer image catalog treats as Papercusp releases.
 *
 * A shared AMI carries no tags across accounts, and ANY account can share an AMI whose Name and
 * Description imitate a release, so the owner account is the only trust anchor a consumer has.
 * This is the AWS counterpart of the GCP catalog's single pinned image project
 * (aws-byoc-gcp-parity-2026-10-01#D-005).
 */
export const AWS_WORKSPACE_HOST_AMI_PUBLISHER_ACCOUNT_IDS: readonly string[] = ['413781344298'];

const AWS_AMI_DESCRIPTION_PATTERN = /^papercusp-workspace-host (\S+) release-sha256:([a-f0-9]{64})$/;

/**
 * The release provenance an AMI carries in its Description.
 *
 * AWS does not share user-defined AMI tags with the accounts an AMI is shared with, so a
 * customer account sees only the Name, Description, owner and architecture of a published
 * AMI. The release digest therefore has to live in the Description for the customer's image
 * catalog to recognise a signed release. EC2 caps a Description at 255 characters.
 */
export function awsAmiReleaseDescription(releaseVersion: string, releaseSha256: string): string {
  const description = `papercusp-workspace-host ${releaseVersion} release-sha256:${releaseSha256}`;
  if (!AWS_AMI_DESCRIPTION_PATTERN.test(description) || description.length > 255) {
    throw new AwsAmiReleaseError('AMI release description must be one version token and a SHA-256 digest within 255 characters');
  }
  return description;
}

/** Parse the release provenance written by `awsAmiReleaseDescription`; undefined for anything else. */
export function parseAwsAmiReleaseDescription(
  description: string | undefined,
): { releaseVersion: string; releaseSha256: string } | undefined {
  const match = description ? AWS_AMI_DESCRIPTION_PATTERN.exec(description) : null;
  return match ? { releaseVersion: match[1]!, releaseSha256: match[2]! } : undefined;
}

/**
 * Host prerequisites from the common bootstrap contract plus AWS transport, named by the
 * RPM the CentOS Stream 10 bootc image (infra/images/bootc/workspace-host.Containerfile)
 * actually installs. These are package names, so each one can be checked with `rpm -q`
 * against the baked image (WI-10005605). The Ubuntu-era names did not exist on that image:
 * ufw maps to nftables and unattended-upgrades to dnf-automatic (RPM-EQUIVALENCE.md), and
 * the AWS agent package is amazon-ssm-agent. The connection profile's `aws-ssm-agent`
 * requirement id is a separate capability id, not a package name.
 */
export const AWS_AMI_REQUIRED_GUEST_TOOLS = [
  'acl',
  'amazon-ssm-agent',
  'ca-certificates',
  'curl',
  'dnf-automatic',
  'jq',
  'minisign',
  'nftables',
  'openssh-server',
] as const;

export interface AwsAmiRegionTarget {
  region: string;
  kmsKeyArn: string;
  /** Exact AWS accounts allowed to launch the AMI and create volumes from its snapshots. */
  shareWithAccountIds: readonly string[];
}

export interface AwsAmiPin {
  region: string;
  imageId: string;
  version: string;
}

export interface AwsAmiReleaseRequest {
  releaseGate: WorkspaceHostReleaseGateInput;
  publisherAccountId: string;
  sourceRegion: string;
  targets: readonly AwsAmiRegionTarget[];
  previousPins?: readonly AwsAmiPin[];
  cleanAccount: {
    accountId: string;
    region: string;
    subnetId: string;
    instanceProfileArn: string;
  };
  publishedAt: string;
  /** AWS requires a future timestamp when image deprecation is enabled. */
  deprecatePreviousAt: string;
  /**
   * WI-10006386: the installed version of every AWS_AMI_REQUIRED_GUEST_TOOLS entry, as the rpm
   * database in the bake's syft SBOM records it. bootc-image-release-request-cli derives it from
   * the same SBOM the trust report binds; nothing hand-maintains it. When absent, the adapter needs
   * the operator's `--guest-tool-versions-file`; when both exist they must agree.
   */
  guestToolVersions?: Readonly<Record<string, string>>;
}

export interface AwsAmiSnapshotEvidence {
  snapshotId: string;
  encrypted: boolean;
  kmsKeyArn: string;
  createVolumeAccountIds: readonly string[];
}

export interface AwsAmiInspection {
  imageId: string;
  region: string;
  ownerAccountId: string;
  state: 'available' | 'pending' | 'failed' | 'deregistered';
  architecture: string;
  tags: Readonly<Record<string, string>>;
  guestTools: readonly { name: string; version: string }[];
  launchAccountIds: readonly string[];
  snapshots: readonly AwsAmiSnapshotEvidence[];
}

export interface AwsAmiScanEvidence {
  imageId: string;
  region: string;
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
   * Coverage measured by the provider scanner. The release policy requires both
   * fields so an AMI whose root filesystem was never mounted cannot read as clean.
   */
  mountedFilesystems: number;
  candidateRootProof: string;
  /**
   * D-204 scope attribution, the same fields the GCP evidence carries (gcp-image-family.ts).
   * AWS_IMAGE_SCAN_POLICY judges the 'papercusp-bundled' scope (WI-10006421), so the release
   * gate denies with `scope-attribution-missing` when any of the four maps is absent, and the
   * bundled secret list is what the committed allowances are matched against. Optional in the
   * type only because the gate, not the type, is where absence must be refused.
   */
  vulnerabilityByScope?: Readonly<Record<string, number>>;
  vulnerabilityCriticalHighByScope?: Readonly<Record<string, number>>;
  bundleCatalogedArtifacts?: number;
  secretsByScope?: Readonly<Record<string, number>>;
  secretBundledSample?: readonly unknown[];
  secretBundledSampleComplete?: boolean;
  evidenceRef: string;
}

export interface AwsAmiCleanAccountLaunchProof {
  evidenceRef: string;
  accountId: string;
  region: string;
  imageId: string;
  buildManifestIdentity: string;
  releaseVersion: string;
  releaseSha256: string;
  ssmOnline: boolean;
  bootstrapAttestationHealthy: boolean;
  serviceHealthy: boolean;
  publicIpv4Assigned: boolean;
  terminated: boolean;
  residualResourceIds: readonly string[];
  observedAt: string;
  /** The fixture the canary executed; must equal the one the release built (WI-10005604). */
  fixtureId: string;
  /**
   * The host's own bootstrap attestation, printed by the fixture's script and read back over
   * SSM. `bootstrapAttestationHealthy` is only believed when this validates against the
   * release fixture's bootstrapInput, the same rule the GCP clean-room proof follows.
   */
  attestation: WorkspaceHostBootstrapAttestation;
}

export interface AwsAmiPublishedRegion {
  region: string;
  imageId: string;
  snapshotIds: readonly string[];
  kmsKeyArn: string;
  launchAccountIds: readonly string[];
}

export interface AwsAmiVersionManifestPayload {
  schemaVersion: typeof AWS_AMI_VERSION_MANIFEST_SCHEMA_VERSION;
  contractVersion: typeof AWS_AMI_RELEASE_CONTRACT_VERSION;
  releaseVersion: string;
  releaseSha256: string;
  buildManifestIdentity: string;
  architecture: string;
  sourceRegion: string;
  publishedAt: string;
  requiredGuestTools: readonly string[];
  regions: readonly AwsAmiPublishedRegion[];
  rollbackPins: readonly AwsAmiPin[];
  cleanAccountProof: AwsAmiCleanAccountLaunchProof;
}

export interface AwsAmiVersionManifest extends AwsAmiVersionManifestPayload {
  /** SHA-256 over RFC 8785 canonical JSON of the normalized payload. */
  manifestIdentity: `sha256:${string}`;
}

export interface AwsAmiReleaseAdapter {
  buildCandidate(input: {
    sourceRegion: string;
    imageName: string;
    /** Cross-account-visible release provenance (see `awsAmiReleaseDescription`). */
    description: string;
    /** The source region's target key: the candidate must already be encrypted with it. */
    kmsKeyArn: string;
    builderKind: WorkspaceHostBuilderKind;
    templatePath: string;
    /** Present exactly for bootc builds: the already-rendered AMI disk to import. */
    bootcArtifact?: WorkspaceHostBootcCloudArtifact;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
    architecture: string;
    requiredGuestTools: readonly string[];
    tags: Readonly<Record<string, string>>;
  }): Promise<{ imageId: string }>;
  scanImage(input: {
    region: string;
    imageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
  }): Promise<AwsAmiScanEvidence>;
  copyImage(input: {
    sourceRegion: string;
    sourceImageId: string;
    targetRegion: string;
    imageName: string;
    description: string;
    encrypted: true;
    kmsKeyArn: string;
    tags: Readonly<Record<string, string>>;
  }): Promise<{ imageId: string }>;
  publishPermissions(input: {
    region: string;
    imageId: string;
    launchAccountIds: readonly string[];
    snapshotCreateVolumeAccountIds: readonly string[];
  }): Promise<void>;
  inspectImage(region: string, imageId: string): Promise<AwsAmiInspection>;
  launchCleanAccountCanary(input: {
    accountId: string;
    region: string;
    subnetId: string;
    instanceProfileArn: string;
    imageId: string;
    releaseVersion: string;
    releaseSha256: string;
    buildManifestIdentity: string;
    /** Canonical clean-room install fixture; the canary runs its bootstrapScript over SSM. */
    fixture: WorkspaceHostCleanRoomInstallFixture;
  }): Promise<AwsAmiCleanAccountLaunchProof>;
  publishVersionManifest(manifest: AwsAmiVersionManifest): Promise<{
    uri: string;
    manifestIdentity: string;
  }>;
  activatePins(input: {
    manifestUri: string;
    manifestIdentity: string;
    pins: readonly AwsAmiPin[];
    rollbackPins: readonly AwsAmiPin[];
  }): Promise<void>;
  enableImageDeprecation(input: {
    region: string;
    imageId: string;
    deprecateAt: string;
    successorImageId: string;
  }): Promise<void>;
}

export interface AwsAmiReleaseResult {
  releaseGate: WorkspaceHostReleaseGateVerdict;
  sourceScan: AwsAmiScanEvidence;
  manifest: AwsAmiVersionManifest;
  manifestUri: string;
  activePins: readonly AwsAmiPin[];
  rollbackPins: readonly AwsAmiPin[];
  deprecatedPins: readonly AwsAmiPin[];
}

export class AwsAmiReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AwsAmiReleaseError';
  }
}

const ACCOUNT_ID = /^\d{12}$/;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const AMI_ID = /^ami-[a-z0-9]+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new AwsAmiReleaseError(message);
}

function requireText(value: string, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value.trim();
}

function requireAccountId(value: string, path: string): string {
  if (!ACCOUNT_ID.test(value)) fail(`${path} must be a 12-digit AWS account id`);
  return value;
}

function requireRegion(value: string, path: string): string {
  if (!REGION.test(value)) fail(`${path} must be an AWS region`);
  return value;
}

function requireAmiId(value: string, path: string): string {
  if (!AMI_ID.test(value)) fail(`${path} must be an immutable AMI id`);
  return value;
}

function requireTimestamp(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${path} must be an ISO timestamp`);
  return parsed;
}

function sortedUnique(values: readonly string[], path: string): string[] {
  const normalized = values.map((value, index) => requireText(value, `${path}[${index}]`)).sort();
  if (new Set(normalized).size !== normalized.length) fail(`${path} must not contain duplicates`);
  return normalized;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function tagsFor(artifact: WorkspaceHostImageArtifact): Readonly<Record<string, string>> {
  return {
    Name: `papercusp-workspace-host-${artifact.image.version}`,
    'papercusp:build-manifest': artifact.buildManifest.manifestIdentity,
    'papercusp:image-version': artifact.image.version,
    'papercusp:managed': 'true',
    'papercusp:release-sha256': workspaceHostReleaseSubjectSha256(artifact),
  };
}

function normalizeTargets(targets: readonly AwsAmiRegionTarget[]): AwsAmiRegionTarget[] {
  if (targets.length === 0) fail('targets must contain at least one AWS region');
  const normalized = targets.map((target, index) => {
    const region = requireRegion(target.region, `targets[${index}].region`);
    const kmsKeyArn = requireText(target.kmsKeyArn, `targets[${index}].kmsKeyArn`);
    if (!kmsKeyArn.includes(`:kms:${region}:`) || !kmsKeyArn.includes(':key/')) {
      fail(`targets[${index}].kmsKeyArn must be a customer-managed KMS key in ${region}`);
    }
    const shareWithAccountIds = sortedUnique(
      target.shareWithAccountIds.map((accountId, accountIndex) =>
        requireAccountId(accountId, `targets[${index}].shareWithAccountIds[${accountIndex}]`),
      ),
      `targets[${index}].shareWithAccountIds`,
    );
    return { region, kmsKeyArn, shareWithAccountIds };
  });
  if (new Set(normalized.map((target) => target.region)).size !== normalized.length) {
    fail('targets must contain one policy per region');
  }
  return normalized.sort((left, right) => left.region.localeCompare(right.region));
}

function normalizePins(pins: readonly AwsAmiPin[] | undefined, path: string): AwsAmiPin[] {
  const normalized = (pins ?? []).map((pin, index) => ({
    region: requireRegion(pin.region, `${path}[${index}].region`),
    imageId: requireAmiId(pin.imageId, `${path}[${index}].imageId`),
    version: requireText(pin.version, `${path}[${index}].version`),
  }));
  if (new Set(normalized.map((pin) => pin.region)).size !== normalized.length) {
    fail(`${path} must contain at most one pin per region`);
  }
  return normalized.sort((left, right) => left.region.localeCompare(right.region));
}

export function buildAwsAmiVersionManifest(
  input: Omit<AwsAmiVersionManifestPayload, 'schemaVersion' | 'contractVersion'>,
): AwsAmiVersionManifest {
  const regions = [...input.regions]
    .map((region, index) => ({
      region: requireRegion(region.region, `regions[${index}].region`),
      imageId: requireAmiId(region.imageId, `regions[${index}].imageId`),
      snapshotIds: sortedUnique(region.snapshotIds, `regions[${index}].snapshotIds`),
      kmsKeyArn: requireText(region.kmsKeyArn, `regions[${index}].kmsKeyArn`),
      launchAccountIds: sortedUnique(region.launchAccountIds, `regions[${index}].launchAccountIds`),
    }))
    .sort((left, right) => left.region.localeCompare(right.region));
  if (new Set(regions.map((region) => region.region)).size !== regions.length) {
    fail('regions must contain one immutable AMI per region');
  }
  const payload: AwsAmiVersionManifestPayload = {
    schemaVersion: AWS_AMI_VERSION_MANIFEST_SCHEMA_VERSION,
    contractVersion: AWS_AMI_RELEASE_CONTRACT_VERSION,
    releaseVersion: requireText(input.releaseVersion, 'releaseVersion'),
    releaseSha256: input.releaseSha256,
    buildManifestIdentity: input.buildManifestIdentity,
    architecture: requireText(input.architecture, 'architecture'),
    sourceRegion: requireRegion(input.sourceRegion, 'sourceRegion'),
    publishedAt: input.publishedAt,
    requiredGuestTools: sortedUnique(input.requiredGuestTools, 'requiredGuestTools'),
    regions,
    rollbackPins: normalizePins(input.rollbackPins, 'rollbackPins'),
    cleanAccountProof: input.cleanAccountProof,
  };
  if (!SHA256.test(payload.releaseSha256)) fail('releaseSha256 must be a lowercase SHA-256 digest');
  if (!/^sha256:[a-f0-9]{64}$/.test(payload.buildManifestIdentity)) {
    fail('buildManifestIdentity must be a canonical sha256 identity');
  }
  requireTimestamp(payload.publishedAt, 'publishedAt');
  const digest = createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
  return { ...payload, manifestIdentity: `sha256:${digest}` };
}

function validateScan(
  scan: AwsAmiScanEvidence,
  artifact: WorkspaceHostImageArtifact,
  sourceRegion: string,
  imageId: string,
): void {
  if (
    scan.imageId !== imageId ||
    scan.region !== sourceRegion ||
    scan.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    scan.releaseSha256 !== workspaceHostReleaseSubjectSha256(artifact)
  ) {
    fail('AMI scan evidence is not bound to the exact source AMI, build manifest, and release digest');
  }
  if (!scan.trusted) {
    fail('AMI scan must be trusted');
  }
  // AWS uses its provider-scoped policy: the scanner must prove it mounted the
  // candidate's OS root before any findings can be treated as release evidence.
  const scanPolicy = evaluateImageScanPolicy(scan, AWS_IMAGE_SCAN_POLICY);
  if (!scanPolicy.accepted) {
    fail(
      `AMI scan violates the workspace-host release policy: ${scanPolicy.failures
        .map((failure) => failure.message)
        .join('; ')}`,
    );
  }
  if (!SHA256.test(scan.sbomSha256) || !scan.evidenceRef.trim()) {
    fail('AMI scan must carry an immutable SBOM digest and evidence reference');
  }
}

function validateInspection(
  inspection: AwsAmiInspection,
  artifact: WorkspaceHostImageArtifact,
  target: AwsAmiRegionTarget,
  publisherAccountId: string,
  expectedImageId: string,
): AwsAmiPublishedRegion {
  if (
    inspection.imageId !== expectedImageId ||
    inspection.region !== target.region ||
    inspection.ownerAccountId !== publisherAccountId ||
    inspection.state !== 'available' ||
    inspection.architecture !== artifact.buildManifest.baseImage.architecture
  ) {
    fail(
      `AMI ${target.region}/${expectedImageId} is not an available publisher-owned image with the expected architecture`,
    );
  }
  const expectedTags = tagsFor(artifact);
  for (const [key, value] of Object.entries(expectedTags)) {
    if (inspection.tags[key] !== value) fail(`AMI ${target.region}/${expectedImageId} is missing exact tag ${key}`);
  }
  const installed = new Map(inspection.guestTools.map((tool) => [tool.name, tool.version]));
  for (const tool of AWS_AMI_REQUIRED_GUEST_TOOLS) {
    if (!installed.get(tool)?.trim()) fail(`AMI ${target.region}/${expectedImageId} is missing guest tool ${tool}`);
  }
  if (!sameStrings(inspection.launchAccountIds, target.shareWithAccountIds)) {
    fail(`AMI ${target.region}/${expectedImageId} launch permissions do not match the explicit account allowlist`);
  }
  if (inspection.snapshots.length === 0) fail(`AMI ${target.region}/${expectedImageId} has no backing snapshots`);
  for (const snapshot of inspection.snapshots) {
    if (!snapshot.encrypted || snapshot.kmsKeyArn !== target.kmsKeyArn) {
      fail(
        `AMI ${target.region}/${expectedImageId} snapshot ${snapshot.snapshotId} is not encrypted with the target KMS key`,
      );
    }
    if (!sameStrings(snapshot.createVolumeAccountIds, target.shareWithAccountIds)) {
      fail(
        `AMI ${target.region}/${expectedImageId} snapshot ${snapshot.snapshotId} permissions do not match the explicit account allowlist`,
      );
    }
  }
  return {
    region: target.region,
    imageId: expectedImageId,
    snapshotIds: inspection.snapshots.map((snapshot) => snapshot.snapshotId).sort(),
    kmsKeyArn: target.kmsKeyArn,
    launchAccountIds: [...target.shareWithAccountIds],
  };
}

/**
 * The canonical clean-room install fixture for the AWS clean-account canary — built from the
 * release gate's own clean-room attestation exactly as the GCP image-family adapter does, so
 * the AMI is proven to run the SAME bootstrap the gate accepted (WI-10005604). Deterministic:
 * observedAt is the release's publishedAt, never the wall clock.
 */
export function awsCleanAccountFixture(
  request: AwsAmiReleaseRequest,
  artifact: WorkspaceHostImageArtifact,
  imageId: string,
): WorkspaceHostCleanRoomInstallFixture {
  const attestation = request.releaseGate.cleanRoomReport.attestation;
  if (!attestation) fail('release gate clean-room attestation is required to build the AWS canary fixture');
  return buildWorkspaceHostCleanRoomInstallFixture(artifact, {
    fixtureId: `aws-ami-${artifact.image.version}-${imageId}`,
    action: 'install',
    provider: 'aws',
    architecture: artifact.buildManifest.baseImage.architecture,
    observedAt: request.publishedAt,
    hostId: `aws-clean-${imageId}`,
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
}

function validateCleanProof(
  proof: AwsAmiCleanAccountLaunchProof,
  request: AwsAmiReleaseRequest,
  artifact: WorkspaceHostImageArtifact,
  imageId: string,
  fixture: WorkspaceHostCleanRoomInstallFixture,
): void {
  if (
    proof.accountId !== request.cleanAccount.accountId ||
    proof.region !== request.cleanAccount.region ||
    proof.imageId !== imageId ||
    proof.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    proof.releaseVersion !== artifact.image.version ||
    proof.releaseSha256 !== workspaceHostReleaseSubjectSha256(artifact)
  ) {
    fail('clean-account launch proof is not bound to the exact account, region, AMI, manifest, and release');
  }
  if (
    !proof.ssmOnline ||
    !proof.bootstrapAttestationHealthy ||
    !proof.serviceHealthy ||
    proof.publicIpv4Assigned ||
    !proof.terminated ||
    proof.residualResourceIds.length > 0 ||
    !proof.evidenceRef.trim()
  ) {
    fail(
      'clean-account launch proof must show SSM/bootstrap/service health, private networking, confirmed teardown, and zero residue',
    );
  }
  requireTimestamp(proof.observedAt, 'cleanAccountProof.observedAt');
  if (proof.fixtureId !== fixture.fixtureId) fail('clean-account launch proof ran a different fixture than the release built');
  if (!proof.attestation || typeof proof.attestation !== 'object' || proof.attestation.status !== 'healthy') {
    fail('clean-account launch proof did not carry a healthy bootstrap attestation');
  }
  const input = fixture.bootstrapInput;
  const validation = validateWorkspaceHostBootstrapAttestation(proof.attestation, {
    contractVersion: input.contractVersion,
    action: input.action,
    hostId: input.hostId,
    release: input.release,
    migrationId: input.migrationId,
    minimumNodeMajor: input.minimumNodeMajor,
    service: input.service,
    workspaceAuthorizedKeys: input.workspaceAuthorizedKeys,
    ...(input.isolation ? { isolation: input.isolation } : {}),
    ...(input.entrypoints ? { entrypoints: input.entrypoints } : {}),
    ...(input.publicMetadata ? { publicMetadata: input.publicMetadata } : {}),
  });
  if (!validation.ok) fail(`clean-account bootstrap attestation failed validation: ${validation.errors.join('; ')}`);
}

/**
 * Execute the AWS adapter of the shared Packer/image contract. Publication is
 * fail-closed: pins and prior-image deprecation happen only after exact scan,
 * encryption/sharing inspection, and a clean-account boot + teardown proof.
 */
export async function executeAwsAmiRelease(
  request: AwsAmiReleaseRequest,
  adapter: AwsAmiReleaseAdapter,
): Promise<AwsAmiReleaseResult> {
  const gate = evaluateWorkspaceHostReleaseGate(request.releaseGate);
  if (!gate.accepted)
    fail(`workspace-host release gate rejected: ${gate.failures.map((item) => item.message).join('; ')}`);

  const artifact = request.releaseGate.artifact;
  if (request.releaseGate.compatibilityRequest.provider !== 'aws') {
    fail('AWS AMI publication requires an AWS compatibility verdict');
  }
  const targets = normalizeTargets(request.targets);
  const sourceRegion = requireRegion(request.sourceRegion, 'sourceRegion');
  const sourceTarget = targets.find((target) => target.region === sourceRegion);
  if (!sourceTarget) fail('sourceRegion must be present in targets');
  const publisherAccountId = requireAccountId(request.publisherAccountId, 'publisherAccountId');
  const cleanAccountId = requireAccountId(request.cleanAccount.accountId, 'cleanAccount.accountId');
  if (cleanAccountId === publisherAccountId) fail('cleanAccount.accountId must differ from publisherAccountId');
  const cleanTarget = targets.find((target) => target.region === request.cleanAccount.region);
  if (!cleanTarget || !cleanTarget.shareWithAccountIds.includes(cleanAccountId)) {
    fail('cleanAccount must select a target region whose explicit share allowlist includes the clean account');
  }
  const publishedAt = requireTimestamp(request.publishedAt, 'publishedAt');
  const deprecateAt = requireTimestamp(request.deprecatePreviousAt, 'deprecatePreviousAt');
  if (deprecateAt <= publishedAt) fail('deprecatePreviousAt must be later than publishedAt');

  const awsTarget = artifact.buildManifest.targets.find((target) => target.provider === 'aws');
  if (!awsTarget) fail('canonical build manifest does not contain an AWS target');
  if (awsTarget.locations.length > 0) {
    const missing = targets.filter((target) => !awsTarget.locations.includes(target.region));
    if (missing.length > 0)
      fail(
        `AWS target regions are absent from the canonical build manifest: ${missing.map((item) => item.region).join(', ')}`,
      );
  }

  const imageName = `${AWS_AMI_NAME_PREFIX}${artifact.image.version}`;
  const description = awsAmiReleaseDescription(artifact.image.version, workspaceHostReleaseSubjectSha256(artifact));
  const tags = tagsFor(artifact);
  const built = await adapter.buildCandidate({
    sourceRegion,
    imageName,
    description,
    kmsKeyArn: sourceTarget.kmsKeyArn,
    builderKind: artifact.buildManifest.builder.kind,
    templatePath: artifact.buildManifest.builder.templatePath,
    ...(artifact.buildManifest.builder.kind === WORKSPACE_HOST_BOOTC_BUILDER_KIND
      ? {
          bootcArtifact: workspaceHostBootcCloudArtifact(
            request.releaseGate.bootcBakeManifest!,
            'aws',
          ),
        }
      : {}),
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
    architecture: artifact.buildManifest.baseImage.architecture,
    requiredGuestTools: AWS_AMI_REQUIRED_GUEST_TOOLS,
    tags,
  });
  requireAmiId(built.imageId, 'buildCandidate.imageId');
  const sourceScan = await adapter.scanImage({
    region: sourceRegion,
    imageId: built.imageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
  });
  validateScan(sourceScan, artifact, sourceRegion, built.imageId);

  const imageIds = new Map<string, string>([[sourceRegion, built.imageId]]);
  for (const target of targets) {
    if (target.region === sourceRegion) continue;
    const copied = await adapter.copyImage({
      sourceRegion,
      sourceImageId: built.imageId,
      targetRegion: target.region,
      imageName,
      description,
      encrypted: true,
      kmsKeyArn: target.kmsKeyArn,
      tags,
    });
    imageIds.set(target.region, requireAmiId(copied.imageId, `copyImage(${target.region}).imageId`));
  }

  const regions: AwsAmiPublishedRegion[] = [];
  for (const target of targets) {
    const imageId = imageIds.get(target.region)!;
    await adapter.publishPermissions({
      region: target.region,
      imageId,
      launchAccountIds: target.shareWithAccountIds,
      snapshotCreateVolumeAccountIds: target.shareWithAccountIds,
    });
    regions.push(
      validateInspection(
        await adapter.inspectImage(target.region, imageId),
        artifact,
        target,
        publisherAccountId,
        imageId,
      ),
    );
  }

  const cleanImageId = imageIds.get(request.cleanAccount.region)!;
  const cleanFixture = awsCleanAccountFixture(request, artifact, cleanImageId);
  const cleanProof = await adapter.launchCleanAccountCanary({
    ...request.cleanAccount,
    imageId: cleanImageId,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    fixture: cleanFixture,
  });
  validateCleanProof(cleanProof, request, artifact, cleanImageId, cleanFixture);

  const activePins = regions.map((region) => ({
    region: region.region,
    imageId: region.imageId,
    version: artifact.image.version,
  }));
  const targetRegions = new Set(targets.map((target) => target.region));
  const rollbackPins = normalizePins(request.previousPins, 'previousPins').filter((pin) =>
    targetRegions.has(pin.region),
  );
  const manifest = buildAwsAmiVersionManifest({
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    architecture: artifact.buildManifest.baseImage.architecture,
    sourceRegion,
    publishedAt: request.publishedAt,
    requiredGuestTools: AWS_AMI_REQUIRED_GUEST_TOOLS,
    regions,
    rollbackPins,
    cleanAccountProof: cleanProof,
  });
  const published = await adapter.publishVersionManifest(manifest);
  if (published.manifestIdentity !== manifest.manifestIdentity || !published.uri.trim()) {
    fail('published version manifest receipt does not match the immutable manifest identity');
  }
  await adapter.activatePins({
    manifestUri: published.uri,
    manifestIdentity: manifest.manifestIdentity,
    pins: activePins,
    rollbackPins,
  });

  const deprecatedPins: AwsAmiPin[] = [];
  for (const previous of rollbackPins) {
    const successor = imageIds.get(previous.region);
    if (!successor || successor === previous.imageId) continue;
    await adapter.enableImageDeprecation({
      region: previous.region,
      imageId: previous.imageId,
      deprecateAt: request.deprecatePreviousAt,
      successorImageId: successor,
    });
    deprecatedPins.push(previous);
  }
  return {
    releaseGate: gate,
    sourceScan,
    manifest,
    manifestUri: published.uri,
    activePins,
    rollbackPins,
    deprecatedPins,
  };
}
