import { createHash } from 'node:crypto';

import { canonicalize } from '@papercusp/publish-auth/jcs';
import {
  WORKSPACE_HOST_BOOTC_BUILDER_KIND,
  type WorkspaceHostBuilderKind,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';

import { AZURE_IMAGE_SCAN_POLICY, evaluateImageScanPolicy } from './image-scan-policy';
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

export const AZURE_COMPUTE_GALLERY_RELEASE_CONTRACT_VERSION = 'papercusp-azure-compute-gallery-release-v1';
export const AZURE_COMPUTE_GALLERY_VERSION_MANIFEST_SCHEMA_VERSION = 1;

/** Common host prerequisites plus the Azure Linux Agent transport. */
export const AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS = [
  'acl',
  'ca-certificates',
  'curl',
  'jq',
  'minisign',
  'openssh-server',
  'ufw',
  'unattended-upgrades',
  'walinuxagent',
] as const;

export type AzureComputeGalleryStorageAccountType = 'Standard_LRS' | 'Standard_ZRS' | 'Premium_LRS';

export interface AzureComputeGalleryRegionTarget {
  region: string;
  replicaCount: number;
  storageAccountType: AzureComputeGalleryStorageAccountType;
}

export interface AzureComputeGalleryReader {
  tenantId: string;
  subscriptionId: string;
}

export interface AzureComputeGalleryVersionPin {
  versionResourceId: string;
  version: string;
  targetRegions: readonly AzureComputeGalleryRegionTarget[];
}

export interface AzureComputeGalleryReleaseRequest {
  releaseGate: WorkspaceHostReleaseGateInput;
  publisherTenantId: string;
  publisherSubscriptionId: string;
  resourceGroup: string;
  galleryName: string;
  imageDefinitionName: string;
  galleryVersion: string;
  sourceRegion: string;
  targets: readonly AzureComputeGalleryRegionTarget[];
  readers: readonly AzureComputeGalleryReader[];
  previousPins?: readonly AzureComputeGalleryVersionPin[];
  cleanAccount: {
    tenantId: string;
    subscriptionId: string;
    region: string;
    resourceGroup: string;
    subnetResourceId: string;
    managedIdentityResourceId: string;
  };
  publishedAt: string;
  /** Azure keeps deprecated versions addressable while excluding them from latest. */
  deprecatePreviousAt: string;
}

export interface AzureComputeGalleryScanEvidence {
  sourceImageId: string;
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
   * fields so an image whose root filesystem was never mounted cannot read as clean.
   */
  mountedFilesystems: number;
  candidateRootProof: string;
  evidenceRef: string;
}

export interface AzureComputeGalleryInspection {
  versionResourceId: string;
  provisioningState: 'Creating' | 'Updating' | 'Succeeded' | 'Failed' | 'Deleting';
  sourceImageId: string;
  architecture: string;
  osType: 'Linux' | 'Windows';
  tags: Readonly<Record<string, string>>;
  guestTools: readonly { name: string; version: string }[];
  targetRegions: readonly AzureComputeGalleryRegionTarget[];
  readerSubscriptionIds: readonly string[];
  excludedFromLatest: boolean;
}

export interface AzureComputeGalleryCleanAccountProof {
  evidenceRef: string;
  tenantId: string;
  subscriptionId: string;
  region: string;
  versionResourceId: string;
  buildManifestIdentity: string;
  releaseVersion: string;
  releaseSha256: string;
  azureAgentOnline: boolean;
  runCommandHealthy: boolean;
  bootstrapAttestationHealthy: boolean;
  serviceHealthy: boolean;
  publicIpv4Assigned: boolean;
  deleted: boolean;
  residualResourceIds: readonly string[];
  observedAt: string;
}

export interface AzureComputeGalleryVersionManifestPayload {
  schemaVersion: typeof AZURE_COMPUTE_GALLERY_VERSION_MANIFEST_SCHEMA_VERSION;
  contractVersion: typeof AZURE_COMPUTE_GALLERY_RELEASE_CONTRACT_VERSION;
  releaseVersion: string;
  galleryVersion: string;
  releaseSha256: string;
  buildManifestIdentity: string;
  architecture: string;
  sourceRegion: string;
  publishedAt: string;
  requiredGuestTools: readonly string[];
  versionResourceId: string;
  targetRegions: readonly AzureComputeGalleryRegionTarget[];
  readerSubscriptionIds: readonly string[];
  rollbackPins: readonly AzureComputeGalleryVersionPin[];
  cleanAccountProof: AzureComputeGalleryCleanAccountProof;
}

export interface AzureComputeGalleryVersionManifest extends AzureComputeGalleryVersionManifestPayload {
  /** SHA-256 over RFC 8785 canonical JSON of the normalized payload. */
  manifestIdentity: `sha256:${string}`;
}

export interface AzureComputeGalleryReleaseAdapter {
  buildCandidate(input: {
    subscriptionId: string;
    resourceGroup: string;
    sourceRegion: string;
    imageName: string;
    builderKind: WorkspaceHostBuilderKind;
    templatePath: string;
    /** Present exactly for bootc builds: the already-rendered fixed VHD to import. */
    bootcArtifact?: WorkspaceHostBootcCloudArtifact;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
    architecture: string;
    requiredGuestTools: readonly string[];
    tags: Readonly<Record<string, string>>;
  }): Promise<{ sourceImageId: string }>;
  scanImage(input: {
    sourceImageId: string;
    buildManifestIdentity: string;
    releaseSha256: string;
  }): Promise<AzureComputeGalleryScanEvidence>;
  ensureImageDefinition(input: {
    subscriptionId: string;
    resourceGroup: string;
    galleryName: string;
    imageDefinitionName: string;
    architecture: string;
    osType: 'Linux';
    hyperVGeneration: 'V2';
    tags: Readonly<Record<string, string>>;
  }): Promise<{ imageDefinitionResourceId: string }>;
  publishImageVersion(input: {
    imageDefinitionResourceId: string;
    version: string;
    sourceImageId: string;
    targetRegions: readonly AzureComputeGalleryRegionTarget[];
    excludeFromLatest: true;
    tags: Readonly<Record<string, string>>;
  }): Promise<{ versionResourceId: string }>;
  grantVersionReadAccess(input: { versionResourceId: string; tenantId: string; subscriptionId: string }): Promise<void>;
  inspectImageVersion(versionResourceId: string): Promise<AzureComputeGalleryInspection>;
  launchCleanAccountCanary(input: {
    tenantId: string;
    subscriptionId: string;
    region: string;
    resourceGroup: string;
    subnetResourceId: string;
    managedIdentityResourceId: string;
    versionResourceId: string;
    buildManifestIdentity: string;
    releaseVersion: string;
    releaseSha256: string;
  }): Promise<AzureComputeGalleryCleanAccountProof>;
  publishVersionManifest(manifest: AzureComputeGalleryVersionManifest): Promise<{
    uri: string;
    manifestIdentity: string;
  }>;
  activateVersionPin(input: {
    manifestUri: string;
    manifestIdentity: string;
    activePin: AzureComputeGalleryVersionPin;
    rollbackPins: readonly AzureComputeGalleryVersionPin[];
  }): Promise<void>;
  deprecateImageVersion(input: {
    versionResourceId: string;
    endOfLifeAt: string;
    excludeFromLatest: true;
    replacementVersionResourceId: string;
  }): Promise<void>;
}

export interface AzureComputeGalleryReleaseResult {
  releaseGate: WorkspaceHostReleaseGateVerdict;
  scan: AzureComputeGalleryScanEvidence;
  manifest: AzureComputeGalleryVersionManifest;
  manifestUri: string;
  activePin: AzureComputeGalleryVersionPin;
  rollbackPins: readonly AzureComputeGalleryVersionPin[];
  deprecatedPins: readonly AzureComputeGalleryVersionPin[];
}

export class AzureComputeGalleryReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AzureComputeGalleryReleaseError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_GROUP = /^[\w.()\-]{1,90}$/;
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const REGION = /^[a-z][a-z0-9-]{1,79}$/;
const GALLERY_VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new AzureComputeGalleryReleaseError(message);
}

