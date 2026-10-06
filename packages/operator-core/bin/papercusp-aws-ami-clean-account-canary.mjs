#!/usr/bin/env node
/**
 * papercusp-aws-ami-clean-account-canary — boot a shared workspace-host AMI in a CLEAN AWS
 * account (never the publisher), privately with no public IPv4. It proves the SSM agent comes
 * Online, runs the release's canonical clean-room bootstrap fixture over SSM, reads back the
 * host's own attestation and the service state, then terminates and censuses residue to zero
 * (WI-10005604; mirrors papercusp-gcp-clean-room).
 *
 * Invoked by SdkAwsAmiReleaseAdapter.launchCleanAccountCanary (aws-ami-production.ts) with NO
 * arguments and the payload on stdin (`--json-stdin` is accepted for parity):
 *
 * INPUT  { accountId, region, subnetId, instanceProfileArn, imageId, releaseVersion,
 *          releaseSha256, buildManifestIdentity, fixture }
 *        fixture = WorkspaceHostCleanRoomInstallFixture built by awsCleanAccountFixture()
 * OUTPUT AwsAmiCleanAccountLaunchProof (aws-ami-release.ts), validated there against the fixture.
 *
 * CREDENTIALS: the environment carries the PUBLISHER's credentials (adapter childEnv). The
 * canary assumes a role INTO the clean account, OrganizationAccountAccessRole by default
 * (override: PAPERCUSP_AWS_AMI_CANARY_ROLE_NAME or PAPERCUSP_AWS_AMI_CANARY_ROLE_ARN), and
 * refuses to launch unless STS confirms the assumed identity is in `accountId`.
 *
 * CLEAN-ACCOUNT PREREQUISITES (failures here surface as typed errors, not silent hangs):
 *   - subnetId: a private subnet with a route to the SSM endpoints (NAT or ssm/ssmmessages/
 *     ec2messages VPC endpoints), plus whatever egress the bootstrap fixture needs;
 *   - instanceProfileArn: a profile in the clean account with AmazonSSMManagedInstanceCore;
 *   - the AMI shared to the account, with its snapshots' KMS key granting the account use.
 * The instance is launched with AssociatePublicIpAddress=false, IMDSv2 required and
 * shutdown→terminate, and every resource carries the run tag the census reads back.
 *
 * Evidence (the proof plus the full observation, including teardown errors) is written to
 * PAPERCUSP_AWS_AMI_CANARY_EVIDENCE_DIR (default ~/.papercusp/evidence/aws-ami-canary).
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  EC2Client,
  GetConsoleOutputCommand,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  SSMClient,
  SendCommandCommand,
} from '@aws-sdk/client-ssm';
import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import {
  AWS_AMI_CANARY_TOOL,
  CANARY_RUN_TAG,
  buildAwsAmiCanaryProof,
  canaryRoleArn,
  parseAwsAmiCanaryInput,
  runAwsAmiCleanAccountCanary,
} from './aws-ami-canary-measure.mjs';
import { emit, parseJsonObject, readStdin } from './gcp-ephemeral.mjs';

const EVIDENCE_ROOT =
  process.env.PAPERCUSP_AWS_AMI_CANARY_EVIDENCE_DIR?.trim() || join(homedir(), '.papercusp', 'evidence', 'aws-ami-canary');
const REFRESH_MARGIN_MS = 5 * 60_000;

function errorName(error) {
  return error?.name ?? error?.Code ?? '';
}

/** Clean-account credentials that re-assume before expiry (a canary can outlive one session). */
function assumedCredentialProvider(region, roleArn, runId) {
  const sts = new STSClient({ region });
  let cached = null;
  return async () => {
    if (cached && cached.expiration.getTime() - Date.now() > REFRESH_MARGIN_MS) return cached;
    const out = await sts.send(
      new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: `papercusp-ami-canary-${runId}`, DurationSeconds: 3600 }),
    );
    const c = out.Credentials;
    if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) {
      throw new Error(`AssumeRole ${roleArn} returned no usable credentials`);
    }
    cached = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
    return cached;
  };
}

