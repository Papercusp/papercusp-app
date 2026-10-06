import { createHash } from 'node:crypto';
import type { WorkspaceHostResourceCreatedObserver, WorkspaceHostResourceDestroyedObserver } from './gcp-provider';
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
import { AWS_WORKSPACE_HOST_TARGET } from './aws-connection';
import { AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC, renderAwsHostBootstrapPush } from './aws-host-bootstrap-push';
import {
  AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS,
  type AwsWorkspaceHostInventoryRequest,
  type AwsWorkspaceHostInventorySnapshot,
} from './aws-safety';
import {
  AWS_WORKSPACE_HOST_TRANSPORTS,
  buildAwsWorkspaceHostTransportProfile,
  type AwsWorkspaceHostTransport,
} from './aws-connection-profile';

export const AWS_WORKSPACE_HOST_PROVIDER_VERSION = 'aws-workspace-host-provider-v1';
export const AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH = 64;

export type AwsEc2InstanceState = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';
/** EC2's own volume states; `error` is terminal-failed (the SDK client fails a wait that lands there). */
export type AwsEbsVolumeState = 'creating' | 'available' | 'in-use' | 'deleting' | 'deleted' | 'error';

export interface AwsTag {
  Key: string;
  Value: string;
}

export interface AwsRunInstancesInput {
  ClientToken: string;
  /**
   * The AMI the instance boots: `desired.image.id` (WI-10005971). Always explicit. The customer
   * launch template carries only metadata options, so an omitted ImageId leaves EC2 with no image
   * at all, and an upgrade must be able to name a different AMI than the one the host first ran.
   */
  ImageId: string;
  /** `desired.size`. Explicit for the same reason: the launch template does not pin a type. */
  InstanceType: string;
  MinCount: 1;
  MaxCount: 1;
  LaunchTemplate: {
    LaunchTemplateId: string;
    Version?: string;
  };
  NetworkInterfaces: readonly [
    {
      DeviceIndex: 0;
      SubnetId: string;
      Groups: readonly string[];
      DeleteOnTermination: true;
      /**
       * Always false (P-005): the host is reached only through SSM Session Manager, so it never
       * needs a public address. Explicit rather than omitted, because an omitted value inherits the
       * subnet's MapPublicIpOnLaunch — a customer subnet with that on would silently publish the
       * host to the internet.
       */
      AssociatePublicIpAddress: false;
    },
  ];
  IamInstanceProfile: { Arn: string };
  BlockDeviceMappings: readonly [
    {
      DeviceName: string;
      Ebs: {
        DeleteOnTermination: true;
        Encrypted: true;
        KmsKeyId: string;
        VolumeSize: number;
        VolumeType: string;
        /**
         * The root volume is always restored from the AMI's snapshot, so it is valid here. Set from
         * `volumeInitializationRateMiBps`; absent only when that setting is `null`.
         */
        VolumeInitializationRate?: number;
      };
    },
  ];
  /**
   * Present only for a spot host. RunInstances then also files a persistent spot request, and
   * the third tag specification tags that request so the managed-tag inventory and the IAM
   * TagOnlyAtCreation guard both cover it.
   */
  InstanceMarketOptions?: AwsSpotMarketOptions;
  TagSpecifications: readonly [
    { ResourceType: 'instance'; Tags: readonly AwsTag[] },
    { ResourceType: 'volume'; Tags: readonly AwsTag[] },
    { ResourceType: 'spot-instances-request'; Tags: readonly AwsTag[] }?,
  ];
  UserData?: string;
}

/**
 * A spot host's market options (WI-10005389; GCP's analogue is `GCP_SPOT_SCHEDULING`, D-028).
 *
 * - `stop`, not `terminate`: an interruption keeps the root and data EBS volumes, so the host
 *   comes back with its state and agents resume. GCP's spot hosts use STOP for the same reason.
 * - `persistent`: RunInstances accepts `stop` only for a persistent request. While the request is
 *   open, EC2 itself restarts the stopped instance once capacity returns; a controller
 *   StartInstances on an interrupted spot instance is refused. No `ValidUntil`, so the request
 *   stays open until it is cancelled (AWS: "Otherwise, the request remains active until you
 *   cancel it").
 * - No `MaxPrice`: AWS recommends against one, because a cap only adds interruptions.
 *
 * The persistent request outlives a TerminateInstances: terminating the instance while the
 * request is open makes EC2 launch a replacement. Destroy therefore cancels the request first.
 */
export interface AwsSpotMarketOptions {
  MarketType: 'spot';
  SpotOptions: { SpotInstanceType: 'persistent'; InstanceInterruptionBehavior: 'stop' };
}

export const AWS_SPOT_MARKET_OPTIONS: AwsSpotMarketOptions = Object.freeze({
  MarketType: 'spot',
  SpotOptions: Object.freeze({ SpotInstanceType: 'persistent', InstanceInterruptionBehavior: 'stop' }),
}) as AwsSpotMarketOptions;

export const AWS_WORKSPACE_HOST_PROVISIONING_MODELS = ['standard', 'spot'] as const;
export type AwsWorkspaceHostProvisioningModel = (typeof AWS_WORKSPACE_HOST_PROVISIONING_MODELS)[number];

export interface AwsCreateVolumeInput {
  AvailabilityZone: string;
  ClientToken: string;
  Encrypted: true;
  KmsKeyId: string;
  Size: number;
  VolumeType: string;
  /** Restore only: the data volume is created from this EBS snapshot of the source host. */
  SnapshotId?: string;
  /**
   * Restore only, like `SnapshotId`: EBS accepts a volume initialization rate only for a volume
   * created from a snapshot. Present iff `SnapshotId` is and `volumeInitializationRateMiBps` is not
   * `null`.
   */
  VolumeInitializationRate?: number;
  TagSpecifications: readonly [{ ResourceType: 'volume'; Tags: readonly AwsTag[] }];
}

/**
 * EBS Provisioned Rate for Volume Initialization (WI-10006140, root cause from WI-10006110).
 *
 * A volume restored from a snapshot is hydrated LAZILY from S3 by default: each block is fetched
 * on first read. A workspace host's root volume always comes from the AMI's snapshot, so its first
 * boot reads the release tree, node and the native addons at lazy-load speed, and
 * papercusp-workspace.service missed its start and health budgets on fresh hosts. Measured in the
 * P-012 canary [peer:su-ee96d6e7 2026-10-05]: with the rate at 300 MiB/s the service started in 56s
 * and passed health; without it, it never bound. A restored data volume is hydrated the same way.
 *
 * AWS accepts 100–300 MiB/s and only for volumes created from a snapshot (the AMI root, a restored
 * data volume) — never for a new empty data volume. The default is the maximum because the point
 * is a predictable first boot. `null` in `aws.desired.provider.volumeInitializationRateMiBps` opts
 * out (EBS's default lazy hydration). AWS bills this per GiB initialized, once per volume.
 */
export const AWS_VOLUME_INITIALIZATION_RATE_MIBPS = Object.freeze({ min: 100, max: 300, default: 300 });

export interface AwsCreateSnapshotInput {
  ClientToken: string;
  VolumeId: string;
  Description: string;
  TagSpecifications: readonly [{ ResourceType: 'snapshot'; Tags: readonly AwsTag[] }];
}

export interface AwsInstanceObservation {
  instanceId: string;
  state: AwsEc2InstanceState;
  imageId?: string;
  attachedVolumeIds: readonly string[];
  instanceStatus?: 'ok' | 'impaired' | 'initializing' | 'insufficient-data';
  systemStatus?: 'ok' | 'impaired' | 'initializing' | 'insufficient-data';
  ssmOnline?: boolean;
  /** EC2's StateReason: why the instance left `pending`/`running` (e.g. Client.InvalidKMSKey.InvalidState). */
  stateReason?: { code: string; message?: string };
  /** EC2's SpotInstanceRequestId: present exactly when the instance is a spot instance. */
  spotInstanceRequestId?: string;
  observedAt: string;
}

/**
 * The instance a `run-instance` step launched ended before it ever ran. Terminal for the step,
 * whatever the cause: EC2 answers a repeated RunInstances carrying the same ClientToken with the
 * SAME instance, so no retry of this step can produce a new one. Before this error the waiter's
 * FAILURE verdict was swallowed, the step reported in-progress, reconcile read `terminated` as
 * absent and re-issued the call, and the operation sat at running forever (WI-10005332).
 *
 * `status` is what the shared classifier reads (4xx -> terminal). `transient` marks an AWS-side
 * cause (`Server.*`, e.g. InsufficientInstanceCapacity) that a NEW operation, with a new token,
 * may clear; a `Client.*` cause (a KMS key the instance cannot use, a volume limit) will recur
 * until the configuration changes.
 */
export class AwsInstanceLaunchFailedError extends Error {
  readonly status = 422;
  readonly code: string;
  readonly transient: boolean;

  constructor(observation: AwsInstanceObservation) {
    const code = observation.stateReason?.code ?? 'unknown';
    const transient = code.startsWith('Server.');
    super(
      `AWS instance ${observation.instanceId} ended '${observation.state}' during launch` +
        ` (${code}${observation.stateReason?.message ? `: ${observation.stateReason.message}` : ''})` +
        (transient ? '; the cause is AWS-side, so a new provision operation may succeed' : ''),
    );
    this.name = 'AwsInstanceLaunchFailedError';
    this.code = code;
    this.transient = transient;
  }
}

/** A launch observed `shutting-down`/`terminated` can never reach `running` (see the error above). */
function assertInstanceLaunchAlive(observation: AwsInstanceObservation | undefined): void {
  if (observation && (observation.state === 'terminated' || observation.state === 'shutting-down')) {
    throw new AwsInstanceLaunchFailedError(observation);
  }
}

export interface AwsVolumeObservation {
  volumeId: string;
  state: AwsEbsVolumeState;
  attachedInstanceId?: string;
  observedAt: string;
}

