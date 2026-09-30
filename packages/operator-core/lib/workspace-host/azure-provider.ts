import { createHash } from 'node:crypto';
import type {
  WorkspaceHostApplyRequest,
  WorkspaceHostApplyResult,
  WorkspaceHostCatalogQuery,
  WorkspaceHostConnectionValidation,
  WorkspaceHostDesiredSpec,
  WorkspaceHostHealthAttestation,
  WorkspaceHostHealthCheck,
  WorkspaceHostImage,
  WorkspaceHostObservation,
  WorkspaceHostPlan,
  WorkspaceHostPlanRequest,
  WorkspaceHostPlanStep,
  WorkspaceHostPriceEstimate,
  WorkspaceHostProvider,
  WorkspaceHostProviderCapabilities,
  WorkspaceHostProviderConnection,
  WorkspaceHostProviderContext,
  WorkspaceHostReconcileRequest,
  WorkspaceHostRef,
  WorkspaceHostRegion,
  WorkspaceHostResourceRef,
  WorkspaceHostScope,
  WorkspaceHostSize,
  WorkspaceHostSnapshotRef,
  WorkspaceHostTransportProfile,
} from '@papercusp/deployment-driver';
import {
  assertWorkspaceHostSecretIsolation,
  resolveWorkspaceHostHealthStatus,
  unmeasuredHealthCheck,
} from '@papercusp/deployment-driver';
import { AZURE_WORKSPACE_HOST_TARGET } from './azure-connection';
import {
  AZURE_WORKSPACE_HOST_TRANSPORTS,
  buildAzureWorkspaceHostTransportProfile,
  type AzureWorkspaceHostTransport,
} from './azure-connection-profile';

export const AZURE_WORKSPACE_HOST_PROVIDER_VERSION = 'azure-workspace-host-provider-v1';

export type AzureArmResourceKind =
  | 'resource-group'
  | 'virtual-network'
  | 'subnet'
  | 'network-security-group'
  | 'public-ip'
  | 'network-interface'
  | 'managed-identity'
  | 'disk'
  | 'vm'
  | 'vm-extension'
  | 'snapshot';

export type AzureVmPowerState =
  | 'creating'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'deallocating'
  | 'deallocated'
  | 'restarting'
  | 'repairing'
  | 'deleting';

export interface AzureArmOperationRef {
  id: string;
  requestId: string;
  resourceId: string;
}

export interface AzureArmOperationObservation extends AzureArmOperationRef {
  status: 'InProgress' | 'Succeeded' | 'Failed' | 'Canceled';
  observedAt: string;
  error?: { code?: string; message: string };
}

export interface AzureArmResourceObservation {
  id: string;
  kind: AzureArmResourceKind;
  provisioningState: 'Creating' | 'Updating' | 'Succeeded' | 'Deleting' | 'Failed';
  observedAt: string;
  powerState?: AzureVmPowerState;
  imageId?: string;
  attachedDataDiskIds?: readonly string[];
  agentOnline?: boolean;
}

export interface AzureArmPutInput {
  kind: AzureArmResourceKind;
  id: string;
  location: string;
  tags?: Readonly<Record<string, string>>;
  properties: Readonly<Record<string, unknown>>;
}

export type AzureVmAction = 'start' | 'deallocate' | 'restart' | 'reapply';

/**
 * Azure Resource Manager-shaped seam. Production composition may wrap the
 * Azure SDK management clients; the provider contract tests inject an
 * in-memory client. Credential bytes never cross this interface.
 */
export interface AzureWorkspaceHostArmClient {
  validateConnection(connection: WorkspaceHostProviderConnection): Promise<WorkspaceHostConnectionValidation>;
  listScopes(connection: WorkspaceHostProviderConnection): Promise<readonly WorkspaceHostScope[]>;
  listRegions(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostRegion[]>;
  listSizes(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostSize[]>;
  listImages(
    query: WorkspaceHostCatalogQuery,
    connection: WorkspaceHostProviderConnection,
  ): Promise<readonly WorkspaceHostImage[]>;
  estimatePrice(
    desired: WorkspaceHostDesiredSpec,
    connection: WorkspaceHostProviderConnection,
  ): Promise<WorkspaceHostPriceEstimate>;

  getResource(resourceId: string): Promise<AzureArmResourceObservation | undefined>;
  getOperation(operationId: string): Promise<AzureArmOperationObservation | undefined>;
  putResource(input: AzureArmPutInput, requestId: string): Promise<AzureArmOperationRef>;
  deleteResource(resourceId: string, requestId: string): Promise<AzureArmOperationRef>;
  beginVmAction(vmId: string, action: AzureVmAction, requestId: string): Promise<AzureArmOperationRef>;
  waitForOperation(operation: AzureArmOperationRef, signal?: AbortSignal): Promise<AzureArmOperationObservation>;
}

export interface AzureWorkspaceHostProviderOptions {
  client: AzureWorkspaceHostArmClient;
  now?: () => string;
}

interface ManagedResourceGroupSettings {
  mode: 'managed';
  name: string;
}

interface ExistingResourceGroupSettings {
  mode: 'existing';
  name: string;
}

interface ManagedNetworkSettings {
  mode: 'managed';
  virtualNetworkName: string;
  subnetName: string;
  networkSecurityGroupName: string;
  addressPrefixes: readonly string[];
  subnetPrefix: string;
  allowedSourceCidrs: readonly string[];
  allowedTcpPorts: readonly number[];
}

interface ExistingNetworkSettings {
  mode: 'existing';
  virtualNetworkResourceId: string;
  subnetResourceId: string;
  networkSecurityGroupResourceId: string;
}

type PublicIpSettings = { mode: 'none' } | { mode: 'managed'; name: string } | { mode: 'existing'; resourceId: string };

type ManagedIdentitySettings = { mode: 'managed'; name: string } | { mode: 'existing'; resourceId: string };

export interface AzureWorkspaceHostDesiredProviderSettings {
  subscriptionId: string;
  resourceGroup: ManagedResourceGroupSettings | ExistingResourceGroupSettings;
  network: ManagedNetworkSettings | ExistingNetworkSettings;
  publicIp: PublicIpSettings;
  identity: ManagedIdentitySettings;
  vmName: string;
  networkInterfaceName: string;
  dataDiskName: string;
  extensionName: string;
  /** Optional: Azure derives the OS disk floor from the source image when omitted. */
  bootDiskGiB?: number;
  diskSku: string;
  diskEncryptionSetId?: string;
  cloudInit?: string;
  extension?: {
    publisher: string;
    type: string;
    typeHandlerVersion: string;
    settings: Readonly<Record<string, unknown>>;
  };
}

type AzureRequirement = readonly string[];

type AzureStepInput =
  | {
      op: 'put-resource';
      hostId: string;
      resourceKind: AzureArmResourceKind;
      requestId: string;
      request: AzureArmPutInput;
      requirements: readonly AzureRequirement[];
    }
  | {
      op: 'use-existing-resource';
      hostId: string;
      resourceKind: string;
      resourceId: string;
      requirements: readonly AzureRequirement[];
    }
  | {
      op: 'vm-action';
      hostId: string;
      vmId: string;
      action: AzureVmAction;
      expectedPowerState: AzureVmPowerState;
      requestId: string;
    }
  | {
      op: 'delete-resource';
      hostId: string;
      resourceId: string;
      resourceKind: AzureArmResourceKind;
      requestId: string;
    };

const RESOURCE_GROUP_KIND = 'resource-group';
const VNET_KIND = 'virtual-network';
const SUBNET_KIND = 'subnet';
const NSG_KIND = 'network-security-group';
const PUBLIC_IP_KIND = 'public-ip';
const NIC_KIND = 'network-interface';
const IDENTITY_KIND = 'managed-identity';
const DISK_KIND = 'disk';
const VM_KIND = 'vm';
const EXTENSION_KIND = 'vm-extension';
const SNAPSHOT_KIND = 'snapshot';
const EXISTING_RESOURCE_GROUP_KIND = 'existing-resource-group';
const EXISTING_VNET_KIND = 'existing-virtual-network';
const EXISTING_SUBNET_KIND = 'existing-subnet';
const EXISTING_NSG_KIND = 'existing-network-security-group';
const EXISTING_PUBLIC_IP_KIND = 'existing-public-ip';
const EXISTING_IDENTITY_KIND = 'existing-managed-identity';

const CAPABILITIES: WorkspaceHostProviderCapabilities = {
  discovery: { scopes: true, regions: true, sizes: true, images: true, priceEstimates: true },
  lifecycle: {
    start: true,
    stop: true,
    restart: true,
    snapshot: true,
    restore: false,
    upgrade: false,
    repair: true,
    confirmedDestroy: true,
    // P-035: same as AWS — no controller-rendered bootstrap is attached yet. See aws-provider.
    hostBootstrap: false,
  },
  transportKinds: AZURE_WORKSPACE_HOST_TRANSPORTS,
  constraints: [
    'Azure Resource Manager ids and x-ms-client-request-id values are deterministic per logical resource',
    'Public IP allocation is explicit; private-only Bastion/Entra SSH is the default',
    'OS and persistent data disks must be encrypted',
    'Restore and in-place image upgrades are not yet supported',
  ],
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function optionalPayload(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string, fallback?: readonly string[]): readonly string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain at least one string`);
  return [...new Set(value.map((item, index) => requireString(item, `${label}[${index}]`)))].sort();
}

function portArray(value: unknown, label: string, fallback: readonly number[]): readonly number[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain at least one port`);
  return [
    ...new Set(
      value.map((item, index) => {
        const port = positiveInteger(item, `${label}[${index}]`);
        if (port > 65_535) throw new Error(`${label}[${index}] must be at most 65535`);
        return port;
      }),
    ),
  ].sort((left, right) => left - right);
}

function objectRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return { ...(value as Record<string, unknown>) };
}

