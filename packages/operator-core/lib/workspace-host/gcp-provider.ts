import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
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
  WORKSPACE_HOST_DATA_ROOT,
} from '@papercusp/deployment-driver';
import {
  GCP_CLOUD_PLATFORM_SCOPE,
  createGcpWorkspaceHostAcquireAuth,
  type GcpResolvedAuth,
} from '../cloud-workspaces/gcp-preflight';
import { createGcpWorkspaceHostApiClient, type GcpWorkspaceHostApiClientOptions } from './gcp-api-client';
import { assertGcpImmutableImageId } from './gcp-image-family';
import {
  GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS,
  gcpWorkspaceHostLabelValue,
  type GcpManagedWorkspaceHostResourceObservation,
  type GcpWorkspaceHostInventoryEvidence,
} from './gcp-safety';

export { createGcpWorkspaceHostApiClient, GoogleComputeWorkspaceHostApiClient } from './gcp-api-client';
export type { GcpWorkspaceHostApiClientOptions } from './gcp-api-client';

export { GCP_CLOUD_PLATFORM_SCOPE };

export const GCP_WORKSPACE_HOST_TARGET = 'gcp';
export const GCP_WORKSPACE_HOST_PROVIDER_VERSION = 'gcp-workspace-host-provider-v1';
export const GCP_IAP_TCP_FORWARDING_RANGE = '35.235.240.0/20';
export const GCP_DATA_DISK_RESIZE_POLICY = 'grow-only';
export const GCP_DATA_MOUNT_POINT = '/var/lib/papercusp';

export type GcpComputeInstanceStatus =
  | 'PROVISIONING'
  | 'STAGING'
  | 'RUNNING'
  | 'STOPPING'
  | 'SUSPENDING'
  | 'SUSPENDED'
  | 'REPAIRING'
  | 'TERMINATED';
export type GcpComputeDiskStatus = 'CREATING' | 'RESTORING' | 'READY' | 'FAILED' | 'DELETING';
export type GcpComputeSnapshotStatus = 'CREATING' | 'READY' | 'FAILED' | 'DELETING';
export type GcpOperationScope = 'global' | 'region' | 'zone';

export interface GcpOperationRef {
  name: string;
  projectId: string;
  scope: GcpOperationScope;
  location?: string;
  requestId: string;
}

export interface GcpOperationObservation extends GcpOperationRef {
  status: 'PENDING' | 'RUNNING' | 'DONE';
  observedAt: string;
  error?: { code?: string; message: string };
}

export interface GcpResourceObservation {
  name: string;
  selfLink?: string;
  observedAt: string;
  labels?: Readonly<Record<string, string>>;
}

export interface GcpFirewallObservation extends GcpResourceObservation {
  direction: 'INGRESS';
  sourceRanges: readonly string[];
  targetTags: readonly string[];
  allowed: readonly [{ IPProtocol: 'tcp'; ports: readonly string[] }];
}

export interface GcpInstanceObservation extends GcpResourceObservation {
  status: GcpComputeInstanceStatus;
  /** GCE numeric id: fresh on every insert, so it tells two incarnations of one name apart. */
  instanceId?: string;
  metadataFingerprint?: string;
  sourceImage?: string;
  attachedDiskNames: readonly string[];
  internalIp?: string;
  externalIp?: string;
  defguardIp?: string;
  agentOnline?: boolean;
  recreateInput?: GcpInstanceInsertInput;
}

export interface GcpDiskObservation extends GcpResourceObservation {
  status: GcpComputeDiskStatus;
  attachedInstanceNames: readonly string[];
  sizeGb?: number;
}

export interface GcpSnapshotObservation extends GcpResourceObservation {
  status: GcpComputeSnapshotStatus;
  /** Name of the disk the snapshot was taken from, when GCP still reports it. */
  sourceDisk?: string;
  /** GCP creationTimestamp — the recovery point's real time, unlike the read-time `observedAt`. */
  createdAt?: string;
}

export interface GcpNetworkInsertInput {
  name: string;
  autoCreateSubnetworks: false;
  routingConfig: { routingMode: 'REGIONAL' };
}

export interface GcpSubnetworkInsertInput {
  name: string;
  network: string;
  ipCidrRange: string;
  region: string;
  privateIpGoogleAccess: true;
  stackType: 'IPV4_ONLY';
}

export interface GcpRouterInsertInput {
  name: string;
  network: string;
  region: string;
}

export interface GcpNatInsertInput {
  name: string;
  routerName: string;
  network: string;
  subnetwork: string;
  region: string;
  natIpAllocateOption: 'AUTO_ONLY';
  sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS';
  minPortsPerVm: 64;
  enableEndpointIndependentMapping: false;
}

export interface GcpNatObservation extends GcpResourceObservation {
  routerName: string;
  network: string;
  subnetwork: string;
  region: string;
  natIpAllocateOption: 'AUTO_ONLY';
  sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS';
}

export interface GcpRouterObservation extends GcpResourceObservation {
  network: string;
  region: string;
  natNames: readonly string[];
}

export interface GcpWorkspaceHostInventoryRequest {
  projectId: string;
  region: string;
  workspaceId: string;
  deterministicNames: {
    networks: readonly string[];
    subnetworks: readonly string[];
    firewalls: readonly string[];
    routers: readonly string[];
    nats: readonly { routerName: string; name: string }[];
  };
}

export interface GcpWorkspaceHostInventorySnapshot {
  complete: true;
  observed: readonly GcpManagedWorkspaceHostResourceObservation[];
  inventoryEvidence: readonly GcpWorkspaceHostInventoryEvidence[];
}

export interface GcpFirewallInsertInput {
  name: string;
  network: string;
  direction: 'INGRESS';
  sourceRanges: readonly string[];
  targetTags: readonly string[];
  allowed: readonly [{ IPProtocol: 'tcp'; ports: readonly string[] }];
}

export interface GcpDiskInsertInput {
  name: string;
  zone: string;
  sizeGb: number;
  type: string;
  labels: Readonly<Record<string, string>>;
  sourceSnapshot?: string;
  sourceSnapshotEncryptionKey?: { kmsKeyName: string };
  diskEncryptionKey?: { kmsKeyName: string };
}

export interface GcpInstanceInsertInput {
  name: string;
  zone: string;
  machineType: string;
  labels: Readonly<Record<string, string>>;
  tags: { items: readonly string[] };
  networkInterfaces: readonly [
    {
      network: string;
      subnetwork: string;
      stackType: 'IPV4_ONLY';
      accessConfigs?: readonly [{ name: 'External NAT'; type: 'ONE_TO_ONE_NAT'; networkTier: 'PREMIUM' }];
    },
  ];
  disks: readonly [
    {
      boot: true;
      autoDelete: true;
      initializeParams: {
        sourceImage: string;
        diskSizeGb: number;
        diskType: string;
        diskEncryptionKey?: { kmsKeyName: string };
      };
    },
    {
      boot: false;
      autoDelete: false;
      source: string;
      deviceName: string;
      mode: 'READ_WRITE';
    },
  ];
  /** Absent = the instance holds no cloud identity at all (Papercusp-hosted hosts, D-399). */
  serviceAccounts?: readonly [{ email: string; scopes: readonly string[] }];
  metadata: { items: readonly { key: string; value: string }[] };
}

/**
 * The permissions GCP checks on `instances.insert` for THIS request: one per field it sets
 * (cloud.google.com/compute/docs/access/iam-permissions, instances.insert). Every role that must
 * create a host is pinned to it by test — a hand-kept list lacked `setTags`, so every
 * Papercusp-hosted create was refused 403. `iam.serviceAccounts.actAs` is checked on the attached
 * account, not the project.
 */
export function gcpInstanceInsertPermissions(request: GcpInstanceInsertInput): string[] {
  const permissions = new Set(['compute.instances.create']);
  if (Object.keys(request.labels).length > 0) permissions.add('compute.instances.setLabels');
  if (request.tags.items.length > 0) permissions.add('compute.instances.setTags');
  if (request.metadata.items.length > 0) permissions.add('compute.instances.setMetadata');
  if (request.serviceAccounts?.length) {
    permissions.add('compute.instances.setServiceAccount');
    permissions.add('iam.serviceAccounts.actAs');
  }
  for (const nic of request.networkInterfaces) {
    permissions.add('compute.subnetworks.use');
    if (nic.accessConfigs?.length) permissions.add('compute.subnetworks.useExternalIp');
  }
  for (const disk of request.disks) {
    if ('initializeParams' in disk) {
      permissions.add('compute.disks.create');
      permissions.add('compute.images.useReadOnly');
    } else {
      permissions.add('compute.disks.use');
    }
  }
  return [...permissions].sort();
}

export interface GcpInstanceMetadataInput {
  fingerprint: string;
  items: readonly { key: string; value: string }[];
}

export interface GcpSnapshotInsertInput {
  name: string;
  sourceDisk: string;
  labels: Readonly<Record<string, string>>;
  snapshotEncryptionKey?: { kmsKeyName: string };
}

export interface GcpInstanceGuestAttribute {
  namespace: string;
  key: string;
  value: string;
}

/**
 * Compute Engine REST-shaped seam. The production composition owns ADC/token
 * resolution; this provider accepts only non-secret connection references and
 * never manufactures a live client implicitly.
 */
export interface GcpWorkspaceHostApiClient {
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
  /** Read the immutable source image's minimum boot-disk size before planning mutations. */
  getImageDiskSizeGb(imageId: string): Promise<number>;
  estimatePrice(
    desired: WorkspaceHostDesiredSpec,
    connection: WorkspaceHostProviderConnection,
  ): Promise<WorkspaceHostPriceEstimate>;
  inventoryManagedResources(request: GcpWorkspaceHostInventoryRequest): Promise<GcpWorkspaceHostInventorySnapshot>;

  getNetwork(projectId: string, name: string): Promise<GcpResourceObservation | undefined>;
  getSubnetwork(projectId: string, region: string, name: string): Promise<GcpResourceObservation | undefined>;
  getFirewall(projectId: string, name: string): Promise<GcpFirewallObservation | undefined>;
  getRouter(projectId: string, region: string, name: string): Promise<GcpRouterObservation | undefined>;
  getNat(projectId: string, region: string, routerName: string, name: string): Promise<GcpNatObservation | undefined>;
  getDisk(projectId: string, zone: string, name: string): Promise<GcpDiskObservation | undefined>;
  getInstance(projectId: string, zone: string, name: string): Promise<GcpInstanceObservation | undefined>;
  getInstanceGuestAttributes(
    projectId: string,
    zone: string,
    name: string,
    queryPath: string,
  ): Promise<readonly GcpInstanceGuestAttribute[]>;
  getSnapshot(projectId: string, name: string): Promise<GcpSnapshotObservation | undefined>;

