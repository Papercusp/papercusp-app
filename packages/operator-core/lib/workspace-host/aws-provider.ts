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
import { AWS_WORKSPACE_HOST_TARGET } from './aws-connection';
import {
  AWS_WORKSPACE_HOST_TRANSPORTS,
  buildAwsWorkspaceHostTransportProfile,
  type AwsWorkspaceHostTransport,
} from './aws-connection-profile';

export const AWS_WORKSPACE_HOST_PROVIDER_VERSION = 'aws-workspace-host-provider-v1';
export const AWS_WORKSPACE_HOST_CLIENT_TOKEN_LENGTH = 64;

export type AwsEc2InstanceState = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';
export type AwsEbsVolumeState = 'creating' | 'available' | 'in-use' | 'deleting' | 'deleted';

export interface AwsTag {
  Key: string;
  Value: string;
}

export interface AwsRunInstancesInput {
  ClientToken: string;
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
      };
    },
  ];
  TagSpecifications: readonly [
    { ResourceType: 'instance'; Tags: readonly AwsTag[] },
    { ResourceType: 'volume'; Tags: readonly AwsTag[] },
  ];
  UserData?: string;
}

export interface AwsCreateVolumeInput {
  AvailabilityZone: string;
  ClientToken: string;
  Encrypted: true;
  KmsKeyId: string;
  Size: number;
  VolumeType: string;
  TagSpecifications: readonly [{ ResourceType: 'volume'; Tags: readonly AwsTag[] }];
}

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
  observedAt: string;
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

  runInstances(input: AwsRunInstancesInput): Promise<AwsCreatedInstance>;
  findInstanceByClientToken(clientToken: string): Promise<AwsInstanceObservation | undefined>;
  describeInstance(instanceId: string): Promise<AwsInstanceObservation | undefined>;
  waitForInstanceState(
    instanceId: string,
    state: 'running' | 'stopped' | 'terminated',
    signal?: AbortSignal,
  ): Promise<AwsInstanceObservation | undefined>;
  attachVolume(input: { InstanceId: string; VolumeId: string; Device: string }): Promise<AwsProviderMutationResult>;
  startInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;
  stopInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;
  rebootInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;
  repairInstance(instanceId: string): Promise<AwsProviderMutationResult>;
  terminateInstances(instanceIds: readonly string[]): Promise<AwsProviderMutationResult>;

  createSnapshot(input: AwsCreateSnapshotInput): Promise<AwsCreatedSnapshot>;
  findSnapshotByClientToken(clientToken: string): Promise<AwsSnapshotObservation | undefined>;
  waitForSnapshotCompleted(snapshotId: string, signal?: AbortSignal): Promise<AwsSnapshotObservation>;
}

export interface AwsWorkspaceHostProviderOptions {
  client: AwsWorkspaceHostSdkClient;
  now?: () => string;
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
}

type AwsStepInput =
  | { op: 'create-data-volume'; request: AwsCreateVolumeInput; hostId: string; region: string }
  | { op: 'run-instance'; request: AwsRunInstancesInput; hostId: string; vpcId: string }
  | { op: 'attach-data-volume'; device: string; hostId: string }
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
  | { op: 'terminate-instance'; instanceId: string; hostId: string }
  | { op: 'delete-volume'; volumeId: string; hostId: string };

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
    restore: false,
    upgrade: false,
    repair: true,
    confirmedDestroy: true,
    // P-030: the AWS launch path does not yet attach a controller-rendered bootstrap. Declaring
    // false keeps the controller from rendering (and fail-closed refusing) for a provider that
    // would discard the result; flip it in the same change that consumes hostBootstrapScript.
    hostBootstrap: false,
  },
  transportKinds: AWS_WORKSPACE_HOST_TRANSPORTS,
  constraints: [
    'Launch Template, subnet, security groups, IAM instance profile, and customer KMS key are required',
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
  };
}

/** AWS EC2 accepts at most 64 ASCII characters for ClientToken. */
export function awsWorkspaceHostClientToken(idempotencyKey: string): string {
  return createHash('sha256').update(requireString(idempotencyKey, 'idempotencyKey')).digest('hex');
}