function resourceName(value: unknown, label: string): string {
  const name = requireString(value, label);
  if (name.includes('/')) throw new Error(`${label} must be a resource name, not an ARM id`);
  return name;
}

function stableName(prefix: string, hostId: string, maxLength = 64): string {
  const suffix = createHash('sha256').update(hostId).digest('hex').slice(0, 8);
  const slug =
    hostId
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'host';
  const available = maxLength - prefix.length - suffix.length - 2;
  const body = slug.slice(0, Math.max(1, available)).replace(/-+$/g, '') || 'host';
  return `${prefix}-${body}-${suffix}`;
}

/** Deterministic RFC-4122 UUID suitable for Azure x-ms-client-request-id. */
export function azureWorkspaceHostRequestUuid(idempotencyKey: string): string {
  const hex = createHash('sha256')
    .update(requireString(idempotencyKey, 'idempotencyKey'))
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

/** Build a canonical Azure Resource Manager id from alternating type/name segments. */
export function azureWorkspaceHostResourceId(
  subscriptionId: string,
  resourceGroup: string,
  providerNamespace: string,
  ...typeAndNameSegments: readonly string[]
): string {
  if (typeAndNameSegments.length === 0 || typeAndNameSegments.length % 2 !== 0) {
    throw new Error('Azure ARM resource ids require alternating type/name segments');
  }
  const segments = typeAndNameSegments.map((segment, index) =>
    index % 2 === 0
      ? requireString(segment, `resource type segment ${index}`)
      : resourceName(segment, `resource name segment ${index}`),
  );
  return `/subscriptions/${requireString(subscriptionId, 'subscriptionId')}/resourceGroups/${resourceName(resourceGroup, 'resourceGroup')}/providers/${requireString(providerNamespace, 'providerNamespace')}/${segments.join('/')}`;
}

function resourceGroupId(subscriptionId: string, resourceGroup: string): string {
  return `/subscriptions/${requireString(subscriptionId, 'subscriptionId')}/resourceGroups/${resourceName(resourceGroup, 'resourceGroup')}`;
}

function requireArmId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!id.startsWith('/subscriptions/')) throw new Error(`${label} must be an absolute Azure resource id`);
  return id;
}