export interface AwsSnapshotObservation {
  snapshotId: string;
  state: 'pending' | 'completed' | 'error' | 'deleted';
  observedAt: string;
}

/** A fresh DescribeSnapshots read of one snapshot, with what a restore must verify before it plans. */
export interface AwsSnapshotDescription extends AwsSnapshotObservation {
  tags: Readonly<Record<string, string>>;
  volumeSizeGiB?: number;
}

/** One security group's inbound surface, as EC2 reports it (P-005). */
export interface AwsSecurityGroupIngressObservation {
  groupId: string;
  /** Number of ingress permissions; any value above zero refuses the launch. */
  ingressRuleCount: number;
}

export interface AwsProviderMutationResult {
  requestId?: string;
}

export interface AwsCreatedInstance extends AwsProviderMutationResult {
  instanceId: string;
}

export interface AwsCreatedVolume extends AwsProviderMutationResult {
  volumeId: string;
}

export interface AwsCreatedSnapshot extends AwsProviderMutationResult {
  snapshotId: string;
}

/**
 * AWS SDK v3-shaped seam. Production composition may wrap EC2, Pricing, STS,
 * and SSM clients; the provider contract tests inject an in-memory fake.
 */
export interface AwsWorkspaceHostSdkClient {
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

  createVolume(input: AwsCreateVolumeInput): Promise<AwsCreatedVolume>;
  findVolumeByClientToken(clientToken: string): Promise<AwsVolumeObservation | undefined>;
  describeVolume(volumeId: string): Promise<AwsVolumeObservation | undefined>;
  waitForVolumeState(
    volumeId: string,
    state: 'available' | 'in-use' | 'deleted',
    signal?: AbortSignal,
  ): Promise<AwsVolumeObservation | undefined>;
  deleteVolume(volumeId: string): Promise<AwsProviderMutationResult>;

  /**
   * Inbound rules of the security groups a host will be launched into (P-005). A workspace host is
   * reached only over SSM, so the run-instance step refuses any group that admits inbound traffic.
   * Every requested group must be returned; a missing one is treated as unverifiable.
   */
  describeSecurityGroupIngress(groupIds: readonly string[]): Promise<readonly AwsSecurityGroupIngressObservation[]>;
  /**
   * The instance's decoded serial-console output, or undefined when EC2 has none yet (P-005).
   * cloud-init prints the SSH host keys there, which is how trust is pinned before the first SSH.
   */
  getConsoleOutput(instanceId: string): Promise<string | undefined>;
  /** Wait until SSM reports the instance Online (D-013); false when the wait budget lapses. */
  waitForSsmOnline(instanceId: string, signal?: AbortSignal): Promise<boolean>;
  /** Run shell lines on one instance through AWS-RunShellScript (D-013). */
  sendShellCommand(input: AwsShellCommandInput): Promise<{ commandId: string; requestId?: string }>;
  /** The command's state on the instance once it settles or the wait budget lapses. */
  waitForCommandInvocation(
    commandId: string,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<AwsCommandInvocationObservation>;
  runInstances(input: AwsRunInstancesInput): Promise<AwsCreatedInstance>;
  findInstanceByClientToken(clientToken: string): Promise<AwsInstanceObservation | undefined>;
  describeInstance(instanceId: string): Promise<AwsInstanceObservation | undefined>;
  waitForInstanceState(
    instanceId: string,
    state: 'running' | 'stopped' | 'terminated',
    signal?: AbortSignal,
  ): Promise<AwsInstanceObservation | undefined>;
  attachVolume(input: { InstanceId: string; VolumeId: string; Device: string }): Promise<AwsProviderMutationResult>;
  /** Detach a data volume from a STOPPED instance (an upgrade moves it to the replacement instance). */
  detachVolume(input: { InstanceId: string; VolumeId: string }): Promise<AwsProviderMutationResult>;
  startInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;
  stopInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;
  rebootInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;
  repairInstance(instanceId: string): Promise<AwsProviderMutationResult>;
  terminateInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;
  /**
   * Cancel spot instance requests. Cancelling never terminates the instance; it only stops EC2
   * from relaunching or restarting it. A request EC2 no longer knows counts as cancelled.
   */
  cancelSpotInstanceRequests(spotInstanceRequestIds: readonly string[]): Promise<AwsProviderMutationResult>;

  createSnapshot(input: AwsCreateSnapshotInput): Promise<AwsCreatedSnapshot>;
  findSnapshotByClientToken(clientToken: string): Promise<AwsSnapshotObservation | undefined>;
  waitForSnapshotCompleted(snapshotId: string, signal?: AbortSignal): Promise<AwsSnapshotObservation>;
  /** One snapshot owned by this account, or undefined when EC2 does not return it. */
  describeSnapshot(snapshotId: string): Promise<AwsSnapshotDescription | undefined>;
  /**
   * Controller-independent inventory of one workspace's Papercusp-managed EC2 instances, EBS
   * volumes and EBS snapshots, by managed-tag filter (aws-byoc-gcp-parity-2026-10-01 P-003).
   * Feeds `censusAwsWorkspaceHostResources` before and after a destroy.
   */
  listManagedResources(request: AwsWorkspaceHostInventoryRequest): Promise<AwsWorkspaceHostInventorySnapshot>;
}

export interface AwsShellCommandInput {
  instanceId: string;
  commands: readonly string[];
  /** Shown in the SSM console; truncated to SSM's 100-character limit. */
  comment: string;
  executionTimeoutSec: number;
}

export interface AwsCommandInvocationObservation {
  /** SSM CommandInvocationStatus: Success, Failed, TimedOut, Cancelled, or a non-terminal state. */
  status: string;
  responseCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface AwsWorkspaceHostProviderOptions {
  client: AwsWorkspaceHostSdkClient;
  now?: () => string;
  /**
   * Teardown-obligation producer (same contract as the GCP provider): called once an owned,
   * metered resource (EC2 instance, EBS volume) is confirmed to exist. Errors propagate and fail
   * the step, because an untracked billable resource is the defect the ledger exists to prevent.
   */
  onResourceCreated?: WorkspaceHostResourceCreatedObserver;
  /** Teardown-obligation consumer: called once a delete is confirmed by a fresh provider read. */
  onResourceDestroyed?: WorkspaceHostResourceDestroyedObserver;
}

export interface AwsWorkspaceHostDesiredProviderSettings {
  vpcId: string;
  subnetId: string;
  securityGroupIds: readonly string[];
  availabilityZone: string;
  instanceProfileArn: string;
  launchTemplateId: string;
  launchTemplateVersion?: string;
  kmsKeyArn: string;
  rootVolumeGiB: number;
  rootDeviceName: string;
  dataDeviceName: string;
  volumeType: string;
  userData?: string;
  /** `spot` launches with `AWS_SPOT_MARKET_OPTIONS`; an absent value means `standard` (on-demand). */
  provisioningModel: AwsWorkspaceHostProvisioningModel;
  /**
   * MiB/s for snapshot-restored volumes (the AMI root, a restored data volume); see
   * `AWS_VOLUME_INITIALIZATION_RATE_MIBPS`. Absent means the default; `null` means EBS lazy hydration.
   */
  volumeInitializationRateMiBps: number | null;
}

/**
 * `replacesInstanceId` is set only on an upgrade's post-launch steps: the host then has TWO known
 * instances (the stopped original and its replacement), and these steps must act on the
 * replacement. Absent, the host's single instance is used.
 */
type AwsStepInput =
  | { op: 'create-data-volume'; request: AwsCreateVolumeInput; hostId: string; region: string }
  | { op: 'run-instance'; request: AwsRunInstancesInput; hostId: string; vpcId: string }
  | { op: 'attach-data-volume'; device: string; hostId: string; replacesInstanceId?: string }
  // D-013: the controller-rendered bootstrap, pushed over SSM once the data volume is attached.
  | { op: 'start-host-bootstrap'; hostId: string; script: string; replacesInstanceId?: string }
  // Upgrade (WI-10005971): move the data volume off the stopped original instance.
  | { op: 'detach-data-volume'; volumeId: string; instanceId: string; hostId: string }
  // Upgrade rollback: put the data volume back on the original instance and start it.
  | {
      op: 'reinstate-instance';
      instanceId: string;
      volumeId: string;
      device: string;
      hostId: string;
      /**
       * WI-10005978: set on the rollback of an upgrade step that runs AFTER the replacement
       * launched. The known replacement is terminated first (which releases the data volume),
       * then the volume goes back onto the original and the original is started.
       */
      retireReplacement?: true;
    }
  | {
      op: 'start-instance' | 'stop-instance' | 'reboot-instance' | 'repair-instance';
      instanceId: string;
      hostId: string;
    }
  | {
      op: 'create-snapshot';
      request: AwsCreateSnapshotInput;
      hostId: string;
    }
  // `resourceName` is the provider id of the resource the step deletes. The provisioning runner
  // maps every destroy step back to ONE registered provider resource through this field, for
  // every provider (GCP steps carry the same name), so it is not optional.
  | { op: 'terminate-instance'; instanceId: string; hostId: string; resourceName: string }
  | { op: 'delete-volume'; volumeId: string; hostId: string; resourceName: string };

/** SSM invocation states that mean the push itself failed (as opposed to still running). */
const AWS_COMMAND_FAILED_STATUSES = new Set(['Failed', 'TimedOut', 'Cancelled', 'Cancelling', 'Undeliverable', 'Terminated']);

const AWS_INSTANCE_RESOURCE_KIND = 'vm';
const AWS_VOLUME_RESOURCE_KIND = 'disk';

const CAPABILITIES: WorkspaceHostProviderCapabilities = {
  discovery: {
    scopes: true,
    regions: true,
    sizes: true,
    images: true,
    priceEstimates: true,
  },
  lifecycle: {
    start: true,
    stop: true,
    restart: true,
    snapshot: true,
    // WI-10005971: restore builds a distinct host whose data volume comes from the snapshot;
    // upgrade replaces the instance from the target AMI and moves the data volume across.
    restore: true,
    upgrade: true,
    repair: true,
    confirmedDestroy: true,
    // D-013: provision and repair push the controller-rendered bootstrap over SSM Run Command
    // (`start-host-bootstrap`); it reports its outcome on the EC2 serial console.
    hostBootstrap: true,
    bootstrapStatusChannel: 'ec2-console-output',
  },
  transportKinds: AWS_WORKSPACE_HOST_TRANSPORTS,
  constraints: [
    'Launch Template, subnet, security groups, IAM instance profile, and customer KMS key are required',
    'Nitro-based instance types only: the data volume is located by its NVMe volume id',
    'An image upgrade replaces the EC2 instance (it gets a new instance id) and moves the data volume to it',
    'Restore creates a distinct host in the same account from a completed snapshot of the source host',
  ],
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireString(value, label);
}

function optionalStringArray(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireUserData(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('aws.desired.provider.userData must be a non-empty string');
  }
  return value;
}

function readSettings(desired: WorkspaceHostDesiredSpec): AwsWorkspaceHostDesiredProviderSettings {
  if (desired.target !== AWS_WORKSPACE_HOST_TARGET) {
    throw new Error(`AWS provider cannot plan target '${desired.target}'`);
  }
  const provider = desired.provider ?? {};
  assertWorkspaceHostSecretIsolation(provider, 'aws.desired.provider');
  if (!desired.data.encrypted) {
    throw new Error('AWS workspace-host data volumes must be encrypted');
  }
  const securityGroupIds = provider.securityGroupIds;
  if (!Array.isArray(securityGroupIds) || securityGroupIds.length === 0) {
    throw new Error('aws.desired.provider.securityGroupIds must contain at least one security group id');
  }
  const normalizedGroups = securityGroupIds.map((value, index) =>
    requireString(value, `aws.desired.provider.securityGroupIds[${index}]`),
  );
  return {
    vpcId: requireString(provider.vpcId, 'aws.desired.provider.vpcId'),
    subnetId: requireString(provider.subnetId, 'aws.desired.provider.subnetId'),
    securityGroupIds: [...new Set(normalizedGroups)].sort(),
    availabilityZone: requireString(desired.zone ?? provider.availabilityZone, 'aws.desired.provider.availabilityZone'),
    instanceProfileArn: requireString(provider.instanceProfileArn, 'aws.desired.provider.instanceProfileArn'),
    launchTemplateId: requireString(provider.launchTemplateId, 'aws.desired.provider.launchTemplateId'),
    launchTemplateVersion:
      provider.launchTemplateVersion === undefined
        ? undefined
        : requireString(provider.launchTemplateVersion, 'aws.desired.provider.launchTemplateVersion'),
    kmsKeyArn: requireString(provider.kmsKeyArn, 'aws.desired.provider.kmsKeyArn'),
    rootVolumeGiB:
      provider.rootVolumeGiB === undefined
        ? 20
        : requirePositiveInteger(provider.rootVolumeGiB, 'aws.desired.provider.rootVolumeGiB'),
    rootDeviceName:
      provider.rootDeviceName === undefined
        ? '/dev/sda1'
        : requireString(provider.rootDeviceName, 'aws.desired.provider.rootDeviceName'),
    dataDeviceName:
      provider.dataDeviceName === undefined
        ? '/dev/sdf'
        : requireString(provider.dataDeviceName, 'aws.desired.provider.dataDeviceName'),
    volumeType:
      provider.volumeType === undefined ? 'gp3' : requireString(provider.volumeType, 'aws.desired.provider.volumeType'),
    userData: provider.userData === undefined ? undefined : requireUserData(provider.userData),
    provisioningModel: provisioningModel(provider.provisioningModel),
    volumeInitializationRateMiBps: volumeInitializationRateMiBps(provider.volumeInitializationRateMiBps),
  };
}

function volumeInitializationRateMiBps(value: unknown): number | null {
  if (value === undefined) return AWS_VOLUME_INITIALIZATION_RATE_MIBPS.default;
  if (value === null) return null;
  const { min, max } = AWS_VOLUME_INITIALIZATION_RATE_MIBPS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `aws.desired.provider.volumeInitializationRateMiBps must be an integer from ${min} to ${max} MiB/s, or null for EBS's default lazy hydration`,
    );
  }
  return value;
}