  insertNetwork(projectId: string, input: GcpNetworkInsertInput, requestId: string): Promise<GcpOperationRef>;
  insertSubnetwork(
    projectId: string,
    region: string,
    input: GcpSubnetworkInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef>;
  insertFirewall(projectId: string, input: GcpFirewallInsertInput, requestId: string): Promise<GcpOperationRef>;
  insertRouter(
    projectId: string,
    region: string,
    input: GcpRouterInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef>;
  insertNat(projectId: string, region: string, input: GcpNatInsertInput, requestId: string): Promise<GcpOperationRef>;
  insertDisk(projectId: string, zone: string, input: GcpDiskInsertInput, requestId: string): Promise<GcpOperationRef>;
  insertInstance(
    projectId: string,
    zone: string,
    input: GcpInstanceInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef>;
  createSnapshot(
    projectId: string,
    zone: string,
    input: GcpSnapshotInsertInput,
    requestId: string,
  ): Promise<GcpOperationRef>;

  startInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  stopInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  resetInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  setInstanceMetadata(
    projectId: string,
    zone: string,
    name: string,
    input: GcpInstanceMetadataInput,
    requestId: string,
  ): Promise<GcpOperationRef>;
  deleteInstance(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteDisk(projectId: string, zone: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteFirewall(projectId: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteNat(
    projectId: string,
    region: string,
    routerName: string,
    name: string,
    requestId: string,
  ): Promise<GcpOperationRef>;
  deleteRouter(projectId: string, region: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteSubnetwork(projectId: string, region: string, name: string, requestId: string): Promise<GcpOperationRef>;
  deleteNetwork(projectId: string, name: string, requestId: string): Promise<GcpOperationRef>;
  waitForOperation(operation: GcpOperationRef, signal?: AbortSignal): Promise<GcpOperationObservation>;
}

/**
 * A resource the provider actually brought into existence, reported at the exact moment its
 * creation was confirmed durable. This is the PRODUCING half of the teardown-obligation ledger:
 * `cloud-resource-obligations.ts` builds the table, the sweep and the escalation, but nothing
 * writes a row unless a creation path reports through here. An unwired observer makes that
 * ledger's silence indistinguishable from "no leaks" (WI-10001672).
 */
export interface WorkspaceHostResourceCreatedEvent {
  readonly resource: WorkspaceHostResourceRef;
  readonly operationId: string;
  readonly stepId: string;
  /**
   * Taken from the live apply context, never captured at construction: one provider instance
   * serves many workspaces, so binding a workspace at wiring time would file every resource
   * under whichever workspace happened to compose the provider.
   */
  readonly workspaceId: string;
  /**
   * The workspace-host this resource was created FOR — per-EVENT for exactly the reason
   * `workspaceId` above is. WI-10001673: this was first modeled on the observer BINDING, which
   * is constructed once in `dbos/bootstrap.ts` where no host is in scope, so the field silently
   * spread to nothing and every row was born with `host_id=''`. Measured 2026-09-17: all 23 rows
   * created after migration 1168 — the migration that ADDED the column — carried an empty one.
   * An obligation row is ADDRESSED, not named: every GCP delete step carries `hostId` and the
   * provider asserts the target's managed-label identity against it before deleting, so a row
   * without one can be escalated but never reclaimed.
   */
  readonly hostId: string;
  /**
   * The enclosing resource this one is addressed THROUGH, when its delete op takes one: a Cloud
   * NAT is deleted via its owning Cloud Router (`delete-nat` takes `routerName`). Empty for every
   * kind addressed directly. Derived from the step input, because the generic
   * `WorkspaceHostResourceRef` carries the project and region but not a GCP-specific parent.
   */
  readonly parentResourceId: string;
}

/**
 * Errors PROPAGATE and fail the apply step on purpose: an unregistered metered resource is the
 * exact defect this seam exists to prevent, so a failed ledger write must be loud rather than
 * leaving a billable resource nothing is tracking. Retry is safe — the underlying recorder is
 * idempotent for the same provider incarnation; a recreated same-name resource reopens its
 * obligation under the fresh provider identity.
 */
export type WorkspaceHostResourceCreatedObserver = (
  event: WorkspaceHostResourceCreatedEvent,
) => Promise<void> | void;

/**
 * The consuming mirror of `WorkspaceHostResourceCreatedObserver`, fired when a delete step is
 * CONFIRMED by a provider read. Carries the provider's own `deleteOp` rather than a resource
 * kind: the op<->kind mapping is owned once by `CLOUD_RESOURCE_DELETE_CONTRACT` in
 * cloud-resource-obligations, so the consumer resolves it there instead of this file keeping a
 * second copy that can drift.
 */
export type WorkspaceHostResourceDestroyedObserver = (
  event: {
    readonly resource: { readonly deleteOp: string; readonly providerId: string; readonly incarnationId?: string };
    readonly workspaceId: string;
  },
) => Promise<void> | void;

export interface GcpWorkspaceHostProviderOptions {
  client: GcpWorkspaceHostApiClient;
  now?: () => string;
  onResourceCreated?: WorkspaceHostResourceCreatedObserver;
  onResourceDestroyed?: WorkspaceHostResourceDestroyedObserver;
}

interface ManagedNetworkSettings {
  mode: 'managed';
  networkName: string;
  subnetworkName: string;
  firewallName: string;
  routerName: string;
  natName: string;
  ipCidrRange: string;
}

interface ExistingNetworkSettings {
  mode: 'existing';
  networkName: string;
  subnetworkName: string;
  firewallName?: string;
}

export const GCP_WORKSPACE_HOST_TRANSPORTS = ['gcp-iap-ssh', 'gcp-direct-ssh', 'defguard-ssh'] as const;
export type GcpWorkspaceHostTransport = (typeof GCP_WORKSPACE_HOST_TRANSPORTS)[number];

interface GcpIapAccessSettings {
  kind: 'gcp-iap-ssh';
  firewallRequired: true;
  sourceRanges: readonly [typeof GCP_IAP_TCP_FORWARDING_RANGE];
  externalIp: false;
}

interface GcpDirectSshAccessSettings {
  kind: 'gcp-direct-ssh';
  firewallRequired: true;
  sourceRanges: readonly string[];
  externalIp: true;
}

interface GcpDefguardAccessSettings {
  kind: 'defguard-ssh';
  firewallRequired: false;
  sourceRanges: readonly [];
  externalIp: false;
}

type GcpAccessSettings = GcpIapAccessSettings | GcpDirectSshAccessSettings | GcpDefguardAccessSettings;

export interface GcpWorkspaceHostDesiredProviderSettings {
  projectId: string;
  zone: string;
  imageId: string;
  network: ManagedNetworkSettings | ExistingNetworkSettings;
  access: GcpAccessSettings;
  /** The instance's own identity; absent = none (a Papercusp-hosted host, D-399). */
  serviceAccountEmail?: string;
  serviceAccountScopes: readonly string[];
  instanceName: string;
  dataDiskName: string;
  dataDeviceName: string;
  bootDiskGiB: number;
  bootDiskType: string;
  dataDiskType: string;
  dataDiskResizePolicy: typeof GCP_DATA_DISK_RESIZE_POLICY;
  kmsKeyName?: string;
  metadata: Readonly<Record<string, string>>;
}

type GcpStepInput =
  | { op: 'insert-network'; projectId: string; requestId: string; request: GcpNetworkInsertInput; hostId: string }
  | {
      op: 'use-existing-network';
      projectId: string;
      networkName: string;
      hostId: string;
    }
  | {
      op: 'insert-subnetwork';
      projectId: string;
      region: string;
      requestId: string;
      request: GcpSubnetworkInsertInput;
      hostId: string;
      managed: true;
    }
  | {
      op: 'use-existing-subnetwork';
      projectId: string;
      region: string;
      subnetworkName: string;
      networkName: string;
      hostId: string;
    }
  | {
      op: 'insert-firewall';
      projectId: string;
      requestId: string;
      request: GcpFirewallInsertInput;
      hostId: string;
      managed: true;
    }
  | {
      op: 'insert-router';
      projectId: string;
      region: string;
      requestId: string;
      request: GcpRouterInsertInput;
      hostId: string;
    }
  | {
      op: 'insert-nat';
      projectId: string;
      region: string;
      requestId: string;
      request: GcpNatInsertInput;
      hostId: string;
    }
  | {
      op: 'use-existing-firewall';
      projectId: string;
      firewallName: string;
      networkName: string;
      hostId: string;
      expectedSourceRanges: readonly string[];
    }
  | {
      op: 'insert-disk';
      projectId: string;
      zone: string;
      requestId: string;
      request: GcpDiskInsertInput;
      hostId: string;
    }
  | {
      op: 'insert-instance';
      projectId: string;
      zone: string;
      requestId: string;
      request: GcpInstanceInsertInput;
      hostId: string;
      requiresFirewall: boolean;
      requiresNat: boolean;
    }
  | {
      op: 'start-instance' | 'stop-instance' | 'reset-instance' | 'repair-instance';
      projectId: string;
      zone: string;
      instanceName: string;
      requestId: string;
      hostId: string;
    }
  | {
      op: 'set-instance-metadata';
      projectId: string;
      zone: string;
      instanceName: string;
      requestId: string;
      hostId: string;
      request: GcpInstanceMetadataInput;
    }
  | {
      op: 'create-snapshot';
      projectId: string;
      zone: string;
      requestId: string;
      request: GcpSnapshotInsertInput;
      hostId: string;
    }
  | {
      op:
        | 'delete-instance'
        | 'delete-disk'
        | 'delete-firewall'
        | 'delete-nat'
        | 'delete-router'
        | 'delete-subnetwork'
        | 'delete-network';
      projectId: string;
      requestId: string;
      resourceName: string;
      /** Expected provider allocation identity from the host resource checkpoint, when known. */
      incarnationId?: string;
      routerName?: string;
      region?: string;
      zone?: string;
      hostId: string;
    };

type GcpDeleteStepInput = Extract<GcpStepInput, { resourceName: string }>;

const VM_KIND = 'vm';
const DISK_KIND = 'disk';
const NETWORK_KIND = 'network';
const SUBNETWORK_KIND = 'subnetwork';
const FIREWALL_KIND = 'firewall';
const ROUTER_KIND = 'router';
const NAT_KIND = 'nat';
const EXISTING_NETWORK_KIND = 'existing-network';
const EXISTING_SUBNETWORK_KIND = 'existing-subnetwork';
const EXISTING_FIREWALL_KIND = 'existing-firewall';

/**
 * The provider reports the delete OP it just confirmed and lets the obligations ledger resolve
 * that to the recorded resource kind. Deliberately NOT an op->kind map here: the kind<->op
 * mapping already exists once, as `CLOUD_RESOURCE_DELETE_CONTRACT` in cloud-resource-obligations,
 * and it is already parity-tested against this provider's delete union. A second copy in this
 * file would be a hand-maintained duplicate of a derived truth, free to drift — and the drift is
 * silent: the two vocabularies agree for six of seven ops and DISAGREE for the most expensive
 * one (`delete-instance` <-> kind `vm`), so a wrong inverse closes nothing for the VM while
 * reporting success (EI-23459044188861686).
 */
/**
 * WI-10001673: the ADDRESS of a resource this step creates — the host it belongs to, and the
 * enclosing resource its delete op is routed through when it has one.
 *
 * Read from the step INPUT rather than from `result.resource`, because the generic
 * `WorkspaceHostResourceRef` carries the project and region but deliberately knows nothing about
 * GCP's `routerName`; and read per-STEP rather than from the observer binding, because the
 * binding is constructed once at the DBOS composition root where no host exists.
 *
 * Only Cloud NAT has a parent today: `delete-nat` takes the owning Cloud Router's name, which is
 * why `CLOUD_RESOURCE_DELETE_CONTRACT` lists `parentResourceId` in nat's `requires`.
 */
function createdAddress(step: WorkspaceHostPlanStep): { hostId: string; parentResourceId: string } {
  // Deliberately a defensive read rather than `stepInput(step)`, for the same reason as
  // `deleteOpName` below: that helper THROWS on a step with no op, and this runs on the observer
  // path AFTER the resource already exists. Throwing here would turn a bookkeeping miss into a
  // failed provision — with the resource live and metered either way.
  const input = (step as { input?: { op?: unknown; hostId?: unknown; request?: { routerName?: unknown } } })?.input;
  const routerName = input?.op === 'insert-nat' ? input?.request?.routerName : undefined;
  return {
    hostId: typeof input?.hostId === 'string' ? input.hostId : '',
    parentResourceId: typeof routerName === 'string' ? routerName : '',
  };
}

function deleteOpName(step: WorkspaceHostPlanStep): string | undefined {
  // Deliberately a defensive read rather than `stepInput(step)`: that helper THROWS on a step
  // with no op, and this runs on the observer path AFTER the delete already succeeded. Throwing
  // here would turn a bookkeeping miss into a failed teardown.
  const op = (step as { input?: { op?: unknown } })?.input?.op;
  return typeof op === 'string' ? op : undefined;
}

/**
 * WI-10001727: does this step BRING THE RESOURCE INTO EXISTENCE, as opposed to adopting one we
 * did not create? Every `insert-*` op creates; every `use-existing-*` op adopts. That distinction
 * is what decides whether an `unchanged` result still owes a teardown obligation.
 *
 * `reconcile` returns `unchanged` whenever it finds a step's target already present. For a
 * `use-existing-*` op that genuinely means "someone else's resource, we owe nothing". For an
 * `insert-*` op it means the OPPOSITE: we issued the create, the provider's confirmation was lost
 * ("Provider outcome is uncertain; the next request will reconcile before applying"), and the
 * resource we are now rediscovering is one WE brought into existence and must tear down.
 *
 * Measured on host pc-p317-cred-20260917b (2026-09-17T09:28-09:37Z): create-subnetwork
 * (attempts=5) and create-firewall (attempts=2) both terminated `unchanged` and got NO obligation
 * row, while create-network and create-router terminated `applied` and did. Both un-recorded
 * resources were live and metered in GCP, invisible to the teardown sweep by construction.
 *
 * Defensive read rather than `stepInput(step)` for the same reason as `deleteOpName` above: this
 * runs on the observer path after the work already succeeded, so throwing here would turn a
 * bookkeeping miss into a failed provision.
 */
function createsOwnedResource(step: WorkspaceHostPlanStep): boolean {
  const op = (step as { input?: { op?: unknown } })?.input?.op;
  return typeof op === 'string' && op.startsWith('insert-');
}

const CAPABILITIES: WorkspaceHostProviderCapabilities = {
  discovery: { scopes: true, regions: true, sizes: true, images: true, priceEstimates: true },
  lifecycle: {
    start: true,
    stop: true,
    restart: true,
    snapshot: true,
    restore: true,
    upgrade: true,
    repair: true,
    confirmedDestroy: true,
    hostBootstrap: true,
    // `enable-guest-attributes=TRUE` is set on every instance this provider creates.
    bootstrapStatusChannel: 'gce-guest-attributes',
  },
  transportKinds: [...GCP_WORKSPACE_HOST_TRANSPORTS],
  constraints: [
    'IAP TCP forwarding with OS Login and no external IP is the default',
    'Direct SSH requires an explicit restricted IPv4 CIDR allowlist and exposes only tcp/22',
    'Defguard uses an enrolled overlay address and provisions no inbound GCP firewall rule',
    'Operator, Postgres, MCP, and application ports are never exposed by the workspace-host provider',
    'Cloud authorization is a resolver reference; service-account key material is forbidden',
    'Data disks use a grow-only resize policy; shrinking requires snapshot-and-restore into a new disk',
    'Upgrade replaces the VM boot/runtime layer and reattaches the retained data disk',
    'Snapshot plans quiesce a running VM before capture and restore its prior running state afterward',
    'Restore creates a distinct host from a READY managed snapshot; the source host and disk remain intact',
  ],
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function dataDeviceName(value: unknown): string {
  const name = optionalString(value, 'gcp.desired.provider.dataDeviceName') ?? 'papercusp-data';
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error('gcp.desired.provider.dataDeviceName must be a lowercase Compute Engine device name');
  }
  return name;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error(`${label} must be a positive safe integer`);
  return value as number;
}

function stringArray(value: unknown, label: string, fallback?: readonly string[]): readonly string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain at least one string`);
  return [...new Set(value.map((item, index) => requireString(item, `${label}[${index}]`)))].sort();
}

function transportPreference(desired: WorkspaceHostDesiredSpec): GcpWorkspaceHostTransport {
  const provider = desired.provider ?? {};
  const desiredValue = desired.transportPreference;
  const providerValue = provider.transportPreference;
  if (desiredValue !== undefined && providerValue !== undefined && desiredValue !== providerValue) {
    throw new Error('desired.transportPreference must match gcp.desired.provider.transportPreference');
  }
  const value = optionalString(desiredValue ?? providerValue, 'desired.transportPreference') ?? 'gcp-iap-ssh';
  if (!(GCP_WORKSPACE_HOST_TRANSPORTS as readonly string[]).includes(value)) {
    throw new Error(`GCP transportPreference must be one of ${GCP_WORKSPACE_HOST_TRANSPORTS.join(', ')}`);
  }
  return value as GcpWorkspaceHostTransport;
}

function restrictedDirectSshCidrs(value: unknown): readonly string[] {
  const cidrs = stringArray(value, 'gcp.desired.provider.directSshSourceRanges');
  for (const cidr of cidrs) {
    const [address, prefixText, ...extra] = cidr.split('/');
    const prefix = Number(prefixText);
    if (extra.length > 0 || isIP(address) !== 4 || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) {
      throw new Error('gcp.desired.provider.directSshSourceRanges must contain restricted IPv4 CIDRs (never /0)');
    }
  }
  return cidrs;
}

function accessSettings(desired: WorkspaceHostDesiredSpec): GcpAccessSettings {
  const provider = desired.provider ?? {};
  const kind = transportPreference(desired);
  if (kind === 'gcp-direct-ssh') {
    return {
      kind,
      firewallRequired: true,
      sourceRanges: restrictedDirectSshCidrs(provider.directSshSourceRanges),
      externalIp: true,
    };
  }
  if (provider.directSshSourceRanges !== undefined) {
    throw new Error('gcp.desired.provider.directSshSourceRanges is valid only for gcp-direct-ssh');
  }
  if (kind === 'defguard-ssh') {
    return { kind, firewallRequired: false, sourceRanges: [], externalIp: false };
  }
  return {
    kind,
    firewallRequired: true,
    sourceRanges: [GCP_IAP_TCP_FORWARDING_RANGE],
    externalIp: false,
  };
}

export interface GcpWorkspaceHostTransportProfileInput {
  kind: GcpWorkspaceHostTransport;
  projectId: string;
  zone: string;
  instanceName: string;
  externalIp?: string;
  defguardAddress?: string;
}

function profileEndpoint(scheme: string, address: string, input: GcpWorkspaceHostTransportProfileInput): string {
  const query = new URLSearchParams({
    project: requireString(input.projectId, 'GCP transport projectId'),
    zone: requireString(input.zone, 'GCP transport zone'),
    instance: requireString(input.instanceName, 'GCP transport instanceName'),
  });
  return `${scheme}://${address}?${query.toString()}`;
}

function sshAddress(value: string | undefined, label: string): string {
  const address = requireString(value, label);
  if (/[/?#@\s]/.test(address)) throw new Error(`${label} must be a host or IP address without URL syntax`);
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
}

const GCP_SSH_FEATURES = ['command', 'pty', 'tcpForward', 'fileTransfer'] as const;

function gcpHostKeyPolicy(): WorkspaceHostTransportProfile['compatibility']['hostKey'] {
  return {
    initialEnrollment: 'verify-before-connect',
    replacement: 'block-and-reverify',
    notes: ['Pin the first observed SSH host key; a changed key requires an independently verified rotation'],
  };
}

function gcpClipboardFallback(): WorkspaceHostTransportProfile['compatibility']['fallbacks'][number] {
  return {
    feature: 'clipboard',
    strategy: 'unsupported',
    description: 'Use explicit copy/paste in the local client; the transport does not synchronize clipboards',
  };
}

/**
 * The transport features EVERY GCP workspace-host transport provides.
 *
 * Named and exported because it is now load-bearing beyond the profile: the initialization
 * resolver reads `fileTransfer` from it to decide whether this provider may carry the git and
 * agent credential channels (D-215 point 6). A caller that needs that answer must read it from
 * here rather than restate a boolean, or the capability gate ends up asserting a copy.
 */
export const GCP_WORKSPACE_HOST_TRANSPORT_FEATURES = Object.freeze({
  command: true,
  pty: true,
  tcpForward: true,
  fileTransfer: true,
  clipboard: false,
} as const);

/** Stable machine-readable profile consumed by psu and the desktop connection manager. */
export function buildGcpWorkspaceHostTransportProfile(
  input: GcpWorkspaceHostTransportProfileInput,
): WorkspaceHostTransportProfile {
  const common = {
    supportedClientPlatforms: ['linux', 'macos', 'windows'],
    features: { ...GCP_WORKSPACE_HOST_TRANSPORT_FEATURES },
    reconnect: 'recreate' as const,
  };
  if (input.kind === 'gcp-direct-ssh') {
    const address = sshAddress(input.externalIp, 'GCP direct SSH external IP');
    if (isIP(address.replace(/^\[|\]$/g, '')) !== 4)
      throw new Error('GCP direct SSH requires an observed IPv4 address');
    return {
      kind: input.kind,
      endpoint: profileEndpoint('ssh', `${address}:22`, input),
      ...common,
      prerequisites: ['OS Login permission', 'Verified SSH host key', 'Explicit restricted source CIDR allowlist'],
      constraints: ['Public IPv4 is enabled', 'Only tcp/22 is exposed', 'No provider tunnel or session-content audit'],
      audited: false,
      compatibility: {
        requirements: [
          {
            id: 'openssh-client',
            label: 'OpenSSH client',
            kind: 'client-tool',
            requiredFor: GCP_SSH_FEATURES,
          },
          {
            id: 'gcp-os-login',
            label: 'OS Login permission',
            kind: 'provider-permission',
            requiredFor: GCP_SSH_FEATURES,
          },
          {
            id: 'gcp-direct-ssh-firewall',
            label: 'Restricted tcp/22 source CIDR allowlist',
            kind: 'network',
            requiredFor: GCP_SSH_FEATURES,
          },
        ],
        traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' },
        limits: {
          unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
          notes: ['Limits and throughput depend on the VM, public network path, and caller SSH policy'],
        },
        proxy: {
          mode: 'provider-dependent',
          notes: ['A corporate proxy must explicitly support the configured direct SSH path'],
        },
        cost: {
          model: 'network-metered',
          meters: ['external IPv4', 'network egress'],
          notes: ['Compute Engine and public-network charges remain provider-billed'],
        },
        audit: {
          controlPlaneEvents: false,
          sessionMetadata: false,
          sessionContent: false,
          fileTransferEvents: false,
          notes: ['Use host-side logging when direct SSH audit evidence is required'],
        },
        hostKey: gcpHostKeyPolicy(),
        fallbacks: [gcpClipboardFallback()],
      },
    };
  }
  if (input.kind === 'defguard-ssh') {
    const address = sshAddress(input.defguardAddress, 'GCP Defguard address');
    return {
      kind: input.kind,
      endpoint: profileEndpoint('ssh', `${address}:22`, input),
      ...common,
      prerequisites: ['Defguard enrollment', 'OS Login permission', 'Verified SSH host key'],
      constraints: ['No public IP or inbound GCP firewall rule', 'Access requires the enrolled Defguard overlay'],
      audited: true,
      compatibility: {
        requirements: [
          {
            id: 'openssh-client',
            label: 'OpenSSH client',
            kind: 'client-tool',
            requiredFor: GCP_SSH_FEATURES,
          },
          {
            id: 'defguard-client',
            label: 'Enrolled Defguard client',
            kind: 'client-tool',
            requiredFor: GCP_SSH_FEATURES,
          },
          {
            id: 'gcp-os-login',
            label: 'OS Login permission',
            kind: 'provider-permission',
            requiredFor: GCP_SSH_FEATURES,
          },
          {
            id: 'defguard-overlay',
            label: 'Defguard overlay route to the workspace host',
            kind: 'network',
            requiredFor: GCP_SSH_FEATURES,
          },
        ],
        traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' },
        limits: {
          unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
          notes: ['Limits and throughput depend on the Defguard gateway, peer path, and VM'],
        },
        proxy: {
          mode: 'provider-dependent',
          notes: ['Corporate-network compatibility must be verified against the deployed Defguard path'],
        },
        cost: {
          model: 'third-party',
          meters: ['Defguard deployment', 'network egress'],
          notes: ['Defguard infrastructure and provider network charges are billed outside this profile'],
        },
        audit: {
          controlPlaneEvents: true,
          sessionMetadata: true,
          sessionContent: false,
          fileTransferEvents: false,
          notes: ['Overlay enrollment and connection events do not include SSH session contents'],
        },
        hostKey: gcpHostKeyPolicy(),
        fallbacks: [gcpClipboardFallback()],
      },
    };
  }
  return {
    kind: input.kind,
    endpoint: profileEndpoint('gcp-iap-ssh', input.instanceName, input),
    ...common,
    prerequisites: ['IAP TCP forwarding permission', 'OS Login permission', 'gcloud or an IAP-capable client'],
    constraints: [
      'No public IP is provisioned',
      'Only tcp/22 is allowed from 35.235.240.0/20',
      'IAP/OS Login control events are auditable; SSH session contents are not provider-recorded',
    ],
    audited: true,
    compatibility: {
      requirements: [
        {
          id: 'gcloud-cli',
          label: 'Google Cloud CLI',
          kind: 'client-tool',
          requiredFor: GCP_SSH_FEATURES,
        },
        {
          id: 'openssh-client',
          label: 'OpenSSH client',
          kind: 'client-tool',
          requiredFor: GCP_SSH_FEATURES,
        },
        {
          id: 'gcp-iap-tunnel',
          label: 'IAP-secured Tunnel User permission',
          kind: 'provider-permission',
          requiredFor: GCP_SSH_FEATURES,
        },
        {
          id: 'gcp-os-login',
          label: 'OS Login permission',
          kind: 'provider-permission',
          requiredFor: GCP_SSH_FEATURES,
        },
        {
          id: 'gcp-iap-network',
          label: 'HTTPS access to the IAP TCP forwarding service',
          kind: 'network',
          requiredFor: GCP_SSH_FEATURES,
        },
      ],
      traffic: { interactive: 'recommended', 'bulk-transfer': 'discouraged' },
      limits: {
        unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
        notes: ['IAP TCP forwarding is an interactive access path; test large transfers separately'],
      },
      proxy: {
        mode: 'allowlist-required',
        requiredDomains: ['tunnel.cloudproxy.app'],
        notes: ['Corporate proxies must allow the IAP TCP forwarding HTTPS domain'],
      },
      cost: {
        model: 'network-metered',
        meters: ['network egress'],
        notes: ['IAP TCP forwarding has no dedicated SKU in this contract; provider network charges may apply'],
      },
      audit: {
        controlPlaneEvents: true,
        sessionMetadata: true,
        sessionContent: false,
        fileTransferEvents: false,
        notes: ['IAP and OS Login control events are visible; SSH payloads are not provider-recorded'],
      },
      hostKey: gcpHostKeyPolicy(),
      fallbacks: [
        {
          feature: 'fileTransfer',
          trafficClass: 'bulk-transfer',
          strategy: 'provider-object-storage',
          description: 'Use a signed or identity-scoped Cloud Storage transfer for large files',
        },
        gcpClipboardFallback(),
      ],
    },
  };
}

function stringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      requireString(key, `${label} key`),
      requireString(item, `${label}.${key}`),
    ]),
  );
}

function nameSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'host'
  );
}

/** Room left for the slug once `prefix`, the 8-character digest and both dashes are placed. */
function nameBodyLength(prefix: string): number {
  return Math.max(1, 63 - prefix.length - 8 - 2);
}

function stableName(prefix: string, hostId: string): string {
  const suffix = createHash('sha256').update(hostId).digest('hex').slice(0, 8);
  const body = nameSlug(hostId).slice(0, nameBodyLength(prefix)).replace(/-+$/g, '') || 'host';
  return `${prefix}-${body}-${suffix}`;
}

/**
 * The name prefixes of every GCP resource one workspace host owns, derived by the SAME
 * functions that name them: network, subnetwork, firewall, router, instance and disks share
 * `resource`; snapshots use `snapshot` (on demand) or `destroySnapshot` (kept at destroy).
 * A grant scoped to these prefixes (hosted-gcp-hosting.ts) reaches this host and no other,
 * because every host's `resource` prefix ends in a digest of its own id.
 */
export function gcpWorkspaceHostNamePrefixes(hostId: string): {
  resource: string;
  snapshot: string;
  destroySnapshot: string;
} {
  const destroyBody = nameSlug(hostId).slice(0, nameBodyLength('pc-destroy'));
  return {
    resource: `${stableName('pc', hostId)}-`,
    snapshot: stableName('pc-snapshot', hostId),
    // Destroy snapshots are named from `${hostId}-${disk}`, whose slug begins with the host's.
    destroySnapshot: `pc-destroy-${destroyBody}`,
  };
}

/**
 * The three fields that identify the REAL GCP instance behind a desired spec.
 *
 * Extracted from `readSettings` and shared with the workspace-host INITIALIZATION path
 * (`initialization-operations-resolver.ts`), which has to SSH to the instance this provider
 * provisions. Those two deriving the instance name independently would be a silent, expensive
 * bug — initialization would tunnel to a name that does not exist, and only at runtime. One
 * exported derivation makes that divergence impossible rather than merely unlikely, which is
 * why `readSettings` below now calls this instead of keeping its own copy.
 */
export function resolveGcpWorkspaceHostInstanceIdentity(desired: WorkspaceHostDesiredSpec): {
  projectId: string;
  zone: string;
  instanceName: string;
} {
  if (desired.target !== GCP_WORKSPACE_HOST_TARGET)
    throw new Error(`GCP provider cannot plan target '${desired.target}'`);
  if (desired.scope.kind !== 'project') throw new Error("GCP workspace hosts require scope.kind 'project'");
  const provider = desired.provider ?? {};
  assertWorkspaceHostSecretIsolation(provider, 'gcp.desired.provider');
  const projectId =
    optionalString(provider.projectId, 'gcp.desired.provider.projectId') ??
    requireString(desired.scope.id, 'desired.scope.id');
  if (projectId !== desired.scope.id) throw new Error('GCP provider projectId must match desired.scope.id');
  const zone = requireString(desired.zone, 'desired.zone');
  if (!zone.startsWith(`${desired.region}-`)) throw new Error('GCP desired.zone must belong to desired.region');
  const instanceName =
    optionalString(provider.instanceName, 'gcp.desired.provider.instanceName') ??
    `${stableName('pc', desired.hostId)}-vm`;
  return { projectId, zone, instanceName };
}

/** Compute Engine requestId: deterministic, non-zero RFC-4122 UUID. */
export function gcpWorkspaceHostRequestUuid(idempotencyKey: string): string {
  const hex = createHash('sha256')
    .update(requireString(idempotencyKey, 'idempotencyKey'))
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
}

function readSettings(desired: WorkspaceHostDesiredSpec): GcpWorkspaceHostDesiredProviderSettings {
  if (desired.target !== GCP_WORKSPACE_HOST_TARGET)
    throw new Error(`GCP provider cannot plan target '${desired.target}'`);
  if (desired.scope.kind !== 'project') throw new Error("GCP workspace hosts require scope.kind 'project'");
  if (!desired.data.encrypted) throw new Error('GCP workspace-host data disks must be encrypted');
  const provider = desired.provider ?? {};
  assertWorkspaceHostSecretIsolation(provider, 'gcp.desired.provider');
  // The host bootstrap is CONTROLLER-authored and arrives on the provider context, never on the
  // caller-authored desired spec. The rendered script pins the release bundleUrl/bundleSha256/
  // signingPublicKey AND the OpenSSH key authorized for the workspace SSH account, so a caller
  // who can name it chooses both which code the host installs and who may log into it. Refusing
  // it here — rather than merging it, or preferring one source over the other — keeps the single
  // trusted producer provable by reading this function: no path carries request input into
  // instance startup metadata.
  if (provider.startupScript !== undefined) {
    throw new Error(
      'gcp.desired.provider.startupScript is not accepted: the host bootstrap is rendered ' +
        'server-side at provision time and delivered through the provider context',
    );
  }
  // Single source of truth, shared with the initialization path — see the helper's comment.
  const { projectId, zone, instanceName } = resolveGcpWorkspaceHostInstanceIdentity(desired);
  const imageId = assertGcpImmutableImageId(desired.image.id, 'gcp.desired.image.id');
  const rawNetwork = provider.network;
  if (!rawNetwork || typeof rawNetwork !== 'object' || Array.isArray(rawNetwork)) {
    throw new Error('gcp.desired.provider.network must select managed or existing mode');
  }
  const networkRecord = rawNetwork as Record<string, unknown>;
  if (networkRecord.sourceRanges !== undefined || networkRecord.allowedTcpPorts !== undefined) {
    throw new Error(
      'GCP workspace-host firewall policy is transport-derived; network.sourceRanges/allowedTcpPorts are forbidden',
    );
  }
  const access = accessSettings(desired);
  const mode = requireString(networkRecord.mode, 'gcp.desired.provider.network.mode');
  const base = stableName('pc', desired.hostId);
  let network: ManagedNetworkSettings | ExistingNetworkSettings;
  if (mode === 'managed') {
    network = {
      mode,
      networkName:
        optionalString(networkRecord.networkName, 'gcp.desired.provider.network.networkName') ?? `${base}-net`,
      subnetworkName:
        optionalString(networkRecord.subnetworkName, 'gcp.desired.provider.network.subnetworkName') ?? `${base}-subnet`,
      firewallName:
        optionalString(networkRecord.firewallName, 'gcp.desired.provider.network.firewallName') ??
        `${base}-${access.kind === 'gcp-iap-ssh' ? 'iap' : 'ssh'}`,
      routerName:
        optionalString(networkRecord.routerName, 'gcp.desired.provider.network.routerName') ?? `${base}-router`,
      natName: optionalString(networkRecord.natName, 'gcp.desired.provider.network.natName') ?? `${base}-nat`,
      ipCidrRange:
        optionalString(networkRecord.ipCidrRange, 'gcp.desired.provider.network.ipCidrRange') ?? '10.132.0.0/24',
    };
  } else if (mode === 'existing') {
    const firewallName = optionalString(networkRecord.firewallName, 'gcp.desired.provider.network.firewallName');
    if (access.firewallRequired && !firewallName) {
      throw new Error(`gcp.desired.provider.network.firewallName is required for ${access.kind}`);
    }
    network = {
      mode,
      networkName: requireString(networkRecord.networkName, 'gcp.desired.provider.network.networkName'),
      subnetworkName: requireString(networkRecord.subnetworkName, 'gcp.desired.provider.network.subnetworkName'),
      ...(firewallName ? { firewallName } : {}),
    };
  } else {
    throw new Error("gcp.desired.provider.network.mode must be 'managed' or 'existing'");
  }
  return {
    projectId,
    zone,
    imageId,
    network,
    access,
    serviceAccountEmail: optionalString(provider.serviceAccountEmail, 'gcp.desired.provider.serviceAccountEmail'),
    serviceAccountScopes: stringArray(provider.serviceAccountScopes, 'gcp.desired.provider.serviceAccountScopes', [
      GCP_CLOUD_PLATFORM_SCOPE,
    ]),
    instanceName,
    dataDiskName: optionalString(provider.dataDiskName, 'gcp.desired.provider.dataDiskName') ?? `${base}-data`,
    dataDeviceName: dataDeviceName(provider.dataDeviceName),
    bootDiskGiB:
      provider.bootDiskGiB === undefined
        ? 30
        : positiveInteger(provider.bootDiskGiB, 'gcp.desired.provider.bootDiskGiB'),
    bootDiskType: optionalString(provider.bootDiskType, 'gcp.desired.provider.bootDiskType') ?? 'pd-balanced',
    dataDiskType: optionalString(provider.dataDiskType, 'gcp.desired.provider.dataDiskType') ?? 'pd-balanced',
    dataDiskResizePolicy: GCP_DATA_DISK_RESIZE_POLICY,
    kmsKeyName: optionalString(provider.kmsKeyName, 'gcp.desired.provider.kmsKeyName'),
    metadata: stringRecord(provider.metadata, 'gcp.desired.provider.metadata'),
  };
}

function labels(desired: WorkspaceHostDesiredSpec, workspaceId: string): Readonly<Record<string, string>> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(desired.labels ?? {})) {
    entries.set(gcpWorkspaceHostLabelValue(key), gcpWorkspaceHostLabelValue(value));
  }
  entries.set(GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId, gcpWorkspaceHostLabelValue(desired.hostId));
  entries.set(GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed, 'true');
  entries.set(GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId, gcpWorkspaceHostLabelValue(workspaceId));
  return Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function assertExactSshFirewall(observed: GcpFirewallObservation, expectedSourceRanges: readonly string[]): void {
  const actualSources = [...observed.sourceRanges].sort();
  const expectedSources = [...expectedSourceRanges].sort();
  const onlyRule = observed.allowed.length === 1 ? observed.allowed[0] : undefined;
  if (
    observed.direction !== 'INGRESS' ||
    JSON.stringify(actualSources) !== JSON.stringify(expectedSources) ||
    onlyRule?.IPProtocol !== 'tcp' ||
    JSON.stringify([...onlyRule.ports].sort()) !== JSON.stringify(['22'])
  ) {
    throw new Error(`GCP firewall '${observed.name}' must allow exactly tcp/22 from ${expectedSources.join(', ')}`);
  }
}

function assertManagedHostResource(observed: GcpResourceObservation, hostId: string, resourceLabel: string): void {
  const expectedHostLabel = gcpWorkspaceHostLabelValue(hostId);
  if (
    observed.labels?.[GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed] !== 'true' ||
    observed.labels[GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId] !== expectedHostLabel
  ) {
    throw new Error(`GCP ${resourceLabel} '${observed.name}' is not labeled as managed by workspace host '${hostId}'`);
  }
}

function metadata(
  settings: GcpWorkspaceHostDesiredProviderSettings,
  hostId: string,
  hostBootstrapScript?: string,
): readonly { key: string; value: string }[] {
  const entries = new Map<string, string>(Object.entries(settings.metadata));
  entries.set('block-project-ssh-keys', 'TRUE');
  entries.set('enable-guest-attributes', 'TRUE');
  entries.set('enable-oslogin', 'TRUE');
  entries.set('papercusp-host-id', hostId);
  entries.set('papercusp-data-resize-policy', settings.dataDiskResizePolicy);
  entries.set('startup-script', durableFilesystemStartupScript(settings.dataDeviceName, hostBootstrapScript));
  return [...entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => ({ key, value }));
}

/**
 * The instance's `startup-script`: the durable data mount, then the controller-authored host
 * bootstrap.
 *
 * The bootstrap runs AFTER the mount because it installs the release and its state under paths
 * that live on the durable disk; running it first would write the release onto the boot disk and
 * have the mount hide it. `hostBootstrapScript` reaches this function only from the provider
 * CONTEXT — `readSettings` refuses a caller-supplied `provider.startupScript`, so there is no
 * second producer for this argument.
 */
function durableFilesystemStartupScript(dataDeviceName: string, hostBootstrapScript?: string): string {
  const device = `/dev/disk/by-id/google-${dataDeviceName}`;
  const userScript = hostBootstrapScript?.trim().replace(/^#![^\n]*(?:\n|$)/, '');
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `data_device='${device}'`,
    `data_mount='${GCP_DATA_MOUNT_POINT}'`,
    'for attempt in $(seq 1 60); do test -b "$data_device" && break; sleep 1; done',
    'test -b "$data_device"',
    'if ! blkid "$data_device" >/dev/null 2>&1; then mkfs.ext4 -F "$data_device"; fi',
    'data_uuid=$(blkid -s UUID -o value "$data_device")',
    'install -d -m 0750 "$data_mount"',
    'grep -q "^UUID=${data_uuid} " /etc/fstab || printf "UUID=%s %s ext4 defaults,nofail,discard 0 2\\n" "$data_uuid" "$data_mount" >> /etc/fstab',
    'mountpoint -q "$data_mount" || mount "$data_mount"',
    'resize2fs "$data_device"',
    'install -d -m 0750 "$data_mount"/{postgres,repositories,transcripts,workspaces}',
    // ⛔ WORKSPACE + AGENT HOMES MUST LAND ON THE DURABLE DISK (WI-10003296).
    //
    // GCP upgrades delete and recreate the boot disk while retaining only `data_device`.
    // Both identities whose state must survive that operation live below /home: the customer's
    // SSH identity owns its dotfiles and option-A agent credentials, and the isolated agent
    // identity owns its native agent homes. Keeping either on the image loses authentication on
    // every routine upgrade even though the workspace data itself survives.
    //
    // First adoption must use repair (which retains the boot disk) before a destructive upgrade.
    // Publish the first copy by same-filesystem rename: a failed/interrupted copy must never be
    // mistaken for a complete home on retry. Existing durable content, even empty, wins forever.
    // This state must be on disk: it is mounted before the bootstrap or database can start.
    '[[ -d /home && ! -L /home ]] || { echo "workspace home mount target is not a real directory" >&2; exit 1; }',
    'if [[ ! -e "$data_mount/home" && ! -L "$data_mount/home" ]]; then',
    '  home_seed="$(mktemp -d "$data_mount/.home-seed.XXXXXX")"',
    '  cp -a /home/. "$home_seed"/',
    '  mv -T -- "$home_seed" "$data_mount/home"',
    'fi',
    '[[ -d "$data_mount/home" && ! -L "$data_mount/home" ]] || { echo "durable home is not a real directory" >&2; exit 1; }',
    "install -d -m 0755 '/home'",
    'grep -q " /home none bind" /etc/fstab || printf "%s /home none bind 0 0\\n" "$data_mount/home" >> /etc/fstab',
    "mountpoint -q '/home' || mount --bind \"$data_mount/home\" '/home'",
    '[[ "$(stat -c %d:%i /home)" == "$(stat -c %d:%i "$data_mount/home")" ]] || { echo "workspace home is not backed by the durable directory" >&2; exit 1; }',
    // ⛔ CUSTOMER WORKSPACES MUST LAND ON THE DURABLE DISK (WI-2143796, proven on canary-14).
    //
    // WORKSPACE_HOST_DATA_ROOT is `/srv/papercusp/workspaces` — a path on the BOOT disk, which
    // `upgrade` DELETES and recreates from the new image (planUpgrade below retains only the data
    // disk, `{ ...dataDisk, autoDelete: false }`). Measured 2026-09-03: a file written to that root
    // as the customer SSH user was GONE after a ledger-verified `succeeded|100` upgrade, while the
    // data disk persisted untouched — i.e. every customer workspace was destroyed by a routine
    // image upgrade. The `workspaces` directory created just above, on the durable mount, was never
    // referenced by anything: the storage was already provisioned and simply not used.
    //
    // Bind, rather than relocating WORKSPACE_HOST_DATA_ROOT itself, because the bootstrap builds a
    // deliberate permission boundary at that path — 0711 on /srv/papercusp so the workspace user can
    // traverse but not list, 0770 + named-user ACLs on the root itself — while $data_mount is
    // 0750 root:$SERVICE_GROUP with the workspace account deliberately NOT in that group (D-043:
    // keep runtime files root-owned and non-readable to the workspace user). Moving the root under
    // $data_mount would put customer workspaces behind a directory the customer is denied, or force
    // that boundary open. A bind mount keeps the entire published path, permission and ACL model
    // byte-identical and changes only which disk the bytes live on. The ACLs are stored in the ext4
    // filesystem on the data disk, so they now survive the upgrade too.
    //
    // This runs BEFORE the user bootstrap (see the ordering contract in this function's header), so
    // the bootstrap's own `install -d`/`setfacl` on the workspace root write straight through to the
    // durable disk. fstab carries the bind so it survives reboot as well as instance recreation.
    `install -d -m 0711 '${WORKSPACE_HOST_DATA_ROOT.replace(/\/[^/]+$/, '')}'`,
    `install -d '${WORKSPACE_HOST_DATA_ROOT}'`,
    `grep -q " ${WORKSPACE_HOST_DATA_ROOT} none bind" /etc/fstab || printf "%s ${WORKSPACE_HOST_DATA_ROOT} none bind 0 0\\n" "$data_mount/workspaces" >> /etc/fstab`,
    `mountpoint -q '${WORKSPACE_HOST_DATA_ROOT}' || mount --bind "$data_mount/workspaces" '${WORKSPACE_HOST_DATA_ROOT}'`,
    ...(userScript ? ['', '# User-supplied bootstrap follows the durable mount.', userScript] : []),
    '',
  ].join('\n');
}

function refreshedInstanceMetadata(
  observed: GcpInstanceObservation,
  hostBootstrapScript: string,
): GcpInstanceMetadataInput {
  const fingerprint = requireString(observed.metadataFingerprint, 'GCP instance metadata fingerprint');
  if (!observed.recreateInput) throw new Error('GCP lifecycle bootstrap refresh requires a fresh instance read');
  const dataDisk = observed.recreateInput.disks.find((disk) => disk.boot === false);
  const dataDeviceName = requireString(dataDisk?.deviceName, 'GCP data disk deviceName');
  const entries = new Map(observed.recreateInput.metadata.items.map(({ key, value }) => [key, value]));
  entries.set('startup-script', durableFilesystemStartupScript(dataDeviceName, hostBootstrapScript));
  return {
    fingerprint,
    items: [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({ key, value })),
  };
}

/** Compute reports a boot disk's image as a full API URL; plans carry the `projects/…` path. */
function gcpImagePath(image: string): string {
  const index = image.indexOf('projects/');
  return index >= 0 ? image.slice(index) : image;
}

/**
 * WI-10002490: an instance with the requested NAME is not necessarily the one an insert step
 * creates. An upgrade's rollback re-inserts under the forward insert's name, so if the failed
 * forward attempt left a VM behind, adopting it on reconcile would report a rollback that never
 * happened. Status 412 classifies this as terminal: re-reading the same VM cannot change the answer.
 * An observation that does not report its image stays adoptable, exactly as before.
 */
function assertInstanceBootsRequestedImage(name: string, observed: string | undefined, requested: string): void {
  if (!observed || gcpImagePath(observed) === gcpImagePath(requested)) return;
  throw Object.assign(
    new Error(
      `GCP instance '${name}' exists but boots '${gcpImagePath(observed)}', not the requested ` +
        `'${gcpImagePath(requested)}'; it is not the instance this step creates`,
    ),
    { status: 412 },
  );
}

function sameMetadata(observed: GcpInstanceObservation, expected: GcpInstanceMetadataInput): boolean {
  const actual = observed.recreateInput?.metadata.items ?? [];
  const normalize = (items: readonly { key: string; value: string }[]) =>
    [...items].sort((left, right) => left.key.localeCompare(right.key));
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected.items));
}

