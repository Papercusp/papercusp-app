import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import type { WorkspaceHostTransportProfile } from '@papercusp/deployment-driver';

import type { OpenSshCommand, OpenSshControlMasterSpec } from './local-connection-manager';

export const AZURE_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION = 'azure-workspace-host-connection-profile-v1';
export const AZURE_WORKSPACE_HOST_TRANSPORTS = [
  'azure-bastion-entra-ssh',
  'azure-bastion-ssh',
  'azure-direct-ssh',
] as const;

export type AzureWorkspaceHostTransport = (typeof AZURE_WORKSPACE_HOST_TRANSPORTS)[number];

export interface AzureWorkspaceHostTransportProfileInput {
  kind: AzureWorkspaceHostTransport;
  vmResourceId: string;
  /** Required only for the explicit public-network direct SSH profile. */
  directAddress?: string;
  /** The provisioned ingress allowlist. /0 is forbidden. */
  directSshSourceRanges?: readonly string[];
}

export interface AzureWorkspaceHostConnectionProfileInput extends AzureWorkspaceHostTransportProfileInput {
  profileName: string;
  sshUser: string;
  /** Required for both Bastion transports. */
  bastionName?: string;
  /** Resource group that owns the Bastion host, not necessarily the VM resource group. */
  bastionResourceGroup?: string;
  /** Private key used either directly or with a short-lived Entra certificate. */
  identityFile: string;
  /** Required for azure-bastion-entra-ssh certificate acquisition. */
  publicKeyFile?: string;
  /** Required for azure-bastion-entra-ssh and refreshed by `az ssh cert`. */
  certificateFile?: string;
}

export interface AzureWorkspaceHostConnectionProfile {
  version: typeof AZURE_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION;
  profileName: string;
  kind: AzureWorkspaceHostTransport;
  transportProfile: WorkspaceHostTransportProfile;
  target: string;
  hostKeyAlias: string;
  identityFile: string;
  certificateFile?: string;
  credentialCommand?: OpenSshCommand;
  bastion?: {
    name: string;
    resourceGroup: string;
    subscriptionId: string;
    targetResourceId: string;
    resourcePort: 22;
  };
  remoteOperatorPort: 3070;
}

export interface AzureWorkspaceHostConnectionPlanInput {
  controlPath: string;
  localOperatorPort: number;
  /** A separately reserved loopback port on which `az network bastion tunnel` listens. */
  bastionLocalPort?: number;
}

export interface AzureWorkspaceHostConnectionPlan {
  prepare: readonly OpenSshCommand[];
  providerTunnel?: OpenSshCommand;
  openSsh: OpenSshControlMasterSpec;
}

const CONNECTION_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SSH_USER = /^[A-Za-z_][A-Za-z0-9._-]{0,63}$/;
const HOSTNAME = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const VM_RESOURCE_ID =
  /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Compute\/virtualMachines\/([^/]+)$/i;
const SSH_FEATURES = ['command', 'pty', 'tcpForward', 'fileTransfer'] as const;

function requiredMatch(value: string, label: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} has an invalid value`);
  return value;
}

function requiredArg(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} must be a non-empty single argument`);
  }
  return value;
}

function resourceName(value: string | undefined, label: string): string {
  const name = requiredArg(value, label);
  if (name.includes('/') || name.includes('\\')) throw new Error(`${label} must be a resource name, not a path`);
  return name;
}

function parseVmResourceId(value: string): {
  id: string;
  subscriptionId: string;
  resourceGroup: string;
  vmName: string;
} {
  const id = requiredArg(value, 'Azure VM resource id');
  const match = VM_RESOURCE_ID.exec(id);
  if (!match) throw new Error('Azure VM resource id must identify one Microsoft.Compute virtualMachine');
  return { id, subscriptionId: match[1]!, resourceGroup: match[2]!, vmName: match[3]! };
}

function directAddress(value: string | undefined): string {
  const address = requiredArg(value, 'Azure direct SSH address');
  const version = isIP(address);
  if (!version && !HOSTNAME.test(address)) {
    throw new Error('Azure direct SSH address must be an IP address or DNS hostname');
  }
  return version === 6 ? `[${address}]` : address;
}

