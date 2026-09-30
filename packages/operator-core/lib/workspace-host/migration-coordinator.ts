/**
 * Secretless local -> hosted workspace migration and reversible cutover.
 *
 * This composes the existing local connection manager and hosted connector
 * gateway through ports. It deliberately does not introduce another control
 * plane or serialize credential material: an imported connection is always
 * `rebind-required` until the destination resolves a new credential locally.
 */
import { createHash } from 'node:crypto';

import { assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';

export const WORKSPACE_HOST_MIGRATION_FORMAT = 'papercusp-workspace-host-migration-v1';
export const WORKSPACE_HOST_PROTOCOL_COMPONENTS = ['psu', 'desktop', 'host', 'control'] as const;

export type WorkspaceHostProtocolComponent = (typeof WORKSPACE_HOST_PROTOCOL_COMPONENTS)[number];
export type WorkspaceHostManagementMode = 'local' | 'dual' | 'hosted';
export type WorkspaceHostMigrationTarget = 'gcp' | 'aws' | 'azure';

export interface WorkspaceHostProtocolRange {
  minVersion: number;
  maxVersion: number;
  /** Versions still readable during a staged deprecation, but never preferred. */
  deprecatedVersions?: readonly number[];
  /** Once reached, deprecated versions are rejected rather than warned. */
  removeDeprecatedAfter?: string;
}

export type WorkspaceHostProtocolManifest = Readonly<
  Record<WorkspaceHostProtocolComponent, WorkspaceHostProtocolRange>
>;

export interface WorkspaceHostMigrationDirectoryEntry {
  id: string;
  name: string;
  createdAt?: string;
  companyId?: string | null;
}

export interface WorkspaceHostMigrationConnectionSource {
  id: string;
  label: string;
  target: WorkspaceHostMigrationTarget;
  credentialRef: string;
  scope: { kind: string; id: string };
  /** Non-secret provider identity such as project id or service-account email. */
  provider?: Readonly<Record<string, unknown>>;
  profile?: {
    transportKind: string;
    providerResourceId?: string;
    region?: string;
    remoteOperatorPort?: number;
  };
}

export interface WorkspaceHostMigrationConnection {
  id: string;
  label: string;
  target: WorkspaceHostMigrationTarget;
  scope: { kind: string; id: string };
  provider?: Readonly<Record<string, unknown>>;
  profile?: WorkspaceHostMigrationConnectionSource['profile'];
  credentialBinding: {
    kind: 'rebind-required';
    /** Scheme only (`adc`, `gcloud`, `resolver`), never the source reference. */
    resolverScheme: string;
  };
}

export interface WorkspaceHostMigrationHost {
  id: string;
  name: string;
  connectionId: string;
  target: WorkspaceHostMigrationTarget;
  providerResourceId?: string;
  connector?: { routeLabel: string; transport: 'sse' | 'websocket' };
}

export interface WorkspaceHostMigrationBundle {
  format: typeof WORKSPACE_HOST_MIGRATION_FORMAT;
  exportedAt: string;
  sourceWorkspaceId: string;
  sourceMode: 'local';
  preserveLocal: true;
  directory: readonly WorkspaceHostMigrationDirectoryEntry[];
  connections: readonly WorkspaceHostMigrationConnection[];
  hosts: readonly WorkspaceHostMigrationHost[];
  protocols: WorkspaceHostProtocolManifest;
  digest: string;
}

export interface WorkspaceHostProtocolNegotiation {
  selected: Readonly<Record<WorkspaceHostProtocolComponent, number>>;
  warnings: readonly string[];
}

export interface WorkspaceHostMigrationPlan {
  bundleDigest: string;
  targetMode: Exclude<WorkspaceHostManagementMode, 'local'>;
  protocols: WorkspaceHostProtocolNegotiation;
  steps: readonly (
    | { kind: 'import-directory'; workspaceId: string }
    | { kind: 'import-connection'; connectionId: string; credentialState: 'rebind-required' }
    | { kind: 'pair-host'; hostId: string; connector: WorkspaceHostMigrationHost['connector'] }
    | { kind: 'set-mode'; mode: 'dual' | 'hosted' }
    | { kind: 'verify-hosted' }
  )[];
  rollback: readonly ['disable-hosted-routing', 'restore-local-profiles', 'verify-local-control'];
}

export interface WorkspaceHostMigrationReceipt {
  bundleDigest: string;
  previousMode: 'local';
  mode: 'dual' | 'hosted';
  importedWorkspaceIds: readonly string[];
  importedConnectionIds: readonly string[];
  pairedHostIds: readonly string[];
  protocols: WorkspaceHostProtocolNegotiation['selected'];
}

export interface WorkspaceHostMigrationPort {
  transaction<T>(run: (target: WorkspaceHostMigrationTargetPort) => Promise<T>): Promise<T>;
  verifyHosted(receipt: WorkspaceHostMigrationReceipt): Promise<void>;
  verifyLocal(bundleDigest: string): Promise<void>;
}

export interface WorkspaceHostMigrationTargetPort {
  upsertDirectory(entry: WorkspaceHostMigrationDirectoryEntry): Promise<void>;
  upsertConnection(connection: WorkspaceHostMigrationConnection): Promise<void>;
  pairHost(host: WorkspaceHostMigrationHost): Promise<void>;
  setManagementMode(mode: WorkspaceHostManagementMode): Promise<void>;
}

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_000 || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value.trim();
}