function stableTags(desired: WorkspaceHostDesiredSpec, workspaceId: string): readonly AwsTag[] {
  const labels = new Map<string, string>(Object.entries(desired.labels ?? {}));
  labels.set('papercusp:host-id', desired.hostId);
  labels.set('papercusp:managed', 'true');
  labels.set('papercusp:workspace-id', workspaceId);
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
  return request.action === 'provision' ? request.desired.hostId : request.host.hostId;
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

  constructor(
    private readonly client: AwsWorkspaceHostSdkClient,
    options: Pick<AwsWorkspaceHostProviderOptions, 'now'> = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
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

  async plan(request: WorkspaceHostPlanRequest, ctx: WorkspaceHostProviderContext): Promise<WorkspaceHostPlan> {
    if (request.action !== 'provision' && request.host.target !== AWS_WORKSPACE_HOST_TARGET) {
      throw new Error(`AWS provider cannot plan host target '${request.host.target}'`);
    }
    const steps = this.planSteps(request, ctx);
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

  private planSteps(
    request: WorkspaceHostPlanRequest,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    if (request.action === 'provision') return this.planProvision(request, ctx);
    if (request.action === 'destroy') return this.planDestroy(request, ctx);
    if (request.action === 'restore' || request.action === 'upgrade') {
      throw new Error(`AWS workspace-host action '${request.action}' is not supported`);
    }

    const instance = requireKnownResource(request.host.resources, AWS_INSTANCE_RESOURCE_KIND, request.action);
    const idempotencyKey = `${request.idempotencyKey}:${request.action}:${instance.providerId}`;
    if (request.action === 'snapshot') {
      const volume = requireKnownResource(request.host.resources, AWS_VOLUME_RESOURCE_KIND, request.action);
      const tags: readonly AwsTag[] = [
        { Key: 'Name', Value: request.name ?? `${request.host.hostId}-snapshot` },
        { Key: 'papercusp:host-id', Value: request.host.hostId },
        { Key: 'papercusp:managed', Value: 'true' },
        { Key: 'papercusp:workspace-id', Value: ctx.workspaceId },
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
    return [
      {
        id: `${request.action}-instance`,
        action: request.action,
        resourceKind: AWS_INSTANCE_RESOURCE_KIND,
        dependsOn: [],
        idempotencyKey,
        destructive: false,
        input: { op, instanceId: instance.providerId, hostId: request.host.hostId } satisfies AwsStepInput,
      },
    ];
  }

  private planProvision(
    request: Extract<WorkspaceHostPlanRequest, { action: 'provision' }>,
    ctx: WorkspaceHostProviderContext,
  ): readonly WorkspaceHostPlanStep[] {
    const desired = request.desired;
    const settings = readSettings(desired);
    const tags = stableTags(desired, ctx.workspaceId);
    const volumeKey = `${request.idempotencyKey}:data-volume`;
    const instanceKey = `${request.idempotencyKey}:instance`;
    const attachKey = `${request.idempotencyKey}:attach-data-volume`;
    const volumeRequest: AwsCreateVolumeInput = {
      AvailabilityZone: settings.availabilityZone,
      ClientToken: awsWorkspaceHostClientToken(volumeKey),
      Encrypted: true,
      KmsKeyId: settings.kmsKeyArn,
      Size: requirePositiveInteger(desired.data.volumeGiB, 'desired.data.volumeGiB'),
      VolumeType: settings.volumeType,
      TagSpecifications: [{ ResourceType: 'volume', Tags: tags }],
    };
    const runRequest: AwsRunInstancesInput = {
      ClientToken: awsWorkspaceHostClientToken(instanceKey),
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
          },
        },
      ],
      TagSpecifications: [
        { ResourceType: 'instance', Tags: tags },
        { ResourceType: 'volume', Tags: tags },
      ],
      ...(settings.userData ? { UserData: Buffer.from(settings.userData, 'utf8').toString('base64') } : {}),
    };

    return [
      {
        id: 'create-data-volume',
        action: 'provision',
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
        action: 'provision',
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
        action: 'provision',
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
                    { Key: 'papercusp:host-id', Value: request.host.hostId },
                    { Key: 'papercusp:managed', Value: 'true' },
                    { Key: 'papercusp:workspace-id', Value: ctx.workspaceId },
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
        input: { op: 'delete-volume', volumeId: volume.providerId, hostId: request.host.hostId } satisfies AwsStepInput,
      });
    }
    return steps;
  }

  async apply(
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
        const created = await this.client.runInstances(input.request);
        const observed = await this.client.waitForInstanceState(created.instanceId, 'running', ctx.signal);
        if (!observed || observed.state !== 'running') return this.inProgress(request, created.requestId);
        return this.applied(request, resource(AWS_INSTANCE_RESOURCE_KIND, created.instanceId), created.requestId);
      }
      case 'attach-data-volume': {
        const volume = requireKnownResource(request.knownResources, AWS_VOLUME_RESOURCE_KIND, request.step.id);
        const instance = requireKnownResource(request.knownResources, AWS_INSTANCE_RESOURCE_KIND, request.step.id);
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
        if (settled?.state === 'running') {
          return this.unchanged(request, resource(AWS_INSTANCE_RESOURCE_KIND, found.instanceId));
        }
        return this.inProgress(request, request.previousProviderRequestId);
      }
    } else if (input.op === 'attach-data-volume') {
      const volume = requireKnownResource(request.knownResources, AWS_VOLUME_RESOURCE_KIND, request.step.id);
      const instance = requireKnownResource(request.knownResources, AWS_INSTANCE_RESOURCE_KIND, request.step.id);
      const found = await this.client.describeVolume(volume.providerId);
      if (found?.state === 'in-use' && found.attachedInstanceId === instance.providerId) {
        return this.unchanged(request);
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
    // NOT `=== true`: `ssmOnline` is optional and no AWS client in this tree writes it.
    const ssmOnline = instance?.ssmOnline ?? null;
    const checks: WorkspaceHostHealthCheck[] = [
      { name: 'ec2-running', ok: running, detail: instance?.state ?? 'absent' },
      { name: 'ec2-instance-status', ok: instanceOk, detail: instance?.instanceStatus ?? 'absent' },
      { name: 'ec2-system-status', ok: systemOk, detail: instance?.systemStatus ?? 'absent' },
      ssmOnline === null
        ? unmeasuredHealthCheck('ssm-online', 'no producer writes ssmOnline on the AWS path')
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
  return new AwsWorkspaceHostProvider(options.client, { now: options.now });
}