function readSettings(desired: WorkspaceHostDesiredSpec): AzureWorkspaceHostDesiredProviderSettings {
  if (desired.target !== AZURE_WORKSPACE_HOST_TARGET) {
    throw new Error(`Azure provider cannot plan target '${desired.target}'`);
  }
  if (desired.scope.kind !== 'subscription') {
    throw new Error("Azure workspace hosts require scope.kind 'subscription'");
  }
  if (!desired.data.encrypted) throw new Error('Azure workspace-host OS and data disks must be encrypted');
  const provider = desired.provider ?? {};
  assertWorkspaceHostSecretIsolation(provider, 'azure.desired.provider');
  const subscriptionId =
    optionalString(provider.subscriptionId, 'azure.desired.provider.subscriptionId') ?? desired.scope.id;
  if (subscriptionId !== desired.scope.id) {
    throw new Error('Azure provider subscriptionId must match desired.scope.id');
  }
  const base = stableName('pc', desired.hostId);

  const rawResourceGroup = objectRecord(provider.resourceGroup, 'azure.desired.provider.resourceGroup');
  const resourceGroupMode = requireString(rawResourceGroup.mode, 'azure.desired.provider.resourceGroup.mode');
  const resourceGroupName =
    optionalString(rawResourceGroup.name, 'azure.desired.provider.resourceGroup.name') ?? `${base}-rg`;
  if (resourceGroupMode !== 'managed' && resourceGroupMode !== 'existing') {
    throw new Error("azure.desired.provider.resourceGroup.mode must be 'managed' or 'existing'");
  }
  const resourceGroup = { mode: resourceGroupMode, name: resourceGroupName } as
    | ManagedResourceGroupSettings
    | ExistingResourceGroupSettings;

  const rawNetwork = objectRecord(provider.network, 'azure.desired.provider.network');
  const networkMode = requireString(rawNetwork.mode, 'azure.desired.provider.network.mode');
  let network: ManagedNetworkSettings | ExistingNetworkSettings;
  if (networkMode === 'managed') {
    network = {
      mode: networkMode,
      virtualNetworkName:
        optionalString(rawNetwork.virtualNetworkName, 'azure.desired.provider.network.virtualNetworkName') ??
        `${base}-vnet`,
      subnetName:
        optionalString(rawNetwork.subnetName, 'azure.desired.provider.network.subnetName') ?? `${base}-subnet`,
      networkSecurityGroupName:
        optionalString(
          rawNetwork.networkSecurityGroupName,
          'azure.desired.provider.network.networkSecurityGroupName',
        ) ?? `${base}-nsg`,
      addressPrefixes: stringArray(rawNetwork.addressPrefixes, 'azure.desired.provider.network.addressPrefixes', [
        '10.42.0.0/16',
      ]),
      subnetPrefix:
        optionalString(rawNetwork.subnetPrefix, 'azure.desired.provider.network.subnetPrefix') ?? '10.42.0.0/24',
      allowedSourceCidrs: stringArray(
        rawNetwork.allowedSourceCidrs,
        'azure.desired.provider.network.allowedSourceCidrs',
        ['10.0.0.0/8'],
      ),
      allowedTcpPorts: portArray(rawNetwork.allowedTcpPorts, 'azure.desired.provider.network.allowedTcpPorts', [22]),
    };
  } else if (networkMode === 'existing') {
    network = {
      mode: networkMode,
      virtualNetworkResourceId: requireArmId(
        rawNetwork.virtualNetworkResourceId,
        'azure.desired.provider.network.virtualNetworkResourceId',
      ),
      subnetResourceId: requireArmId(rawNetwork.subnetResourceId, 'azure.desired.provider.network.subnetResourceId'),
      networkSecurityGroupResourceId: requireArmId(
        rawNetwork.networkSecurityGroupResourceId,
        'azure.desired.provider.network.networkSecurityGroupResourceId',
      ),
    };
  } else {
    throw new Error("azure.desired.provider.network.mode must be 'managed' or 'existing'");
  }

  const rawPublicIp = objectRecord(provider.publicIp, 'azure.desired.provider.publicIp');
  const publicIpMode = optionalString(rawPublicIp.mode, 'azure.desired.provider.publicIp.mode') ?? 'none';
  let publicIp: PublicIpSettings;
  if (publicIpMode === 'none') publicIp = { mode: 'none' };
  else if (publicIpMode === 'managed') {
    publicIp = {
      mode: 'managed',
      name: optionalString(rawPublicIp.name, 'azure.desired.provider.publicIp.name') ?? `${base}-pip`,
    };
  } else if (publicIpMode === 'existing') {
    publicIp = {
      mode: 'existing',
      resourceId: requireArmId(rawPublicIp.resourceId, 'azure.desired.provider.publicIp.resourceId'),
    };
  } else throw new Error("azure.desired.provider.publicIp.mode must be 'none', 'managed', or 'existing'");

  const rawIdentity = objectRecord(provider.identity, 'azure.desired.provider.identity');
  const identityMode = optionalString(rawIdentity.mode, 'azure.desired.provider.identity.mode') ?? 'managed';
  let identity: ManagedIdentitySettings;
  if (identityMode === 'managed') {
    identity = {
      mode: 'managed',
      name: optionalString(rawIdentity.name, 'azure.desired.provider.identity.name') ?? `${base}-identity`,
    };
  } else if (identityMode === 'existing') {
    identity = {
      mode: 'existing',
      resourceId: requireArmId(rawIdentity.resourceId, 'azure.desired.provider.identity.resourceId'),
    };
  } else throw new Error("azure.desired.provider.identity.mode must be 'managed' or 'existing'");

  const extensionRaw = provider.extension;
  let extension: AzureWorkspaceHostDesiredProviderSettings['extension'];
  if (extensionRaw !== undefined) {
    const record = objectRecord(extensionRaw, 'azure.desired.provider.extension');
    const settings = objectRecord(record.settings, 'azure.desired.provider.extension.settings');
    assertWorkspaceHostSecretIsolation(settings, 'azure.desired.provider.extension.settings');
    extension = {
      publisher: requireString(record.publisher, 'azure.desired.provider.extension.publisher'),
      type: requireString(record.type, 'azure.desired.provider.extension.type'),
      typeHandlerVersion: requireString(
        record.typeHandlerVersion,
        'azure.desired.provider.extension.typeHandlerVersion',
      ),
      settings,
    };
  }

  return {
    subscriptionId,
    resourceGroup,
    network,
    publicIp,
    identity,
    vmName: optionalString(provider.vmName, 'azure.desired.provider.vmName') ?? `${base}-vm`,
    networkInterfaceName:
      optionalString(provider.networkInterfaceName, 'azure.desired.provider.networkInterfaceName') ?? `${base}-nic`,
    dataDiskName: optionalString(provider.dataDiskName, 'azure.desired.provider.dataDiskName') ?? `${base}-data`,
    extensionName:
      optionalString(provider.extensionName, 'azure.desired.provider.extensionName') ?? `${base}-bootstrap`,
    ...(provider.bootDiskGiB === undefined
      ? {}
      : { bootDiskGiB: positiveInteger(provider.bootDiskGiB, 'azure.desired.provider.bootDiskGiB') }),
    diskSku: optionalString(provider.diskSku, 'azure.desired.provider.diskSku') ?? 'Premium_LRS',
    diskEncryptionSetId: optionalString(provider.diskEncryptionSetId, 'azure.desired.provider.diskEncryptionSetId'),
    cloudInit: optionalPayload(provider.cloudInit, 'azure.desired.provider.cloudInit'),
    extension,
  };
}

