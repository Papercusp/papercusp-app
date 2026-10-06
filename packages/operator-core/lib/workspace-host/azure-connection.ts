import type { RefusalContract } from '../capability-envelope/refusal-contract-types';
import {
assertWorkspaceHostSecretIsolation,
  type CloudCredentialRef,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';

export const AZURE_WORKSPACE_HOST_TARGET = 'azure';
export const AZURE_WORKSPACE_HOST_PREFLIGHT_VERSION = 'azure-workspace-host-preflight-v1';

export type AzureCloudEnvironment = 'AzureCloud' | 'AzureChinaCloud' | 'AzureUSGovernment';

export interface AzureCloudEndpoints {
  authorityHost: string;
  managementEndpoint: string;
  managementScope: string;
}

export const AZURE_CLOUD_ENDPOINTS: Readonly<Record<AzureCloudEnvironment, AzureCloudEndpoints>> = {
  AzureCloud: {
    authorityHost: 'https://login.microsoftonline.com',
    managementEndpoint: 'https://management.azure.com',
    managementScope: 'https://management.azure.com/.default',
  },
  AzureChinaCloud: {
    authorityHost: 'https://login.chinacloudapi.cn',
    managementEndpoint: 'https://management.chinacloudapi.cn',
    managementScope: 'https://management.chinacloudapi.cn/.default',
  },
  AzureUSGovernment: {
    authorityHost: 'https://login.microsoftonline.us',
    managementEndpoint: 'https://management.usgovcloudapi.net',
    managementScope: 'https://management.usgovcloudapi.net/.default',
  },
};

export const AZURE_WORKSPACE_HOST_REQUIRED_PROVIDER_NAMESPACES = [
  'Microsoft.Compute',
  'Microsoft.Network',
  'Microsoft.ManagedIdentity',
  'Microsoft.KeyVault',
] as const;
export type AzureWorkspaceHostProviderNamespace =
  (typeof AZURE_WORKSPACE_HOST_REQUIRED_PROVIDER_NAMESPACES)[number];

/**
 * Resource types used by the workspace-host lifecycle. Azure Bastion is part
 * of Microsoft.Network rather than a separate resource-provider namespace.
 */
export const AZURE_WORKSPACE_HOST_REQUIRED_RESOURCE_TYPES = [
  'Microsoft.Compute/virtualMachines',
  'Microsoft.Compute/disks',
  'Microsoft.Compute/snapshots',
  'Microsoft.Compute/galleries/images/versions',
  'Microsoft.Network/virtualNetworks',
  'Microsoft.Network/subnets',
  'Microsoft.Network/networkInterfaces',
  'Microsoft.Network/networkSecurityGroups',
  'Microsoft.Network/publicIPAddresses',
  'Microsoft.Network/bastionHosts',
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  'Microsoft.KeyVault/vaults',
] as const;
export type AzureWorkspaceHostRequiredResourceType =
  (typeof AZURE_WORKSPACE_HOST_REQUIRED_RESOURCE_TYPES)[number];

/**
 * Narrow control-plane actions exercised by provision, retained-data
 * lifecycle, snapshots, managed identity, Key Vault encryption, and Bastion.
 * Data-plane Key Vault actions are intentionally separate from secret access.
 */
export const AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS = [
  'Microsoft.Resources/subscriptions/read',
  'Microsoft.Resources/subscriptions/resourceGroups/read',
  'Microsoft.Resources/subscriptions/resourceGroups/write',
  'Microsoft.Resources/subscriptions/resourceGroups/delete',
  'Microsoft.Resources/subscriptions/providers/read',
  'Microsoft.Resources/subscriptions/providers/register/action',
  'Microsoft.Compute/locations/usages/read',
  'Microsoft.Compute/skus/read',
  'Microsoft.Compute/images/read',
  'Microsoft.Compute/galleries/images/versions/read',
  'Microsoft.Compute/virtualMachines/read',
  'Microsoft.Compute/virtualMachines/write',
  'Microsoft.Compute/virtualMachines/delete',
  'Microsoft.Compute/virtualMachines/start/action',
  'Microsoft.Compute/virtualMachines/restart/action',
  'Microsoft.Compute/virtualMachines/deallocate/action',
  'Microsoft.Compute/disks/read',
  'Microsoft.Compute/disks/write',
  'Microsoft.Compute/disks/delete',
  'Microsoft.Compute/snapshots/read',
  'Microsoft.Compute/snapshots/write',
  'Microsoft.Compute/snapshots/delete',
  'Microsoft.Network/virtualNetworks/read',
  'Microsoft.Network/virtualNetworks/write',
  'Microsoft.Network/virtualNetworks/delete',
  'Microsoft.Network/virtualNetworks/subnets/read',
  'Microsoft.Network/virtualNetworks/subnets/write',
  'Microsoft.Network/virtualNetworks/subnets/join/action',
  'Microsoft.Network/networkInterfaces/read',
  'Microsoft.Network/networkInterfaces/write',
  'Microsoft.Network/networkInterfaces/delete',
  'Microsoft.Network/networkSecurityGroups/read',
  'Microsoft.Network/networkSecurityGroups/write',
  'Microsoft.Network/networkSecurityGroups/delete',
  'Microsoft.Network/publicIPAddresses/read',
  'Microsoft.Network/publicIPAddresses/write',
  'Microsoft.Network/publicIPAddresses/delete',
  'Microsoft.Network/bastionHosts/read',
  'Microsoft.Network/bastionHosts/connect/action',
  'Microsoft.ManagedIdentity/userAssignedIdentities/read',
  'Microsoft.ManagedIdentity/userAssignedIdentities/write',
  'Microsoft.ManagedIdentity/userAssignedIdentities/delete',
  'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action',
  'Microsoft.Authorization/roleAssignments/read',
  'Microsoft.Authorization/roleAssignments/write',
  'Microsoft.Authorization/roleAssignments/delete',
  'Microsoft.KeyVault/vaults/read',
  'Microsoft.KeyVault/vaults/write',
  'Microsoft.KeyVault/vaults/delete',
  'Microsoft.KeyVault/vaults/keys/read',
  'Microsoft.KeyVault/vaults/keys/wrap/action',
  'Microsoft.KeyVault/vaults/keys/unwrap/action',
] as const;
export type AzureWorkspaceHostPermissionAction = (typeof AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS)[number];

export type AzureWorkspaceHostCredentialSource =
  | {
      environment: 'local';
      method: 'default-credential';
      tenantId?: string;
    }
  | {
      environment: 'local';
      method: 'azure-cli';
      tenantId?: string;
    }
  | {
      environment: 'hosted';
      method: 'federated-service-principal';
      tenantId: string;
      clientId: string;
      issuer: string;
      audience: string;
      subject: string;
      /** Reference resolved at runtime to a short-lived external assertion. */
      assertionRef: string;
    }
  | {
      environment: 'hosted';
      method: 'managed-application';
      tenantId: string;
      applicationId: string;
      managedApplicationResourceId: string;
      managedIdentityResourceId?: string;
      authorizationAudience?: string;
    };

export interface AzureCredentialProviderPlan {
  sdk: '@azure/identity' | 'azure-resource-manager';
  factory:
    | 'DefaultAzureCredential'
    | 'AzureCliCredential'
    | 'ClientAssertionCredential'
    | 'ManagedApplicationListTokens';
  source:
    | 'default-chain'
    | 'azure-cli'
    | 'federated-service-principal'
    | 'managed-application-identity';
  tenantId?: string;
  clientId?: string;
  authorityHost: string;
  managementEndpoint: string;
  managementScope: string;
  federation?: {
    issuer: string;
    audience: string;
    subject: string;
    assertionRef: string;
  };
  managedApplication?: {
    applicationId: string;
    resourceId: string;
    managedIdentityResourceId?: string;
    authorizationAudience: string;
  };
}

export interface AzureWorkspaceHostQuotaRequirement {
  providerNamespace: 'Microsoft.Compute' | 'Microsoft.Network';
  resourceName: string;
  minimumAvailable: number;
  label: string;
}

export type AzureWorkspaceHostImageSelection =
  | {
      kind: 'compute-gallery';
      versionResourceId: string;
      architecture?: string;
      requireSigned?: boolean;
    }
  | {
      kind: 'marketplace';
      publisher: string;
      offer: string;
      sku: string;
      version: string;
      architecture?: string;
      plan?: {
        publisher: string;
        product: string;
        name: string;
      };
    };

export interface AzureWorkspaceHostSelection {
  cloud: AzureCloudEnvironment;
  tenantId: string;
  subscriptionId: string;
  resourceGroup: string;
  region: string;
  vmSku: string;
  architecture?: string;
  image: AzureWorkspaceHostImageSelection;
  quotas: readonly AzureWorkspaceHostQuotaRequirement[];
}

export interface AzureCallerIdentityEvidence {
  tenantId: string;
  principalId: string;
  principalType: 'user' | 'service-principal' | 'managed-identity' | 'unknown';
  clientId?: string;
  evidenceRef: string;
}

export interface AzureSubscriptionEvidence {
  id: string;
  tenantId: string;
  enabled: boolean;
  displayName?: string;
  evidenceRef: string;
}

export interface AzureResourceGroupEvidence {
  subscriptionId: string;
  name: string;
  exists: boolean;
  evidenceRef: string;
}

export interface AzureLocationEvidence {
  id: string;
  available: boolean;
  evidenceRef: string;
}

export interface AzureProviderResourceTypeEvidence {
  resourceType: string;
  locations: readonly string[];
  evidenceRef: string;
}

export interface AzureProviderRegistrationEvidence {
  namespace: string;
  registrationState: string;
  resourceTypes: readonly AzureProviderResourceTypeEvidence[];
  evidenceRef: string;
}

export interface AzureWorkspaceHostPermissionEvidence {
  action: AzureWorkspaceHostPermissionAction;
  allowed: boolean;
  evidenceRef: string;
  reason?: string;
}

export interface AzureWorkspaceHostQuotaEvidence extends AzureWorkspaceHostQuotaRequirement {
  limit: number;
  usage: number;
  evidenceRef: string;
}

export interface AzureVmSkuEvidence {
  name: string;
  region: string;
  available: boolean;
  architecture?: string;
  restrictions: readonly string[];
  evidenceRef: string;
}

export interface AzureImageEvidence {
  id: string;
  kind: AzureWorkspaceHostImageSelection['kind'];
  region: string;
  available: boolean;
  architecture?: string;
  signed?: boolean;
  evidenceRef: string;
}

export interface AzureWorkspaceHostPermissionRequest {
  actions: readonly AzureWorkspaceHostPermissionAction[];
  subscriptionId: string;
  resourceGroup: string;
  region: string;
}

/**
 * Adapter over Azure Resource Manager and authorization APIs. Implementations
 * construct SDK clients from the credential plan and return redacted evidence
 * references; credential or access-token bytes never enter this contract.
 */
export interface AzureWorkspaceHostPreflightClient {
  getCallerIdentity(): Promise<AzureCallerIdentityEvidence>;
  getSubscription(subscriptionId: string): Promise<AzureSubscriptionEvidence>;
  getResourceGroup(subscriptionId: string, resourceGroup: string): Promise<AzureResourceGroupEvidence>;
  getLocation(subscriptionId: string, region: string): Promise<AzureLocationEvidence>;
  getProviderRegistration(
    subscriptionId: string,
    namespace: AzureWorkspaceHostProviderNamespace,
  ): Promise<AzureProviderRegistrationEvidence>;
  evaluatePermissions(
    request: AzureWorkspaceHostPermissionRequest,
  ): Promise<readonly AzureWorkspaceHostPermissionEvidence[]>;
  getQuota(
    subscriptionId: string,
    region: string,
    requirement: AzureWorkspaceHostQuotaRequirement,
  ): Promise<AzureWorkspaceHostQuotaEvidence>;
  describeVmSku(subscriptionId: string, region: string, sku: string): Promise<AzureVmSkuEvidence>;
  describeImage(
    subscriptionId: string,
    region: string,
    image: AzureWorkspaceHostImageSelection,
  ): Promise<AzureImageEvidence>;
}

export interface AzureWorkspaceHostPreflightIssue {
  code:
    | 'tenant-mismatch'
    | 'subscription-unavailable'
    | 'resource-group-unavailable'
    | 'region-unavailable'
    | 'provider-unregistered'
    | 'resource-type-unavailable'
    | 'permission-denied'
    | 'permission-unverified'
    | 'quota-unverified'
    | 'quota-insufficient'
    | 'sku-unavailable'
    | 'sku-architecture-mismatch'
    | 'image-unavailable'
    | 'image-region-mismatch'
    | 'image-architecture-mismatch'
    | 'image-unsigned'
    | 'probe-failed';
  message: string;
  remediation: string;
  /** Present on fail-closed authority refusals (WI-10005197): what compared, what lifts it, who can. */
  refusal?: RefusalContract;
}

export interface AzureWorkspaceHostPreflightRequest {
  cloudCredentialRef: CloudCredentialRef;
  credentialSource: AzureWorkspaceHostCredentialSource;
  selection: AzureWorkspaceHostSelection;
  now?: () => string;
}

export interface AzureWorkspaceHostPreflightReport {
  version: typeof AZURE_WORKSPACE_HOST_PREFLIGHT_VERSION;
  ok: boolean;
  checkedAt: string;
  connection: WorkspaceHostProviderConnection;
  credentialProvider: AzureCredentialProviderPlan;
  identity?: AzureCallerIdentityEvidence;
  subscription?: AzureSubscriptionEvidence;
  resourceGroup?: AzureResourceGroupEvidence;
  location?: AzureLocationEvidence;
  providers: readonly AzureProviderRegistrationEvidence[];
  permissions: readonly AzureWorkspaceHostPermissionEvidence[];
  quotas: readonly AzureWorkspaceHostQuotaEvidence[];
  sku?: AzureVmSkuEvidence;
  image?: AzureImageEvidence;
  issues: readonly AzureWorkspaceHostPreflightIssue[];
}

const AZURE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AZURE_RESOURCE_GROUP = /^(?!.*\.$)[\p{L}\p{N}._()\-]{1,90}$/u;
const AZURE_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AZURE_VM_SKU = /^[A-Za-z0-9][A-Za-z0-9_\-]{0,79}$/;

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty`);
  return normalized;
}

function requireUuid(value: string, label: string): string {
  const normalized = value.trim();
  if (!AZURE_UUID.test(normalized)) throw new Error(`${label} must be an Azure UUID`);
  return normalized;
}

function requireHttpsUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return parsed.toString();
}

function requireAzureResourceId(value: string, providerPath: string, label: string): string {
  const normalized = value.trim();
  const expected = `/providers/${providerPath}/`;
  if (!normalized.startsWith('/') || !normalized.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`${label} must be an Azure resource ID under ${providerPath}`);
  }
  return normalized;
}

function credentialTenant(source: AzureWorkspaceHostCredentialSource): string | undefined {
  return source.tenantId;
}

/** Produce a non-secret Azure identity resolver plan without resolving a credential. */
export function planAzureCredentialProvider(
  source: AzureWorkspaceHostCredentialSource,
  cloud: AzureCloudEnvironment = 'AzureCloud',
): AzureCredentialProviderPlan {
  assertWorkspaceHostSecretIsolation(source, 'azure.credentialSource');
  const endpoints = AZURE_CLOUD_ENDPOINTS[cloud];
  if (!endpoints) throw new Error(`Unsupported Azure cloud environment '${cloud}'`);

  if (source.environment === 'local') {
    if (source.tenantId !== undefined) requireUuid(source.tenantId, 'tenantId');
    return {
      sdk: '@azure/identity',
      factory: source.method === 'default-credential' ? 'DefaultAzureCredential' : 'AzureCliCredential',
      source: source.method === 'default-credential' ? 'default-chain' : 'azure-cli',
      tenantId: source.tenantId,
      ...endpoints,
    };
  }

  const tenantId = requireUuid(source.tenantId, 'tenantId');
  if (source.method === 'federated-service-principal') {
    const clientId = requireUuid(source.clientId, 'clientId');
    const issuer = requireHttpsUrl(source.issuer, 'federated issuer');
    const audience = nonEmpty(source.audience, 'federated audience');
    const subject = nonEmpty(source.subject, 'federated subject');
    const assertionRef = nonEmpty(source.assertionRef, 'assertionRef');
    return {
      sdk: '@azure/identity',
      factory: 'ClientAssertionCredential',
      source: 'federated-service-principal',
      tenantId,
      clientId,
      ...endpoints,
      federation: { issuer, audience, subject, assertionRef },
    };
  }

  const applicationId = requireUuid(source.applicationId, 'applicationId');
  const resourceId = requireAzureResourceId(
    source.managedApplicationResourceId,
    'Microsoft.Solutions/applications',
    'managedApplicationResourceId',
  );
  const managedIdentityResourceId = source.managedIdentityResourceId === undefined
    ? undefined
    : requireAzureResourceId(
      source.managedIdentityResourceId,
      'Microsoft.ManagedIdentity/userAssignedIdentities',
      'managedIdentityResourceId',
    );
  const authorizationAudience = source.authorizationAudience === undefined
    ? `${endpoints.managementEndpoint}/`
    : requireHttpsUrl(source.authorizationAudience, 'authorizationAudience');
  return {
    sdk: 'azure-resource-manager',
    factory: 'ManagedApplicationListTokens',
    source: 'managed-application-identity',
    tenantId,
    clientId: applicationId,
    ...endpoints,
    managedApplication: {
      applicationId,
      resourceId,
      managedIdentityResourceId,
      authorizationAudience,
    },
  };
}

function validateImage(image: AzureWorkspaceHostImageSelection): void {
  if (image.kind === 'compute-gallery') {
    requireAzureResourceId(
      image.versionResourceId,
      'Microsoft.Compute/galleries',
      'image.versionResourceId',
    );
    return;
  }
  nonEmpty(image.publisher, 'image.publisher');
  nonEmpty(image.offer, 'image.offer');
  nonEmpty(image.sku, 'image.sku');
  nonEmpty(image.version, 'image.version');
  if (image.plan) {
    nonEmpty(image.plan.publisher, 'image.plan.publisher');
    nonEmpty(image.plan.product, 'image.plan.product');
    nonEmpty(image.plan.name, 'image.plan.name');
  }
}

export function buildAzureWorkspaceHostProviderConnection(
  request: AzureWorkspaceHostPreflightRequest,
): WorkspaceHostProviderConnection {
  if (request.cloudCredentialRef.kind !== 'cloud') {
    throw new Error('Azure cloud credential reference must be typed as cloud');
  }
  nonEmpty(request.cloudCredentialRef.ref, 'cloudCredentialRef.ref');
  requireUuid(request.selection.tenantId, 'selection.tenantId');
  requireUuid(request.selection.subscriptionId, 'selection.subscriptionId');
  if (!AZURE_RESOURCE_GROUP.test(request.selection.resourceGroup)) {
    throw new Error('resourceGroup must be a valid Azure resource-group name');
  }
  if (!AZURE_REGION.test(request.selection.region)) throw new Error('region must be an Azure region identifier');
  if (!AZURE_VM_SKU.test(request.selection.vmSku)) throw new Error('vmSku must be a valid Azure VM SKU');
  if (!request.selection.quotas.length) throw new Error('At least one Azure quota must be preflighted');
  request.selection.quotas.forEach((quota) => {
    nonEmpty(quota.resourceName, 'quota.resourceName');
    nonEmpty(quota.label, 'quota.label');
    if (!Number.isFinite(quota.minimumAvailable) || quota.minimumAvailable < 0) {
      throw new Error('quota.minimumAvailable must be a non-negative finite number');
    }
  });
  validateImage(request.selection.image);

  const sourceTenant = credentialTenant(request.credentialSource);
  if (sourceTenant && sourceTenant.toLowerCase() !== request.selection.tenantId.toLowerCase()) {
    throw new Error('Selected tenantId must match the Azure credential source tenant');
  }
  planAzureCredentialProvider(request.credentialSource, request.selection.cloud);

  const connection: WorkspaceHostProviderConnection = {
    target: AZURE_WORKSPACE_HOST_TARGET,
    cloudCredentialRef: request.cloudCredentialRef,
    scope: { kind: 'subscription', id: request.selection.subscriptionId },
    provider: {
      preflightVersion: AZURE_WORKSPACE_HOST_PREFLIGHT_VERSION,
      credentialSource: request.credentialSource,
      cloud: request.selection.cloud,
      tenantId: request.selection.tenantId,
      resourceGroup: request.selection.resourceGroup,
      region: request.selection.region,
      vmSku: request.selection.vmSku,
      architecture: request.selection.architecture,
      image: request.selection.image,
    },
  };
  assertWorkspaceHostSecretIsolation(connection, 'azure.connection');
  return connection;
}

type ProbeResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function probe<T>(run: () => Promise<T>): Promise<ProbeResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function probeIssue(label: string, result: ProbeResult<unknown>): AzureWorkspaceHostPreflightIssue | undefined {
  if (result.ok) return undefined;
  return {
    code: 'probe-failed',
    message: `${label} probe failed: ${result.message}`,
    remediation: `Resolve the Azure ${label} API or credential error, then rerun preflight.`,
  };
}

function same(value: string, expected: string): boolean {
  return value.toLowerCase() === expected.toLowerCase();
}

function imageSelectionId(image: AzureWorkspaceHostImageSelection): string {
  return image.kind === 'compute-gallery'
    ? image.versionResourceId
    : `${image.publisher}:${image.offer}:${image.sku}:${image.version}`;
}

/** Run a fail-closed, read-only onboarding preflight through an injected Azure adapter. */
export async function preflightAzureWorkspaceHostConnection(
  request: AzureWorkspaceHostPreflightRequest,
  client: AzureWorkspaceHostPreflightClient,
): Promise<AzureWorkspaceHostPreflightReport> {
  const credentialProvider = planAzureCredentialProvider(request.credentialSource, request.selection.cloud);
  const connection = buildAzureWorkspaceHostProviderConnection(request);
  const now = request.now ?? (() => new Date().toISOString());

  const [identity, subscription, resourceGroup, location, permissions, sku, image, providers, quotas] =
    await Promise.all([
      probe(() => client.getCallerIdentity()),
      probe(() => client.getSubscription(request.selection.subscriptionId)),
      probe(() => client.getResourceGroup(request.selection.subscriptionId, request.selection.resourceGroup)),
      probe(() => client.getLocation(request.selection.subscriptionId, request.selection.region)),
      probe(() => client.evaluatePermissions({
        actions: AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS,
        subscriptionId: request.selection.subscriptionId,
        resourceGroup: request.selection.resourceGroup,
        region: request.selection.region,
      })),
      probe(() => client.describeVmSku(
        request.selection.subscriptionId,
        request.selection.region,
        request.selection.vmSku,
      )),
      probe(() => client.describeImage(
        request.selection.subscriptionId,
        request.selection.region,
        request.selection.image,
      )),
      Promise.all(AZURE_WORKSPACE_HOST_REQUIRED_PROVIDER_NAMESPACES.map((namespace) =>
        probe(() => client.getProviderRegistration(request.selection.subscriptionId, namespace)))),
      Promise.all(request.selection.quotas.map((requirement) =>
        probe(() => client.getQuota(request.selection.subscriptionId, request.selection.region, requirement)))),
    ] as const);

  const issues: AzureWorkspaceHostPreflightIssue[] = [];
  [
    probeIssue('identity', identity),
    probeIssue('subscription', subscription),
    probeIssue('resource group', resourceGroup),
    probeIssue('region', location),
    probeIssue('permission', permissions),
    probeIssue('VM SKU', sku),
    probeIssue('image', image),
    ...providers.map((result, index) => probeIssue(
      `provider '${AZURE_WORKSPACE_HOST_REQUIRED_PROVIDER_NAMESPACES[index] ?? index}'`,
      result,
    )),
    ...quotas.map((result, index) => probeIssue(
      `quota '${request.selection.quotas[index]?.label ?? index}'`,
      result,
    )),
  ].forEach((issue) => { if (issue) issues.push(issue); });

  if (identity.ok && !same(identity.value.tenantId, request.selection.tenantId)) {
    issues.push({
      code: 'tenant-mismatch',
      message: `Resolved Azure tenant '${identity.value.tenantId}' does not match '${request.selection.tenantId}'.`,
      remediation: 'Select the intended tenant with DefaultAzureCredential/Azure CLI or the hosted delegation.',
    });
  }
  if (
    subscription.ok &&
    (!same(subscription.value.id, request.selection.subscriptionId) || !subscription.value.enabled)
  ) {
    issues.push({
      code: 'subscription-unavailable',
      message: `Azure subscription '${request.selection.subscriptionId}' is unavailable or disabled.`,
      remediation: 'Select an enabled subscription visible to the resolved principal.',
    });
  }
  if (subscription.ok && !same(subscription.value.tenantId, request.selection.tenantId)) {
    issues.push({
      code: 'tenant-mismatch',
      message: `Subscription tenant '${subscription.value.tenantId}' does not match '${request.selection.tenantId}'.`,
      remediation: 'Use a subscription and credential from the same customer tenant.',
    });
  }
  if (
    resourceGroup.ok &&
    (
      !resourceGroup.value.exists ||
      !same(resourceGroup.value.subscriptionId, request.selection.subscriptionId) ||
      !same(resourceGroup.value.name, request.selection.resourceGroup)
    )
  ) {
    issues.push({
      code: 'resource-group-unavailable',
      message: `Resource group '${request.selection.resourceGroup}' is unavailable in the selected subscription.`,
      remediation: 'Choose an existing resource group or grant the narrow scope needed to create it.',
    });
  }
  if (location.ok && (!location.value.available || !same(location.value.id, request.selection.region))) {
    issues.push({
      code: 'region-unavailable',
      message: `Azure region '${request.selection.region}' is unavailable for the selected subscription.`,
      remediation: 'Choose an enabled Azure region supported by the required resources.',
    });
  }

  const providerValues = providers.flatMap((result) => result.ok ? [result.value] : []);
  for (const namespace of AZURE_WORKSPACE_HOST_REQUIRED_PROVIDER_NAMESPACES) {
    const evidence = providerValues.find((entry) => same(entry.namespace, namespace));
    if (!evidence) continue;
    const state = evidence.registrationState.toLowerCase();
    if (state !== 'registered' && state !== 'registering') {
      issues.push({
        code: 'provider-unregistered',
        message: `Azure resource provider '${namespace}' is '${evidence.registrationState}'.`,
        remediation: `Register only '${namespace}' for this subscription, then rerun preflight.`,
      });
    }

    for (const requiredType of AZURE_WORKSPACE_HOST_REQUIRED_RESOURCE_TYPES) {
      if (!requiredType.toLowerCase().startsWith(`${namespace.toLowerCase()}/`)) continue;
      const typeEvidence = evidence.resourceTypes.find((entry) => same(entry.resourceType, requiredType));
      const supportsRegion = typeEvidence?.locations.some((entry) => same(entry, request.selection.region));
      if (!typeEvidence || !supportsRegion) {
        issues.push({
          code: 'resource-type-unavailable',
          message: `Azure resource type '${requiredType}' is unavailable in '${request.selection.region}'.`,
          remediation: `Choose a region supported by '${requiredType}' or remove the dependent capability.`,
        });
      }
    }
  }

  const permissionValues = permissions.ok ? permissions.value : [];
  const permissionByAction = new Map(permissionValues.map((entry) => [entry.action, entry]));
  for (const action of AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS) {
    const evidence = permissionByAction.get(action);
    if (!evidence) {
      issues.push({
        code: 'permission-unverified',
        message: `Azure permission '${action}' was not evaluated.`,
        remediation: 'Evaluate every required action at the selected subscription/resource-group scope.',
      });
    } else if (!evidence.allowed) {
      issues.push({
        code: 'permission-denied',
        message: `Azure permission '${action}' is denied${evidence.reason ? `: ${evidence.reason}` : '.'}`,
        remediation: `Grant '${action}' at the narrowest applicable subscription or resource-group scope.`,
        refusal: {
          observed: { action, allowed: 'false', reason: evidence.reason ?? null },
          liftsWhen:
            `the selected principal is granted '${action}' at the subscription/resource-group scope (an Azure ` +
            'administrator assigns the role) and the preflight is re-run. Re-running unchanged cannot pass',
          whoCanMakeItTrue: ['owner'],
        } satisfies RefusalContract,
      });
    }
  }

  const quotaValues = quotas.flatMap((result) => result.ok ? [result.value] : []);
  for (const required of request.selection.quotas) {
    const evidence = quotaValues.find((entry) =>
      same(entry.providerNamespace, required.providerNamespace) && same(entry.resourceName, required.resourceName));
    if (!evidence) {
      issues.push({
        code: 'quota-unverified',
        message: `Azure quota '${required.label}' was not verified.`,
        remediation: 'Grant quota/usage read access and rerun preflight for the selected region.',
      });
    } else if (evidence.limit - evidence.usage < required.minimumAvailable) {
      issues.push({
        code: 'quota-insufficient',
        message: `Azure quota '${required.label}' has ${evidence.limit - evidence.usage} available; ` +
          `${required.minimumAvailable} is required.`,
        remediation: 'Request a quota increase, free capacity, or select a smaller workspace-host profile.',
      });
    }
  }

  if (
    sku.ok &&
    (
      !sku.value.available ||
      !same(sku.value.name, request.selection.vmSku) ||
      !same(sku.value.region, request.selection.region) ||
      sku.value.restrictions.length > 0
    )
  ) {
    issues.push({
      code: 'sku-unavailable',
      message: `Azure VM SKU '${request.selection.vmSku}' is unavailable in '${request.selection.region}'.`,
      remediation: 'Choose an unrestricted VM SKU returned for the selected subscription and region.',
    });
  }
  if (
    sku.ok &&
    request.selection.architecture &&
    sku.value.architecture &&
    !same(sku.value.architecture, request.selection.architecture)
  ) {
    issues.push({
      code: 'sku-architecture-mismatch',
      message: `Azure VM SKU architecture '${sku.value.architecture}' does not match ` +
        `'${request.selection.architecture}'.`,
      remediation: 'Choose a VM SKU with the intended architecture.',
    });
  }

  if (
    image.ok &&
    (
      !image.value.available ||
      image.value.kind !== request.selection.image.kind ||
      !same(image.value.id, imageSelectionId(request.selection.image))
    )
  ) {
    issues.push({
      code: 'image-unavailable',
      message: `Azure image '${imageSelectionId(request.selection.image)}' is unavailable.`,
      remediation: 'Choose an accessible Marketplace image or replicated Azure Compute Gallery version.',
    });
  }
  if (image.ok && !same(image.value.region, request.selection.region)) {
    issues.push({
      code: 'image-region-mismatch',
      message: `Azure image region '${image.value.region}' does not match '${request.selection.region}'.`,
      remediation: 'Replicate the gallery version or select an image available in the target region.',
    });
  }
  const requestedArchitecture = request.selection.architecture ?? request.selection.image.architecture;
  if (
    image.ok &&
    requestedArchitecture &&
    image.value.architecture &&
    !same(image.value.architecture, requestedArchitecture)
  ) {
    issues.push({
      code: 'image-architecture-mismatch',
      message: `Azure image architecture '${image.value.architecture}' does not match '${requestedArchitecture}'.`,
      remediation: 'Choose an image version matching the intended VM architecture.',
    });
  }
  if (
    image.ok &&
    request.selection.image.kind === 'compute-gallery' &&
    request.selection.image.requireSigned &&
    image.value.signed !== true
  ) {
    issues.push({
      code: 'image-unsigned',
      message: `Azure Compute Gallery image '${request.selection.image.versionResourceId}' lacks signed provenance.`,
      remediation: 'Publish and select a signed, attested gallery image version before beta use.',
    });
  }

  const report: AzureWorkspaceHostPreflightReport = {
    version: AZURE_WORKSPACE_HOST_PREFLIGHT_VERSION,
    ok: issues.length === 0,
    checkedAt: now(),
    connection,
    credentialProvider,
    identity: identity.ok ? identity.value : undefined,
    subscription: subscription.ok ? subscription.value : undefined,
    resourceGroup: resourceGroup.ok ? resourceGroup.value : undefined,
    location: location.ok ? location.value : undefined,
    providers: providerValues,
    permissions: permissionValues,
    quotas: quotaValues,
    sku: sku.ok ? sku.value : undefined,
    image: image.ok ? image.value : undefined,
    issues,
  };
  assertWorkspaceHostSecretIsolation(report, 'azure.preflightReport');
  return report;
}
