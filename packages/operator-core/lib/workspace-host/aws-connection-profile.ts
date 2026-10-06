import { isIP } from 'node:net';

import type { WorkspaceHostTransportProfile } from '@papercusp/deployment-driver';

export const AWS_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION = 'aws-workspace-host-connection-profile-v1';
export const AWS_WORKSPACE_HOST_TRANSPORTS = ['aws-ssm-ssh', 'aws-direct-ssh'] as const;

export type AwsWorkspaceHostTransport = (typeof AWS_WORKSPACE_HOST_TRANSPORTS)[number];

export interface AwsWorkspaceHostTransportProfileInput {
  kind: AwsWorkspaceHostTransport;
  instanceId: string;
  region: string;
  /** Required only for the explicit public-network direct SSH profile. */
  directAddress?: string;
  /** The provisioned ingress allowlist. /0 is forbidden. */
  directSshSourceRanges?: readonly string[];
}

export interface AwsWorkspaceHostConnectionProfileInput extends AwsWorkspaceHostTransportProfileInput {
  profileName: string;
  sshUser: string;
  /** Optional shared AWS config profile. Omit to use the standard AWS credential chain. */
  awsProfile?: string;
}

/**
 * Provider-specific values consumed by the existing local OpenSSH manager and,
 * later, the provider-neutral remote-console action endpoint. This adapter is
 * deliberately pure: it never stores a psu profile or issues a launch ticket.
 */
export interface AwsWorkspaceHostConnectionProfile {
  version: typeof AWS_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION;
  profileName: string;
  kind: AwsWorkspaceHostTransport;
  transportProfile: WorkspaceHostTransportProfile;
  target: string;
  extraArgs: readonly string[];
  remoteOperatorPort: 3070;
}

const CONNECTION_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AWS_SHARED_PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/;
const AWS_INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const AWS_REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/;
const SSH_USER = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function requiredMatch(value: string, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} has an invalid value`);
  return value;
}

function directAddress(value: string | undefined): string {
  if (typeof value !== 'string' || !value || (isIP(value) !== 4 && !HOSTNAME.test(value))) {
    throw new Error('AWS direct SSH address must be an IPv4 address or DNS hostname');
  }
  return value;
}

function restrictedSourceRanges(values: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('AWS direct SSH requires an explicit restricted source CIDR allowlist');
  }
  return values.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`AWS direct SSH source CIDR ${index} must be a string`);
    const separator = value.lastIndexOf('/');
    const address = separator > 0 ? value.slice(0, separator) : '';
    const prefix = separator > 0 ? Number(value.slice(separator + 1)) : Number.NaN;
    const version = isIP(address);
    const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : 0;
    if (!maxPrefix || !Number.isInteger(prefix) || prefix < 1 || prefix > maxPrefix) {
      throw new Error(`AWS direct SSH source CIDR '${value}' must be a restricted IPv4 or IPv6 CIDR`);
    }
    return value;
  });
}

function profileEndpoint(scheme: string, address: string, instanceId: string, region: string): string {
  return `${scheme}://${address}?${new URLSearchParams({ instance: instanceId, region }).toString()}`;
}

const SSH_FEATURES = ['command', 'pty', 'tcpForward', 'fileTransfer'] as const;

/**
 * What both AWS SSH transports can carry. The initialization resolver reads this to decide which
 * credential channels an AWS host can receive (D-215 point 6), so it is declared once here rather
 * than restated beside GCP's.
 */
export const AWS_WORKSPACE_HOST_TRANSPORT_FEATURES = Object.freeze({
  command: true,
  pty: true,
  tcpForward: true,
  fileTransfer: true,
  clipboard: false,
} as const);

function hostKeyPolicy(): WorkspaceHostTransportProfile['compatibility']['hostKey'] {
  return {
    initialEnrollment: 'verify-before-connect',
    replacement: 'block-and-reverify',
    notes: ['Pin the enrolled host key; a changed key requires independently verified rotation'],
  };
}

function clipboardFallback(): WorkspaceHostTransportProfile['compatibility']['fallbacks'][number] {
  return {
    feature: 'clipboard',
    strategy: 'unsupported',
    description: 'Use explicit local-client copy/paste; neither SSH transport synchronizes clipboards',
  };
}