function iso(value: string, label: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function resolverScheme(reference: string): string {
  const normalized = requiredText(reference, 'credentialRef');
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(normalized);
  return match?.[1]?.toLowerCase() ?? 'resolver';
}

function validateRange(range: WorkspaceHostProtocolRange, label: string): void {
  if (!Number.isSafeInteger(range.minVersion) || range.minVersion < 1) {
    throw new Error(`${label}.minVersion must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(range.maxVersion) || range.maxVersion < range.minVersion) {
    throw new Error(`${label}.maxVersion must be at least minVersion`);
  }
  for (const version of range.deprecatedVersions ?? []) {
    if (!Number.isSafeInteger(version) || version < range.minVersion || version > range.maxVersion) {
      throw new Error(`${label}.deprecatedVersions must stay inside the supported range`);
    }
  }
  if (range.removeDeprecatedAfter) iso(range.removeDeprecatedAfter, `${label}.removeDeprecatedAfter`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function bundlePayload(bundle: Omit<WorkspaceHostMigrationBundle, 'digest'>): Omit<WorkspaceHostMigrationBundle, 'digest'> {
  return bundle;
}

export function buildWorkspaceHostMigrationBundle(input: {
  exportedAt: string;
  sourceWorkspaceId: string;
  directory: readonly WorkspaceHostMigrationDirectoryEntry[];
  connections: readonly WorkspaceHostMigrationConnectionSource[];
  hosts: readonly WorkspaceHostMigrationHost[];
  protocols: WorkspaceHostProtocolManifest;
}): WorkspaceHostMigrationBundle {
  const sourceWorkspaceId = requiredText(input.sourceWorkspaceId, 'sourceWorkspaceId');
  const exportedAt = iso(input.exportedAt, 'exportedAt');
  for (const component of WORKSPACE_HOST_PROTOCOL_COMPONENTS) {
    validateRange(input.protocols[component], `protocols.${component}`);
  }
  assertUnique(input.directory.map((entry) => requiredText(entry.id, 'directory.id')), 'directory ids');
  assertUnique(input.connections.map((entry) => requiredText(entry.id, 'connection.id')), 'connection ids');
  assertUnique(input.hosts.map((entry) => requiredText(entry.id, 'host.id')), 'host ids');

  const connectionIds = new Set(input.connections.map((entry) => entry.id));
  for (const host of input.hosts) {
    if (!connectionIds.has(host.connectionId)) {
      throw new Error(`host '${host.id}' references unknown connection '${host.connectionId}'`);
    }
  }

  const connections = input.connections.map(({ credentialRef, ...connection }) => ({
    ...connection,
    credentialBinding: { kind: 'rebind-required' as const, resolverScheme: resolverScheme(credentialRef) },
  }));
  const payload = bundlePayload({
    format: WORKSPACE_HOST_MIGRATION_FORMAT,
    exportedAt,
    sourceWorkspaceId,
    sourceMode: 'local',
    preserveLocal: true,
    directory: structuredClone(input.directory),
    connections: structuredClone(connections),
    hosts: structuredClone(input.hosts),
    protocols: structuredClone(input.protocols),
  });
  assertWorkspaceHostSecretIsolation(payload, 'workspaceHost.migration.bundle');
  return { ...payload, digest: digest(payload) };
}

export function validateWorkspaceHostMigrationBundle(bundle: WorkspaceHostMigrationBundle): void {
  if (bundle.format !== WORKSPACE_HOST_MIGRATION_FORMAT || bundle.sourceMode !== 'local' || bundle.preserveLocal !== true) {
    throw new Error('unsupported or destructive workspace-host migration bundle');
  }
  assertWorkspaceHostSecretIsolation(bundle, 'workspaceHost.migration.bundle');
  const { digest: claimed, ...payload } = bundle;
  if (!/^[0-9a-f]{64}$/.test(claimed) || digest(payload) !== claimed) {
    throw new Error('workspace-host migration bundle digest mismatch');
  }
  for (const connection of bundle.connections) {
    if (connection.credentialBinding.kind !== 'rebind-required') {
      throw new Error(`connection '${connection.id}' must require destination credential rebinding`);
    }
  }
}

export function negotiateWorkspaceHostMigrationProtocols(
  source: WorkspaceHostProtocolManifest,
  target: WorkspaceHostProtocolManifest,
  now = new Date(),
): WorkspaceHostProtocolNegotiation {
  const selected = {} as Record<WorkspaceHostProtocolComponent, number>;
  const warnings: string[] = [];
  for (const component of WORKSPACE_HOST_PROTOCOL_COMPONENTS) {
    const left = source[component];
    const right = target[component];
    validateRange(left, `source.${component}`);
    validateRange(right, `target.${component}`);
    const minimum = Math.max(left.minVersion, right.minVersion);
    const maximum = Math.min(left.maxVersion, right.maxVersion);
    if (minimum > maximum) throw new Error(`no compatible ${component} protocol version`);
    const deprecated = new Set([...(left.deprecatedVersions ?? []), ...(right.deprecatedVersions ?? [])]);
    let version = maximum;
    while (version >= minimum && deprecated.has(version)) version -= 1;
    if (version < minimum) {
      const removals = [left.removeDeprecatedAfter, right.removeDeprecatedAfter]
        .filter((value): value is string => Boolean(value))
        .map((value) => Date.parse(value));
      if (removals.some((value) => value <= now.getTime())) {
        throw new Error(`${component} protocol overlap contains only removed deprecated versions`);
      }
      version = maximum;
      warnings.push(`${component} protocol v${version} is deprecated; upgrade before staged removal`);
    }
    selected[component] = version;
  }
  return { selected, warnings };
}

export function planWorkspaceHostMigration(
  bundle: WorkspaceHostMigrationBundle,
  targetProtocols: WorkspaceHostProtocolManifest,
  targetMode: Exclude<WorkspaceHostManagementMode, 'local'> = 'hosted',
  now = new Date(),
): WorkspaceHostMigrationPlan {
  validateWorkspaceHostMigrationBundle(bundle);
  const protocols = negotiateWorkspaceHostMigrationProtocols(bundle.protocols, targetProtocols, now);
  const steps: WorkspaceHostMigrationPlan['steps'][number][] = [];
  for (const workspace of bundle.directory) steps.push({ kind: 'import-directory', workspaceId: workspace.id });
  for (const connection of bundle.connections) {
    steps.push({ kind: 'import-connection', connectionId: connection.id, credentialState: 'rebind-required' });
  }
  for (const host of bundle.hosts) steps.push({ kind: 'pair-host', hostId: host.id, connector: host.connector });
  steps.push({ kind: 'set-mode', mode: 'dual' }, { kind: 'verify-hosted' });
  if (targetMode === 'hosted') steps.push({ kind: 'set-mode', mode: 'hosted' });
  return {
    bundleDigest: bundle.digest,
    targetMode,
    protocols,
    steps,
    rollback: ['disable-hosted-routing', 'restore-local-profiles', 'verify-local-control'],
  };
}

export async function applyWorkspaceHostMigration(
  bundle: WorkspaceHostMigrationBundle,
  targetProtocols: WorkspaceHostProtocolManifest,
  port: WorkspaceHostMigrationPort,
  targetMode: Exclude<WorkspaceHostManagementMode, 'local'> = 'hosted',
): Promise<WorkspaceHostMigrationReceipt> {
  const plan = planWorkspaceHostMigration(bundle, targetProtocols, targetMode);
  const receipt: WorkspaceHostMigrationReceipt = {
    bundleDigest: bundle.digest,
    previousMode: 'local',
    mode: targetMode,
    importedWorkspaceIds: bundle.directory.map(({ id }) => id),
    importedConnectionIds: bundle.connections.map(({ id }) => id),
    pairedHostIds: bundle.hosts.map(({ id }) => id),
    protocols: plan.protocols.selected,
  };
  try {
    await port.transaction(async (target) => {
      for (const entry of bundle.directory) await target.upsertDirectory(entry);
      for (const connection of bundle.connections) await target.upsertConnection(connection);
      for (const host of bundle.hosts) await target.pairHost(host);
      await target.setManagementMode('dual');
    });
    await port.verifyHosted(receipt);
    if (targetMode === 'hosted') {
      await port.transaction((target) => target.setManagementMode('hosted'));
    }
    return receipt;
  } catch (error) {
    await port.transaction((target) => target.setManagementMode('local'));
    await port.verifyLocal(bundle.digest);
    throw error;
  }
}

export async function rollbackWorkspaceHostMigration(
  bundle: WorkspaceHostMigrationBundle,
  receipt: WorkspaceHostMigrationReceipt,
  port: WorkspaceHostMigrationPort,
): Promise<void> {
  validateWorkspaceHostMigrationBundle(bundle);
  if (receipt.bundleDigest !== bundle.digest || receipt.previousMode !== 'local') {
    throw new Error('rollback receipt does not match the preserved local migration source');
  }
  await port.transaction((target) => target.setManagementMode('local'));
  await port.verifyLocal(bundle.digest);
}