function sdkDeps(input, runId) {
  const credentials = assumedCredentialProvider(input.region, canaryRoleArn(input.accountId, input.region, process.env), runId);
  const ec2 = new EC2Client({ region: input.region, credentials });
  const ssm = new SSMClient({ region: input.region, credentials });
  const stsClean = new STSClient({ region: input.region, credentials });
  const runTag = [{ Name: `tag:${CANARY_RUN_TAG}`, Values: [runId] }];
  return {
    runId: () => runId,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async callerAccount() {
      return (await stsClean.send(new GetCallerIdentityCommand({}))).Account ?? '';
    },
    async describeImage(imageId) {
      try {
        const image = (await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }))).Images?.[0];
        const rootEbs = image?.BlockDeviceMappings?.find((m) => m.DeviceName === image.RootDeviceName)?.Ebs;
        return image
          ? {
              state: image.State ?? 'unknown',
              architecture: image.Architecture ?? 'unknown',
              ...(image.RootDeviceName ? { rootDeviceName: image.RootDeviceName } : {}),
              ...(typeof rootEbs?.Encrypted === 'boolean' ? { rootEncrypted: rootEbs.Encrypted } : {}),
            }
          : null;
      } catch (error) {
        if (/InvalidAMIID/.test(errorName(error))) return null;
        throw error;
      }
    },
    async describeSubnet(subnetId) {
      try {
        const subnet = (await ec2.send(new DescribeSubnetsCommand({ SubnetIds: [subnetId] }))).Subnets?.[0];
        return subnet ? { subnetId: subnet.SubnetId, vpcId: subnet.VpcId } : null;
      } catch (error) {
        if (/InvalidSubnetID/.test(errorName(error))) return null;
        throw error;
      }
    },
    async runInstance({ imageId, subnetId, instanceProfileArn, instanceType, tags, rootDeviceName, volumeInitializationRateMiBps, encryptRootVolume }) {
      const out = await ec2.send(
        new RunInstancesCommand({
          ImageId: imageId,
          InstanceType: instanceType,
          MinCount: 1,
          MaxCount: 1,
          // The root mapping inherits the AMI's snapshot. Only the initialization rate is set, plus
          // encryption at launch (the account's default EBS key) for an unencrypted AMI.
          ...(rootDeviceName && volumeInitializationRateMiBps
            ? {
                BlockDeviceMappings: [
                  {
                    DeviceName: rootDeviceName,
                    Ebs: { VolumeInitializationRate: volumeInitializationRateMiBps, ...(encryptRootVolume ? { Encrypted: true } : {}) },
                  },
                ],
              }
            : {}),
          IamInstanceProfile: { Arn: instanceProfileArn },
          NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: subnetId, AssociatePublicIpAddress: false, DeleteOnTermination: true }],
          MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled' },
          InstanceInitiatedShutdownBehavior: 'terminate',
          TagSpecifications: ['instance', 'volume', 'network-interface'].map((ResourceType) => ({ ResourceType, Tags: [...tags] })),
        }),
      );
      const instanceId = out.Instances?.[0]?.InstanceId;
      if (!instanceId) throw new Error('RunInstances returned no instance id');
      return instanceId;
    },
    async describeInstance(instanceId) {
      try {
        const instance = (await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))).Reservations?.[0]
          ?.Instances?.[0];
        if (!instance) return { state: 'pending' };
        return {
          state: instance.State?.Name ?? 'pending',
          publicIpv4: instance.PublicIpAddress ?? null,
          stateReason: instance.StateReason?.Message ?? null,
        };
      } catch (error) {
        // Eventual consistency: a just-created id can read NotFound for a few seconds.
        if (/InvalidInstanceID\.NotFound/.test(errorName(error))) return { state: 'pending' };
        throw error;
      }
    },
    async ssmPingStatus(instanceId) {
      const out = await ssm.send(
        new DescribeInstanceInformationCommand({ Filters: [{ Key: 'InstanceIds', Values: [instanceId] }] }),
      );
      return out.InstanceInformationList?.[0]?.PingStatus ?? null;
    },
    async consoleOutput(instanceId) {
      let out;
      try {
        out = await ec2.send(new GetConsoleOutputCommand({ InstanceId: instanceId, Latest: true }));
      } catch (error) {
        // Latest is Nitro-only. Other types refuse it, so fall back to the buffered capture.
        if (!/UnsupportedOperation|InvalidParameter/.test(errorName(error))) throw error;
        out = await ec2.send(new GetConsoleOutputCommand({ InstanceId: instanceId }));
      }
      return out.Output ? Buffer.from(out.Output, 'base64').toString('utf8') : null;
    },
    async sendCommand({ instanceId, commands, executionTimeoutSec }) {
      const out = await ssm.send(
        new SendCommandCommand({
          InstanceIds: [instanceId],
          DocumentName: 'AWS-RunShellScript',
          Parameters: { commands: [...commands], executionTimeout: [String(executionTimeoutSec)] },
          TimeoutSeconds: 600,
          Comment: `papercusp ami canary ${runId}`,
        }),
      );
      const commandId = out.Command?.CommandId;
      if (!commandId) throw new Error('SendCommand returned no command id');
      return commandId;
    },
    async getInvocation({ commandId, instanceId }) {
      try {
        const out = await ssm.send(new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }));
        return {
          status: out.Status ?? 'Pending',
          stdout: out.StandardOutputContent ?? '',
          stderr: out.StandardErrorContent ?? '',
          responseCode: out.ResponseCode,
        };
      } catch (error) {
        if (/InvocationDoesNotExist/.test(errorName(error))) return null;
        throw error;
      }
    },
    async terminate(instanceId) {
      await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
    },
    async censusByRunTag() {
      const [instances, volumes, enis] = await Promise.all([
        ec2.send(new DescribeInstancesCommand({ Filters: runTag })),
        ec2.send(new DescribeVolumesCommand({ Filters: runTag })),
        ec2.send(new DescribeNetworkInterfacesCommand({ Filters: runTag })),
      ]);
      const live = (instances.Reservations ?? [])
        .flatMap((r) => r.Instances ?? [])
        .filter((i) => i.State?.Name !== 'terminated')
        .map((i) => i.InstanceId);
      return [
        ...live,
        ...(volumes.Volumes ?? []).map((v) => v.VolumeId),
        ...(enis.NetworkInterfaces ?? []).map((n) => n.NetworkInterfaceId),
      ].filter(Boolean);
    },
  };
}