function resource(
  kind: string,
  providerId: string,
  options: Pick<WorkspaceHostResourceRef, 'parentProviderId' | 'region' | 'zone' | 'incarnationId'> = {},
): WorkspaceHostResourceRef {
  return { target: GCP_WORKSPACE_HOST_TARGET, kind, providerId, ...options };
}

function vmResource(
  observed: GcpInstanceObservation,
  projectId: string,
  zone: string,
  region?: string,
): WorkspaceHostResourceRef {
  return resource(VM_KIND, observed.name, {
    parentProviderId: projectId,
    zone,
    ...(region ? { region } : {}),
    incarnationId: requireString(observed.instanceId, `GCP instance '${observed.name}' incarnation id`),
  });
}

function knownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kinds: readonly string[],
): WorkspaceHostResourceRef | undefined {
  return resources.find(
    (candidate) => candidate.target === GCP_WORKSPACE_HOST_TARGET && kinds.includes(candidate.kind),
  );
}

function requireKnownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kinds: readonly string[],
  stepId: string,
): WorkspaceHostResourceRef {
  const found = knownResource(resources, kinds);
  if (!found)
    throw new Error(
      `GCP step '${stepId}' requires a persisted ${kinds.join('/')} resource identity before its provider call`,
    );
  return found;
}