function tags(desired: WorkspaceHostDesiredSpec, workspaceId: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [
      ...Object.entries(desired.labels ?? {}),
      ['papercusp-host-id', desired.hostId],
      ['papercusp-managed', 'true'],
      ['papercusp-workspace-id', workspaceId],
    ].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function diskEncryption(diskEncryptionSetId?: string): Readonly<Record<string, unknown>> {
  return diskEncryptionSetId
    ? { type: 'EncryptionAtRestWithCustomerKey', diskEncryptionSetId }
    : { type: 'EncryptionAtRestWithPlatformKey' };
}

function resource(
  kind: string,
  providerId: string,
  options: Pick<WorkspaceHostResourceRef, 'parentProviderId' | 'region' | 'zone'> = {},
): WorkspaceHostResourceRef {
  return { target: AZURE_WORKSPACE_HOST_TARGET, kind, providerId, ...options };
}

function knownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kinds: readonly string[],
): WorkspaceHostResourceRef | undefined {
  return resources.find(
    (candidate) => candidate.target === AZURE_WORKSPACE_HOST_TARGET && kinds.includes(candidate.kind),
  );
}

function requireKnownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kinds: readonly string[],
  stepId: string,
): WorkspaceHostResourceRef {
  const found = knownResource(resources, kinds);
  if (!found) {
    throw new Error(
      `Azure step '${stepId}' requires a persisted ${kinds.join('/')} resource identity before its provider call`,
    );
  }
  return found;
}

function requireRequirements(
  resources: readonly WorkspaceHostResourceRef[],
  requirements: readonly AzureRequirement[],
  stepId: string,
): void {
  for (const kinds of requirements) requireKnownResource(resources, kinds, stepId);
}

function stepInput(step: WorkspaceHostPlanStep): AzureStepInput {
  const input = step.input as unknown as AzureStepInput;
  if (!input || typeof input !== 'object' || !('op' in input)) {
    throw new Error(`Azure plan step '${step.id}' lacks an Azure operation`);
  }
  return input;
}

function hostIdFor(request: WorkspaceHostPlanRequest): string {
  return request.action === 'provision' ? request.desired.hostId : request.host.hostId;
}

function expectedVmState(action: WorkspaceHostPlanRequest['action']): AzureVmPowerState {
  return action === 'stop' ? 'deallocated' : 'running';
}

export class AzureWorkspaceHostProvider implements WorkspaceHostProvider {
  readonly target = AZURE_WORKSPACE_HOST_TARGET;
  readonly capabilities = CAPABILITIES;
  private readonly now: () => string;