function provisioningModel(value: unknown): AwsWorkspaceHostProvisioningModel {
  if (value === undefined) return 'standard';
  if ((AWS_WORKSPACE_HOST_PROVISIONING_MODELS as readonly unknown[]).includes(value)) {
    return value as AwsWorkspaceHostProvisioningModel;
  }
  throw new Error(
    `aws.desired.provider.provisioningModel must be one of ${AWS_WORKSPACE_HOST_PROVISIONING_MODELS.join(', ')}`,
  );
}

/** AWS EC2 accepts at most 64 ASCII characters for ClientToken. */
export function awsWorkspaceHostClientToken(idempotencyKey: string): string {
  return createHash('sha256').update(requireString(idempotencyKey, 'idempotencyKey')).digest('hex');
}

function stableTags(desired: WorkspaceHostDesiredSpec, workspaceId: string): readonly AwsTag[] {
  const labels = new Map<string, string>(Object.entries(desired.labels ?? {}));
  labels.set(AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId, desired.hostId);
  labels.set(AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed, 'true');
  labels.set(AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId, workspaceId);
  return [...labels.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([Key, Value]) => ({ Key, Value }));
}

function resource(
  kind: typeof AWS_INSTANCE_RESOURCE_KIND | typeof AWS_VOLUME_RESOURCE_KIND,
  providerId: string,
  region?: string,
  zone?: string,
): WorkspaceHostResourceRef {
  return { target: AWS_WORKSPACE_HOST_TARGET, kind, providerId, region, zone };
}

function hostIdFor(request: WorkspaceHostPlanRequest): string {
  return request.action === 'provision' || request.action === 'restore' ? request.desired.hostId : request.host.hostId;
}

/**
 * An AMI id, never an alias. EC2 also accepts `resolve:ssm:<parameter>` in ImageId, which names
 * whatever the parameter points at WHEN the instance launches; a host must boot the exact image
 * its desired spec, the release manifest and the upgrade record all name.
 */
function requireAwsAmiId(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!/^ami-[0-9A-Za-z]+(?:-[0-9A-Za-z]+)*$/.test(id)) {
    throw new Error(`${label} must be an EC2 AMI id (ami-...), not '${id}'`);
  }
  return id;
}

type AwsBootstrapAction = 'provision' | 'repair' | 'restore' | 'upgrade';

/**
 * The `start-host-bootstrap` step (D-013). Fails closed when the controller supplied no bootstrap:
 * this provider declares `hostBootstrap`, and nothing else would mount the data volume, so a host
 * planned without one would come up with its state on the boot disk.
 */
function hostBootstrapStep(
  ctx: WorkspaceHostProviderContext,
  action: AwsBootstrapAction,
  hostId: string,
  idempotencyKey: string,
  dependsOn: readonly string[],
  replacesInstanceId?: string,
): WorkspaceHostPlanStep {
  const script = ctx.hostBootstrapScript;
  if (!script?.trim()) {
    throw new Error(`aws_workspace_host_bootstrap_missing: '${action}' needs the controller-rendered host bootstrap`);
  }
  return {
    id: 'start-host-bootstrap',
    action,
    resourceKind: AWS_INSTANCE_RESOURCE_KIND,
    dependsOn: [...dependsOn],
    idempotencyKey,
    destructive: false,
    input: {
      op: 'start-host-bootstrap',
      hostId,
      script,
      ...(replacesInstanceId ? { replacesInstanceId } : {}),
    } satisfies AwsStepInput,
  };
}

/**
 * The instance a step acts on. Ordinarily the host's single known instance. During an upgrade the
 * stopped original is still known beside its replacement, so a post-launch step names the
 * original and acts on the one other instance; anything but exactly one is refused rather than
 * guessed, because attaching the data volume or pushing the bootstrap to the wrong instance
 * cannot be undone by a retry.
 */
function requireStepInstance(
  resources: readonly WorkspaceHostResourceRef[],
  stepId: string,
  replacesInstanceId: string | undefined,
): WorkspaceHostResourceRef {
  if (!replacesInstanceId) return requireKnownResource(resources, AWS_INSTANCE_RESOURCE_KIND, stepId);
  const candidates = resources.filter(
    (candidate) =>
      candidate.target === AWS_WORKSPACE_HOST_TARGET &&
      candidate.kind === AWS_INSTANCE_RESOURCE_KIND &&
      candidate.providerId !== replacesInstanceId,
  );
  const distinct = [...new Map(candidates.map((candidate) => [candidate.providerId, candidate])).values()];
  if (distinct.length !== 1) {
    throw new Error(
      `AWS step '${stepId}' needs exactly one replacement instance for ${replacesInstanceId}; found ${distinct.length}`,
    );
  }
  return distinct[0];
}

/**
 * The registered replacement of an upgrade's original instance, or undefined when none was
 * registered (the launch never recorded one). Two candidates are ambiguous, and a rollback that
 * guessed could terminate the wrong instance, so that refuses.
 */
function findReplacementInstance(
  resources: readonly WorkspaceHostResourceRef[],
  originalInstanceId: string,
): string | undefined {
  const ids = [
    ...new Set(
      resources
        .filter(
          (candidate) =>
            candidate.target === AWS_WORKSPACE_HOST_TARGET &&
            candidate.kind === AWS_INSTANCE_RESOURCE_KIND &&
            candidate.providerId !== originalInstanceId,
        )
        .map((candidate) => candidate.providerId),
    ),
  ];
  if (ids.length > 1) {
    throw new Error(`aws_workspace_host_reinstate_ambiguous_replacement: ${ids.join(', ')}`);
  }
  return ids[0];
}