async function writeEvidence(evidenceRef, body) {
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  const path = join(EVIDENCE_ROOT, `${evidenceRef.replace(/[^A-Za-z0-9._-]+/g, '_')}.json`);
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function canary() {
  const input = parseAwsAmiCanaryInput(parseJsonObject(await readStdin(), AWS_AMI_CANARY_TOOL));
  const runId = randomBytes(6).toString('hex');
  try {
    const observed = await runAwsAmiCleanAccountCanary(input, sdkDeps(input, runId), process.env);
    const proof = buildAwsAmiCanaryProof(input, observed, new Date().toISOString());
    await writeEvidence(proof.evidenceRef, { tool: AWS_AMI_CANARY_TOOL, proof, observed });
    return proof;
  } catch (error) {
    await writeEvidence(`aws-ami-canary-failed-${runId}`, {
      tool: AWS_AMI_CANARY_TOOL,
      error: error instanceof Error ? error.message : String(error),
      details: error?.details ?? null,
    }).catch(() => {});
    throw error;
  }
}

try {
  emit(await canary());
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      tool: AWS_AMI_CANARY_TOOL,
      error: error instanceof Error ? error.message : String(error),
      ...(error?.details ? { details: error.details } : {}),
    })}\n`,
  );
  process.exit(1);
}