  constructor(
    private readonly client: AzureWorkspaceHostArmClient,
    options: Pick<AzureWorkspaceHostProviderOptions, 'now'> = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  validateConnection(ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostConnectionValidation> {
    if (ctx.connection.target !== AZURE_WORKSPACE_HOST_TARGET) {
      return Promise.resolve({
        ok: false,
        checkedAt: this.now(),
        warnings: [],
        errors: [`Azure provider cannot validate target '${ctx.connection.target}'`],
      });
    }
    assertWorkspaceHostSecretIsolation(ctx.connection.provider, 'azure.connection.provider');
    return this.client.validateConnection(ctx.connection);
  }

  listScopes(ctx: WorkspaceHostProviderContext): Promise<readonly WorkspaceHostScope[]> {
    return this.client.listScopes(ctx.connection);
  }

  listRegions(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostRegion[]> {
    return this.client.listRegions(query, ctx.connection);
  }

  listSizes(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostSize[]> {
    return this.client.listSizes(query, ctx.connection);
  }

  listImages(
    query: WorkspaceHostCatalogQuery,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostImage[]> {
    return this.client.listImages(query, ctx.connection);
  }

  estimatePrice(
    desired: WorkspaceHostDesiredSpec,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostPriceEstimate> {
    return this.client.estimatePrice(desired, ctx.connection);
  }

  async plan(request: WorkspaceHostPlanRequest, ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostPlan> {
    if (request.action !== 'provision' && request.host.target !== AZURE_WORKSPACE_HOST_TARGET) {
      throw new Error(`Azure provider cannot plan host target '${request.host.target}'`);
    }
    return {
      planId: `azure:${azureWorkspaceHostRequestUuid(`${request.operationId}:plan`)}`,
      operationId: request.operationId,
      target: AZURE_WORKSPACE_HOST_TARGET,
      hostId: hostIdFor(request),
      generatedAt: this.now(),
      steps: this.planSteps(request, ctx),
      warnings: [],
    };
  }

  private planSteps(
    request: WorkspaceHostPlanRequest,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    if (request.action === 'provision') return this.planProvision(request, ctx);
    if (request.action === 'destroy') return this.planDestroy(request);
    if (request.action === 'restore' || request.action === 'upgrade') {
      throw new Error(`Azure workspace-host action '${request.action}' is not supported`);
    }
    const vm = requireKnownResource(request.host.resources, [VM_KIND], request.action);
    const key = `${request.idempotencyKey}:${request.action}:${vm.providerId}`;
    if (request.action === 'snapshot') {
      const disk = requireKnownResource(request.host.resources, [DISK_KIND], request.action);
      const resourceGroup = requireKnownResource(
        request.host.resources,
        [RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND],
        request.action,
      );
      const snapshotId = `${resourceGroup.providerId}/providers/Microsoft.Compute/snapshots/${resourceName(
        request.name ?? stableName('pc-snapshot', request.host.hostId),
        'snapshot name',
      )}`;
      const snapshotKey = `${request.idempotencyKey}:snapshot:${disk.providerId}`;
      return [
        {
          id: 'snapshot-data-disk',
          action: 'snapshot',
          resourceKind: SNAPSHOT_KIND,
          dependsOn: [],
          idempotencyKey: snapshotKey,
          destructive: false,
          input: {
            op: 'put-resource',
            hostId: request.host.hostId,
            resourceKind: SNAPSHOT_KIND,
            requestId: azureWorkspaceHostRequestUuid(snapshotKey),
            requirements: [[DISK_KIND]],
            request: {
              kind: SNAPSHOT_KIND,
              id: snapshotId,
              location: disk.region ?? 'global',
              properties: { creationData: { createOption: 'Copy', sourceResourceId: disk.providerId } },
            },
          } satisfies AzureStepInput,
        },
      ];
    }
    const action =
      request.action === 'start'
        ? 'start'
        : request.action === 'stop'
          ? 'deallocate'
          : request.action === 'restart'
            ? 'restart'
            : 'reapply';
    return [
      {
        id: `${request.action}-vm`,
        action: request.action,
        resourceKind: VM_KIND,
        dependsOn: [],
        idempotencyKey: key,
        destructive: false,
        input: {
          op: 'vm-action',
          hostId: request.host.hostId,
          vmId: vm.providerId,
          action,
          expectedPowerState: expectedVmState(request.action),
          requestId: azureWorkspaceHostRequestUuid(key),
        } satisfies AzureStepInput,
      },
    ];
  }

  private planProvision(
    request: Extract<WorkspaceHostPlanRequest, { action: 'provision' }>,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    const desired = request.desired;
    const settings = readSettings(desired);
    const commonTags = tags(desired, ctx.workspaceId);
    const rgId = resourceGroupId(settings.subscriptionId, settings.resourceGroup.name);
    const steps: WorkspaceHostPlanStep[] = [];

    const addPut = (
      id: string,
      kind: AzureArmResourceKind,
      dependsOn: readonly string[],
      requirements: readonly AzureRequirement[],
      input: AzureArmPutInput,
    ): void => {
      const key = `${request.idempotencyKey}:${id}`;
      steps.push({
        id,
        action: 'provision',
        resourceKind: kind,
        dependsOn,
        idempotencyKey: key,
        destructive: false,
        input: {
          op: 'put-resource',
          hostId: desired.hostId,
          resourceKind: kind,
          requestId: azureWorkspaceHostRequestUuid(key),
          request: input,
          requirements,
        } satisfies AzureStepInput,
      });
    };
    const addExisting = (
      id: string,
      kind: string,
      resourceId: string,
      dependsOn: readonly string[],
      requirements: readonly AzureRequirement[],
    ): void => {
      steps.push({
        id,
        action: 'provision',
        resourceKind: kind,
        dependsOn,
        idempotencyKey: `${request.idempotencyKey}:${id}`,
        destructive: false,
        input: {
          op: 'use-existing-resource',
          hostId: desired.hostId,
          resourceKind: kind,
          resourceId,
          requirements,
        } satisfies AzureStepInput,
      });
    };

    const rgStep = settings.resourceGroup.mode === 'managed' ? 'create-resource-group' : 'record-resource-group';
    if (settings.resourceGroup.mode === 'managed') {
      addPut(rgStep, RESOURCE_GROUP_KIND, [], [], {
        kind: RESOURCE_GROUP_KIND,
        id: rgId,
        location: desired.region,
        tags: commonTags,
        properties: {},
      });
    } else addExisting(rgStep, EXISTING_RESOURCE_GROUP_KIND, rgId, [], []);

    let vnetId: string;
    let subnetId: string;
    let nsgId: string;
    let vnetStep: string;
    let subnetStep: string;
    let nsgStep: string;
    if (settings.network.mode === 'managed') {
      const network = settings.network;
      vnetId = azureWorkspaceHostResourceId(
        settings.subscriptionId,
        settings.resourceGroup.name,
        'Microsoft.Network',
        'virtualNetworks',
        network.virtualNetworkName,
      );
      subnetId = azureWorkspaceHostResourceId(
        settings.subscriptionId,
        settings.resourceGroup.name,
        'Microsoft.Network',
        'virtualNetworks',
        network.virtualNetworkName,
        'subnets',
        network.subnetName,
      );
      nsgId = azureWorkspaceHostResourceId(
        settings.subscriptionId,
        settings.resourceGroup.name,
        'Microsoft.Network',
        'networkSecurityGroups',
        network.networkSecurityGroupName,
      );
      vnetStep = 'create-virtual-network';
      nsgStep = 'create-network-security-group';
      subnetStep = 'create-subnet';
      addPut(vnetStep, VNET_KIND, [rgStep], [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]], {
        kind: VNET_KIND,
        id: vnetId,
        location: desired.region,
        tags: commonTags,
        properties: { addressSpace: { addressPrefixes: network.addressPrefixes } },
      });
      addPut(nsgStep, NSG_KIND, [rgStep], [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]], {
        kind: NSG_KIND,
        id: nsgId,
        location: desired.region,
        tags: commonTags,
        properties: {
          securityRules: network.allowedTcpPorts.map((port, index) => ({
            name: `allow-tcp-${port}`,
            properties: {
              priority: 100 + index,
              direction: 'Inbound',
              access: 'Allow',
              protocol: 'Tcp',
              sourceAddressPrefixes: network.allowedSourceCidrs,
              sourcePortRange: '*',
              destinationAddressPrefix: '*',
              destinationPortRange: String(port),
            },
          })),
        },
      });
      addPut(subnetStep, SUBNET_KIND, [vnetStep, nsgStep], [[VNET_KIND], [NSG_KIND]], {
        kind: SUBNET_KIND,
        id: subnetId,
        location: desired.region,
        tags: commonTags,
        properties: {
          addressPrefix: network.subnetPrefix,
          networkSecurityGroup: { id: nsgId },
        },
      });
    } else {
      vnetId = settings.network.virtualNetworkResourceId;
      subnetId = settings.network.subnetResourceId;
      nsgId = settings.network.networkSecurityGroupResourceId;
      vnetStep = 'record-virtual-network';
      nsgStep = 'record-network-security-group';
      subnetStep = 'record-subnet';
      addExisting(
        vnetStep,
        EXISTING_VNET_KIND,
        vnetId,
        [rgStep],
        [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]],
      );
      addExisting(nsgStep, EXISTING_NSG_KIND, nsgId, [rgStep], [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]]);
      addExisting(
        subnetStep,
        EXISTING_SUBNET_KIND,
        subnetId,
        [vnetStep, nsgStep],
        [[EXISTING_VNET_KIND], [EXISTING_NSG_KIND]],
      );
    }

    let publicIpId: string | undefined;
    let publicIpStep: string | undefined;
    if (settings.publicIp.mode === 'managed') {
      publicIpId = azureWorkspaceHostResourceId(
        settings.subscriptionId,
        settings.resourceGroup.name,
        'Microsoft.Network',
        'publicIPAddresses',
        settings.publicIp.name,
      );
      publicIpStep = 'create-public-ip';
      addPut(publicIpStep, PUBLIC_IP_KIND, [rgStep], [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]], {
        kind: PUBLIC_IP_KIND,
        id: publicIpId,
        location: desired.region,
        tags: commonTags,
        properties: { publicIPAllocationMethod: 'Static', sku: { name: 'Standard' } },
      });
    } else if (settings.publicIp.mode === 'existing') {
      publicIpId = settings.publicIp.resourceId;
      publicIpStep = 'record-public-ip';
      addExisting(
        publicIpStep,
        EXISTING_PUBLIC_IP_KIND,
        publicIpId,
        [rgStep],
        [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]],
      );
    }

    let identityId: string;
    let identityStep: string;
    if (settings.identity.mode === 'managed') {
      identityId = azureWorkspaceHostResourceId(
        settings.subscriptionId,
        settings.resourceGroup.name,
        'Microsoft.ManagedIdentity',
        'userAssignedIdentities',
        settings.identity.name,
      );
      identityStep = 'create-managed-identity';
      addPut(identityStep, IDENTITY_KIND, [rgStep], [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]], {
        kind: IDENTITY_KIND,
        id: identityId,
        location: desired.region,
        tags: commonTags,
        properties: {},
      });
    } else {
      identityId = settings.identity.resourceId;
      identityStep = 'record-managed-identity';
      addExisting(
        identityStep,
        EXISTING_IDENTITY_KIND,
        identityId,
        [rgStep],
        [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]],
      );
    }