function restrictedSourceRanges(values: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Azure direct SSH requires an explicit restricted source CIDR allowlist');
  }
  return values.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`Azure direct SSH source CIDR ${index} must be a string`);
    const separator = value.lastIndexOf('/');
    const address = separator > 0 ? value.slice(0, separator) : '';
    const prefix = separator > 0 ? Number(value.slice(separator + 1)) : Number.NaN;
    const version = isIP(address);
    const maxPrefix = version === 4 ? 32 : version === 6 ? 128 : 0;
    if (!maxPrefix || !Number.isInteger(prefix) || prefix < 1 || prefix > maxPrefix) {
      throw new Error(`Azure direct SSH source CIDR '${value}' must be a restricted IPv4 or IPv6 CIDR`);
    }
    return value;
  });
}

function requirePort(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || value! < 1 || value! > 65_535) {
    throw new Error(`${label} must be an integer from 1 through 65535`);
  }
  return value!;
}

function hostKeyPolicy(): WorkspaceHostTransportProfile['compatibility']['hostKey'] {
  return {
    initialEnrollment: 'verify-before-connect',
    replacement: 'block-and-reverify',
    notes: ['Pin the VM host key under its stable Azure resource alias; block unexpected replacement'],
  };
}

function clipboardFallback(): WorkspaceHostTransportProfile['compatibility']['fallbacks'][number] {
  return {
    feature: 'clipboard',
    strategy: 'unsupported',
    description: 'Use explicit local-client copy/paste; SSH does not synchronize clipboards',
  };
}

function blobFallback(): WorkspaceHostTransportProfile['compatibility']['fallbacks'][number] {
  return {
    feature: 'fileTransfer',
    trafficClass: 'bulk-transfer',
    strategy: 'provider-object-storage',
    description: 'Use an identity-scoped Azure Blob Storage transfer for bulk workspace data',
  };
}