function stepInput(step: WorkspaceHostPlanStep): GcpStepInput {
  const input = step.input as unknown as GcpStepInput;
  if (!input || typeof input !== 'object' || !('op' in input))
    throw new Error(`GCP plan step '${step.id}' lacks a GCP operation`);
  return input;
}

function hostIdFor(request: WorkspaceHostPlanRequest): string {
  return request.action === 'provision' || request.action === 'restore' ? request.desired.hostId : request.host.hostId;
}

function refName(value: string): string {
  return value.split('/').filter(Boolean).at(-1) ?? value;
}

function isDeleteStepInput(input: GcpStepInput): input is GcpDeleteStepInput {
  return input.op.startsWith('delete-');
}

export class GcpWorkspaceHostProvider implements WorkspaceHostProvider {
  readonly target = GCP_WORKSPACE_HOST_TARGET;
  readonly capabilities = CAPABILITIES;
  private readonly now: () => string;
  private readonly onResourceCreated?: WorkspaceHostResourceCreatedObserver;
  private readonly onResourceDestroyed?: WorkspaceHostResourceDestroyedObserver;

  constructor(
    private readonly client: GcpWorkspaceHostApiClient,
    options: Pick<GcpWorkspaceHostProviderOptions, 'now' | 'onResourceCreated' | 'onResourceDestroyed'> = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onResourceCreated = options.onResourceCreated;
    this.onResourceDestroyed = options.onResourceDestroyed;
  }