/** Build the capability/policy half shared by provider discovery and psu connection normalization. */
export function buildAwsWorkspaceHostTransportProfile(
  input: AwsWorkspaceHostTransportProfileInput,
): WorkspaceHostTransportProfile {
  const instanceId = requiredMatch(input.instanceId, 'AWS instance id', AWS_INSTANCE_ID);
  const region = requiredMatch(input.region, 'AWS region', AWS_REGION);
  const common = {
    supportedClientPlatforms: ['linux', 'macos', 'windows'],
    features: { ...AWS_WORKSPACE_HOST_TRANSPORT_FEATURES },
    reconnect: 'recreate' as const,
  };

  if (input.kind === 'aws-direct-ssh') {
    const address = directAddress(input.directAddress);
    const sourceRanges = restrictedSourceRanges(input.directSshSourceRanges);
    return {
      kind: input.kind,
      endpoint: profileEndpoint('ssh', `${address}:22`, instanceId, region),
      ...common,
      prerequisites: ['OpenSSH client', 'Verified SSH host key', 'Explicit restricted tcp/22 source CIDR allowlist'],
      constraints: [
        'Public-network SSH is explicitly selected',
        `Only tcp/22 from ${sourceRanges.join(', ')} may be exposed`,
        'No provider tunnel or session-content audit',
      ],
      audited: false,
      compatibility: {
        requirements: [
          { id: 'openssh-client', label: 'OpenSSH client', kind: 'client-tool', requiredFor: SSH_FEATURES },
          {
            id: 'aws-direct-ssh-ingress',
            label: 'Restricted tcp/22 source CIDR allowlist',
            kind: 'network',
            requiredFor: SSH_FEATURES,
          },
        ],
        traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' },
        limits: {
          unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
          notes: ['Limits and throughput depend on the instance and public network path'],
        },
        proxy: {
          mode: 'provider-dependent',
          notes: ['A corporate proxy must explicitly support the configured direct SSH path'],
        },
        cost: {
          model: 'network-metered',
          meters: ['public IPv4', 'network egress'],
          notes: ['EC2 and public-network charges remain provider-billed'],
        },
        audit: {
          controlPlaneEvents: false,
          sessionMetadata: false,
          sessionContent: false,
          fileTransferEvents: false,
          notes: ['Use host-side logging when direct SSH audit evidence is required'],
        },
        hostKey: hostKeyPolicy(),
        fallbacks: [clipboardFallback()],
      },
    };
  }

  if (input.directAddress !== undefined || input.directSshSourceRanges !== undefined) {
    throw new Error('AWS direct SSH settings are valid only for aws-direct-ssh');
  }
  return {
    kind: input.kind,
    endpoint: profileEndpoint('aws-ssm-ssh', instanceId, instanceId, region),
    ...common,
    prerequisites: ['OpenSSH client', 'AWS CLI', 'Session Manager plugin', 'AWS Systems Manager Agent online'],
    constraints: [
      'No public IP is required',
      'SSH and SCP payload content is not available in Session Manager logs',
      'Bulk workspace transfer should use an identity-scoped S3 path',
    ],
    audited: true,
    compatibility: {
      requirements: [
        { id: 'openssh-client', label: 'OpenSSH client', kind: 'client-tool', requiredFor: SSH_FEATURES },
        {
          id: 'aws-cli',
          label: 'AWS CLI',
          kind: 'client-tool',
          requiredFor: SSH_FEATURES,
        },
        {
          id: 'aws-session-manager-plugin',
          label: 'AWS Session Manager plugin',
          kind: 'client-plugin',
          minimumVersion: '1.1.23.0',
          requiredFor: SSH_FEATURES,
        },
        {
          id: 'aws-ssm-agent',
          label: 'AWS Systems Manager Agent',
          kind: 'remote-agent',
          minimumVersion: '2.3.672.0',
          requiredFor: SSH_FEATURES,
        },
        {
          id: 'aws-ssm-session-permission',
          label: 'Systems Manager StartSession permission',
          kind: 'provider-permission',
          requiredFor: SSH_FEATURES,
        },
        {
          id: 'aws-ssmmessages-network',
          label: 'Reachable Systems Manager message endpoints',
          kind: 'network',
          requiredFor: SSH_FEATURES,
        },
      ],
      traffic: { interactive: 'recommended', 'bulk-transfer': 'discouraged' },
      limits: {
        unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
        notes: ['Session quotas and idle timeouts depend on the AWS account and Session Manager preferences'],
      },
      proxy: {
        mode: 'provider-dependent',
        notes: ['Preflight must verify AWS CLI and Session Manager plugin access to regional HTTPS endpoints'],
      },
      cost: {
        model: 'included',
        meters: ['network egress'],
        notes: ['Session Manager has no separate connection charge; provider network charges may apply'],
      },
      audit: {
        controlPlaneEvents: true,
        sessionMetadata: true,
        sessionContent: false,
        fileTransferEvents: false,
        notes: ['Port-forwarded SSH and SCP payloads are encrypted and are not available in Session Manager logs'],
      },
      hostKey: hostKeyPolicy(),
      fallbacks: [
        {
          feature: 'fileTransfer',
          trafficClass: 'bulk-transfer',
          strategy: 'provider-object-storage',
          description: 'Use an identity-scoped, audited S3 transfer for bulk workspace data',
        },
        clipboardFallback(),
      ],
    },
  };
}

/** Normalize AWS routing into the target/extraArgs interface owned by the local OpenSSH manager. */
export function normalizeAwsWorkspaceHostConnectionProfile(
  input: AwsWorkspaceHostConnectionProfileInput,
): AwsWorkspaceHostConnectionProfile {
  const profileName = requiredMatch(input.profileName, 'Connection profile name', CONNECTION_PROFILE_NAME);
  const sshUser = requiredMatch(input.sshUser, 'SSH user', SSH_USER);
  const transportProfile = buildAwsWorkspaceHostTransportProfile(input);
  const instanceId = requiredMatch(input.instanceId, 'AWS instance id', AWS_INSTANCE_ID);
  const region = requiredMatch(input.region, 'AWS region', AWS_REGION);

  if (input.awsProfile !== undefined && !AWS_SHARED_PROFILE.test(input.awsProfile)) {
    throw new Error('AWS shared profile name has an invalid value');
  }
  if (input.kind === 'aws-direct-ssh' && input.awsProfile !== undefined) {
    throw new Error('AWS shared profile is valid only for aws-ssm-ssh');
  }

  const targetHost = input.kind === 'aws-ssm-ssh' ? instanceId : directAddress(input.directAddress);
  const extraArgs =
    input.kind === 'aws-ssm-ssh'
      ? [
          '-o',
          [
            'ProxyCommand=aws ssm start-session',
            '--target %h',
            '--document-name AWS-StartSSHSession',
            '--parameters portNumber=%p',
            `--region ${region}`,
            ...(input.awsProfile ? [`--profile ${input.awsProfile}`] : []),
          ].join(' '),
        ]
      : [];

  return {
    version: AWS_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION,
    profileName,
    kind: input.kind,
    transportProfile,
    target: `${sshUser}@${targetHost}`,
    extraArgs,
    remoteOperatorPort: 3070,
  };
}