/** Exactly one registered resource of a kind; an upgrade refuses an ambiguous host rather than guess. */
function requireSingleResource(
  resources: readonly WorkspaceHostResourceRef[],
  kind: typeof AWS_INSTANCE_RESOURCE_KIND | typeof AWS_VOLUME_RESOURCE_KIND,
  action: string,
): WorkspaceHostResourceRef {
  const matches = [
    ...new Map(
      resources
        .filter((candidate) => candidate.target === AWS_WORKSPACE_HOST_TARGET && candidate.kind === kind)
        .map((candidate) => [candidate.providerId, candidate]),
    ).values(),
  ];
  if (matches.length !== 1) {
    throw new Error(`AWS ${action} needs exactly one registered ${kind}; the host has ${matches.length}`);
  }
  return matches[0];
}

/**
 * The RunInstances request for one host: provision, restore and an upgrade's replacement all launch
 * through this, so they differ only in their idempotency key and the AMI they name.
 */
function runInstancesRequest(
  desired: WorkspaceHostDesiredSpec,
  settings: AwsWorkspaceHostDesiredProviderSettings,
  tags: readonly AwsTag[],
  idempotencyKey: string,
  imageId: string,
): AwsRunInstancesInput {
  return {
    ClientToken: awsWorkspaceHostClientToken(idempotencyKey),
    ImageId: imageId,
    InstanceType: requireString(desired.size, 'desired.size'),
    MinCount: 1,
    MaxCount: 1,
    LaunchTemplate: {
      LaunchTemplateId: settings.launchTemplateId,
      ...(settings.launchTemplateVersion ? { Version: settings.launchTemplateVersion } : {}),
    },
    NetworkInterfaces: [
      {
        DeviceIndex: 0,
        SubnetId: settings.subnetId,
        Groups: settings.securityGroupIds,
        DeleteOnTermination: true,
        AssociatePublicIpAddress: false,
      },
    ],
    IamInstanceProfile: { Arn: settings.instanceProfileArn },
    BlockDeviceMappings: [
      {
        DeviceName: settings.rootDeviceName,
        Ebs: {
          DeleteOnTermination: true,
          Encrypted: true,
          KmsKeyId: settings.kmsKeyArn,
          VolumeSize: settings.rootVolumeGiB,
          VolumeType: settings.volumeType,
          ...(settings.volumeInitializationRateMiBps === null
            ? {}
            : { VolumeInitializationRate: settings.volumeInitializationRateMiBps }),
        },
      },
    ],
    ...(settings.provisioningModel === 'spot' ? { InstanceMarketOptions: AWS_SPOT_MARKET_OPTIONS } : {}),
    TagSpecifications:
      settings.provisioningModel === 'spot'
        ? [
            { ResourceType: 'instance', Tags: tags },
            { ResourceType: 'volume', Tags: tags },
            { ResourceType: 'spot-instances-request', Tags: tags },
          ]
        : [
            { ResourceType: 'instance', Tags: tags },
            { ResourceType: 'volume', Tags: tags },
          ],
    ...(settings.userData ? { UserData: Buffer.from(settings.userData, 'utf8').toString('base64') } : {}),
  };
}

function stepInput(step: WorkspaceHostPlanStep): AwsStepInput {
  const candidate = step.input as unknown as AwsStepInput;
  if (!candidate || typeof candidate !== 'object' || !('op' in candidate)) {
    throw new Error(`AWS plan step '${step.id}' lacks an AWS operation`);
  }
  return candidate;
}

function knownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kind: typeof AWS_INSTANCE_RESOURCE_KIND | typeof AWS_VOLUME_RESOURCE_KIND,
): WorkspaceHostResourceRef | undefined {
  return resources.find((candidate) => candidate.target === AWS_WORKSPACE_HOST_TARGET && candidate.kind === kind);
}

function requireKnownResource(
  resources: readonly WorkspaceHostResourceRef[],
  kind: typeof AWS_INSTANCE_RESOURCE_KIND | typeof AWS_VOLUME_RESOURCE_KIND,
  stepId: string,
): WorkspaceHostResourceRef {
  const existing = knownResource(resources, kind);
  if (!existing) {
    throw new Error(`AWS step '${stepId}' requires the persisted ${kind} resource identity before its provider call`);
  }
  return existing;
}

function isInstanceAbsent(observation: AwsInstanceObservation | undefined): boolean {
  return observation === undefined || observation.state === 'terminated';
}

function isVolumeAbsent(observation: AwsVolumeObservation | undefined): boolean {
  return observation === undefined || observation.state === 'deleted';
}

export class AwsWorkspaceHostProvider implements WorkspaceHostProvider {
  readonly target = AWS_WORKSPACE_HOST_TARGET;
  readonly capabilities = CAPABILITIES;
  private readonly now: () => string;

  private readonly onResourceCreated?: WorkspaceHostResourceCreatedObserver;
  private readonly onResourceDestroyed?: WorkspaceHostResourceDestroyedObserver;

  constructor(
    private readonly client: AwsWorkspaceHostSdkClient,
    options: Pick<AwsWorkspaceHostProviderOptions, 'now' | 'onResourceCreated' | 'onResourceDestroyed'> = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.onResourceCreated = options.onResourceCreated;
    this.onResourceDestroyed = options.onResourceDestroyed;
  }