  validateConnection(ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostConnectionValidation> {
    if (ctx.connection.target !== GCP_WORKSPACE_HOST_TARGET) {
      return Promise.resolve({
        ok: false,
        checkedAt: this.now(),
        warnings: [],
        errors: [`GCP provider cannot validate target '${ctx.connection.target}'`],
      });
    }
    assertWorkspaceHostSecretIsolation(ctx.connection.provider, 'gcp.connection.provider');
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

  /**
   * Controller-independent, all-kind inventory used by the terminal destroy proof.
   * Keeping this on the configured provider preserves the one credential-resolution seam: the
   * DBOS workflow never serializes a client and the destroy runner never creates a second one.
   */
  inventoryManagedResources(request: GcpWorkspaceHostInventoryRequest): Promise<GcpWorkspaceHostInventorySnapshot> {
    return this.client.inventoryManagedResources(request);
  }

  async plan(request: WorkspaceHostPlanRequest, ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostPlan> {
    if (request.action !== 'provision' && request.host.target !== GCP_WORKSPACE_HOST_TARGET) {
      throw new Error(`GCP provider cannot plan host target '${request.host.target}'`);
    }
    return {
      planId: `gcp:${gcpWorkspaceHostRequestUuid(`${request.operationId}:plan`)}`,
      operationId: request.operationId,
      target: GCP_WORKSPACE_HOST_TARGET,
      hostId: hostIdFor(request),
      generatedAt: this.now(),
      steps: await this.planSteps(request, ctx),
      warnings: [],
    };
  }

  private async planSteps(
    request: WorkspaceHostPlanRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostPlanStep[]> {
    if (request.action === 'provision') return this.planProvision(request, ctx);
    if (request.action === 'destroy') return this.planDestroy(request, ctx);
    if (request.action === 'restore') {
      if (request.desired.hostId === request.host.hostId) {
        throw new Error('GCP restore must create a distinct target host');
      }
      if (request.snapshot.target !== GCP_WORKSPACE_HOST_TARGET || request.snapshot.hostId !== request.host.hostId) {
        throw new Error('GCP restore snapshot must belong to the exact source host');
      }
      const sourceProject = request.host.resources.find(
        (item) => item.target === GCP_WORKSPACE_HOST_TARGET,
      )?.parentProviderId;
      if (sourceProject && sourceProject !== request.desired.scope.id) {
        throw new Error('GCP restore across projects is not supported');
      }
      const snapshotName = refName(request.snapshot.providerId);
      const observedSnapshot = await this.client.getSnapshot(request.desired.scope.id, snapshotName);
      if (observedSnapshot?.status !== 'READY') {
        throw new Error(`GCP restore snapshot '${snapshotName}' is not READY`);
      }
      assertManagedHostResource(observedSnapshot, request.host.hostId, 'restore snapshot');
      return this.planProvision(request, ctx, snapshotName);
    }
    const instance = requireKnownResource(request.host.resources, [VM_KIND], request.action);
    const zone = requireString(instance.zone, `GCP ${request.action} instance zone`);
    const projectId = requireString(
      request.host.resources.find((item) => item.target === GCP_WORKSPACE_HOST_TARGET)?.parentProviderId ??
        ctx.connection.scope?.id,
      'GCP projectId',
    );
    const requestId = gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:${request.action}:${instance.providerId}`);
    if (request.action === 'upgrade') {
      if (!ctx.hostBootstrapScript) {
        throw new Error('GCP upgrade requires a controller-authored host bootstrap');
      }
      const imageId = assertGcpImmutableImageId(request.image.id, 'gcp.upgrade.image.id');
      // WI-10002490: the rollback image gets the same checks, here, for the same reason — a
      // rollback that is only discovered to be unusable after the delete is no rollback at all.
      const rollbackImageId = request.rollbackImage
        ? assertGcpImmutableImageId(request.rollbackImage.id, 'gcp.upgrade.rollbackImage.id')
        : undefined;
      // Validate and normalize before emitting a destructive delete step. The final Compute
      // client retains its own clamp, but waiting until insert-instance would leave an upgrade
      // with a deleted runtime VM when the new image is larger than the retained boot disk.
      const imageDiskSizeGb = await this.client.getImageDiskSizeGb(imageId);
      const rollbackImageDiskSizeGb = rollbackImageId
        ? await this.client.getImageDiskSizeGb(rollbackImageId)
        : undefined;
      const observed = await this.client.getInstance(projectId, zone, instance.providerId);
      if (!observed?.recreateInput) {
        throw new Error('GCP upgrade requires a fresh instance read with recreateInput');
      }
      const recreateInput = observed.recreateInput;
      const disk = requireKnownResource(request.host.resources, [DISK_KIND], request.action);
      const [bootDisk, dataDisk] = recreateInput.disks;
      if (refName(dataDisk.source) !== refName(disk.providerId) || dataDisk.autoDelete) {
        throw new Error('GCP upgrade refused because the retained data disk identity is ambiguous');
      }
      const metadata = { items: refreshedInstanceMetadata(observed, ctx.hostBootstrapScript).items };
      // The same recreate, parameterized only by boot image, so the rollback is exactly the
      // forward insert pointed at the prior image — never a second, drifting description.
      const recreateFrom = (sourceImage: string, sourceImageDiskSizeGb: number): GcpInstanceInsertInput => ({
        ...recreateInput,
        metadata,
        disks: [
          {
            ...bootDisk,
            initializeParams: {
              ...bootDisk.initializeParams,
              sourceImage,
              diskSizeGb: Math.max(bootDisk.initializeParams.diskSizeGb, sourceImageDiskSizeGb),
            },
          },
          { ...dataDisk, autoDelete: false, source: dataDisk.source },
        ],
      });
      const insertTarget = {
        op: 'insert-instance' as const,
        projectId,
        zone,
        hostId: request.host.hostId,
        requiresFirewall: request.host.resources.some((item) =>
          [FIREWALL_KIND, EXISTING_FIREWALL_KIND].includes(item.kind),
        ),
        requiresNat: request.host.resources.some((item) => item.kind === NAT_KIND),
      };
      const deleteKey = `${request.idempotencyKey}:delete-boot-runtime:${instance.providerId}`;
      const createKey = `${request.idempotencyKey}:create-boot-runtime:${instance.providerId}`;
      const rollbackKey = `${createKey}:rollback`;
      return [
        {
          id: 'delete-boot-runtime',
          action: 'upgrade',
          resourceKind: VM_KIND,
          dependsOn: [],
          idempotencyKey: deleteKey,
          destructive: true,
          input: {
            op: 'delete-instance',
            projectId,
            zone,
            resourceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(deleteKey),
            hostId: request.host.hostId,
          } satisfies GcpStepInput,
        },
        {
          id: 'create-boot-runtime',
          action: 'upgrade',
          resourceKind: VM_KIND,
          dependsOn: ['delete-boot-runtime'],
          idempotencyKey: createKey,
          destructive: false,
          input: {
            ...insertTarget,
            requestId: gcpWorkspaceHostRequestUuid(createKey),
            request: recreateFrom(imageId, imageDiskSizeGb),
          } satisfies GcpStepInput,
          ...(rollbackImageId && rollbackImageDiskSizeGb !== undefined
            ? {
                rollback: {
                  idempotencyKey: rollbackKey,
                  input: {
                    ...insertTarget,
                    requestId: gcpWorkspaceHostRequestUuid(rollbackKey),
                    request: recreateFrom(rollbackImageId, rollbackImageDiskSizeGb),
                  } satisfies GcpStepInput,
                },
              }
            : {}),
        },
      ];
    }
    if (request.action === 'snapshot') {
      const disk = requireKnownResource(request.host.resources, [DISK_KIND], request.action);
      const name = request.name ?? stableName('pc-snapshot', request.host.hostId);
      const observed = await this.client.getInstance(projectId, zone, instance.providerId);
      const quiesce = observed?.status === 'RUNNING';
      const stopId = 'quiesce-instance';
      const snapshotId = 'snapshot-data-disk';
      const steps: WorkspaceHostPlanStep[] = [];
      if (quiesce) {
        steps.push({
          id: stopId,
          action: 'snapshot',
          resourceKind: VM_KIND,
          dependsOn: [],
          idempotencyKey: `${request.idempotencyKey}:quiesce:${instance.providerId}`,
          destructive: false,
          input: {
            op: 'stop-instance',
            projectId,
            zone,
            instanceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:quiesce:${instance.providerId}`),
            hostId: request.host.hostId,
          } satisfies GcpStepInput,
        });
      }
      steps.push({
        id: snapshotId,
        action: 'snapshot',
        resourceKind: 'snapshot',
        dependsOn: quiesce ? [stopId] : [],
        idempotencyKey: `${request.idempotencyKey}:snapshot:${disk.providerId}`,
        destructive: false,
        input: {
          op: 'create-snapshot',
          projectId,
          zone: requireString(disk.zone, 'GCP snapshot disk zone'),
          requestId,
          hostId: request.host.hostId,
          request: {
            name,
            sourceDisk: disk.providerId,
            labels: {
              [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: gcpWorkspaceHostLabelValue(request.host.hostId),
              [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
              [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: gcpWorkspaceHostLabelValue(ctx.workspaceId),
            },
          },
        } satisfies GcpStepInput,
      });
      if (quiesce) {
        steps.push({
          id: 'resume-instance',
          action: 'snapshot',
          resourceKind: VM_KIND,
          dependsOn: [snapshotId],
          idempotencyKey: `${request.idempotencyKey}:resume:${instance.providerId}`,
          destructive: false,
          input: {
            op: 'start-instance',
            projectId,
            zone,
            instanceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:resume:${instance.providerId}`),
            hostId: request.host.hostId,
          } satisfies GcpStepInput,
        });
      }
      return steps;
    }
    if (request.action === 'repair') {
      if (!ctx.hostBootstrapScript) {
        throw new Error('GCP repair requires a controller-authored host bootstrap');
      }
      const observed = await this.client.getInstance(projectId, zone, instance.providerId);
      if (!observed) throw new Error(`GCP repair instance '${instance.providerId}' is absent`);
      assertManagedHostResource(observed, request.host.hostId, 'repair instance');
      const refreshKey = `${request.idempotencyKey}:refresh-bootstrap:${instance.providerId}`;
      const resetKey = `${request.idempotencyKey}:repair:${instance.providerId}`;
      return [
        {
          id: 'refresh-bootstrap-metadata',
          action: 'repair',
          resourceKind: VM_KIND,
          dependsOn: [],
          idempotencyKey: refreshKey,
          destructive: false,
          input: {
            op: 'set-instance-metadata',
            projectId,
            zone,
            instanceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(refreshKey),
            hostId: request.host.hostId,
            request: refreshedInstanceMetadata(observed, ctx.hostBootstrapScript),
          } satisfies GcpStepInput,
        },
        {
          id: 'repair-instance',
          action: 'repair',
          resourceKind: VM_KIND,
          dependsOn: ['refresh-bootstrap-metadata'],
          idempotencyKey: resetKey,
          destructive: false,
          input: {
            op: 'repair-instance',
            projectId,
            zone,
            instanceName: instance.providerId,
            requestId: gcpWorkspaceHostRequestUuid(resetKey),
            hostId: request.host.hostId,
          } satisfies GcpStepInput,
        },
      ];
    }
    const op =
      request.action === 'start'
        ? 'start-instance'
        : request.action === 'stop'
          ? 'stop-instance'
          : request.action === 'restart'
            ? 'reset-instance'
            : 'repair-instance';
    return [
      {
        id: `${request.action}-instance`,
        action: request.action,
        resourceKind: VM_KIND,
        dependsOn: [],
        idempotencyKey: `${request.idempotencyKey}:${request.action}:${instance.providerId}`,
        destructive: false,
        input: {
          op,
          projectId,
          zone,
          instanceName: instance.providerId,
          requestId,
          hostId: request.host.hostId,
        } satisfies GcpStepInput,
      },
    ];
  }

  private async planProvision(
    request: Extract<WorkspaceHostPlanRequest, { action: 'provision' | 'restore' }>,
    ctx: WorkspaceHostProviderContext,
    sourceSnapshotName?: string,
  ): Promise<readonly WorkspaceHostPlanStep[]> {
    const desired = request.desired;
    const settings = readSettings(desired);
    // This is an admission-time lookup. It must happen before the plan can be applied because
    // GCP rejects boot disks below their source image's size, while the plan intentionally creates
    // network and data-disk resources before the VM. The API client repeats the clamp at mutation
    // time as defense in depth, but it is too late to prevent partial infrastructure.
    const imageDiskSizeGb = await this.client.getImageDiskSizeGb(settings.imageId);
    if (!Number.isFinite(imageDiskSizeGb) || imageDiskSizeGb <= 0) {
      throw new Error(`GCP source image '${settings.imageId}' reported an invalid disk size`);
    }
    const bootDiskGiB = Math.max(settings.bootDiskGiB, imageDiskSizeGb);
    const commonLabels = labels(desired, ctx.workspaceId);
    const hostTag = stableName('pc-host', desired.hostId);
    const steps: WorkspaceHostPlanStep[] = [];
    let subnetworkStepId: string;
    let firewallStepId: string | undefined;
    let natStepId: string | undefined;
    if (settings.network.mode === 'managed') {
      steps.push(
        {
          id: 'create-network',
          action: request.action,
          resourceKind: NETWORK_KIND,
          dependsOn: [],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:network`,
          input: {
            op: 'insert-network',
            projectId: settings.projectId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:network`),
            hostId: desired.hostId,
            request: {
              name: settings.network.networkName,
              autoCreateSubnetworks: false,
              routingConfig: { routingMode: 'REGIONAL' },
            },
          } satisfies GcpStepInput,
        },
        {
          id: 'create-subnetwork',
          action: request.action,
          resourceKind: SUBNETWORK_KIND,
          dependsOn: ['create-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:subnetwork`,
          input: {
            op: 'insert-subnetwork',
            projectId: settings.projectId,
            region: desired.region,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:subnetwork`),
            hostId: desired.hostId,
            managed: true,
            request: {
              name: settings.network.subnetworkName,
              network: settings.network.networkName,
              ipCidrRange: settings.network.ipCidrRange,
              region: desired.region,
              privateIpGoogleAccess: true,
              stackType: 'IPV4_ONLY',
            },
          } satisfies GcpStepInput,
        },
      );
      subnetworkStepId = 'create-subnetwork';
      if (settings.access.firewallRequired) {
        firewallStepId = 'create-firewall';
        steps.push({
          id: firewallStepId,
          action: request.action,
          resourceKind: FIREWALL_KIND,
          dependsOn: ['create-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:firewall`,
          input: {
            op: 'insert-firewall',
            projectId: settings.projectId,
            requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:firewall`),
            hostId: desired.hostId,
            managed: true,
            request: {
              name: settings.network.firewallName,
              network: settings.network.networkName,
              direction: 'INGRESS',
              sourceRanges: settings.access.sourceRanges,
              targetTags: [hostTag],
              allowed: [{ IPProtocol: 'tcp', ports: ['22'] }],
            },
          } satisfies GcpStepInput,
        });
      }
      if (!settings.access.externalIp) {
        steps.push(
          {
            id: 'create-router',
            action: request.action,
            resourceKind: ROUTER_KIND,
            dependsOn: ['create-network'],
            destructive: false,
            idempotencyKey: `${request.idempotencyKey}:router`,
            input: {
              op: 'insert-router',
              projectId: settings.projectId,
              region: desired.region,
              requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:router`),
              hostId: desired.hostId,
              request: {
                name: settings.network.routerName,
                network: settings.network.networkName,
                region: desired.region,
              },
            } satisfies GcpStepInput,
          },
          {
            id: 'create-nat',
            action: request.action,
            resourceKind: NAT_KIND,
            dependsOn: ['create-router', 'create-subnetwork'],
            destructive: false,
            idempotencyKey: `${request.idempotencyKey}:nat`,
            input: {
              op: 'insert-nat',
              projectId: settings.projectId,
              region: desired.region,
              requestId: gcpWorkspaceHostRequestUuid(`${request.idempotencyKey}:nat`),
              hostId: desired.hostId,
              request: {
                name: settings.network.natName,
                routerName: settings.network.routerName,
                network: settings.network.networkName,
                subnetwork: settings.network.subnetworkName,
                region: desired.region,
                natIpAllocateOption: 'AUTO_ONLY',
                sourceSubnetworkIpRangesToNat: 'LIST_OF_SUBNETWORKS',
                minPortsPerVm: 64,
                enableEndpointIndependentMapping: false,
              },
            } satisfies GcpStepInput,
          },
        );
        natStepId = 'create-nat';
      }
    } else {
      steps.push(
        {
          id: 'record-existing-network',
          action: request.action,
          resourceKind: EXISTING_NETWORK_KIND,
          dependsOn: [],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:existing-network`,
          input: {
            op: 'use-existing-network',
            projectId: settings.projectId,
            networkName: settings.network.networkName,
            hostId: desired.hostId,
          } satisfies GcpStepInput,
        },
        {
          id: 'record-existing-subnetwork',
          action: request.action,
          resourceKind: EXISTING_SUBNETWORK_KIND,
          dependsOn: ['record-existing-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:existing-subnetwork`,
          input: {
            op: 'use-existing-subnetwork',
            projectId: settings.projectId,
            region: desired.region,
            subnetworkName: settings.network.subnetworkName,
            networkName: settings.network.networkName,
            hostId: desired.hostId,
          } satisfies GcpStepInput,
        },
      );
      subnetworkStepId = 'record-existing-subnetwork';
      if (settings.access.firewallRequired) {
        firewallStepId = 'record-existing-firewall';
        steps.push({
          id: firewallStepId,
          action: request.action,
          resourceKind: EXISTING_FIREWALL_KIND,
          dependsOn: ['record-existing-network'],
          destructive: false,
          idempotencyKey: `${request.idempotencyKey}:existing-firewall`,
          input: {
            op: 'use-existing-firewall',
            projectId: settings.projectId,
            firewallName: requireString(settings.network.firewallName, 'GCP existing firewall name'),
            networkName: settings.network.networkName,
            hostId: desired.hostId,
            expectedSourceRanges: settings.access.sourceRanges,
          } satisfies GcpStepInput,
        });
      }
    }
    const diskKey = `${request.idempotencyKey}:data-disk`;
    steps.push({
      id: 'create-data-disk',
      action: request.action,
      resourceKind: DISK_KIND,
      dependsOn: [],
      destructive: false,
      idempotencyKey: diskKey,
      input: {
        op: 'insert-disk',
        projectId: settings.projectId,
        zone: settings.zone,
        requestId: gcpWorkspaceHostRequestUuid(diskKey),
        hostId: desired.hostId,
        request: {
          name: settings.dataDiskName,
          zone: settings.zone,
          sizeGb: positiveInteger(desired.data.volumeGiB, 'desired.data.volumeGiB'),
          type: settings.dataDiskType,
          labels: commonLabels,
          ...(sourceSnapshotName
            ? {
                sourceSnapshot: `projects/${settings.projectId}/global/snapshots/${sourceSnapshotName}`,
                ...(request.action === 'restore' && request.snapshot.encryptionKeyRef
                  ? {
                      sourceSnapshotEncryptionKey: {
                        kmsKeyName: request.snapshot.encryptionKeyRef,
                      },
                    }
                  : {}),
              }
            : {}),
          ...(settings.kmsKeyName ? { diskEncryptionKey: { kmsKeyName: settings.kmsKeyName } } : {}),
        },
      } satisfies GcpStepInput,
    });
    const instanceKey = `${request.idempotencyKey}:instance`;
    steps.push({
      id: 'create-instance',
      action: request.action,
      resourceKind: VM_KIND,
      dependsOn: [
        subnetworkStepId,
        ...(firewallStepId ? [firewallStepId] : []),
        ...(natStepId ? [natStepId] : []),
        'create-data-disk',
      ],
      destructive: false,
      idempotencyKey: instanceKey,
      input: {
        op: 'insert-instance',
        projectId: settings.projectId,
        zone: settings.zone,
        requestId: gcpWorkspaceHostRequestUuid(instanceKey),
        hostId: desired.hostId,
        requiresFirewall: settings.access.firewallRequired,
        requiresNat: natStepId !== undefined,
        request: {
          name: settings.instanceName,
          zone: settings.zone,
          machineType: desired.size.includes('/')
            ? desired.size
            : `zones/${settings.zone}/machineTypes/${desired.size}`,
          labels: commonLabels,
          tags: { items: [hostTag] },
          networkInterfaces: [
            {
              network: settings.network.networkName,
              subnetwork: settings.network.subnetworkName,
              stackType: 'IPV4_ONLY',
              ...(settings.access.externalIp
                ? { accessConfigs: [{ name: 'External NAT', type: 'ONE_TO_ONE_NAT', networkTier: 'PREMIUM' }] as const }
                : {}),
            },
          ],
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: settings.imageId,
                diskSizeGb: bootDiskGiB,
                diskType: settings.bootDiskType,
                ...(settings.kmsKeyName ? { diskEncryptionKey: { kmsKeyName: settings.kmsKeyName } } : {}),
              },
            },
            {
              boot: false,
              autoDelete: false,
              source: `projects/${settings.projectId}/zones/${settings.zone}/disks/${settings.dataDiskName}`,
              deviceName: settings.dataDeviceName,
              mode: 'READ_WRITE',
            },
          ],
          ...(settings.serviceAccountEmail
            ? { serviceAccounts: [{ email: settings.serviceAccountEmail, scopes: settings.serviceAccountScopes }] as const }
            : {}),
          metadata: { items: metadata(settings, desired.hostId, ctx.hostBootstrapScript) },
        },
      } satisfies GcpStepInput,
    });
    return steps;
  }