    const dataDiskId = azureWorkspaceHostResourceId(
      settings.subscriptionId,
      settings.resourceGroup.name,
      'Microsoft.Compute',
      'disks',
      settings.dataDiskName,
    );
    const dataDiskStep = 'create-data-disk';
    addPut(dataDiskStep, DISK_KIND, [rgStep], [[RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND]], {
      kind: DISK_KIND,
      id: dataDiskId,
      location: desired.region,
      tags: commonTags,
      properties: {
        diskSizeGB: positiveInteger(desired.data.volumeGiB, 'desired.data.volumeGiB'),
        sku: { name: settings.diskSku },
        creationData: { createOption: 'Empty' },
        encryption: diskEncryption(settings.diskEncryptionSetId),
      },
    });

    const nicId = azureWorkspaceHostResourceId(
      settings.subscriptionId,
      settings.resourceGroup.name,
      'Microsoft.Network',
      'networkInterfaces',
      settings.networkInterfaceName,
    );
    const nicDependencies = [subnetStep, nsgStep, ...(publicIpStep ? [publicIpStep] : [])];
    const nicRequirements: AzureRequirement[] = [
      [SUBNET_KIND, EXISTING_SUBNET_KIND],
      [NSG_KIND, EXISTING_NSG_KIND],
      ...(publicIpId ? [[PUBLIC_IP_KIND, EXISTING_PUBLIC_IP_KIND] as const] : []),
    ];
    addPut('create-network-interface', NIC_KIND, nicDependencies, nicRequirements, {
      kind: NIC_KIND,
      id: nicId,
      location: desired.region,
      tags: commonTags,
      properties: {
        networkSecurityGroup: { id: nsgId },
        ipConfigurations: [
          {
            name: 'primary',
            properties: {
              primary: true,
              privateIPAllocationMethod: 'Dynamic',
              subnet: { id: subnetId },
              ...(publicIpId ? { publicIPAddress: { id: publicIpId } } : {}),
            },
          },
        ],
      },
    });

    const vmId = azureWorkspaceHostResourceId(
      settings.subscriptionId,
      settings.resourceGroup.name,
      'Microsoft.Compute',
      'virtualMachines',
      settings.vmName,
    );
    addPut(
      'create-vm',
      VM_KIND,
      ['create-network-interface', identityStep, dataDiskStep],
      [[NIC_KIND], [IDENTITY_KIND, EXISTING_IDENTITY_KIND], [DISK_KIND]],
      {
        kind: VM_KIND,
        id: vmId,
        location: desired.region,
        tags: commonTags,
        properties: {
          hardwareProfile: { vmSize: desired.size },
          identity: { type: 'UserAssigned', userAssignedIdentities: { [identityId]: {} } },
          networkProfile: { networkInterfaces: [{ id: nicId, properties: { primary: true } }] },
          storageProfile: {
            imageReference: { id: desired.image.id },
            osDisk: {
              createOption: 'FromImage',
              ...(settings.bootDiskGiB === undefined ? {} : { diskSizeGB: settings.bootDiskGiB }),
              managedDisk: { storageAccountType: settings.diskSku },
              encryption: diskEncryption(settings.diskEncryptionSetId),
            },
            dataDisks: [{ lun: 0, createOption: 'Attach', managedDisk: { id: dataDiskId } }],
          },
          // ⚠ EI-22185970114422986 (D-238 class): this DISABLES password authentication and
          // authorizes NO SSH public key — there is no `linuxConfiguration.ssh.publicKeys` here
          // and `cloudInit` is an optional payload with no key requirement, so a planned Azure
          // host is unreachable while the plan reports success. D-241's fail-closed key resolver
          // does NOT protect this path: provisioning-runner.ts consults it only for providers
          // declaring `capabilities.lifecycle.hostBootstrap`, and Azure declares false.
          // Also suspected: ARM documents `disablePasswordAuthentication` under
          // `osProfile.linuxConfiguration`, not on `osProfile` — unverifiable from this tree.
          // The hazard is pinned by a characterization test in azure-provider.test.ts that must
          // be INVERTED into a refusal when key delivery is designed (P-030 / P-035).
          osProfile: {
            computerName: settings.vmName,
            adminUsername: 'papercusp',
            disablePasswordAuthentication: true,
            ...(settings.cloudInit ? { customData: Buffer.from(settings.cloudInit, 'utf8').toString('base64') } : {}),
          },
        },
      },
    );