  validateConnection(ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostConnectionValidation> {
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

  /** The managed-resource inventory the provisioning runner's destroy census probes for. */
  inventoryManagedResources(request: AwsWorkspaceHostInventoryRequest): Promise<AwsWorkspaceHostInventorySnapshot> {
    return this.client.listManagedResources(request);
  }

  async plan(request: WorkspaceHostPlanRequest, ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostPlan> {
    if (request.action !== 'provision' && request.host.target !== AWS_WORKSPACE_HOST_TARGET) {
      throw new Error(`AWS provider cannot plan host target '${request.host.target}'`);
    }
    const steps = await this.planSteps(request, ctx);
    return {
      planId: `aws:${awsWorkspaceHostClientToken(`${request.operationId}:plan`)}`,
      operationId: request.operationId,
      target: AWS_WORKSPACE_HOST_TARGET,
      hostId: hostIdFor(request),
      generatedAt: this.now(),
      steps,
      warnings: [],
    };
  }

  private async planSteps(
    request: WorkspaceHostPlanRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostPlanStep[]> {
    if (request.action === 'provision') {
      return this.planProvision(request.desired, request.idempotencyKey, ctx, { action: 'provision' });
    }
    if (request.action === 'destroy') return this.planDestroy(request, ctx);
    if (request.action === 'restore') return this.planRestore(request, ctx);
    if (request.action === 'upgrade') return this.planUpgrade(request, ctx);

    const instance = requireKnownResource(request.host.resources, AWS_INSTANCE_RESOURCE_KIND, request.action);
    const idempotencyKey = `${request.idempotencyKey}:${request.action}:${instance.providerId}`;
    if (request.action === 'snapshot') {
      const volume = requireKnownResource(request.host.resources, AWS_VOLUME_RESOURCE_KIND, request.action);
      const tags: readonly AwsTag[] = [
        { Key: 'Name', Value: request.name ?? `${request.host.hostId}-snapshot` },
        { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId, Value: request.host.hostId },
        { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed, Value: 'true' },
        { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId, Value: ctx.workspaceId },
      ];
      return [
        {
          id: 'snapshot-data-volume',
          action: request.action,
          resourceKind: 'snapshot',
          dependsOn: [],
          idempotencyKey,
          destructive: false,
          input: {
            op: 'create-snapshot',
            hostId: request.host.hostId,
            request: {
              ClientToken: awsWorkspaceHostClientToken(idempotencyKey),
              VolumeId: volume.providerId,
              Description: request.name ?? `Papercusp workspace ${request.host.hostId}`,
              TagSpecifications: [{ ResourceType: 'snapshot', Tags: tags }],
            },
          } satisfies AwsStepInput,
        },
      ];
    }

    const opByAction = {
      start: 'start-instance',
      stop: 'stop-instance',
      restart: 'reboot-instance',
      repair: 'repair-instance',
    } as const;
    const op = opByAction[request.action];
    const lifecycleStep: WorkspaceHostPlanStep = {
      id: `${request.action}-instance`,
      action: request.action,
      resourceKind: AWS_INSTANCE_RESOURCE_KIND,
      dependsOn: [],
      idempotencyKey,
      destructive: false,
      input: { op, instanceId: instance.providerId, hostId: request.host.hostId } satisfies AwsStepInput,
    };
    // D-013 point 6: repair re-runs the lifecycle-rendered bootstrap once the instance is back.
    if (request.action !== 'repair') return [lifecycleStep];
    return [
      lifecycleStep,
      hostBootstrapStep(ctx, request.action, request.host.hostId, `${idempotencyKey}:host-bootstrap`, [lifecycleStep.id]),
    ];
  }

  /**
   * Provision, and restore (which is a provision of a distinct host whose data volume is created
   * from the source host's snapshot). One description of the host for both, so a restored host is
   * launched exactly as a provisioned one would be.
   */
  private planProvision(
    desired: WorkspaceHostDesiredSpec,
    idempotencyKey: string,
    ctx: WorkspaceHostProviderContext,
    options: { action: 'provision' | 'restore'; snapshotId?: string },
  ): readonly WorkspaceHostPlanStep[] {
    const { action } = options;
    const settings = readSettings(desired);
    const tags = stableTags(desired, ctx.workspaceId);
    const volumeKey = `${idempotencyKey}:data-volume`;
    const instanceKey = `${idempotencyKey}:instance`;
    const attachKey = `${idempotencyKey}:attach-data-volume`;
    const volumeRequest: AwsCreateVolumeInput = {
      AvailabilityZone: settings.availabilityZone,
      ClientToken: awsWorkspaceHostClientToken(volumeKey),
      Encrypted: true,
      KmsKeyId: settings.kmsKeyArn,
      Size: requirePositiveInteger(desired.data.volumeGiB, 'desired.data.volumeGiB'),
      VolumeType: settings.volumeType,
      ...(options.snapshotId ? { SnapshotId: options.snapshotId } : {}),
      // EBS refuses a rate on a volume that is not created from a snapshot: restore only.
      ...(options.snapshotId && settings.volumeInitializationRateMiBps !== null
        ? { VolumeInitializationRate: settings.volumeInitializationRateMiBps }
        : {}),
      TagSpecifications: [{ ResourceType: 'volume', Tags: tags }],
    };
    const runRequest = runInstancesRequest(desired, settings, tags, instanceKey, requireAwsAmiId(desired.image.id, 'desired.image.id'));

    return [
      {
        id: 'create-data-volume',
        action,
        resourceKind: AWS_VOLUME_RESOURCE_KIND,
        dependsOn: [],
        idempotencyKey: volumeKey,
        destructive: false,
        input: {
          op: 'create-data-volume',
          request: volumeRequest,
          hostId: desired.hostId,
          region: desired.region,
        } satisfies AwsStepInput,
      },
      {
        id: 'run-instance',
        action,
        resourceKind: AWS_INSTANCE_RESOURCE_KIND,
        dependsOn: ['create-data-volume'],
        idempotencyKey: instanceKey,
        destructive: false,
        input: {
          op: 'run-instance',
          request: runRequest,
          hostId: desired.hostId,
          vpcId: settings.vpcId,
        } satisfies AwsStepInput,
      },
      {
        id: 'attach-data-volume',
        action,
        resourceKind: 'attachment',
        dependsOn: ['create-data-volume', 'run-instance'],
        idempotencyKey: attachKey,
        destructive: false,
        input: {
          op: 'attach-data-volume',
          device: settings.dataDeviceName,
          hostId: desired.hostId,
        } satisfies AwsStepInput,
      },
      hostBootstrapStep(ctx, action, desired.hostId, `${idempotencyKey}:host-bootstrap`, ['attach-data-volume']),
    ];
  }

  /**
   * Restore onto a DISTINCT host (GCP parity: planRestore in gcp-provider.ts). The snapshot is
   * read fresh and must be completed, owned by this account, and tagged as a managed snapshot of
   * the exact source host in this workspace: a restore that accepted any snapshot id would let a
   * caller mount another host's (or another workspace's) data.
   */
  private async planRestore(
    request: Extract<WorkspaceHostPlanRequest, { action: 'restore' }>,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostPlanStep[]> {
    if (request.desired.hostId === request.host.hostId) {
      throw new Error('AWS restore must create a distinct target host');
    }
    if (request.snapshot.target !== AWS_WORKSPACE_HOST_TARGET || request.snapshot.hostId !== request.host.hostId) {
      throw new Error('AWS restore snapshot must belong to the exact source host');
    }
    const snapshotId = requireString(request.snapshot.providerId, 'aws.restore.snapshot.providerId');
    if (!/^snap-[0-9a-f]+$/.test(snapshotId)) {
      throw new Error(`aws.restore.snapshot.providerId must be an EBS snapshot id (snap-...), not '${snapshotId}'`);
    }
    const observed = await this.client.describeSnapshot(snapshotId);
    if (observed?.state !== 'completed') {
      throw new Error(`AWS restore snapshot '${snapshotId}' is not completed (${observed?.state ?? 'absent'})`);
    }
    const tags = observed.tags;
    if (
      tags[AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed] !== 'true' ||
      tags[AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId] !== request.host.hostId ||
      tags[AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId] !== ctx.workspaceId
    ) {
      throw new Error(
        `AWS restore snapshot '${snapshotId}' is not a managed snapshot of host '${request.host.hostId}' in this workspace`,
      );
    }
    const volumeGiB = requirePositiveInteger(request.desired.data.volumeGiB, 'desired.data.volumeGiB');
    if (observed.volumeSizeGiB !== undefined && volumeGiB < observed.volumeSizeGiB) {
      throw new Error(
        `AWS restore data volume (${volumeGiB} GiB) is smaller than snapshot '${snapshotId}' (${observed.volumeSizeGiB} GiB)`,
      );
    }
    return this.planProvision(request.desired, request.idempotencyKey, ctx, { action: 'restore', snapshotId });
  }

  /**
   * Replace the instance with one booted from the target AMI, keeping the data volume (GCP parity:
   * planUpgrade in gcp-provider.ts recreates the boot disk around the retained data disk).
   *
   * The original instance is terminated LAST, after its replacement is running with the data
   * volume attached and the bootstrap pushed. GCP deletes first because its re-insert carries the
   * data disk and the startup script in ONE call, so a one-step rollback rebuilds the host. On AWS
   * the data volume is attached after launch and the bootstrap is pushed over SSM, so a host cannot
   * be rebuilt in one step; keeping the original until the end is what makes a rollback possible.
   *
   * Detaching the data volume is the destructive step (the original can no longer serve). A
   * replacement that cannot launch is therefore stranded-by-failure, and its precomputed rollback
   * re-attaches the volume to the original and starts it. Because the rollback reinstates the
   * original instance, the only rollback image it can deliver is the one that instance runs.
   *
   * Launch settings come from the host's recorded desired spec (overlaid with the connection's
   * current launch resources, the same merge provision applies), so the replacement launches
   * exactly as the original did except for its AMI.
   */
  private async planUpgrade(
    request: Extract<WorkspaceHostPlanRequest, { action: 'upgrade' }>,
    ctx: WorkspaceHostProviderContext,
  ): Promise<readonly WorkspaceHostPlanStep[]> {
    const recorded = request.desired;
    if (!recorded) throw new Error("AWS upgrade requires the host's recorded desired spec");
    if (recorded.hostId !== request.host.hostId) {
      throw new Error('AWS upgrade desired spec does not belong to the host being upgraded');
    }
    const imageId = requireAwsAmiId(request.image.id, 'aws.upgrade.image.id');
    if (request.rollbackImage) {
      const rollbackImageId = requireAwsAmiId(request.rollbackImage.id, 'aws.upgrade.rollbackImage.id');
      if (rollbackImageId !== recorded.image.id) {
        throw new Error(
          `AWS upgrade rolls back by reinstating the running instance, so its rollback image must be the recorded image '${recorded.image.id}', not '${rollbackImageId}'`,
        );
      }
    }
    const instance = requireSingleResource(request.host.resources, AWS_INSTANCE_RESOURCE_KIND, 'upgrade');
    const volume = requireSingleResource(request.host.resources, AWS_VOLUME_RESOURCE_KIND, 'upgrade');
    const desired: WorkspaceHostDesiredSpec = {
      ...recorded,
      image: request.image,
      provider: { ...(recorded.provider ?? {}), ...(ctx.connection.provider ?? {}) },
    };
    const settings = readSettings(desired);
    const tags = stableTags(desired, ctx.workspaceId);
    const hostId = request.host.hostId;
    const key = `${request.idempotencyKey}:upgrade:${instance.providerId}`;
    const runRequest = runInstancesRequest(desired, settings, tags, `${key}:instance`, imageId);
    // Step ids name the instance being replaced. The controller keys each step's resource row by
    // step id, and recording a plan resets that row to `planned`; ids shared with provision or an
    // earlier upgrade would therefore un-register the running instance until this upgrade's own
    // step re-applied it. Per-replacement ids leave every earlier row, and its registration, intact.
    const original = instance.providerId;
    const ids = {
      quiesce: `quiesce-runtime-instance:${original}`,
      detach: `detach-data-volume:${original}`,
      launch: `launch-replacement-instance:${original}`,
      attach: `attach-replacement-volume:${original}`,
      retire: `retire-runtime-instance:${original}`,
    };
    // WI-10005978: a failure AFTER the replacement launched (attach or bootstrap) must not leave the
    // original stopped with its data volume detached. Each post-launch step carries the same
    // rollback as a failed launch, plus retiring the replacement first so the volume is free.
    // lifecycle-runner strandedByFailure() only rolls back a step that depends on an applied
    // destructive step, so the bootstrap step names the destructive detach among its dependencies.
    const reinstateAfterLaunch = (stage: 'attach' | 'bootstrap') => ({
      idempotencyKey: `${key}:reinstate-after-${stage}`,
      input: {
        op: 'reinstate-instance',
        instanceId: original,
        volumeId: volume.providerId,
        device: settings.dataDeviceName,
        hostId,
        retireReplacement: true,
      } satisfies AwsStepInput,
    });
    return [
      {
        id: ids.quiesce,
        action: 'upgrade',
        resourceKind: AWS_INSTANCE_RESOURCE_KIND,
        dependsOn: [],
        idempotencyKey: `${key}:quiesce`,
        destructive: false,
        input: { op: 'stop-instance', instanceId: original, hostId } satisfies AwsStepInput,
      },
      {
        id: ids.detach,
        action: 'upgrade',
        resourceKind: 'attachment',
        dependsOn: [ids.quiesce],
        idempotencyKey: `${key}:detach-data-volume`,
        destructive: true,
        input: {
          op: 'detach-data-volume',
          volumeId: volume.providerId,
          instanceId: original,
          hostId,
        } satisfies AwsStepInput,
      },
      {
        id: ids.launch,
        action: 'upgrade',
        resourceKind: AWS_INSTANCE_RESOURCE_KIND,
        dependsOn: [ids.detach],
        idempotencyKey: `${key}:instance`,
        destructive: false,
        input: { op: 'run-instance', request: runRequest, hostId, vpcId: settings.vpcId } satisfies AwsStepInput,
        rollback: {
          idempotencyKey: `${key}:reinstate`,
          input: {
            op: 'reinstate-instance',
            instanceId: instance.providerId,
            volumeId: volume.providerId,
            device: settings.dataDeviceName,
            hostId,
          } satisfies AwsStepInput,
        },
      },
      {
        id: ids.attach,
        action: 'upgrade',
        resourceKind: 'attachment',
        dependsOn: [ids.detach, ids.launch],
        idempotencyKey: `${key}:attach-data-volume`,
        destructive: false,
        input: {
          op: 'attach-data-volume',
          device: settings.dataDeviceName,
          hostId,
          replacesInstanceId: original,
        } satisfies AwsStepInput,
        rollback: reinstateAfterLaunch('attach'),
      },
      {
        ...hostBootstrapStep(ctx, 'upgrade', hostId, `${key}:host-bootstrap`, [ids.detach, ids.attach], original),
        rollback: reinstateAfterLaunch('bootstrap'),
      },
      {
        id: ids.retire,
        action: 'upgrade',
        resourceKind: AWS_INSTANCE_RESOURCE_KIND,
        dependsOn: ['start-host-bootstrap'],
        idempotencyKey: `${key}:retire`,
        destructive: true,
        input: {
          op: 'terminate-instance',
          instanceId: original,
          hostId,
          resourceName: original,
        } satisfies AwsStepInput,
      },
    ];
  }

  private planDestroy(
    request: Extract<WorkspaceHostPlanRequest, { action: 'destroy' }>,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    if (request.confirmation.expectedHostId !== request.host.hostId) {
      throw new Error('AWS destroy confirmation expectedHostId does not match the host');
    }
    const volumes = request.host.resources
      .filter(
        (candidate) => candidate.target === AWS_WORKSPACE_HOST_TARGET && candidate.kind === AWS_VOLUME_RESOURCE_KIND,
      )
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
    const instances = request.host.resources
      .filter(
        (candidate) => candidate.target === AWS_WORKSPACE_HOST_TARGET && candidate.kind === AWS_INSTANCE_RESOURCE_KIND,
      )
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
    if (instances.length === 0 && volumes.length === 0)
      throw new Error('AWS destroy requires known instance or volume resources');

    const steps: WorkspaceHostPlanStep[] = [];
    const preserveIds: string[] = [];
    if (request.disposition !== 'discard') {
      for (const [index, volume] of volumes.entries()) {
        const id = `preserve-volume-${index}`;
        const key = `${request.idempotencyKey}:${id}:${volume.providerId}`;
        preserveIds.push(id);
        steps.push({
          id,
          action: 'destroy',
          resourceKind: 'snapshot',
          dependsOn: [],
          idempotencyKey: key,
          destructive: false,
          input: {
            op: 'create-snapshot',
            hostId: request.host.hostId,
            request: {
              ClientToken: awsWorkspaceHostClientToken(key),
              VolumeId: volume.providerId,
              Description: `Papercusp ${request.disposition} before destroy ${request.host.hostId}`,
              TagSpecifications: [
                {
                  ResourceType: 'snapshot',
                  Tags: [
                    { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.hostId, Value: request.host.hostId },
                    { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.managed, Value: 'true' },
                    { Key: AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS.workspaceId, Value: ctx.workspaceId },
                  ],
                },
              ],
            },
          } satisfies AwsStepInput,
        });
      }
    }

    const terminateIds: string[] = [];
    for (const [index, instance] of instances.entries()) {
      const id = `terminate-instance-${index}`;
      terminateIds.push(id);
      steps.push({
        id,
        action: 'destroy',
        resourceKind: AWS_INSTANCE_RESOURCE_KIND,
        dependsOn: preserveIds,
        idempotencyKey: `${request.idempotencyKey}:${id}:${instance.providerId}`,
        destructive: true,
        input: {
          op: 'terminate-instance',
          instanceId: instance.providerId,
          hostId: request.host.hostId,
          resourceName: instance.providerId,
        } satisfies AwsStepInput,
      });
    }
    for (const [index, volume] of volumes.entries()) {
      const id = `delete-volume-${index}`;
      steps.push({
        id,
        action: 'destroy',
        resourceKind: AWS_VOLUME_RESOURCE_KIND,
        dependsOn: terminateIds,
        idempotencyKey: `${request.idempotencyKey}:${id}:${volume.providerId}`,
        destructive: true,
        input: {
          op: 'delete-volume',
          volumeId: volume.providerId,
          hostId: request.host.hostId,
          resourceName: volume.providerId,
        } satisfies AwsStepInput,
      });
    }
    return steps;
  }

  async apply(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    return this.report(request, ctx, await this.applyStep(request, ctx));
  }

  /**
   * Feed the teardown-obligation ledger from confirmed provider facts, mirroring the GCP
   * provider's `report()`: a created owned resource opens an obligation (also on a re-run that
   * finds the client-token twin already present), a provider-read absence closes it.
   *
   * The OBSERVER's resource copy carries the connection's account (`parentProviderId`) and region:
   * the obligation row is addressed for an out-of-band delete from those two fields, and an EC2
   * instance ref does not record its region. The returned result is left exactly as the step
   * produced it, so persisted host resources do not change shape.
   */
  private async report(
    request: WorkspaceHostApplyRequest,
    ctx: WorkspaceHostProviderContext,
    result: WorkspaceHostApplyResult,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    const createsOwnedResource = input.op === 'create-data-volume' || input.op === 'run-instance';
    const owesCreationObligation =
      createsOwnedResource && (result.state === 'applied' || result.state === 'unchanged');
    if (this.onResourceCreated && owesCreationObligation && result.resource) {
      const accountId = ctx.connection.scope?.id ?? '';
      const region = typeof ctx.connection.provider?.region === 'string' ? ctx.connection.provider.region : undefined;
      await this.onResourceCreated({
        resource: {
          ...result.resource,
          ...(result.resource.parentProviderId || !accountId ? {} : { parentProviderId: accountId }),
          ...(result.resource.region || !region ? {} : { region }),
        },
        operationId: result.operationId,
        stepId: result.stepId,
        workspaceId: ctx.workspaceId,
        hostId: input.hostId,
        parentResourceId: accountId,
      });
    }
    if (this.onResourceDestroyed && result.state === 'destroyed' && result.confirmation) {
      const deleteOp =
        input.op === 'terminate-instance' || input.op === 'delete-volume' ? input.op : undefined;
      if (deleteOp) {
        await this.onResourceDestroyed({
          resource: { deleteOp, providerId: result.confirmation.providerResourceId },
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
      case 'create-data-volume': {
        const created = await this.client.createVolume(input.request);
        const observed = await this.client.waitForVolumeState(created.volumeId, 'available', ctx.signal);
        if (!observed || observed.state !== 'available') {
          return this.inProgress(request, created.requestId);
        }
        return this.applied(
          request,
          resource(AWS_VOLUME_RESOURCE_KIND, created.volumeId, input.region, input.request.AvailabilityZone),
          created.requestId,
        );
      }
      case 'run-instance': {
        requireKnownResource(request.knownResources, AWS_VOLUME_RESOURCE_KIND, request.step.id);
        await this.assertNoInboundRules(input.request.NetworkInterfaces[0].Groups);
        const created = await this.client.runInstances(input.request);
        const observed = await this.client.waitForInstanceState(created.instanceId, 'running', ctx.signal);
        assertInstanceLaunchAlive(observed);
        if (!observed || observed.state !== 'running') return this.inProgress(request, created.requestId);
        return this.applied(request, resource(AWS_INSTANCE_RESOURCE_KIND, created.instanceId), created.requestId);
      }
      case 'attach-data-volume': {
        const volume = requireKnownResource(request.knownResources, AWS_VOLUME_RESOURCE_KIND, request.step.id);
        const instance = requireStepInstance(request.knownResources, request.step.id, input.replacesInstanceId);
        const result = await this.client.attachVolume({
          InstanceId: instance.providerId,
          VolumeId: volume.providerId,
          Device: input.device,
        });
        const observed = await this.client.waitForVolumeState(volume.providerId, 'in-use', ctx.signal);
        if (!observed || observed.attachedInstanceId !== instance.providerId) {
          return this.inProgress(request, result.requestId);
        }
        return this.applied(request, undefined, result.requestId);
      }
      case 'start-host-bootstrap': {
        // D-013: the volume id names the guest device; the push installs mount + bootstrap and
        // starts it as a transient unit. `applied` means STARTED — its outcome arrives on the
        // ec2-console-output status channel, which the readiness wait reads.
        const volume = requireKnownResource(request.knownResources, AWS_VOLUME_RESOURCE_KIND, request.step.id);
        const instance = requireStepInstance(request.knownResources, request.step.id, input.replacesInstanceId);
        // On an upgrade, name the replacement as this step's resource: the controller otherwise
        // records the step against the instance it seeded at plan time, which is the original.
        const stepResource = input.replacesInstanceId ? instance : undefined;
        const push = renderAwsHostBootstrapPush({ volumeId: volume.providerId, hostBootstrapScript: input.script });
        if (!(await this.client.waitForSsmOnline(instance.providerId, ctx.signal))) return this.inProgress(request);
        const sent = await this.client.sendShellCommand({
          instanceId: instance.providerId,
          commands: push.commands,
          comment: `Papercusp host bootstrap ${input.hostId}`,
          executionTimeoutSec: AWS_HOST_BOOTSTRAP_PUSH_EXECUTION_TIMEOUT_SEC,
        });
        const invocation = await this.client.waitForCommandInvocation(sent.commandId, instance.providerId, ctx.signal);
        if (invocation.status === 'Success') return this.applied(request, stepResource, sent.requestId);
        if (AWS_COMMAND_FAILED_STATUSES.has(invocation.status)) {
          const detail = (invocation.stderr ?? invocation.stdout ?? '').trim().slice(-300);
          throw new Error(
            `aws_workspace_host_bootstrap_push_failed: ${invocation.status}` +
              `${invocation.responseCode === undefined ? '' : ` exit=${invocation.responseCode}`}` +
              `${detail ? `: ${detail}` : ''}`,
          );
        }
        return this.inProgress(request, sent.requestId);
      }
      case 'detach-data-volume': {
        // The original is stopped by the step before this one; EC2 refuses to detach a root
        // volume, and detaching a mounted data volume from a RUNNING instance risks the data.
        const current = await this.client.describeInstance(input.instanceId);
        if (current && current.state !== 'stopped' && current.state !== 'terminated') {
          throw new Error(
            `aws_workspace_host_detach_requires_stopped_instance: ${input.instanceId} is '${current.state}'`,
          );
        }
        const before = await this.client.describeVolume(input.volumeId);
        if (!before || isVolumeAbsent(before)) {
          throw new Error(`aws_workspace_host_upgrade_data_volume_absent: ${input.volumeId}`);
        }
        if (before.state === 'available' && !before.attachedInstanceId) return this.applied(request);
        if (before.attachedInstanceId && before.attachedInstanceId !== input.instanceId) {
          throw new Error(
            `aws_workspace_host_upgrade_data_volume_attached_elsewhere: ${input.volumeId} is attached to ${before.attachedInstanceId}`,
          );
        }
        const result = await this.client.detachVolume({ InstanceId: input.instanceId, VolumeId: input.volumeId });
        const observed = await this.client.waitForVolumeState(input.volumeId, 'available', ctx.signal);
        if (!observed || observed.state !== 'available') return this.inProgress(request, result.requestId);
        return this.applied(request, undefined, result.requestId);
      }
      case 'reinstate-instance': {
        // Upgrade rollback: the data volume goes back onto the original instance and the original is
        // started again, booting the image it always ran. After a launch (WI-10005978) the known
        // replacement is terminated first; terminating it releases the volume, which is never set to
        // delete on termination because it was attached after launch.
        const replacement = input.retireReplacement
          ? findReplacementInstance(request.knownResources, input.instanceId)
          : undefined;
        if (replacement !== undefined) {
          const observed = await this.client.describeInstance(replacement);
          if (!isInstanceAbsent(observed)) {
            await this.cancelOpenSpotRequest(replacement);
            await this.client.terminateInstances([replacement]);
            await this.client.waitForInstanceState(replacement, 'terminated', ctx.signal);
            if (!isInstanceAbsent(await this.client.describeInstance(replacement))) return this.inProgress(request);
          }
        }
        let volume = await this.client.describeVolume(input.volumeId);
        if (!volume || isVolumeAbsent(volume)) {
          throw new Error(`aws_workspace_host_reinstate_data_volume_absent: ${input.volumeId}`);
        }
        if (replacement !== undefined && volume.attachedInstanceId === replacement) {
          await this.client.waitForVolumeState(input.volumeId, 'available', ctx.signal);
          volume = await this.client.describeVolume(input.volumeId);
          if (!volume || isVolumeAbsent(volume)) {
            throw new Error(`aws_workspace_host_reinstate_data_volume_absent: ${input.volumeId}`);
          }
          if (volume.attachedInstanceId === replacement) return this.inProgress(request);
        }
        if (volume.attachedInstanceId !== input.instanceId) {
          if (volume.attachedInstanceId) {
            throw new Error(
              `aws_workspace_host_reinstate_data_volume_attached_elsewhere: ${input.volumeId} is attached to ${volume.attachedInstanceId}`,
            );
          }
          await this.client.attachVolume({ InstanceId: input.instanceId, VolumeId: input.volumeId, Device: input.device });
          const attached = await this.client.waitForVolumeState(input.volumeId, 'in-use', ctx.signal);
          if (attached?.attachedInstanceId !== input.instanceId) return this.inProgress(request);
        }
        return this.setInstanceState(
          request,
          input.instanceId,
          'running',
          () => this.client.startInstances([input.instanceId]),
          ctx.signal,
        );
      }
      case 'start-instance':
        return this.setInstanceState(
          request,
          input.instanceId,
          'running',
          () => this.client.startInstances([input.instanceId]),
          ctx.signal,
        );
      case 'stop-instance':
        return this.setInstanceState(
          request,
          input.instanceId,
          'stopped',
          () => this.client.stopInstances([input.instanceId]),
          ctx.signal,
        );
      case 'reboot-instance':
        return this.setInstanceState(
          request,
          input.instanceId,
          'running',
          () => this.client.rebootInstances([input.instanceId]),
          ctx.signal,
        );
      case 'repair-instance':
        return this.setInstanceState(
          request,
          input.instanceId,
          'running',
          () => this.client.repairInstance(input.instanceId),
          ctx.signal,
        );
      case 'create-snapshot': {
        requireKnownResource(request.knownResources, AWS_VOLUME_RESOURCE_KIND, request.step.id);
        const created = await this.client.createSnapshot(input.request);
        const observed = await this.client.waitForSnapshotCompleted(created.snapshotId, ctx.signal);
        if (observed.state !== 'completed') return this.inProgress(request, created.requestId);
        const snapshot: WorkspaceHostSnapshotRef = {
          target: AWS_WORKSPACE_HOST_TARGET,
          providerId: created.snapshotId,
          hostId: input.hostId,
          createdAt: observed.observedAt,
        };
        return {
          operationId: request.operationId,
          stepId: request.step.id,
          state: 'applied',
          snapshot,
          observedAt: observed.observedAt,
          providerRequestId: created.requestId,
        };
      }
      case 'terminate-instance': {
        await this.cancelOpenSpotRequest(input.instanceId);
        const result = await this.client.terminateInstances([input.instanceId]);
        await this.client.waitForInstanceState(input.instanceId, 'terminated', ctx.signal);
        const fresh = await this.client.describeInstance(input.instanceId);
        if (!isInstanceAbsent(fresh)) return this.inProgress(request, result.requestId);
        return this.destroyed(request, input.hostId, input.instanceId, result.requestId);
      }
      case 'delete-volume': {
        const result = await this.client.deleteVolume(input.volumeId);
        await this.client.waitForVolumeState(input.volumeId, 'deleted', ctx.signal);
        const fresh = await this.client.describeVolume(input.volumeId);
        if (!isVolumeAbsent(fresh)) return this.inProgress(request, result.requestId);
        return this.destroyed(request, input.hostId, input.volumeId, result.requestId);
      }
    }
  }

  /**
   * Cancel the persistent spot request behind a spot instance, before it is terminated
   * (WI-10005389). While the request is open EC2 treats a terminated instance as interrupted
   * capacity and launches a replacement, which would leave a billable host no controller step
   * created or tracks. Cancelling never touches the instance itself. Run on every attempt, not
   * only the first: a retried step may find the instance already terminated with the request
   * still open, and the SDK client counts an unknown request as cancelled.
   */
  private async cancelOpenSpotRequest(instanceId: string): Promise<void> {
    const observed = await this.client.describeInstance(instanceId);
    if (!observed?.spotInstanceRequestId) return;
    await this.client.cancelSpotInstanceRequests([observed.spotInstanceRequestId]);
  }

  /**
   * Refuse to launch into a security group that admits inbound traffic (P-005). The host is
   * reached only over SSM Session Manager, which needs no inbound rule; GCP's equivalent is the
   * IAP-only firewall. Checked at apply time, immediately before the launch, because the groups are
   * customer-owned and can change between plan and apply. A group EC2 does not return is refused
   * too: an unverifiable group is not a verified-closed one.
   */
  private async assertNoInboundRules(groupIds: readonly string[]): Promise<void> {
    const observed = await this.client.describeSecurityGroupIngress(groupIds);
    const byId = new Map(observed.map((group) => [group.groupId, group.ingressRuleCount]));
    const open = groupIds.filter((groupId) => (byId.get(groupId) ?? 0) > 0);
    const missing = groupIds.filter((groupId) => !byId.has(groupId));
    if (missing.length > 0) {
      throw new Error(`aws_workspace_host_security_group_unverifiable: ${missing.join(', ')}`);
    }
    if (open.length > 0) {
      throw new Error(
        `aws_workspace_host_security_group_has_ingress: ${open.join(', ')} admit inbound traffic; ` +
          'a workspace host is reached only over SSM Session Manager and must have no inbound rule',
      );
    }
  }

  private async setInstanceState(
    request: WorkspaceHostApplyRequest,
    instanceId: string,
    state: 'running' | 'stopped',
    mutate: () => Promise<AwsProviderMutationResult>,
    signal?: AbortSignal,
  ): Promise<WorkspaceHostApplyResult> {
    const result = await mutate();
    const observed = await this.client.waitForInstanceState(instanceId, state, signal);
    if (!observed || observed.state !== state) return this.inProgress(request, result.requestId);
    return this.applied(request, resource(AWS_INSTANCE_RESOURCE_KIND, instanceId), result.requestId);
  }

  private applied(
    request: WorkspaceHostApplyRequest,
    appliedResource?: WorkspaceHostResourceRef,
    requestId?: string,
  ): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'applied',
      observedAt: this.now(),
      providerRequestId: requestId,
      ...(appliedResource ? { resource: appliedResource } : {}),
    };
  }

  private inProgress(request: WorkspaceHostApplyRequest, requestId?: string): WorkspaceHostApplyResult {
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'in-progress',
      observedAt: this.now(),
      providerRequestId: requestId,
      retryAfterMs: 2_000,
    };
  }

  private destroyed(
    request: WorkspaceHostApplyRequest,
    hostId: string,
    providerResourceId: string,
    requestId?: string,
  ): WorkspaceHostApplyResult {
    const observedAt = this.now();
    return {
      operationId: request.operationId,
      stepId: request.step.id,
      state: 'destroyed',
      observedAt,
      providerRequestId: requestId,
      confirmation: {
        hostId,
        providerResourceId,
        confirmedAbsentAt: observedAt,
        source: 'provider-read',
        providerRequestId: requestId,
      },
    };
  }

  async reconcile(
    request: WorkspaceHostReconcileRequest,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostApplyResult> {
    const input = stepInput(request.step);
    if (input.op === 'create-data-volume') {
      const found = await this.client.findVolumeByClientToken(input.request.ClientToken);
      if (found && !isVolumeAbsent(found)) {
        const settled =
          found.state === 'available' || found.state === 'in-use'
            ? found
            : await this.client.waitForVolumeState(found.volumeId, 'available', ctx.signal);
        if (settled && (settled.state === 'available' || settled.state === 'in-use')) {
          return this.unchanged(
            request,
            resource(AWS_VOLUME_RESOURCE_KIND, found.volumeId, input.region, input.request.AvailabilityZone),
          );
        }
        return this.inProgress(request, request.previousProviderRequestId);
      }
    } else if (input.op === 'run-instance') {
      const found = await this.client.findInstanceByClientToken(input.request.ClientToken);
      if (found && !isInstanceAbsent(found)) {
        const settled =
          found.state === 'running'
            ? found
            : await this.client.waitForInstanceState(found.instanceId, 'running', ctx.signal);
        assertInstanceLaunchAlive(settled);
        if (settled?.state === 'running') {
          return this.unchanged(request, resource(AWS_INSTANCE_RESOURCE_KIND, found.instanceId));
        }
        return this.inProgress(request, request.previousProviderRequestId);
      }
    } else if (input.op === 'attach-data-volume') {
      const volume = requireKnownResource(request.knownResources, AWS_VOLUME_RESOURCE_KIND, request.step.id);
      const instance = requireStepInstance(request.knownResources, request.step.id, input.replacesInstanceId);
      const found = await this.client.describeVolume(volume.providerId);
      if (found?.state === 'in-use' && found.attachedInstanceId === instance.providerId) {
        return this.unchanged(request);
      }
    } else if (input.op === 'detach-data-volume') {
      const found = await this.client.describeVolume(input.volumeId);
      if (found?.state === 'available' && !found.attachedInstanceId) return this.unchanged(request);
    } else if (input.op === 'reinstate-instance') {
      const [volume, instance] = await Promise.all([
        this.client.describeVolume(input.volumeId),
        this.client.describeInstance(input.instanceId),
      ]);
      if (volume?.attachedInstanceId === input.instanceId && instance?.state === 'running') {
        return this.unchanged(request, resource(AWS_INSTANCE_RESOURCE_KIND, input.instanceId));
      }
    } else if (input.op === 'create-snapshot') {
      const found = await this.client.findSnapshotByClientToken(input.request.ClientToken);
      const settled =
        found?.state === 'pending' ? await this.client.waitForSnapshotCompleted(found.snapshotId, ctx.signal) : found;
      if (settled?.state === 'completed') {
        return {
          operationId: request.operationId,
          stepId: request.step.id,
          state: 'unchanged',
          observedAt: settled.observedAt,
          snapshot: {
            target: AWS_WORKSPACE_HOST_TARGET,
            providerId: settled.snapshotId,
            hostId: input.hostId,
            createdAt: settled.observedAt,
          },
        };
      }
      if (settled) return this.inProgress(request, request.previousProviderRequestId);
    } else if (input.op === 'terminate-instance') {
      const found = await this.client.describeInstance(input.instanceId);
      if (isInstanceAbsent(found)) return this.destroyed(request, input.hostId, input.instanceId);
    } else if (input.op === 'delete-volume') {
      const found = await this.client.describeVolume(input.volumeId);
      if (isVolumeAbsent(found)) return this.destroyed(request, input.hostId, input.volumeId);
    } else if (input.op === 'start-host-bootstrap') {
      // No provider-side record says whether a push landed; re-push. The wrapper leaves a running
      // bootstrap alone, and the bootstrap itself is replay-safe.
    } else {
      const found = await this.client.describeInstance(input.instanceId);
      const wanted = input.op === 'stop-instance' ? 'stopped' : 'running';
      if (found?.state === wanted) {
        return this.unchanged(request, resource(AWS_INSTANCE_RESOURCE_KIND, found.instanceId));
      }
    }
    return this.apply(request, ctx);
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

  async observe(host: WorkspaceHostRef, _ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostObservation> {
    const instanceRef = knownResource(host.resources, AWS_INSTANCE_RESOURCE_KIND);
    const volumeRefs = host.resources.filter(
      (candidate) => candidate.target === AWS_WORKSPACE_HOST_TARGET && candidate.kind === AWS_VOLUME_RESOURCE_KIND,
    );
    const [instance, volumes] = await Promise.all([
      instanceRef ? this.client.describeInstance(instanceRef.providerId) : Promise.resolve(undefined),
      Promise.all(volumeRefs.map((candidate) => this.client.describeVolume(candidate.providerId))),
    ]);
    const drift: string[] = [];
    if (!instanceRef || isInstanceAbsent(instance)) drift.push('instance-absent');
    volumeRefs.forEach((candidate, index) => {
      const observed = volumes[index];
      if (isVolumeAbsent(observed)) drift.push(`volume-absent:${candidate.providerId}`);
      else if (instanceRef && observed?.attachedInstanceId !== instanceRef.providerId) {
        drift.push(`volume-detached:${candidate.providerId}`);
      }
    });
    const resources = host.resources.filter((candidate) => {
      if (candidate.kind === AWS_INSTANCE_RESOURCE_KIND) return !isInstanceAbsent(instance);
      if (candidate.kind === AWS_VOLUME_RESOURCE_KIND) {
        const index = volumeRefs.findIndex((volume) => volume.providerId === candidate.providerId);
        return index >= 0 && !isVolumeAbsent(volumes[index]);
      }
      return true;
    });
    return {
      host,
      state: this.lifecycleState(instance),
      resources,
      ...(instance?.imageId ? { image: { id: instance.imageId } } : {}),
      observedAt: this.now(),
      drift,
    };
  }

  private lifecycleState(instance: AwsInstanceObservation | undefined): WorkspaceHostObservation['state'] {
    if (isInstanceAbsent(instance)) return 'absent';
    if (instance?.state === 'running') {
      return instance.instanceStatus === 'impaired' || instance.systemStatus === 'impaired' ? 'degraded' : 'running';
    }
    if (instance?.state === 'stopped') return 'stopped';
    if (instance?.state === 'shutting-down') return 'destroying';
    return 'provisioning';
  }

  async getTransportProfile(
    host: WorkspaceHostRef,
    ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostTransportProfile> {
    const instance = requireKnownResource(host.resources, AWS_INSTANCE_RESOURCE_KIND, 'get-transport-profile');
    const provider = ctx.connection.provider ?? {};
    const requested = optionalString(provider.transportPreference, 'AWS connection transportPreference') ?? 'aws-ssm-ssh';
    if (!(AWS_WORKSPACE_HOST_TRANSPORTS as readonly string[]).includes(requested)) {
      throw new Error(`AWS transportPreference must be one of ${AWS_WORKSPACE_HOST_TRANSPORTS.join(', ')}`);
    }
    return buildAwsWorkspaceHostTransportProfile({
      kind: requested as AwsWorkspaceHostTransport,
      instanceId: instance.providerId,
      region: requireString(instance.region ?? provider.region, 'AWS transport region'),
      ...(provider.directAddress !== undefined
        ? { directAddress: requireString(provider.directAddress, 'AWS direct SSH address') }
        : {}),
      ...(provider.directSshSourceRanges !== undefined
        ? {
            directSshSourceRanges: optionalStringArray(
              provider.directSshSourceRanges,
              'AWS direct SSH source ranges',
            ),
          }
        : {}),
    });
  }

  async attestHealth(
    host: WorkspaceHostRef,
    _ctx: WorkspaceHostProviderContext,
  ): Promise<WorkspaceHostHealthAttestation> {
    const instanceRef = knownResource(host.resources, AWS_INSTANCE_RESOURCE_KIND);
    const instance = instanceRef ? await this.client.describeInstance(instanceRef.providerId) : undefined;
    const running = instance?.state === 'running';
    // EC2 status checks carry their own "not measured" values: `initializing` means the check
    // has not produced a verdict yet, and `insufficient-data` is AWS saying it cannot tell.
    // Collapsing either (or an absent field) to `false` reports a host as FAILING when nothing
    // has been measured — the WI-2143924 coercion, with AWS's own vocabulary for it discarded.
    const statusCheck = (value: AwsInstanceObservation['instanceStatus']): boolean | null =>
      value === 'ok' ? true : value === 'impaired' ? false : null;
    const instanceOk = statusCheck(instance?.instanceStatus);
    const systemOk = statusCheck(instance?.systemStatus);
    // NOT `=== true`: the SDK client (aws-sdk-client.ts) writes `ssmOnline` only when SSM
    // DescribeInstanceInformation answered; an access-denied read leaves it absent = unmeasured.
    const ssmOnline = instance?.ssmOnline ?? null;
    const checks: WorkspaceHostHealthCheck[] = [
      { name: 'ec2-running', ok: running, detail: instance?.state ?? 'absent' },
      { name: 'ec2-instance-status', ok: instanceOk, detail: instance?.instanceStatus ?? 'absent' },
      { name: 'ec2-system-status', ok: systemOk, detail: instance?.systemStatus ?? 'absent' },
      ssmOnline === null
        ? unmeasuredHealthCheck('ssm-online', 'SSM instance information was not readable for this host')
        : { name: 'ssm-online', ok: ssmOnline },
    ];
    return {
      hostId: host.hostId,
      observedAt: this.now(),
      status: resolveWorkspaceHostHealthStatus({ reachable: running, checks }),
      ...(instance?.imageId ? { image: { id: instance.imageId } } : {}),
      checks,
    };
  }
}

export function createAwsWorkspaceHostProvider(options: AwsWorkspaceHostProviderOptions): AwsWorkspaceHostProvider {
  return new AwsWorkspaceHostProvider(options.client, {
    now: options.now,
    onResourceCreated: options.onResourceCreated,
    onResourceDestroyed: options.onResourceDestroyed,
  });
}