  private planDestroy(
    request: Extract<WorkspaceHostPlanRequest, { action: 'destroy' }>,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    if (request.confirmation.expectedHostId !== request.host.hostId)
      throw new Error('GCP destroy confirmation expectedHostId does not match the host');
    const managed = request.host.resources.filter(
      (item) =>
        item.target === GCP_WORKSPACE_HOST_TARGET &&
        [VM_KIND, DISK_KIND, FIREWALL_KIND, NAT_KIND, ROUTER_KIND, SUBNETWORK_KIND, NETWORK_KIND].includes(item.kind),
    );
    if (managed.length === 0) throw new Error('GCP destroy requires known managed resources');
    const projectId = requireString(managed[0]?.parentProviderId ?? ctx.connection.scope?.id, 'GCP projectId');
    const steps: WorkspaceHostPlanStep[] = [];
    const preserveIds: string[] = [];
    if (request.disposition !== 'discard') {
      for (const disk of managed.filter((item) => item.kind === DISK_KIND)) {
        const id = `preserve-disk-${disk.providerId}`;
        preserveIds.push(id);
        const key = `${request.idempotencyKey}:${id}`;
        steps.push({
          id,
          action: 'destroy',
          resourceKind: 'snapshot',
          dependsOn: [],
          destructive: false,
          idempotencyKey: key,
          input: {
            op: 'create-snapshot',
            projectId,
            zone: requireString(disk.zone, 'GCP destroy snapshot disk zone'),
            requestId: gcpWorkspaceHostRequestUuid(key),
            hostId: request.host.hostId,
            request: {
              name: stableName('pc-destroy', `${request.host.hostId}-${disk.providerId}`),
              sourceDisk: disk.providerId,
              labels: {
                [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.hostId]: gcpWorkspaceHostLabelValue(request.host.hostId),
                [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.managed]: 'true',
                [GCP_WORKSPACE_HOST_MANAGED_LABEL_KEYS.workspaceId]: gcpWorkspaceHostLabelValue(ctx.workspaceId),
              },
            },
          } satisfies GcpStepInput,
        });
      }
    }
    const idsByKind = new Map<string, string[]>();
    const order: readonly [string, GcpStepInput['op']][] = [
      [VM_KIND, 'delete-instance'],
      [DISK_KIND, 'delete-disk'],
      [FIREWALL_KIND, 'delete-firewall'],
      [NAT_KIND, 'delete-nat'],
      [ROUTER_KIND, 'delete-router'],
      [SUBNETWORK_KIND, 'delete-subnetwork'],
      [NETWORK_KIND, 'delete-network'],
    ];
    for (const [kind, op] of order) {
      const prior = order
        .slice(
          0,
          order.findIndex(([candidate]) => candidate === kind),
        )
        .flatMap(([candidate]) => idsByKind.get(candidate) ?? []);
      const ids: string[] = [];
      for (const item of managed
        .filter((candidate) => candidate.kind === kind)
        .sort((a, b) => a.providerId.localeCompare(b.providerId))) {
        const id = `${op}-${item.providerId}`;
        ids.push(id);
        const key = `${request.idempotencyKey}:${id}`;
        steps.push({
          id,
          action: 'destroy',
          resourceKind: kind,
          dependsOn: [...preserveIds, ...prior],
          destructive: true,
          idempotencyKey: key,
          input: {
            op,
            projectId,
            requestId: gcpWorkspaceHostRequestUuid(key),
            resourceName: item.providerId,
            ...(kind === NAT_KIND
              ? {
                  routerName: requireString(
                    managed.find((candidate) => candidate.kind === ROUTER_KIND)?.providerId,
                    'GCP destroy NAT router identity',
                  ),
                }
              : {}),
            region: item.region,
            zone: item.zone,
            hostId: request.host.hostId,
            ...(kind === VM_KIND && item.incarnationId ? { incarnationId: item.incarnationId } : {}),
          } as GcpStepInput,
        });
      }
      idsByKind.set(kind, ids);
    }
    return steps;
  }

  /**
   * Single reporting seam for created resources. Every confirmed creation in `applyStep` returns
   * through `applied(...)` carrying the resource ref it just brought into existence, so observing
   * the RESULT covers every current insert case — and every future one — without each call site
   * having to remember.
   *
   * WI-10001727: `unchanged` is NOT a reliable proxy for "we did not create this". It has two
   * distinct causes and only one of them is someone else's resource:
   *   - `applyStep` returns it for the three `use-existing-*` ops — genuinely adopted, no
   *     obligation owed. Still excluded, deliberately.
   *   - `reconcile` returns it for an `insert-*` op whose target it finds already present — which
   *     means WE created it on an attempt whose confirmation was lost. An obligation IS owed, and
   *     gating on `applied` alone silently dropped it, leaving a live metered resource with no
   *     ledger row and therefore invisible to the teardown sweep forever.
   * `createsOwnedResource` is the discriminator. Firing is safe to repeat: the ledger writer is
   * idempotent for the same provider incarnation, so a re-reconciled step is a no-op; a
   * same-name replacement is a new incarnation and reopens the obligation.
   */
  async apply(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    return this.report(request, ctx, await this.applyStep(request, ctx));
  }

  /**
   * WI-10001727: the seam above only deserves the name "single" if EVERY terminal result reaches
   * it. `reconcile` returns `unchanged`/`destroyed` DIRECTLY for the branches where it resolves a
   * step by observation, and only falls through to `apply` when it finds nothing — so before this
   * was extracted, precisely the results that reconciliation produces were the ones that never
   * reported. Both entry points now funnel their results through here; a new terminal branch that
   * forgets to is a bookkeeping hole, not a style nit.
   */
  private async report(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
    result: WorkspaceHostApplyResult,
  ): Promise<WorkspaceHostApplyResult> {
    const owesCreationObligation =
      result.state === 'applied' ||
      (result.state === 'unchanged' && createsOwnedResource(request.step));
    if (this.onResourceCreated && owesCreationObligation && result.resource) {
      const address = createdAddress(request.step);
      await this.onResourceCreated({
        resource: result.resource,
        operationId: result.operationId,
        stepId: result.stepId,
        workspaceId: ctx.workspaceId,
        hostId: address.hostId,
        parentResourceId: address.parentResourceId,
      });
    }
    // The consuming mirror of the branch above. A destroy is confirmed PER RESOURCE here, so the
    // obligation closes on the provider's own terminal evidence rather than on an aggregate
    // census — one slow census read must not discard the terminal evidence for the whole
    // operation (EI-23459044188861686). Reaching this from `reconcile` too is what closes the
    // matching hole on the teardown side: a delete whose confirmation arrived only on the
    // reconciling read used to leave its obligation open forever.
    if (this.onResourceDestroyed && result.state === 'destroyed' && result.confirmation) {
      const deleteOp = deleteOpName(request.step);
      if (deleteOp) {
        await this.onResourceDestroyed({
          resource: {
            deleteOp,
            providerId: result.confirmation.providerResourceId,
            ...(result.confirmation.incarnationId ? { incarnationId: result.confirmation.incarnationId } : {}),
            ...(result.confirmation.confirmedAbsentAt
              ? { confirmedAbsentAt: result.confirmation.confirmedAbsentAt }
              : {}),
          },
          workspaceId: ctx.workspaceId,
        });
      }
    }
    return result;
  }