function requireText(value: string, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${path} must be a non-empty string`);
  return value.trim();
}

function requireUuid(value: string, path: string): string {
  const normalized = requireText(value, path).toLowerCase();
  if (!UUID.test(normalized)) fail(`${path} must be an Azure UUID`);
  return normalized;
}

function requireResourceGroup(value: string, path: string): string {
  const normalized = requireText(value, path);
  if (!RESOURCE_GROUP.test(normalized) || normalized.endsWith('.'))
    fail(`${path} must be an Azure resource-group name`);
  return normalized;
}

function requireResourceName(value: string, path: string): string {
  const normalized = requireText(value, path);
  if (!RESOURCE_NAME.test(normalized)) fail(`${path} must be an Azure resource name`);
  return normalized;
}

function requireRegion(value: string, path: string): string {
  const normalized = requireText(value, path).toLowerCase();
  if (!REGION.test(normalized)) fail(`${path} must be an Azure region identifier`);
  return normalized;
}

function requireGalleryVersion(value: string, path: string): string {
  const normalized = requireText(value, path);
  if (!GALLERY_VERSION.test(normalized)) fail(`${path} must be an immutable numeric major.minor.patch version`);
  return normalized;
}

function requireTimestamp(value: string, path: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail(`${path} must be an ISO timestamp`);
  return parsed;
}

function requireAzureResourceId(value: string, providerPath: string, path: string): string {
  const normalized = requireText(value, path);
  if (
    !normalized.startsWith('/subscriptions/') ||
    !normalized.toLowerCase().includes(`/providers/${providerPath.toLowerCase()}/`)
  ) {
    fail(`${path} must be an Azure ${providerPath} resource id`);
  }
  return normalized;
}

function imageDefinitionResourceId(request: AzureComputeGalleryReleaseRequest): string {
  return (
    `/subscriptions/${request.publisherSubscriptionId}/resourceGroups/${request.resourceGroup}/providers/` +
    `Microsoft.Compute/galleries/${request.galleryName}/images/${request.imageDefinitionName}`
  );
}

function versionResourceId(request: AzureComputeGalleryReleaseRequest): string {
  return `${imageDefinitionResourceId(request)}/versions/${request.galleryVersion}`;
}

function tagsFor(artifact: WorkspaceHostImageArtifact): Readonly<Record<string, string>> {
  return {
    'papercusp:build-manifest': artifact.buildManifest.manifestIdentity,
    'papercusp:image-version': artifact.image.version,
    'papercusp:managed': 'true',
    'papercusp:release-sha256': workspaceHostReleaseSubjectSha256(artifact),
  };
}

function normalizeTargets(
  targets: readonly AzureComputeGalleryRegionTarget[],
  path = 'targets',
): AzureComputeGalleryRegionTarget[] {
  if (targets.length === 0) fail(`${path} must contain at least one Azure region`);
  const normalized = targets.map((target, index) => {
    const replicaCount = target.replicaCount;
    if (!Number.isInteger(replicaCount) || replicaCount < 1 || replicaCount > 100) {
      fail(`${path}[${index}].replicaCount must be an integer from 1 to 100`);
    }
    if (!['Standard_LRS', 'Standard_ZRS', 'Premium_LRS'].includes(target.storageAccountType)) {
      fail(`${path}[${index}].storageAccountType is unsupported`);
    }
    return {
      region: requireRegion(target.region, `${path}[${index}].region`),
      replicaCount,
      storageAccountType: target.storageAccountType,
    };
  });
  if (new Set(normalized.map((target) => target.region)).size !== normalized.length) {
    fail(`${path} must contain one replication policy per region`);
  }
  return normalized.sort((left, right) => left.region.localeCompare(right.region));
}

function normalizeReaders(readers: readonly AzureComputeGalleryReader[]): AzureComputeGalleryReader[] {
  if (readers.length === 0) fail('readers must contain at least one explicit Azure subscription');
  const normalized = readers.map((reader, index) => ({
    tenantId: requireUuid(reader.tenantId, `readers[${index}].tenantId`),
    subscriptionId: requireUuid(reader.subscriptionId, `readers[${index}].subscriptionId`),
  }));
  if (new Set(normalized.map((reader) => reader.subscriptionId)).size !== normalized.length) {
    fail('readers must not contain duplicate subscriptions');
  }
  return normalized.sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId));
}

function normalizePins(pins: readonly AzureComputeGalleryVersionPin[] | undefined): AzureComputeGalleryVersionPin[] {
  return (pins ?? [])
    .map((pin, index) => ({
      versionResourceId: requireAzureResourceId(
        pin.versionResourceId,
        'Microsoft.Compute/galleries',
        `previousPins[${index}].versionResourceId`,
      ),
      version: requireGalleryVersion(pin.version, `previousPins[${index}].version`),
      targetRegions: normalizeTargets(pin.targetRegions, `previousPins[${index}].targetRegions`),
    }))
    .sort((left, right) => left.version.localeCompare(right.version));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join('\u0000') === [...right].sort().join('\u0000');
}

function sameTargets(
  left: readonly AzureComputeGalleryRegionTarget[],
  right: readonly AzureComputeGalleryRegionTarget[],
): boolean {
  return canonicalize(normalizeTargets(left, 'inspection.targetRegions')) === canonicalize(normalizeTargets(right));
}

export function buildAzureComputeGalleryVersionManifest(
  input: Omit<AzureComputeGalleryVersionManifestPayload, 'schemaVersion' | 'contractVersion'>,
): AzureComputeGalleryVersionManifest {
  const payload: AzureComputeGalleryVersionManifestPayload = {
    schemaVersion: AZURE_COMPUTE_GALLERY_VERSION_MANIFEST_SCHEMA_VERSION,
    contractVersion: AZURE_COMPUTE_GALLERY_RELEASE_CONTRACT_VERSION,
    releaseVersion: requireText(input.releaseVersion, 'releaseVersion'),
    galleryVersion: requireGalleryVersion(input.galleryVersion, 'galleryVersion'),
    releaseSha256: input.releaseSha256,
    buildManifestIdentity: input.buildManifestIdentity,
    architecture: requireText(input.architecture, 'architecture'),
    sourceRegion: requireRegion(input.sourceRegion, 'sourceRegion'),
    publishedAt: input.publishedAt,
    requiredGuestTools: [...input.requiredGuestTools]
      .map((tool, index) => requireText(tool, `requiredGuestTools[${index}]`))
      .sort(),
    versionResourceId: requireAzureResourceId(
      input.versionResourceId,
      'Microsoft.Compute/galleries',
      'versionResourceId',
    ),
    targetRegions: normalizeTargets(input.targetRegions),
    readerSubscriptionIds: input.readerSubscriptionIds
      .map((id, index) => requireUuid(id, `readerSubscriptionIds[${index}]`))
      .sort(),
    rollbackPins: normalizePins(input.rollbackPins),
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
  scan: AzureComputeGalleryScanEvidence,
  artifact: WorkspaceHostImageArtifact,
  sourceImageId: string,
): void {
  if (
    scan.sourceImageId !== sourceImageId ||
    scan.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    scan.releaseSha256 !== workspaceHostReleaseSubjectSha256(artifact)
  ) {
    fail('Azure image scan evidence is not bound to the exact source image, build manifest, and release digest');
  }
  if (!scan.trusted) {
    fail('Azure image scan must be trusted');
  }
  // Azure uses its provider-scoped policy: the scanner must prove it mounted the
  // candidate's OS root before any findings can be treated as release evidence.
  const scanPolicy = evaluateImageScanPolicy(scan, AZURE_IMAGE_SCAN_POLICY);
  if (!scanPolicy.accepted) {
    fail(
      `Azure image scan violates the workspace-host release policy: ${scanPolicy.failures
        .map((failure) => failure.message)
        .join('; ')}`,
    );
  }
  if (!SHA256.test(scan.sbomSha256) || !scan.evidenceRef.trim()) {
    fail('Azure image scan must carry an immutable SBOM digest and evidence reference');
  }
}

function validateInspection(
  inspection: AzureComputeGalleryInspection,
  request: AzureComputeGalleryReleaseRequest,
  artifact: WorkspaceHostImageArtifact,
  sourceImageId: string,
  targets: readonly AzureComputeGalleryRegionTarget[],
  readers: readonly AzureComputeGalleryReader[],
): void {
  if (
    inspection.versionResourceId !== versionResourceId(request) ||
    inspection.provisioningState !== 'Succeeded' ||
    inspection.sourceImageId !== sourceImageId ||
    inspection.architecture !== artifact.buildManifest.baseImage.architecture ||
    inspection.osType !== 'Linux' ||
    !inspection.excludedFromLatest
  ) {
    fail('Azure gallery version is not the exact green, excluded-from-latest Linux candidate');
  }
  const expectedTags = tagsFor(artifact);
  for (const [key, value] of Object.entries(expectedTags)) {
    if (inspection.tags[key] !== value) fail(`Azure gallery version is missing exact tag ${key}`);
  }
  const installed = new Map(inspection.guestTools.map((tool) => [tool.name, tool.version]));
  for (const tool of AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS) {
    if (!installed.get(tool)?.trim()) fail(`Azure gallery version is missing guest tool ${tool}`);
  }
  if (!sameTargets(inspection.targetRegions, targets)) {
    fail('Azure gallery target regions, replica counts, or storage policies do not match the release request');
  }
  if (
    !sameStrings(
      inspection.readerSubscriptionIds,
      readers.map((reader) => reader.subscriptionId),
    )
  ) {
    fail('Azure gallery reader access does not match the explicit subscription allowlist');
  }
}

function validateCleanProof(
  proof: AzureComputeGalleryCleanAccountProof,
  request: AzureComputeGalleryReleaseRequest,
  artifact: WorkspaceHostImageArtifact,
): void {
  if (
    proof.tenantId !== request.cleanAccount.tenantId ||
    proof.subscriptionId !== request.cleanAccount.subscriptionId ||
    proof.region !== request.cleanAccount.region ||
    proof.versionResourceId !== versionResourceId(request) ||
    proof.buildManifestIdentity !== artifact.buildManifest.manifestIdentity ||
    proof.releaseVersion !== artifact.image.version ||
    proof.releaseSha256 !== workspaceHostReleaseSubjectSha256(artifact)
  ) {
    fail(
      'clean-subscription proof is not bound to the exact tenant, subscription, region, gallery version, manifest, and release',
    );
  }
  if (
    !proof.azureAgentOnline ||
    !proof.runCommandHealthy ||
    !proof.bootstrapAttestationHealthy ||
    !proof.serviceHealthy ||
    proof.publicIpv4Assigned ||
    !proof.deleted ||
    proof.residualResourceIds.length > 0 ||
    !proof.evidenceRef.trim()
  ) {
    fail(
      'clean-subscription proof must show Azure Agent/Run Command/bootstrap/service health, private networking, deletion, and zero residue',
    );
  }
  requireTimestamp(proof.observedAt, 'cleanAccountProof.observedAt');
}

/**
 * Execute the Azure adapter of the shared Packer/image contract. The gallery
 * version stays excluded from latest until scan, replication, access, and a
 * clean-subscription boot + teardown proof all pass.
 */
export async function executeAzureComputeGalleryRelease(
  request: AzureComputeGalleryReleaseRequest,
  adapter: AzureComputeGalleryReleaseAdapter,
): Promise<AzureComputeGalleryReleaseResult> {
  const gate = evaluateWorkspaceHostReleaseGate(request.releaseGate);
  if (!gate.accepted) {
    fail(`workspace-host release gate rejected: ${gate.failures.map((item) => item.message).join('; ')}`);
  }

  const artifact = request.releaseGate.artifact;
  if (request.releaseGate.compatibilityRequest.provider !== 'azure') {
    fail('Azure Compute Gallery publication requires an Azure compatibility verdict');
  }
  request.publisherTenantId = requireUuid(request.publisherTenantId, 'publisherTenantId');
  request.publisherSubscriptionId = requireUuid(request.publisherSubscriptionId, 'publisherSubscriptionId');
  request.resourceGroup = requireResourceGroup(request.resourceGroup, 'resourceGroup');
  request.galleryName = requireResourceName(request.galleryName, 'galleryName');
  request.imageDefinitionName = requireResourceName(request.imageDefinitionName, 'imageDefinitionName');
  request.galleryVersion = requireGalleryVersion(request.galleryVersion, 'galleryVersion');
  request.sourceRegion = requireRegion(request.sourceRegion, 'sourceRegion');
  const targets = normalizeTargets(request.targets);
  if (!targets.some((target) => target.region === request.sourceRegion)) {
    fail('sourceRegion must be present in targets');
  }
  const readers = normalizeReaders(request.readers);
  request.cleanAccount.tenantId = requireUuid(request.cleanAccount.tenantId, 'cleanAccount.tenantId');
  request.cleanAccount.subscriptionId = requireUuid(request.cleanAccount.subscriptionId, 'cleanAccount.subscriptionId');
  request.cleanAccount.region = requireRegion(request.cleanAccount.region, 'cleanAccount.region');
  request.cleanAccount.resourceGroup = requireResourceGroup(
    request.cleanAccount.resourceGroup,
    'cleanAccount.resourceGroup',
  );
  requireAzureResourceId(
    request.cleanAccount.subnetResourceId,
    'Microsoft.Network/virtualNetworks',
    'cleanAccount.subnetResourceId',
  );
  requireAzureResourceId(
    request.cleanAccount.managedIdentityResourceId,
    'Microsoft.ManagedIdentity/userAssignedIdentities',
    'cleanAccount.managedIdentityResourceId',
  );
  if (request.cleanAccount.subscriptionId === request.publisherSubscriptionId) {
    fail('cleanAccount.subscriptionId must differ from publisherSubscriptionId');
  }
  if (!targets.some((target) => target.region === request.cleanAccount.region)) {
    fail('cleanAccount.region must be one of the replicated target regions');
  }
  if (
    !readers.some(
      (reader) =>
        reader.subscriptionId === request.cleanAccount.subscriptionId &&
        reader.tenantId === request.cleanAccount.tenantId,
    )
  ) {
    fail('readers must include the exact clean tenant and subscription');
  }
  const publishedAt = requireTimestamp(request.publishedAt, 'publishedAt');
  const deprecateAt = requireTimestamp(request.deprecatePreviousAt, 'deprecatePreviousAt');
  if (deprecateAt <= publishedAt) fail('deprecatePreviousAt must be later than publishedAt');

  const azureTarget = artifact.buildManifest.targets.find((target) => target.provider === 'azure');
  if (!azureTarget) fail('canonical build manifest does not contain an Azure target');
  if (azureTarget.locations.length > 0) {
    const missing = targets.filter((target) => !azureTarget.locations.includes(target.region));
    if (missing.length > 0) {
      fail(
        `Azure target regions are absent from the canonical build manifest: ${missing.map((item) => item.region).join(', ')}`,
      );
    }
  }

  const tags = tagsFor(artifact);
  const built = await adapter.buildCandidate({
    subscriptionId: request.publisherSubscriptionId,
    resourceGroup: request.resourceGroup,
    sourceRegion: request.sourceRegion,
    imageName: `papercusp-workspace-host-${artifact.image.version}`,
    builderKind: artifact.buildManifest.builder.kind,
    templatePath: artifact.buildManifest.builder.templatePath,
    ...(artifact.buildManifest.builder.kind === WORKSPACE_HOST_BOOTC_BUILDER_KIND
      ? {
          bootcArtifact: workspaceHostBootcCloudArtifact(
            request.releaseGate.bootcBakeManifest!,
            'azure',
          ),
        }
      : {}),
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
    architecture: artifact.buildManifest.baseImage.architecture,
    requiredGuestTools: AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS,
    tags,
  });
  requireAzureResourceId(built.sourceImageId, 'Microsoft.Compute/images', 'buildCandidate.sourceImageId');
  const scan = await adapter.scanImage({
    sourceImageId: built.sourceImageId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
  });
  validateScan(scan, artifact, built.sourceImageId);

  const definition = await adapter.ensureImageDefinition({
    subscriptionId: request.publisherSubscriptionId,
    resourceGroup: request.resourceGroup,
    galleryName: request.galleryName,
    imageDefinitionName: request.imageDefinitionName,
    architecture: artifact.buildManifest.baseImage.architecture,
    osType: 'Linux',
    hyperVGeneration: 'V2',
    tags,
  });
  if (definition.imageDefinitionResourceId !== imageDefinitionResourceId(request)) {
    fail('image definition receipt does not match the exact publisher gallery coordinates');
  }
  const published = await adapter.publishImageVersion({
    imageDefinitionResourceId: definition.imageDefinitionResourceId,
    version: request.galleryVersion,
    sourceImageId: built.sourceImageId,
    targetRegions: targets,
    excludeFromLatest: true,
    tags,
  });
  if (published.versionResourceId !== versionResourceId(request)) {
    fail('published gallery version receipt does not match the exact immutable version coordinates');
  }

  for (const reader of readers) {
    await adapter.grantVersionReadAccess({ versionResourceId: published.versionResourceId, ...reader });
  }
  validateInspection(
    await adapter.inspectImageVersion(published.versionResourceId),
    request,
    artifact,
    built.sourceImageId,
    targets,
    readers,
  );

  const cleanProof = await adapter.launchCleanAccountCanary({
    ...request.cleanAccount,
    versionResourceId: published.versionResourceId,
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    releaseVersion: artifact.image.version,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
  });
  validateCleanProof(cleanProof, request, artifact);

  const activePin: AzureComputeGalleryVersionPin = {
    versionResourceId: published.versionResourceId,
    version: request.galleryVersion,
    targetRegions: targets,
  };
  const rollbackPins = normalizePins(request.previousPins);
  const manifest = buildAzureComputeGalleryVersionManifest({
    releaseVersion: artifact.image.version,
    galleryVersion: request.galleryVersion,
    releaseSha256: workspaceHostReleaseSubjectSha256(artifact),
    buildManifestIdentity: artifact.buildManifest.manifestIdentity,
    architecture: artifact.buildManifest.baseImage.architecture,
    sourceRegion: request.sourceRegion,
    publishedAt: request.publishedAt,
    requiredGuestTools: AZURE_COMPUTE_GALLERY_REQUIRED_GUEST_TOOLS,
    versionResourceId: published.versionResourceId,
    targetRegions: targets,
    readerSubscriptionIds: readers.map((reader) => reader.subscriptionId),
    rollbackPins,
    cleanAccountProof: cleanProof,
  });
  const manifestReceipt = await adapter.publishVersionManifest(manifest);
  if (manifestReceipt.manifestIdentity !== manifest.manifestIdentity || !manifestReceipt.uri.trim()) {
    fail('published version manifest receipt does not match the immutable manifest identity');
  }
  await adapter.activateVersionPin({
    manifestUri: manifestReceipt.uri,
    manifestIdentity: manifest.manifestIdentity,
    activePin,
    rollbackPins,
  });

  const deprecatedPins: AzureComputeGalleryVersionPin[] = [];
  for (const previous of rollbackPins) {
    if (previous.versionResourceId === activePin.versionResourceId) continue;
    await adapter.deprecateImageVersion({
      versionResourceId: previous.versionResourceId,
      endOfLifeAt: request.deprecatePreviousAt,
      excludeFromLatest: true,
      replacementVersionResourceId: activePin.versionResourceId,
    });
    deprecatedPins.push(previous);
  }

  return {
    releaseGate: gate,
    scan,
    manifest,
    manifestUri: manifestReceipt.uri,
    activePin,
    rollbackPins,
    deprecatedPins,
  };
}