    if (settings.extension) {
      const extensionId = `${vmId}/extensions/${resourceName(settings.extensionName, 'extension name')}`;
      addPut('install-vm-extension', EXTENSION_KIND, ['create-vm'], [[VM_KIND]], {
        kind: EXTENSION_KIND,
        id: extensionId,
        location: desired.region,
        tags: commonTags,
        properties: {
          publisher: settings.extension.publisher,
          type: settings.extension.type,
          typeHandlerVersion: settings.extension.typeHandlerVersion,
          autoUpgradeMinorVersion: true,
          settings: settings.extension.settings,
        },
      });
    }
    return steps;
  }

  private planDestroy(
    request: Extract<WorkspaceHostPlanRequest, { action: 'destroy' }>,
  ): readonly WorkspaceHostPlanStep[] {
    if (request.confirmation.expectedHostId !== request.host.hostId) {
      throw new Error('Azure destroy confirmation expectedHostId does not match the host');
    }
    const managedKinds = [
      EXTENSION_KIND,
      VM_KIND,
      NIC_KIND,
      PUBLIC_IP_KIND,
      DISK_KIND,
      IDENTITY_KIND,
      SUBNET_KIND,
      NSG_KIND,
      VNET_KIND,
      RESOURCE_GROUP_KIND,
    ];
    const managed = request.host.resources.filter(
      (item) => item.target === AZURE_WORKSPACE_HOST_TARGET && managedKinds.includes(item.kind),
    );
    if (managed.length === 0) throw new Error('Azure destroy requires known managed resources');
    const steps: WorkspaceHostPlanStep[] = [];
    const preserveIds: string[] = [];
    if (request.disposition !== 'discard') {
      const resourceGroup = requireKnownResource(
        request.host.resources,
        [RESOURCE_GROUP_KIND, EXISTING_RESOURCE_GROUP_KIND],
        'destroy',
      );
      for (const disk of managed.filter((item) => item.kind === DISK_KIND)) {
        const id = `preserve-disk-${createHash('sha256').update(disk.providerId).digest('hex').slice(0, 8)}`;
        const key = `${request.idempotencyKey}:${id}`;
        preserveIds.push(id);
        steps.push({
          id,
          action: 'destroy',
          resourceKind: SNAPSHOT_KIND,
          dependsOn: [],
          idempotencyKey: key,
          destructive: false,
          input: {
            op: 'put-resource',
            hostId: request.host.hostId,
            resourceKind: SNAPSHOT_KIND,
            requestId: azureWorkspaceHostRequestUuid(key),
            requirements: [[DISK_KIND]],
            request: {
              kind: SNAPSHOT_KIND,
              id: `${resourceGroup.providerId}/providers/Microsoft.Compute/snapshots/${stableName(
                'pc-destroy',
                `${request.host.hostId}-${disk.providerId}`,
              )}`,
              location: disk.region ?? 'global',
              properties: { creationData: { createOption: 'Copy', sourceResourceId: disk.providerId } },
            },
          } satisfies AzureStepInput,
        });
      }
    }

    const priorDeleteIds: string[] = [];
    for (const kind of managedKinds) {
      const currentIds: string[] = [];
      for (const item of managed
        .filter((candidate) => candidate.kind === kind)
        .sort((left, right) => left.providerId.localeCompare(right.providerId))) {
        const id = `delete-${kind}-${createHash('sha256').update(item.providerId).digest('hex').slice(0, 8)}`;
        const key = `${request.idempotencyKey}:${id}`;
        currentIds.push(id);
        steps.push({
          id,
          action: 'destroy',
          resourceKind: kind,
          dependsOn: [...preserveIds, ...priorDeleteIds],
          idempotencyKey: key,
          destructive: true,
          input: {
            op: 'delete-resource',
            hostId: request.host.hostId,
            resourceId: item.providerId,
            resourceKind: kind as AzureArmResourceKind,
            requestId: azureWorkspaceHostRequestUuid(key),
          } satisfies AzureStepInput,
        });
      }
      priorDeleteIds.push(...currentIds);
    }
    return steps;
  }

  async apply(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    if (input.op === 'use-existing-resource') {
      requireRequirements(request.knownResources, input.requirements, request.step.id);
      const found = await this.client.getResource(input.resourceId);
      if (!found || found.provisioningState !== 'Succeeded') {
        throw new Error(`Azure existing resource '${input.resourceId}' was not found or ready`);
      }
      return this.unchanged(
        request,
        resource(input.resourceKind, found.id, { parentProviderId: ctx.connection.scope?.id }),
      );
    }
    if (input.op === 'put-resource') {
      requireRequirements(request.knownResources, input.requirements, request.step.id);
      const operation = await this.client.putResource(input.request, input.requestId);
      if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.id);
      const found = await this.client.getResource(input.request.id);
      if (!found || found.provisioningState !== 'Succeeded') return this.inProgress(request, operation.id);
      if (input.resourceKind === SNAPSHOT_KIND) {
        return this.snapshotApplied(request, input.hostId, found, operation.id);
      }
      return this.applied(
        request,
        resource(input.resourceKind, found.id, {
          parentProviderId: ctx.connection.scope?.id,
          region: input.request.location,
        }),
        operation.id,
      );
    }
    if (input.op === 'vm-action') {
      const operation = await this.client.beginVmAction(input.vmId, input.action, input.requestId);
      if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.id);
      const found = await this.client.getResource(input.vmId);
      return found?.powerState === input.expectedPowerState
        ? this.applied(
            request,
            resource(VM_KIND, found.id, { parentProviderId: ctx.connection.scope?.id }),
            operation.id,
          )
        : this.inProgress(request, operation.id);
    }
    return this.deleteResource(request, input, ctx.signal);
  }

  private async settled(operation: AzureArmOperationRef, signal?: AbortSignal): Promise<boolean> {
    const observed = await this.client.waitForOperation(operation, signal);
    if (observed.error || observed.status === 'Failed' || observed.status === 'Canceled') {
      throw new Error(`Azure operation '${operation.id}' failed: ${observed.error?.message ?? observed.status}`);
    }
    return observed.status === 'Succeeded';
  }

  private async deleteResource(
    request: WorkspaceHostApplyRequest,
    input: Extract<AzureStepInput, { op: 'delete-resource' }>,
    signal?: AbortSignal,
  ): Promise<WorkspaceHostApplyResult> {
    if (!(await this.client.getResource(input.resourceId))) {
      return this.destroyed(request, input.hostId, input.resourceId);
    }
    const operation = await this.client.deleteResource(input.resourceId, input.requestId);
    if (!(await this.settled(operation, signal))) return this.inProgress(request, operation.id);
    return (await this.client.getResource(input.resourceId))
      ? this.inProgress(request, operation.id)
      : this.destroyed(request, input.hostId, input.resourceId, operation.id);
  }

  async reconcile(
    request: WorkspaceHostReconcileRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    if (input.op === 'put-resource') {
      const found = await this.client.getResource(input.request.id);
      if (found?.provisioningState === 'Succeeded') {
        if (input.resourceKind === SNAPSHOT_KIND) return this.snapshotUnchanged(request, input.hostId, found);
        return this.unchanged(
          request,
          resource(input.resourceKind, found.id, {
            parentProviderId: ctx.connection.scope?.id,
            region: input.request.location,
          }),
        );
      }
    } else if (input.op === 'use-existing-resource') {
      const found = await this.client.getResource(input.resourceId);
      if (found?.provisioningState === 'Succeeded') {
        return this.unchanged(
          request,
          resource(input.resourceKind, found.id, { parentProviderId: ctx.connection.scope?.id }),
        );
      }
    } else if (input.op === 'vm-action') {
      const found = await this.client.getResource(input.vmId);
      if (found?.powerState === input.expectedPowerState) {
        return this.unchanged(request, resource(VM_KIND, found.id, { parentProviderId: ctx.connection.scope?.id }));
      }
    } else if (!(await this.client.getResource(input.resourceId))) {
      return this.destroyed(request, input.hostId, input.resourceId);
    }

    if (request.previousProviderRequestId) {
      const operation = await this.client.getOperation(request.previousProviderRequestId);
      if (operation?.error || operation?.status === 'Failed' || operation?.status === 'Canceled') {
        throw new Error(
          `Azure operation '${request.previousProviderRequestId}' failed: ${operation.error?.message ?? operation.status}`,
        );
      }
      if (operation?.status === 'InProgress') return this.inProgress(request, operation.id);
    }
    return this.apply(request, ctx);
  }

  private snapshotApplied(
    request: WorkspaceHostApplyRequest,
    hostId: string,
    found: AzureArmResourceObservation,
    providerRequestId?: string,
  ): WorkspaceHostApplyResult {
    const snapshot: WorkspaceHostSnapshotRef = {
      target: AZURE_WORKSPACE_HOST_TARGET,
      providerId: found.id,
      hostId,
      createdAt: found.observedAt,
    };
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'applied',
      snapshot,
      observedAt: found.observedAt,
      providerRequestId,
    };
  }

  private snapshotUnchanged(
    request: WorkspaceHostApplyRequest,
    hostId: string,
    found: AzureArmResourceObservation,
  ): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'unchanged',
      observedAt: found.observedAt,
      snapshot: {
        target: AZURE_WORKSPACE_HOST_TARGET,
        providerId: found.id,
        hostId,
        createdAt: found.observedAt,
      },
    };
  }

  private applied(
    request: WorkspaceHostApplyRequest,
    appliedResource?: WorkspaceHostResourceRef,
    providerRequestId?: string,
  ): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'applied',
      observedAt: this.now(),
      providerRequestId,
      ...(appliedResource ? { resource: appliedResource } : {}),
    };
  }

  private unchanged(
    request: WorkspaceHostApplyRequest,
    unchangedResource?: WorkspaceHostResourceRef,
  ): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'unchanged',
      observedAt: this.now(),
      ...(unchangedResource ? { resource: unchangedResource } : {}),
    };
  }

  private inProgress(request: WorkspaceHostApplyRequest, providerRequestId?: string): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'in-progress',
      observedAt: this.now(),
      providerRequestId,
      retryAfterMs: 2_000,
    };
  }

  private destroyed(
    request: WorkspaceHostApplyRequest,
    hostId: string,
    providerResourceId: string,
    providerRequestId?: string,
  ): WorkspaceHostApplyResult {
    const observedAt = this.now();
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'destroyed',
      observedAt,
      providerRequestId,
      confirmation: {
        hostId,
        providerResourceId,
        confirmedAbsentAt: observedAt,
        source: 'provider-read',
        providerRequestId,
      },
    };
  }

  async observe(host: WorkspaceHostRef, _ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostObservation> {
    const observations = await Promise.all(host.resources.map((item) => this.client.getResource(item.providerId)));
    const vmIndex = host.resources.findIndex(
      (item) => item.target === AZURE_WORKSPACE_HOST_TARGET && item.kind === VM_KIND,
    );
    const vm = vmIndex >= 0 ? observations[vmIndex] : undefined;
    const drift: string[] = [];
    if (!vm) drift.push('vm-absent');
    host.resources.forEach((item, index) => {
      if (!observations[index]) drift.push(`${item.kind}-absent:${item.providerId}`);
    });
    const disks = host.resources.filter((item) => item.kind === DISK_KIND);
    for (const disk of disks) {
      if (vm && !(vm.attachedDataDiskIds ?? []).includes(disk.providerId)) {
        drift.push(`disk-detached:${disk.providerId}`);
      }
    }
    return {
      host,
      state: this.lifecycleState(vm),
      resources: host.resources.filter((_, index) => !!observations[index]),
      ...(vm?.imageId ? { image: { id: vm.imageId } } : {}),
      observedAt: this.now(),
      drift,
    };
  }

  private lifecycleState(vm: AzureArmResourceObservation | undefined): WorkspaceHostObservation['state'] {
    if (!vm) return 'absent';
    // Explicit three-way, not a `=== false` coercion: an UNMEASURED agent leaves the VM
    // 'running' (the lifecycle state describes the VM) and only a MEASURED false demotes it,
    // so this no longer silently disagrees with attestHealth about the same field (WI-2143924).
    if (vm.powerState === 'running') {
      if (vm.agentOnline === false) return 'degraded';
      return 'running';
    }
    if (vm.powerState === 'stopped' || vm.powerState === 'deallocated') return 'stopped';
    if (vm.powerState === 'deleting' || vm.provisioningState === 'Deleting') return 'destroying';
    if (vm.powerState === 'repairing') return 'repairing';
    return 'provisioning';
  }

  async getTransportProfile(
    host: WorkspaceHostRef,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostTransportProfile> {
    const vm = requireKnownResource(host.resources, [VM_KIND], 'get-transport-profile');
    const provider = ctx.connection.provider ?? {};
    const requested =
      optionalString(provider.transportPreference, 'Azure connection transportPreference') ?? 'azure-bastion-entra-ssh';
    if (!(AZURE_WORKSPACE_HOST_TRANSPORTS as readonly string[]).includes(requested)) {
      throw new Error(`Azure transportPreference must be one of ${AZURE_WORKSPACE_HOST_TRANSPORTS.join(', ')}`);
    }
    return buildAzureWorkspaceHostTransportProfile({
      kind: requested as AzureWorkspaceHostTransport,
      vmResourceId: vm.providerId,
      ...(provider.directAddress !== undefined
        ? { directAddress: requireString(provider.directAddress, 'Azure direct SSH address') }
        : {}),
      ...(provider.directSshSourceRanges !== undefined
        ? {
            directSshSourceRanges: stringArray(provider.directSshSourceRanges, 'Azure direct SSH source ranges', []),
          }
        : {}),
    });
  }

  async attestHealth(
    host: WorkspaceHostRef,
    _ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostHealthAttestation> {
    const vmRef = knownResource(host.resources, [VM_KIND]);
    const vm = vmRef ? await this.client.getResource(vmRef.providerId) : undefined;
    const running = vm?.powerState === 'running';
    const provisioned = vm?.provisioningState === 'Succeeded';
    // NOT `=== true`. `agentOnline` is optional and no Azure ARM client in this tree writes
    // it, so coercing it to a boolean made `healthy` unreachable and reported `degraded` for
    // hosts nothing had actually measured — the GCP defect in WI-2143924, same shape.
    const agentOnline = vm?.agentOnline ?? null;
    const checks: WorkspaceHostHealthCheck[] = [
      { name: 'azure-vm-running', ok: running, detail: vm?.powerState ?? 'absent' },
      { name: 'azure-provisioning-succeeded', ok: provisioned, detail: vm?.provisioningState ?? 'absent' },
      agentOnline === null
        ? unmeasuredHealthCheck('azure-vm-agent-online', 'no producer writes agentOnline on the Azure path')
        : { name: 'azure-vm-agent-online', ok: agentOnline },
    ];
    return {
      hostId: host.hostId,
      observedAt: this.now(),
      status: resolveWorkspaceHostHealthStatus({ reachable: running, checks }),
      ...(vm?.imageId ? { image: { id: vm.imageId } } : {}),
      checks,
    };
  }
}

export function createAzureWorkspaceHostProvider(
  options: AzureWorkspaceHostProviderOptions,
): AzureWorkspaceHostProvider {
  if (!options?.client) throw new Error('Azure workspace-host provider requires an injected ARM client');
  return new AzureWorkspaceHostProvider(options.client, { now: options.now });
}