  private async applyStep(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    switch (input.op) {
      case 'use-existing-network': {
        const found = await this.client.getNetwork(input.projectId, input.networkName);
        if (!found) throw new Error(`GCP existing network '${input.networkName}' was not found`);
        return this.unchanged(
          request,
          resource(EXISTING_NETWORK_KIND, found.name, { parentProviderId: input.projectId }),
        );
      }
      case 'use-existing-subnetwork': {
        requireKnownResource(request.knownResources, [NETWORK_KIND, EXISTING_NETWORK_KIND], request.step.id);
        const found = await this.client.getSubnetwork(input.projectId, input.region, input.subnetworkName);
        if (!found) throw new Error(`GCP existing subnetwork '${input.subnetworkName}' was not found`);
        return this.unchanged(
          request,
          resource(EXISTING_SUBNETWORK_KIND, found.name, { parentProviderId: input.projectId, region: input.region }),
        );
      }
      case 'use-existing-firewall': {
        requireKnownResource(request.knownResources, [NETWORK_KIND, EXISTING_NETWORK_KIND], request.step.id);
        const found = await this.client.getFirewall(input.projectId, input.firewallName);
        if (!found) throw new Error(`GCP existing firewall '${input.firewallName}' was not found`);
        assertExactSshFirewall(found, input.expectedSourceRanges);
        return this.unchanged(
          request,
          resource(EXISTING_FIREWALL_KIND, found.name, { parentProviderId: input.projectId }),
        );
      }
      case 'insert-network': {
        const operation = await this.client.insertNetwork(input.projectId, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getNetwork(input.projectId, input.request.name);
        return found
          ? this.applied(
              request,
              resource(NETWORK_KIND, found.name, { parentProviderId: input.projectId }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-subnetwork': {
        requireKnownResource(request.knownResources, [NETWORK_KIND], request.step.id);
        const operation = await this.client.insertSubnetwork(
          input.projectId,
          input.region,
          input.request,
          input.requestId,
        );
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getSubnetwork(input.projectId, input.region, input.request.name);
        return found
          ? this.applied(
              request,
              resource(SUBNETWORK_KIND, found.name, { parentProviderId: input.projectId, region: input.region }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-firewall': {
        requireKnownResource(request.knownResources, [NETWORK_KIND], request.step.id);
        const operation = await this.client.insertFirewall(input.projectId, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getFirewall(input.projectId, input.request.name);
        return found
          ? this.applied(
              request,
              resource(FIREWALL_KIND, found.name, { parentProviderId: input.projectId }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-router': {
        requireKnownResource(request.knownResources, [NETWORK_KIND], request.step.id);
        const operation = await this.client.insertRouter(input.projectId, input.region, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getRouter(input.projectId, input.region, input.request.name);
        return found
          ? this.applied(
              request,
              resource(ROUTER_KIND, found.name, { parentProviderId: input.projectId, region: input.region }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-nat': {
        requireKnownResource(request.knownResources, [ROUTER_KIND], request.step.id);
        requireKnownResource(request.knownResources, [SUBNETWORK_KIND], request.step.id);
        const operation = await this.client.insertNat(input.projectId, input.region, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getNat(
          input.projectId,
          input.region,
          input.request.routerName,
          input.request.name,
        );
        return found
          ? this.applied(
              request,
              resource(NAT_KIND, found.name, { parentProviderId: input.projectId, region: input.region }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-disk': {
        const operation = await this.client.insertDisk(input.projectId, input.zone, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getDisk(input.projectId, input.zone, input.request.name);
        return found?.status === 'READY'
          ? this.applied(
              request,
              resource(DISK_KIND, found.name, {
                parentProviderId: input.projectId,
                region: input.zone.slice(0, input.zone.lastIndexOf('-')),
                zone: input.zone,
              }),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'insert-instance': {
        requireKnownResource(request.knownResources, [SUBNETWORK_KIND, EXISTING_SUBNETWORK_KIND], request.step.id);
        if (input.requiresFirewall) {
          requireKnownResource(request.knownResources, [FIREWALL_KIND, EXISTING_FIREWALL_KIND], request.step.id);
        }
        if (input.requiresNat) requireKnownResource(request.knownResources, [NAT_KIND], request.step.id);
        requireKnownResource(request.knownResources, [DISK_KIND], request.step.id);
        const operation = await this.client.insertInstance(input.projectId, input.zone, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getInstance(input.projectId, input.zone, input.request.name);
        return found?.status === 'RUNNING'
          ? this.applied(
              request,
              vmResource(found, input.projectId, input.zone, input.zone.slice(0, input.zone.lastIndexOf('-'))),
              operation.name,
            )
          : this.inProgress(request, operation.name);
      }
      case 'start-instance':
        return this.mutateInstance(
          request,
          input,
          'RUNNING',
          () => this.client.startInstance(input.projectId, input.zone, input.instanceName, input.requestId),
          ctx.signal,
        );
      case 'stop-instance':
        return this.mutateInstance(
          request,
          input,
          'TERMINATED',
          () => this.client.stopInstance(input.projectId, input.zone, input.instanceName, input.requestId),
          ctx.signal,
        );
      case 'reset-instance':
      case 'repair-instance':
        return this.mutateInstance(
          request,
          input,
          'RUNNING',
          () => this.client.resetInstance(input.projectId, input.zone, input.instanceName, input.requestId),
          ctx.signal,
        );
      case 'set-instance-metadata': {
        const operation = await this.client.setInstanceMetadata(
          input.projectId,
          input.zone,
          input.instanceName,
          input.request,
          input.requestId,
        );
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getInstance(input.projectId, input.zone, input.instanceName);
        if (!found || !sameMetadata(found, input.request)) {
          throw new Error(`GCP instance '${input.instanceName}' did not retain refreshed startup metadata`);
        }
        return this.applied(
          request,
          vmResource(found, input.projectId, input.zone),
          operation.name,
        );
      }
      case 'create-snapshot': {
        requireKnownResource(request.knownResources, [DISK_KIND], request.step.id);
        const sourceDisk = await this.client.getDisk(input.projectId, input.zone, input.request.sourceDisk);
        if (!sourceDisk) return this.adoptSnapshotOfAbsentDisk(request, input);
        assertManagedHostResource(sourceDisk, input.hostId, 'snapshot source disk');
        const operation = await this.client.createSnapshot(input.projectId, input.zone, input.request, input.requestId);
        if (!(await this.settled(operation, ctx.signal))) return this.inProgress(request, operation.name);
        const found = await this.client.getSnapshot(input.projectId, input.request.name);
        if (found?.status !== 'READY') return this.inProgress(request, operation.name);
        return {
          operationId: request.operationId,
          stepId: request.step.id,
          state: 'applied',
          observedAt: found.observedAt,
          providerRequestId: operation.name,
          snapshot: {
            target: GCP_WORKSPACE_HOST_TARGET,
            providerId: found.name,
            hostId: input.hostId,
            createdAt: found.observedAt,
            ...(input.request.snapshotEncryptionKey?.kmsKeyName
              ? { encryptionKeyRef: input.request.snapshotEncryptionKey.kmsKeyName }
              : {}),
          },
        };
      }
      case 'delete-instance':
      case 'delete-disk':
      case 'delete-firewall':
      case 'delete-nat':
      case 'delete-router':
      case 'delete-subnetwork':
      case 'delete-network':
        return this.deleteResource(request, input, ctx.signal);
    }
  }

  /**
   * A snapshot step whose source disk is gone can never take a NEW recovery point, so it is
   * satisfied only if an earlier attempt already took this exact snapshot — e.g. a destroy re-driven
   * under a new operation after the first one snapshotted and deleted the disk but failed its census
   * (P-318, r38). The step's snapshot name is deterministic, so adopt it as `unchanged` when it is
   * READY, labeled for this host and taken from this disk. With the disk present we always take a
   * fresh snapshot instead: adopting there would pass off an older point in time as current.
   */
  private async adoptSnapshotOfAbsentDisk(
    request: WorkspaceHostApplyRequest,
    input: Extract<GcpStepInput, { op: 'create-snapshot' }>,
  ): Promise<WorkspaceHostApplyResult> {
    const absent = `GCP snapshot source disk '${input.request.sourceDisk}' is absent`;
    const existing = await this.client.getSnapshot(input.projectId, input.request.name);
    if (existing?.status !== 'READY') throw new Error(absent);
    assertManagedHostResource(existing, input.hostId, 'snapshot');
    if (existing.sourceDisk !== input.request.sourceDisk) {
      throw new Error(`${absent}, and snapshot '${existing.name}' was not taken from it`);
    }
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'unchanged',
      observedAt: existing.observedAt,
      snapshot: {
        target: GCP_WORKSPACE_HOST_TARGET,
        providerId: existing.name,
        hostId: input.hostId,
        createdAt: existing.createdAt ?? existing.observedAt,
        ...(input.request.snapshotEncryptionKey?.kmsKeyName
          ? { encryptionKeyRef: input.request.snapshotEncryptionKey.kmsKeyName }
          : {}),
      },
    };
  }

  private async mutateInstance(
    request: WorkspaceHostApplyRequest,
    input: Extract<GcpStepInput, { op: 'start-instance' | 'stop-instance' | 'reset-instance' | 'repair-instance' }>,
    expected: GcpComputeInstanceStatus,
    mutation: () => Promise<GcpOperationRef>,
    signal?: AbortSignal,
  ): Promise<WorkspaceHostApplyResult> {
    const operation = await mutation();
    if (!(await this.settled(operation, signal))) return this.inProgress(request, operation.name);
    const found = await this.client.getInstance(input.projectId, input.zone, input.instanceName);
    return found?.status === expected
      ? this.applied(
          request,
          vmResource(found, input.projectId, input.zone),
          operation.name,
        )
      : this.inProgress(request, operation.name);
  }

  private async settled(operation: GcpOperationRef, signal?: AbortSignal): Promise<boolean> {
    const observed = await this.client.waitForOperation(operation, signal);
    if (observed.error) throw new Error(`GCP operation '${operation.name}' failed: ${observed.error.message}`);
    return observed.status === 'DONE';
  }

  private async deleteResource(
    request: WorkspaceHostApplyRequest,
    input: Extract<
      GcpStepInput,
      {
        op:
          | 'delete-instance'
          | 'delete-disk'
          | 'delete-firewall'
          | 'delete-nat'
          | 'delete-router'
          | 'delete-subnetwork'
          | 'delete-network';
      }
    >,
    signal?: AbortSignal,
  ): Promise<WorkspaceHostApplyResult> {
    const before = await this.describeDeleteTarget(input);
    if (!before) return this.destroyed(request, input.hostId, input.resourceName, undefined, input.incarnationId);
    const beforeIncarnationId = input.op === 'delete-instance'
      ? requireString((before as GcpInstanceObservation).instanceId, `GCP instance '${input.resourceName}' id`)
      : undefined;
    if (input.op === 'delete-instance' && input.incarnationId && beforeIncarnationId !== input.incarnationId) {
      // The provider name now identifies a replacement, not the incarnation this destroy plan
      // observed. Treat the old target as absent without deleting the live replacement.
      return this.destroyed(request, input.hostId, input.resourceName, undefined, input.incarnationId);
    }
    const destroyedIncarnationId = input.op === 'delete-instance'
      ? input.incarnationId ?? beforeIncarnationId
      : undefined;
    if (input.op === 'delete-instance') assertManagedHostResource(before, input.hostId, 'instance');
    if (input.op === 'delete-disk') {
      const disk = before as GcpDiskObservation;
      assertManagedHostResource(disk, input.hostId, 'data disk');
      if (disk.attachedInstanceNames.length > 0) {
        throw new Error(
          `GCP data disk '${disk.name}' is still attached to ${disk.attachedInstanceNames.join(', ')}; refusing deletion`,
        );
      }
    }
    if (input.op === 'delete-router') {
      const router = before as GcpRouterObservation;
      if (router.natNames.length > 0) {
        throw new Error(
          `GCP router '${router.name}' still contains NAT configuration(s): ${router.natNames.join(', ')}; refusing deletion`,
        );
      }
    }
    let operation: GcpOperationRef;
    if (input.op === 'delete-instance')
      operation = await this.client.deleteInstance(
        input.projectId,
        requireString(input.zone, 'delete instance zone'),
        input.resourceName,
        input.requestId,
      );
    else if (input.op === 'delete-disk')
      operation = await this.client.deleteDisk(
        input.projectId,
        requireString(input.zone, 'delete disk zone'),
        input.resourceName,
        input.requestId,
      );
    else if (input.op === 'delete-firewall')
      operation = await this.client.deleteFirewall(input.projectId, input.resourceName, input.requestId);
    else if (input.op === 'delete-nat')
      operation = await this.client.deleteNat(
        input.projectId,
        requireString(input.region, 'delete NAT region'),
        requireString(input.routerName, 'delete NAT router'),
        input.resourceName,
        input.requestId,
      );
    else if (input.op === 'delete-router')
      operation = await this.client.deleteRouter(
        input.projectId,
        requireString(input.region, 'delete router region'),
        input.resourceName,
        input.requestId,
      );
    else if (input.op === 'delete-subnetwork')
      operation = await this.client.deleteSubnetwork(
        input.projectId,
        requireString(input.region, 'delete subnetwork region'),
        input.resourceName,
        input.requestId,
      );
    else operation = await this.client.deleteNetwork(input.projectId, input.resourceName, input.requestId);
    if (!(await this.settled(operation, signal))) return this.inProgress(request, operation.name);
    const after = await this.describeDeleteTarget(input);
    if (after) {
      if (input.op === 'delete-instance') {
        const afterIncarnationId = requireString(
          (after as GcpInstanceObservation).instanceId,
          `GCP instance '${input.resourceName}' id`,
        );
        if (destroyedIncarnationId && afterIncarnationId !== destroyedIncarnationId) {
          return this.destroyed(request, input.hostId, input.resourceName, operation.name, destroyedIncarnationId);
        }
      }
      return this.inProgress(request, operation.name);
    }
    return this.destroyed(request, input.hostId, input.resourceName, operation.name, destroyedIncarnationId);
  }

  private describeDeleteTarget(
    input: Extract<
      GcpStepInput,
      {
        op:
          | 'delete-instance'
          | 'delete-disk'
          | 'delete-firewall'
          | 'delete-nat'
          | 'delete-router'
          | 'delete-subnetwork'
          | 'delete-network';
      }
    >,
  ): Promise<GcpResourceObservation | undefined> {
    if (input.op === 'delete-instance')
      return this.client.getInstance(
        input.projectId,
        requireString(input.zone, 'delete instance zone'),
        input.resourceName,
      );
    if (input.op === 'delete-disk')
      return this.client.getDisk(input.projectId, requireString(input.zone, 'delete disk zone'), input.resourceName);
    if (input.op === 'delete-firewall') return this.client.getFirewall(input.projectId, input.resourceName);
    if (input.op === 'delete-nat')
      return this.client.getNat(
        input.projectId,
        requireString(input.region, 'delete NAT region'),
        requireString(input.routerName, 'delete NAT router'),
        input.resourceName,
      );
    if (input.op === 'delete-router')
      return this.client.getRouter(
        input.projectId,
        requireString(input.region, 'delete router region'),
        input.resourceName,
      );
    if (input.op === 'delete-subnetwork')
      return this.client.getSubnetwork(
        input.projectId,
        requireString(input.region, 'delete subnetwork region'),
        input.resourceName,
      );
    return this.client.getNetwork(input.projectId, input.resourceName);
  }

  async reconcile(
    request: WorkspaceHostReconcileRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    const existing = await this.describeCreatedTarget(input);
    if (existing) {
      if (input.op === 'insert-instance') {
        assertInstanceBootsRequestedImage(
          existing.name,
          'sourceImage' in existing ? existing.sourceImage : undefined,
          input.request.disks[0].initializeParams.sourceImage,
        );
      }
      if (input.op === 'create-snapshot' && 'status' in existing && existing.status === 'READY') {
        return {
          operationId: request.operationId,
          stepId: request.step.id,
          state: 'unchanged',
          observedAt: existing.observedAt,
          snapshot: {
            target: GCP_WORKSPACE_HOST_TARGET,
            providerId: existing.name,
            hostId: input.hostId,
            createdAt: existing.observedAt,
          },
        };
      }
      const kind =
        input.op === 'insert-instance'
          ? VM_KIND
          : input.op === 'insert-disk'
            ? DISK_KIND
            : input.op === 'insert-network'
              ? NETWORK_KIND
              : input.op === 'insert-subnetwork'
                ? SUBNETWORK_KIND
                : input.op === 'insert-firewall'
                  ? FIREWALL_KIND
                  : input.op === 'insert-router'
                    ? ROUTER_KIND
                    : input.op === 'insert-nat'
                      ? NAT_KIND
                      : input.op === 'use-existing-network'
                        ? EXISTING_NETWORK_KIND
                        : input.op === 'use-existing-subnetwork'
                          ? EXISTING_SUBNETWORK_KIND
                          : input.op === 'use-existing-firewall'
                            ? EXISTING_FIREWALL_KIND
                            : undefined;
      if (kind) {
        const resourceRef = input.op === 'insert-instance'
          ? vmResource(
              existing as GcpInstanceObservation,
              input.projectId,
              input.zone,
              input.zone.slice(0, input.zone.lastIndexOf('-')),
            )
          : resource(kind, existing.name, {
              parentProviderId: 'projectId' in input ? input.projectId : undefined,
              region: 'region' in input ? input.region : undefined,
              zone: 'zone' in input ? input.zone : undefined,
            });
        return this.report(request, ctx, this.unchanged(request, resourceRef));
      }
      if (input.op === 'set-instance-metadata') {
        if (sameMetadata(existing as GcpInstanceObservation, input.request)) {
          return this.report(
            request,
            ctx,
            this.unchanged(
              request,
              vmResource(existing as GcpInstanceObservation, input.projectId, input.zone),
            ),
          );
        }
        return this.apply(request, ctx);
      }
      if ('instanceName' in input) {
        const wanted = input.op === 'stop-instance' ? 'TERMINATED' : 'RUNNING';
        if ('status' in existing && existing.status === wanted)
          return this.report(
            request,
            ctx,
            this.unchanged(
              request,
              vmResource(existing as GcpInstanceObservation, input.projectId, input.zone),
            ),
          );
      }
    }
    if (isDeleteStepInput(input) && !(await this.describeDeleteTarget(input))) {
      return this.report(
        request,
        ctx,
        this.destroyed(request, input.hostId, input.resourceName, undefined, input.incarnationId),
      );
    }
    return this.apply(request, ctx);
  }

  private describeCreatedTarget(
    input: GcpStepInput,
  ): Promise<
    GcpResourceObservation | GcpInstanceObservation | GcpDiskObservation | GcpSnapshotObservation | undefined
  > {
    if (input.op === 'insert-network') return this.client.getNetwork(input.projectId, input.request.name);
    if (input.op === 'use-existing-network') return this.client.getNetwork(input.projectId, input.networkName);
    if (input.op === 'insert-subnetwork')
      return this.client.getSubnetwork(input.projectId, input.region, input.request.name);
    if (input.op === 'use-existing-subnetwork')
      return this.client.getSubnetwork(input.projectId, input.region, input.subnetworkName);
    if (input.op === 'insert-firewall') return this.client.getFirewall(input.projectId, input.request.name);
    if (input.op === 'insert-router') return this.client.getRouter(input.projectId, input.region, input.request.name);
    if (input.op === 'insert-nat')
      return this.client.getNat(input.projectId, input.region, input.request.routerName, input.request.name);
    if (input.op === 'use-existing-firewall') return this.client.getFirewall(input.projectId, input.firewallName);
    if (input.op === 'insert-disk') return this.client.getDisk(input.projectId, input.zone, input.request.name);
    if (input.op === 'insert-instance') return this.client.getInstance(input.projectId, input.zone, input.request.name);
    if (input.op === 'create-snapshot') return this.client.getSnapshot(input.projectId, input.request.name);
    if ('instanceName' in input) return this.client.getInstance(input.projectId, input.zone, input.instanceName);
    return Promise.resolve(undefined);
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
    incarnationId?: string,
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
        ...(incarnationId ? { incarnationId } : {}),
        confirmedAbsentAt: observedAt,
        source: 'provider-read',
        providerRequestId,
      },
    };
  }

  async observe(host: WorkspaceHostRef, _ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostObservation> {
    const vm = knownResource(host.resources, [VM_KIND]);
    const disks = host.resources.filter((item) => item.target === GCP_WORKSPACE_HOST_TARGET && item.kind === DISK_KIND);
    const projectId = requireString(vm?.parentProviderId ?? disks[0]?.parentProviderId, 'GCP observation projectId');
    const instance = vm
      ? await this.client.getInstance(projectId, requireString(vm.zone, 'GCP VM zone'), vm.providerId)
      : undefined;
    const observedDisks = await Promise.all(
      disks.map((item) => this.client.getDisk(projectId, requireString(item.zone, 'GCP disk zone'), item.providerId)),
    );
    const drift: string[] = [];
    if (!vm || !instance) drift.push('instance-absent');
    disks.forEach((disk, index) => {
      const observed = observedDisks[index];
      if (!observed) drift.push(`disk-absent:${disk.providerId}`);
      else if (vm && !observed.attachedInstanceNames.map(refName).includes(refName(vm.providerId)))
        drift.push(`disk-detached:${disk.providerId}`);
    });
    const resources = host.resources
      .filter((item) => item.kind !== VM_KIND || !!instance)
      .filter(
        (item) =>
          item.kind !== DISK_KIND || !!observedDisks[disks.findIndex((disk) => disk.providerId === item.providerId)],
      );
    return {
      host,
      state: this.lifecycleState(instance),
      resources,
      ...(instance?.sourceImage ? { image: { id: instance.sourceImage } } : {}),
      observedAt: this.now(),
      drift,
    };
  }

  private lifecycleState(instance: GcpInstanceObservation | undefined): WorkspaceHostObservation['state'] {
    if (!instance) return 'absent';
    // `agentOnline` is optional and currently has NO producer on the GCP path. The lifecycle
    // state describes the VM, so an UNMEASURED agent leaves the host 'running' and only a
    // MEASURED false demotes it. Written as an explicit three-way rather than a `=== false`
    // coercion so the absent case is a deliberate decision here instead of an accident that
    // silently disagrees with attestHealth's reading of the same field (WI-2143924).
    if (instance.status === 'RUNNING') {
      if (instance.agentOnline === false) return 'degraded';
      return 'running';
    }
    if (instance.status === 'SUSPENDED' || instance.status === 'TERMINATED') return 'stopped';
    if (instance.status === 'STOPPING') return 'destroying';
    if (instance.status === 'REPAIRING') return 'repairing';
    return 'provisioning';
  }

  async getTransportProfile(
    host: WorkspaceHostRef,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostTransportProfile> {
    const vm = requireKnownResource(host.resources, [VM_KIND], 'get-transport-profile');
    const projectId = requireString(vm.parentProviderId ?? ctx.connection.scope?.id, 'GCP transport projectId');
    const zone = requireString(vm.zone, 'GCP VM zone');
    const provider = ctx.connection.provider ?? {};
    const requested =
      optionalString(provider.transportPreference, 'GCP connection transportPreference') ?? 'gcp-iap-ssh';
    if (!(GCP_WORKSPACE_HOST_TRANSPORTS as readonly string[]).includes(requested)) {
      throw new Error(`GCP transportPreference must be one of ${GCP_WORKSPACE_HOST_TRANSPORTS.join(', ')}`);
    }
    const kind = requested as GcpWorkspaceHostTransport;
    const instance = kind === 'gcp-iap-ssh' ? undefined : await this.client.getInstance(projectId, zone, vm.providerId);
    return buildGcpWorkspaceHostTransportProfile({
      kind,
      projectId,
      zone,
      instanceName: vm.providerId,
      ...(instance?.externalIp ? { externalIp: instance.externalIp } : {}),
      ...(instance?.defguardIp
        ? { defguardAddress: instance.defguardIp }
        : provider.defguardAddress !== undefined
          ? { defguardAddress: requireString(provider.defguardAddress, 'GCP connection defguardAddress') }
          : {}),
    });
  }

  async attestHealth(
    host: WorkspaceHostRef,
    _ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostHealthAttestation> {
    const vm = knownResource(host.resources, [VM_KIND]);
    const projectId = requireString(vm?.parentProviderId, 'GCP health projectId');
    const instance = vm
      ? await this.client.getInstance(projectId, requireString(vm.zone, 'GCP VM zone'), vm.providerId)
      : undefined;
    const running = instance?.status === 'RUNNING';
    // NOT `=== true`. Nothing on the GCP path writes `agentOnline` — gcp-api-client.ts never
    // assigns it, and gcp-api-client.test.ts pins its absence — so coercing it to a boolean
    // reported `degraded` for every healthy host and made `healthy` unreachable, which would
    // hang any caller polling for it (WI-2143924). Propagate the absence instead; when a real
    // producer lands, this same line starts carrying a real boolean with no other change.
    const agentOnline = instance?.agentOnline ?? null;
    const checks: WorkspaceHostHealthCheck[] = [
      { name: 'compute-running', ok: running, detail: instance?.status ?? 'absent' },
      agentOnline === null
        ? unmeasuredHealthCheck('workspace-agent-online', 'no producer writes agentOnline on the GCP path')
        : { name: 'workspace-agent-online', ok: agentOnline },
    ];
    return {
      hostId: host.hostId,
      observedAt: this.now(),
      status: resolveWorkspaceHostHealthStatus({ reachable: running, checks }),
      ...(instance?.sourceImage ? { image: { id: instance.sourceImage } } : {}),
      checks,
    };
  }
}

export function createGcpWorkspaceHostProvider(options: GcpWorkspaceHostProviderOptions): GcpWorkspaceHostProvider {
  if (!options?.client) throw new Error('GCP workspace-host provider requires an injected Compute Engine client');
  return new GcpWorkspaceHostProvider(options.client, {
    now: options.now,
    onResourceCreated: options.onResourceCreated,
    onResourceDestroyed: options.onResourceDestroyed,
  });
}

/** Explicit production composition: ADC and Google REST are never selected implicitly. */
export function createAdcGcpWorkspaceHostProvider(
  options: GcpWorkspaceHostApiClientOptions & {
    onResourceCreated?: WorkspaceHostResourceCreatedObserver;
    onResourceDestroyed?: WorkspaceHostResourceDestroyedObserver;
  } = {},
): GcpWorkspaceHostProvider {
  const { onResourceCreated, onResourceDestroyed, ...clientOptions } = options;
  return new GcpWorkspaceHostProvider(createGcpWorkspaceHostApiClient(clientOptions), {
    now: options.now,
    onResourceCreated,
    onResourceDestroyed,
  });
}

/** Production composition selected by the persisted, non-secret cloud credential reference. */
export function createConfiguredGcpWorkspaceHostProvider(
  connection: WorkspaceHostProviderConnection,
  options: Omit<GcpWorkspaceHostApiClientOptions, 'acquireAuth' | 'credentialRef'> & {
    resolveHostedAuth?: (input: {
      credentialRef: string;
      provider: Readonly<Record<string, unknown>>;
    }) => Promise<GcpResolvedAuth>;
    onResourceCreated?: WorkspaceHostResourceCreatedObserver;
    onResourceDestroyed?: WorkspaceHostResourceDestroyedObserver;
  } = {},
): GcpWorkspaceHostProvider {
  if (connection.target !== GCP_WORKSPACE_HOST_TARGET) {
    throw new Error(`GCP workspace-host provider cannot compose target '${connection.target}'`);
  }
  const credentialRef = connection.cloudCredentialRef.ref.trim();
  const hosted = /^(?:encrypted|resolver|delegation):\/\//.test(credentialRef);
  if (hosted && !options.resolveHostedAuth) {
    throw new Error('gcp_workspace_host_hosted_auth_resolver_required');
  }
  const acquireAuth = hosted
    ? () => options.resolveHostedAuth!({ credentialRef, provider: connection.provider ?? {} })
    : createGcpWorkspaceHostAcquireAuth(credentialRef);
  const {
    resolveHostedAuth: _resolveHostedAuth,
    onResourceCreated,
    onResourceDestroyed,
    ...clientOptions
  } = options;
  return new GcpWorkspaceHostProvider(
    createGcpWorkspaceHostApiClient({
      ...clientOptions,
      acquireAuth,
      credentialRef,
    }),
    { now: clientOptions.now, onResourceCreated, onResourceDestroyed },
  );
}