/** Build the capability/policy contract shared by Azure discovery and connection normalization. */
export function buildAzureWorkspaceHostTransportProfile(
  input: AzureWorkspaceHostTransportProfileInput,
): WorkspaceHostTransportProfile {
  const vm = parseVmResourceId(input.vmResourceId);
  const common = {
    supportedClientPlatforms: ['linux', 'macos', 'windows'],
    features: { command: true, pty: true, tcpForward: true, fileTransfer: true, clipboard: false },
    reconnect: 'recreate' as const,
  };

  if (input.kind === 'azure-direct-ssh') {
    const address = directAddress(input.directAddress);
    const sourceRanges = restrictedSourceRanges(input.directSshSourceRanges);
    return {
      kind: input.kind,
      endpoint: `ssh://${address}:22?${new URLSearchParams({ resource: vm.id }).toString()}`,
      ...common,
      prerequisites: ['OpenSSH client', 'Verified SSH host key', 'Explicit restricted tcp/22 source CIDR allowlist'],
      constraints: [
        'Public-network SSH is explicitly selected',
        `Only tcp/22 from ${sourceRanges.join(', ')} may be exposed`,
        'No Bastion control-plane or session-metadata audit applies',
      ],
      audited: false,
      compatibility: {
        requirements: [
          { id: 'openssh-client', label: 'OpenSSH client', kind: 'client-tool', requiredFor: SSH_FEATURES },
          {
            id: 'azure-direct-ssh-ingress',
            label: 'Restricted tcp/22 source CIDR allowlist',
            kind: 'network',
            requiredFor: SSH_FEATURES,
          },
        ],
        traffic: { interactive: 'recommended', 'bulk-transfer': 'supported' },
        limits: {
          unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
          notes: ['Limits and throughput depend on the VM and public network path'],
        },
        proxy: {
          mode: 'provider-dependent',
          notes: ['A corporate proxy must explicitly support the configured direct SSH path'],
        },
        cost: {
          model: 'network-metered',
          meters: ['public IPv4', 'network egress'],
          notes: ['VM, public-address, and network charges remain provider-billed'],
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
    throw new Error('Azure direct SSH settings are valid only for azure-direct-ssh');
  }
  const entra = input.kind === 'azure-bastion-entra-ssh';
  return {
    kind: input.kind,
    endpoint: `azure-bastion-ssh://${encodeURIComponent(vm.id)}?auth=${entra ? 'entra' : 'ssh-key'}`,
    ...common,
    prerequisites: [
      'OpenSSH client',
      'Azure CLI 2.32.0 or newer',
      'Azure CLI Bastion extension',
      'Azure Bastion Standard or Premium with native client enabled',
      ...(entra
        ? ['Azure CLI SSH extension', 'Microsoft Entra SSH authorization and VM login extension']
        : ['Local SSH private key']),
    ],
    constraints: [
      'Public IP is not required',
      'Runtime uses az network bastion tunnel plus OpenSSH so known_hosts and file transfer remain available',
      'The az network bastion ssh convenience command is not used because it overrides host-key policy',
      'Bulk workspace transfer should use an identity-scoped Blob Storage path',
    ],
    audited: true,
    compatibility: {
      requirements: [
        { id: 'openssh-client', label: 'OpenSSH client', kind: 'client-tool', requiredFor: SSH_FEATURES },
        {
          id: 'azure-cli',
          label: 'Azure CLI',
          kind: 'client-tool',
          minimumVersion: '2.32.0',
          requiredFor: SSH_FEATURES,
        },
        {
          id: 'azure-bastion-extension',
          label: 'Azure CLI Bastion extension',
          kind: 'client-plugin',
          requiredFor: SSH_FEATURES,
        },
        ...(entra
          ? [
              {
                id: 'azure-ssh-extension',
                label: 'Azure CLI SSH extension',
                kind: 'client-plugin' as const,
                requiredFor: SSH_FEATURES,
              },
              {
                id: 'azure-entra-ssh',
                label: 'Microsoft Entra SSH authorization',
                kind: 'provider-permission' as const,
                requiredFor: SSH_FEATURES,
              },
            ]
          : [
              {
                id: 'azure-local-ssh-key',
                label: 'Local SSH private key authorized by the VM',
                kind: 'provider-permission' as const,
                requiredFor: SSH_FEATURES,
              },
            ]),
        {
          id: 'azure-bastion-standard-sku',
          label: 'Azure Bastion Standard or Premium SKU with native client enabled',
          kind: 'provider-permission',
          requiredFor: SSH_FEATURES,
        },
        {
          id: 'azure-bastion-network',
          label: 'Reachable Azure Bastion native-client HTTPS path',
          kind: 'network',
          requiredFor: SSH_FEATURES,
        },
      ],
      traffic: { interactive: 'recommended', 'bulk-transfer': 'discouraged' },
      limits: {
        unknown: ['session-duration', 'idle-timeout', 'concurrency', 'throughput'],
        notes: ['Bastion scale units, SKU, VM, and network path determine concurrency and throughput'],
      },
      proxy: {
        mode: 'supported',
        notes: ['Preflight must verify Azure CLI and Bastion extension access through corporate policy'],
      },
      cost: {
        model: 'provider-metered',
        requiredSkus: ['Standard', 'Premium'],
        meters: ['Azure Bastion hourly deployment', 'Bastion scale units', 'network egress'],
        notes: ['Native client and file transfer require a paid Bastion SKU'],
      },
      audit: {
        controlPlaneEvents: true,
        sessionMetadata: true,
        sessionContent: false,
        fileTransferEvents: false,
        notes: ['Bastion and Entra control events do not record SSH or SCP/SFTP payload contents'],
      },
      hostKey: hostKeyPolicy(),
      fallbacks: [blobFallback(), clipboardFallback()],
    },
  };
}

/** Normalize stable Azure routing and auth fields without starting a process or issuing a launch ticket. */
export function normalizeAzureWorkspaceHostConnectionProfile(
  input: AzureWorkspaceHostConnectionProfileInput,
): AzureWorkspaceHostConnectionProfile {
  const profileName = requiredMatch(input.profileName, 'Connection profile name', CONNECTION_PROFILE_NAME);
  const sshUser = requiredMatch(input.sshUser, 'SSH user', SSH_USER);
  const vm = parseVmResourceId(input.vmResourceId);
  const identityFile = requiredArg(input.identityFile, 'Azure SSH identity file');
  const transportProfile = buildAzureWorkspaceHostTransportProfile(input);
  const hostKeyAlias = `azure-${createHash('sha256').update(vm.id.toLowerCase()).digest('hex').slice(0, 32)}`;

  if (input.kind === 'azure-direct-ssh') {
    if (input.bastionName !== undefined || input.bastionResourceGroup !== undefined) {
      throw new Error('Azure Bastion settings are valid only for an Azure Bastion transport');
    }
    if (input.publicKeyFile !== undefined || input.certificateFile !== undefined) {
      throw new Error('Microsoft Entra certificate settings are valid only for azure-bastion-entra-ssh');
    }
    return {
      version: AZURE_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION,
      profileName,
      kind: input.kind,
      transportProfile,
      target: `${sshUser}@${directAddress(input.directAddress)}`,
      hostKeyAlias,
      identityFile,
      remoteOperatorPort: 3070,
    };
  }

  const bastion = {
    name: resourceName(input.bastionName, 'Azure Bastion name'),
    resourceGroup: resourceName(input.bastionResourceGroup, 'Azure Bastion resource group'),
    subscriptionId: vm.subscriptionId,
    targetResourceId: vm.id,
    resourcePort: 22 as const,
  };
  if (input.kind === 'azure-bastion-ssh') {
    if (input.publicKeyFile !== undefined || input.certificateFile !== undefined) {
      throw new Error('Microsoft Entra certificate settings are valid only for azure-bastion-entra-ssh');
    }
    return {
      version: AZURE_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION,
      profileName,
      kind: input.kind,
      transportProfile,
      target: `${sshUser}@127.0.0.1`,
      hostKeyAlias,
      identityFile,
      bastion,
      remoteOperatorPort: 3070,
    };
  }

  const publicKeyFile = requiredArg(input.publicKeyFile, 'Azure SSH public key file');
  const certificateFile = requiredArg(input.certificateFile, 'Azure SSH certificate file');
  return {
    version: AZURE_WORKSPACE_HOST_CONNECTION_PROFILE_VERSION,
    profileName,
    kind: input.kind,
    transportProfile,
    target: `${sshUser}@127.0.0.1`,
    hostKeyAlias,
    identityFile,
    certificateFile,
    credentialCommand: {
      command: 'az',
      args: [
        'ssh',
        'cert',
        '--public-key-file',
        publicKeyFile,
        '--file',
        certificateFile,
        '--subscription',
        vm.subscriptionId,
        '--only-show-errors',
        '--output',
        'none',
      ],
    },
    bastion,
    remoteOperatorPort: 3070,
  };
}

/** Materialize one invocation into the shared local-forward/remote-command OpenSSH interface. */
export function planAzureWorkspaceHostConnection(
  profile: AzureWorkspaceHostConnectionProfile,
  input: AzureWorkspaceHostConnectionPlanInput,
): AzureWorkspaceHostConnectionPlan {
  const localOperatorPort = requirePort(input.localOperatorPort, 'Local operator port');
  const controlPath = requiredArg(input.controlPath, 'OpenSSH control path');
  let providerTunnel: OpenSshCommand | undefined;
  let port: number | undefined;
  if (profile.bastion) {
    port = requirePort(input.bastionLocalPort, 'Azure Bastion local port');
    providerTunnel = {
      command: 'az',
      args: [
        'network',
        'bastion',
        'tunnel',
        '--name',
        profile.bastion.name,
        '--resource-group',
        profile.bastion.resourceGroup,
        '--target-resource-id',
        profile.bastion.targetResourceId,
        '--resource-port',
        String(profile.bastion.resourcePort),
        '--port',
        String(port),
        '--subscription',
        profile.bastion.subscriptionId,
        '--only-show-errors',
      ],
    };
  } else if (input.bastionLocalPort !== undefined) {
    throw new Error('Azure Bastion local port is valid only for an Azure Bastion transport');
  }

  return {
    prepare: profile.credentialCommand ? [profile.credentialCommand] : [],
    ...(providerTunnel ? { providerTunnel } : {}),
    openSsh: {
      target: profile.target,
      ...(port ? { port } : {}),
      hostKeyAlias: profile.hostKeyAlias,
      identityFile: profile.identityFile,
      ...(profile.certificateFile ? { certificateFile: profile.certificateFile } : {}),
      controlPath,
      localPort: localOperatorPort,
      remoteOperatorPort: profile.remoteOperatorPort,
    },
  };
}
