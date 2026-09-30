import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { isAbsolute } from 'node:path';

import type { WorkspaceHostTransportProfile } from '@papercusp/deployment-driver';

export const LOCAL_WORKSPACE_HOST_CONNECTION_VERSION = 'local-workspace-host-connection-v1';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_REMOTE_OPERATOR_PORT = 3070;
const DEFAULT_MONITOR_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_STARTUP_PROBE_ATTEMPTS = 5;
const DEFAULT_STARTUP_PROBE_DELAY_MS = 250;
const DEFAULT_PORT_ATTEMPTS = 3;
const MAX_OPENSSH_CONTROL_PATH_BYTES = 100;
const MANAGER_OWNED_OPENSSH_FLAGS = ['-F', '-L', '-R', '-D', '-W', '-S', '-i', '-p', '-f'] as const;
const MANAGER_OWNED_OPENSSH_OPTIONS = new Set([
  'batchmode',
  'certificatefile',
  'checkhostip',
  'clearallforwardings',
  'connecttimeout',
  'controlmaster',
  'controlpath',
  'controlpersist',
  'dynamicforward',
  'exitonforwardfailure',
  'forwardagent',
  'forwardx11',
  'forwardx11trusted',
  'forkafterauthentication',
  'gatewayports',
  'globalknownhostsfile',
  'hostkeyalias',
  'identitiesonly',
  'identityagent',
  'identityfile',
  'localcommand',
  'localforward',
  'permitlocalcommand',
  'remotecommand',
  'remoteforward',
  'requesttty',
  'serveralivecountmax',
  'serveraliveinterval',
  'sessiontype',
  'stricthostkeychecking',
  'tunnel',
  'tunneldevice',
  'updatehostkeys',
  'userknownhostsfile',
  'verifyhostkeydns',
]);

export interface WorkspaceHostProtocolRange {
  minVersion: number;
  maxVersion: number;
}

export class IncompatibleWorkspaceHostProtocolError extends Error {
  readonly client: WorkspaceHostProtocolRange;
  readonly remote: WorkspaceHostProtocolRange;

  constructor(client: WorkspaceHostProtocolRange, remote: WorkspaceHostProtocolRange) {
    super(
      `No compatible workspace-host protocol: client ${client.minVersion}-${client.maxVersion}, ` +
        `remote ${remote.minVersion}-${remote.maxVersion}`,
    );
    this.name = 'IncompatibleWorkspaceHostProtocolError';
    this.client = client;
    this.remote = remote;
  }
}

function validateProtocolRange(range: WorkspaceHostProtocolRange, label: string): void {
  if (!Number.isSafeInteger(range.minVersion) || range.minVersion < 1) {
    throw new Error(`${label}.minVersion must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(range.maxVersion) || range.maxVersion < range.minVersion) {
    throw new Error(`${label}.maxVersion must be a safe integer greater than or equal to minVersion`);
  }
}

/** Select the newest version both sides implement; fail closed when the ranges do not overlap. */
export function negotiateWorkspaceHostProtocol(
  client: WorkspaceHostProtocolRange,
  remote: WorkspaceHostProtocolRange,
): number {
  validateProtocolRange(client, 'client protocol');
  validateProtocolRange(remote, 'remote protocol');
  const selected = Math.min(client.maxVersion, remote.maxVersion);
  if (selected < Math.max(client.minVersion, remote.minVersion)) {
    throw new IncompatibleWorkspaceHostProtocolError(client, remote);
  }
  return selected;
}

export interface LoopbackPortLease {
  readonly port: number;
  release(): Promise<void>;
}

/**
 * Hold an OS-assigned loopback port until the tunnel is ready to spawn. The
 * manager retries with a new lease if another process wins the tiny release →
 * OpenSSH bind window, avoiding scan-and-guess port allocation.
 */
export function reserveLoopbackPort(): Promise<LoopbackPortLease> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let released = false;
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener('error', reject);
      server.unref();
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Failed to reserve a numeric loopback port'));
        return;
      }
      resolve({
        port: address.port,
        async release() {
          if (released) return;
          released = true;
          await closeServer(server);
        },
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export interface OpenSshControlMasterSpec {
  executable?: string;
  /** Provider adapter output, such as user@host. Never a shell fragment. */
  target: string;
  /** Provider-native OpenSSH options, for example a ProxyCommand for GCP IAP. */
  extraArgs?: readonly string[];
  /** Typed destination port for nested provider tunnels such as Azure Bastion. */
  port?: number;
  /** Stable remote identity when the network endpoint is a loopback provider tunnel. */
  hostKeyAlias?: string;
  /** Explicit private key selected by the provider connection profile. */
  identityFile?: string;
  /** Controller-owned, pre-enrolled trust store. Omission retains the user's OpenSSH policy. */
  knownHostsFile?: string;
  /** Short-lived OpenSSH certificate paired with identityFile. */
  certificateFile?: string;
  controlPath: string;
  localPort: number;
  remoteOperatorPort?: number;
  connectTimeoutSeconds?: number;
  serverAliveIntervalSeconds?: number;
  serverAliveCountMax?: number;
}

export interface OpenSshCommand {
  command: string;
  args: readonly string[];
}

export interface OpenSshPtySessionSpec {
  executable?: string;
  /** Must match the destination used to create the ControlMaster. */
  target: string;
  /** Existing multiplex socket created by buildOpenSshControlMasterCommand. */
  controlPath: string;
  /** Exact remote argv. It is encoded once for OpenSSH's remote POSIX shell. */
  remoteArgv: readonly string[];
}

function requirePort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer from 1 through 65535`);
  }
  return value;
}

function requireArg(value: string, label: string): string {
  if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${label} must be a non-empty single OpenSSH argument`);
  }
  return value;
}

/** Encode one argv cell for the POSIX shell OpenSSH uses for a remote command. */
export function quotePosixShellArg(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error('Remote command arguments must be strings without NUL bytes');
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function openSshOptionName(value: string, label: string): string {
  const option = requireArg(value, label).trim();
  const match = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=|\s)\s*\S/.exec(option);
  if (!match) throw new Error(`${label} must contain an OpenSSH keyword and value`);
  return match[1]!.toLowerCase();
}

/**
 * Provider adapters may add routing options such as ProxyCommand/ProxyJump,
 * but they may not replace the manager's forwarding, process-lifecycle, auth,
 * or host-identity policy. Bare operands are rejected so an injected second
 * destination cannot displace the validated target.
 */
function validateOpenSshExtraArgs(values: readonly string[]): string[] {
  const args = values.map((value, index) => requireArg(value, `extraArgs[${index}]`));
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '-o') {
      const option = args[index + 1];
      if (!option) throw new Error('extraArgs -o requires an OpenSSH keyword and value');
      const optionName = openSshOptionName(option, `extraArgs[${index + 1}]`);
      if (MANAGER_OWNED_OPENSSH_OPTIONS.has(optionName)) {
        throw new Error(`extraArgs may not override manager-owned OpenSSH option '${optionName}'`);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-o') && arg.length > 2) {
      const optionName = openSshOptionName(arg.slice(2), `extraArgs[${index}]`);
      if (MANAGER_OWNED_OPENSSH_OPTIONS.has(optionName)) {
        throw new Error(`extraArgs may not override manager-owned OpenSSH option '${optionName}'`);
      }
      continue;
    }
    const ownedFlag = MANAGER_OWNED_OPENSSH_FLAGS.find((flag) => arg === flag || arg.startsWith(flag));
    if (ownedFlag) throw new Error(`extraArgs may not override manager-owned OpenSSH flag '${ownedFlag}'`);
    if (!arg.startsWith('-')) {
      throw new Error('extraArgs may not contain a bare OpenSSH destination or command operand');
    }
  }
  return args;
}

/**
 * Build argv for a foreground OpenSSH master. Host-key and authentication
 * policy deliberately remain in the user's/system's OpenSSH configuration;
 * this layer never injects accept-new, an alternate known_hosts file, or a key.
 */
export function buildOpenSshControlMasterCommand(spec: OpenSshControlMasterSpec): OpenSshCommand {
  const target = requireArg(spec.target, 'OpenSSH target');
  if (target.startsWith('-') || /\s/.test(target)) {
    throw new Error('OpenSSH target must be one host argument and may not begin with a dash');
  }
  const controlPath = requireArg(spec.controlPath, 'OpenSSH ControlPath');
  if (Buffer.byteLength(controlPath) > MAX_OPENSSH_CONTROL_PATH_BYTES) {
    throw new Error(`OpenSSH ControlPath must be at most ${MAX_OPENSSH_CONTROL_PATH_BYTES} bytes`);
  }
  const localPort = requirePort(spec.localPort, 'local tunnel port');
  const remotePort = requirePort(spec.remoteOperatorPort ?? DEFAULT_REMOTE_OPERATOR_PORT, 'remote operator port');
  const connectTimeout = requirePort(spec.connectTimeoutSeconds ?? 10, 'ConnectTimeout seconds');
  const aliveInterval = requirePort(spec.serverAliveIntervalSeconds ?? 15, 'ServerAliveInterval seconds');
  const aliveCount = requirePort(spec.serverAliveCountMax ?? 3, 'ServerAliveCountMax');
  const extraArgs = validateOpenSshExtraArgs(spec.extraArgs ?? []);
  const portArgs = spec.port === undefined ? [] : ['-p', String(requirePort(spec.port, 'OpenSSH port'))];
  const hostKeyAlias =
    spec.hostKeyAlias === undefined ? undefined : requireArg(spec.hostKeyAlias, 'OpenSSH HostKeyAlias');
  if (hostKeyAlias !== undefined && (hostKeyAlias.startsWith('-') || /\s/.test(hostKeyAlias))) {
    throw new Error('OpenSSH HostKeyAlias must be one token and may not begin with a dash');
  }
  const identityFile =
    spec.identityFile === undefined ? undefined : requireArg(spec.identityFile, 'OpenSSH identity file');
  const certificateFile =
    spec.certificateFile === undefined ? undefined : requireArg(spec.certificateFile, 'OpenSSH certificate file');
  if (certificateFile && !identityFile) {
    throw new Error('OpenSSH certificate file requires an explicit identity file');
  }
  const identityArgs = identityFile
    ? [
        '-o',
        'IdentitiesOnly=yes',
        '-i',
        identityFile,
        ...(certificateFile ? ['-o', `CertificateFile=${certificateFile}`] : []),
      ]
    : [];
  const hostKeyArgs = hostKeyAlias ? ['-o', `HostKeyAlias=${hostKeyAlias}`] : [];
  const knownHostsFile = spec.knownHostsFile === undefined
    ? undefined : requireArg(spec.knownHostsFile, 'OpenSSH known_hosts file');
  if (knownHostsFile !== undefined && (!isAbsolute(knownHostsFile) || /[%$]/.test(knownHostsFile))) {
    throw new Error('OpenSSH known_hosts file must be absolute and contain no OpenSSH expansions');
  }
  // OpenSSH parses -o values again; quote a path with spaces as one file. A pinned
  // controller connection trusts only this store and cannot add keys on its own.
  const trustStoreArgs = knownHostsFile === undefined ? [] : [
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile="${knownHostsFile.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
    '-o', 'GlobalKnownHostsFile=none',
    '-o', 'UpdateHostKeys=no',
  ];

  return {
    command: requireArg(spec.executable ?? 'ssh', 'OpenSSH executable'),
    args: [
      '-M',
      '-N',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ControlMaster=yes',
      '-o',
      // The manager owns this foreground master. ControlPersist forks a detached
      // child, making isRunning()/stop() observe and kill the wrong process.
      'ControlPersist=no',
      '-o',
      'ForkAfterAuthentication=no',
      '-o',
      `ControlPath=${controlPath}`,
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      `ConnectTimeout=${connectTimeout}`,
      '-o',
      `ServerAliveInterval=${aliveInterval}`,
      '-o',
      `ServerAliveCountMax=${aliveCount}`,
      ...portArgs,
      ...hostKeyArgs,
      ...trustStoreArgs,
      ...identityArgs,
      '-L',
      `${LOOPBACK_HOST}:${localPort}:${LOOPBACK_HOST}:${remotePort}`,
      ...extraArgs,
      target,
    ],
  };
}

/**
 * Build a PTY-backed remote command that reuses an established multiplex
 * socket. Quoting happens here, once, because OpenSSH joins trailing command
 * operands and asks the remote login shell to parse them.
 */
export function buildOpenSshPtySessionCommand(spec: OpenSshPtySessionSpec): OpenSshCommand {
  const target = requireArg(spec.target, 'OpenSSH target');
  if (target.startsWith('-') || /\s/.test(target)) {
    throw new Error('OpenSSH target must be one host argument and may not begin with a dash');
  }
  const controlPath = requireArg(spec.controlPath, 'OpenSSH ControlPath');
  if (Buffer.byteLength(controlPath) > MAX_OPENSSH_CONTROL_PATH_BYTES) {
    throw new Error(`OpenSSH ControlPath must be at most ${MAX_OPENSSH_CONTROL_PATH_BYTES} bytes`);
  }
  if (!Array.isArray(spec.remoteArgv) || spec.remoteArgv.length === 0) {
    throw new Error('Remote command argv must contain at least one argument');
  }
  const remoteCommand = spec.remoteArgv.map(quotePosixShellArg).join(' ');

  return {
    command: requireArg(spec.executable ?? 'ssh', 'OpenSSH executable'),
    args: ['-tt', '-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-S', controlPath, '--', target, remoteCommand],
  };
}

export interface OpenSshTunnelExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OpenSshTunnelHandle {
  readonly exited: Promise<OpenSshTunnelExit>;
  isRunning(): boolean;
  stop(): Promise<void>;
}

export interface OpenSshTunnelRunner {
  start(spec: OpenSshControlMasterSpec): Promise<OpenSshTunnelHandle>;
}

export type OpenSshSpawn = (
  command: string,
  args: readonly string[],
  options: { stdio: 'ignore'; shell: false },
) => ChildProcess;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

/** Real process adapter; lifecycle policy remains in LocalWorkspaceHostConnectionManager. */
export class NodeOpenSshTunnelRunner implements OpenSshTunnelRunner {
  private readonly spawn: OpenSshSpawn;

  constructor(spawn: OpenSshSpawn = nodeSpawn) {
    this.spawn = spawn;
  }

  async start(spec: OpenSshControlMasterSpec): Promise<OpenSshTunnelHandle> {
    const command = buildOpenSshControlMasterCommand(spec);
    const child = this.spawn(command.command, command.args, { stdio: 'ignore', shell: false });
    let running = true;
    let resolveExit!: (exit: OpenSshTunnelExit) => void;
    const exited = new Promise<OpenSshTunnelExit>((resolve) => {
      resolveExit = resolve;
    });
    child.once('exit', (code, signal) => {
      running = false;
      resolveExit({ code, signal });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        running = false;
        reject(error);
      });
    });

    return {
      exited,
      isRunning: () => running,
      async stop() {
        if (!running) return;
        child.kill('SIGTERM');
        await Promise.race([exited, wait(2_000)]);
        if (running) child.kill('SIGKILL');
      },
    };
  }
}

export type LocalWorkspaceHostConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disconnected';

export interface PersistedLocalWorkspaceHostConnection {
  version: typeof LOCAL_WORKSPACE_HOST_CONNECTION_VERSION;
  connectionId: string;
  hostId: string;
  status: LocalWorkspaceHostConnectionStatus;
  profile: WorkspaceHostTransportProfile;
  localOrigin?: string;
  localPort?: number;
  remoteOperatorPort: number;
  controlPath: string;
  negotiatedProtocolVersion?: number;
  observedAt: string;
  lastError?: string;
}

export interface LocalWorkspaceHostConnectionStore {
  save(connection: PersistedLocalWorkspaceHostConnection): Promise<void>;
}

export interface WorkspaceHostUiTarget {
  connectionId: string;
  hostId: string;
  /** Always a loopback HTTP origin; remote provider origins are never handed to Tauri. */
  origin: string;
  protocolVersion: number;
}

export interface LocalWorkspaceHostConnectionInput {
  connectionId: string;
  hostId: string;
  profile: WorkspaceHostTransportProfile;
  clientProtocol: WorkspaceHostProtocolRange;
  tunnel: Omit<OpenSshControlMasterSpec, 'localPort'>;
}

export interface LocalWorkspaceHostConnectionManagerDeps {
  store: LocalWorkspaceHostConnectionStore;
  probeProtocol(origin: string): Promise<WorkspaceHostProtocolRange>;
  retargetUi(target: WorkspaceHostUiTarget): Promise<void>;
  tunnelRunner?: OpenSshTunnelRunner;
  reservePort?: () => Promise<LoopbackPortLease>;
  now?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
  schedule?: (milliseconds: number, task: () => void) => () => void;
  monitorIntervalMs?: number;
  reconnectDelayMs?: number;
  startupProbeAttempts?: number;
  startupProbeDelayMs?: number;
  portAttempts?: number;
}

interface ActiveConnection {
  input: LocalWorkspaceHostConnectionInput;
  tunnel: OpenSshTunnelHandle;
  record: PersistedLocalWorkspaceHostConnection;
}

function defaultSchedule(milliseconds: number, task: () => void): () => void {
  const timer = setTimeout(task, milliseconds);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireLoopbackOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== LOOPBACK_HOST ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Workspace-host UI target must be a bare http://${LOOPBACK_HOST} loopback origin`);
  }
  requirePort(Number(parsed.port), 'workspace-host UI port');
  return parsed.origin;
}

function validateConnectionInput(input: LocalWorkspaceHostConnectionInput): void {
  requireArg(input.connectionId, 'connectionId');
  requireArg(input.hostId, 'hostId');
  validateProtocolRange(input.clientProtocol, 'client protocol');
  if (!input.profile.features.tcpForward) {
    throw new Error(`Workspace-host transport '${input.profile.kind}' does not support TCP forwarding`);
  }
  if (!input.profile.endpoint) {
    throw new Error(`Workspace-host transport '${input.profile.kind}' has no endpoint`);
  }
  requirePort(input.tunnel.remoteOperatorPort ?? DEFAULT_REMOTE_OPERATOR_PORT, 'remote operator port');
}

/**
 * Owns one selected workspace-host connection. Provider adapters normalize
 * their profile into OpenSSH argv; this manager owns the local port, master,
 * loopback UI target, protocol handshake, monitoring, and reconnect policy.
 */
export class LocalWorkspaceHostConnectionManager {
  private readonly deps: LocalWorkspaceHostConnectionManagerDeps;
  private readonly runner: OpenSshTunnelRunner;
  private readonly allocatePort: () => Promise<LoopbackPortLease>;
  private readonly now: () => string;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly schedule: (milliseconds: number, task: () => void) => () => void;
  private readonly monitorIntervalMs: number;
  private readonly reconnectDelayMs: number;
  private readonly startupProbeAttempts: number;
  private readonly startupProbeDelayMs: number;
  private readonly portAttempts: number;
  private active: ActiveConnection | null = null;
  private selected: LocalWorkspaceHostConnectionInput | null = null;
  private cancelScheduled: (() => void) | null = null;
  private serial: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(deps: LocalWorkspaceHostConnectionManagerDeps) {
    this.deps = deps;
    this.runner = deps.tunnelRunner ?? new NodeOpenSshTunnelRunner();
    this.allocatePort = deps.reservePort ?? reserveLoopbackPort;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.delay = deps.delay ?? wait;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.monitorIntervalMs = deps.monitorIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
    this.reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.startupProbeAttempts = deps.startupProbeAttempts ?? DEFAULT_STARTUP_PROBE_ATTEMPTS;
    this.startupProbeDelayMs = deps.startupProbeDelayMs ?? DEFAULT_STARTUP_PROBE_DELAY_MS;
    this.portAttempts = deps.portAttempts ?? DEFAULT_PORT_ATTEMPTS;
    for (const [label, value] of [
      ['monitorIntervalMs', this.monitorIntervalMs],
      ['reconnectDelayMs', this.reconnectDelayMs],
      ['startupProbeAttempts', this.startupProbeAttempts],
      ['startupProbeDelayMs', this.startupProbeDelayMs],
      ['portAttempts', this.portAttempts],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
    }
  }

  connect(input: LocalWorkspaceHostConnectionInput): Promise<PersistedLocalWorkspaceHostConnection> {
    return this.enqueue(async () => {
      validateConnectionInput(input);
      this.stopped = false;
      this.selected = input;
      this.cancelMonitor();
      await this.stopActive();
      return this.establish('connecting');
    });
  }

  /** Probe the live forward and recreate it when the process or remote host disappeared. */
  reconcile(): Promise<PersistedLocalWorkspaceHostConnection> {
    return this.enqueue(async () => {
      if (!this.selected || this.stopped) throw new Error('No selected workspace-host connection to reconcile');
      this.cancelMonitor();
      if (this.active?.tunnel.isRunning()) {
        try {
          const remote = await this.deps.probeProtocol(this.active.record.localOrigin!);
          const protocol = negotiateWorkspaceHostProtocol(this.selected.clientProtocol, remote);
          const record = { ...this.active.record, negotiatedProtocolVersion: protocol, observedAt: this.now() };
          this.active.record = record;
          await this.deps.store.save(record);
          this.armMonitor(this.monitorIntervalMs);
          return record;
        } catch (error) {
          if (error instanceof IncompatibleWorkspaceHostProtocolError) {
            await this.failActive(error);
            throw error;
          }
        }
      }
      await this.persistStatus('reconnecting');
      await this.stopActive();
      await this.delay(this.reconnectDelayMs);
      return this.establish('reconnecting');
    });
  }

  disconnect(): Promise<PersistedLocalWorkspaceHostConnection | null> {
    return this.enqueue(async () => {
      this.stopped = true;
      this.cancelMonitor();
      const previous = this.active?.record ?? null;
      await this.stopActive();
      if (!this.selected || !previous) return previous;
      const record: PersistedLocalWorkspaceHostConnection = {
        ...previous,
        status: 'disconnected',
        observedAt: this.now(),
      };
      await this.deps.store.save(record);
      return record;
    });
  }

  snapshot(): PersistedLocalWorkspaceHostConnection | null {
    return this.active?.record ?? null;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async establish(
    initialStatus: Extract<LocalWorkspaceHostConnectionStatus, 'connecting' | 'reconnecting'>,
  ): Promise<PersistedLocalWorkspaceHostConnection> {
    const input = this.selected;
    if (!input) throw new Error('No selected workspace-host connection');
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.portAttempts; attempt += 1) {
      const lease = await this.allocatePort();
      let connecting: PersistedLocalWorkspaceHostConnection | null = null;
      let tunnel: OpenSshTunnelHandle | null = null;
      try {
        const remoteOperatorPort = input.tunnel.remoteOperatorPort ?? DEFAULT_REMOTE_OPERATOR_PORT;
        const localOrigin = requireLoopbackOrigin(`http://${LOOPBACK_HOST}:${lease.port}`);
        connecting = {
          version: LOCAL_WORKSPACE_HOST_CONNECTION_VERSION,
          connectionId: input.connectionId,
          hostId: input.hostId,
          status: initialStatus,
          profile: input.profile,
          localOrigin,
          localPort: lease.port,
          remoteOperatorPort,
          controlPath: input.tunnel.controlPath,
          observedAt: this.now(),
        };
        await this.deps.store.save(connecting);
        await lease.release();
        tunnel = await this.runner.start({ ...input.tunnel, localPort: lease.port });
        const remote = await this.probeStartup(localOrigin, tunnel);
        const protocol = negotiateWorkspaceHostProtocol(input.clientProtocol, remote);
        const connected: PersistedLocalWorkspaceHostConnection = {
          ...connecting,
          status: 'connected',
          negotiatedProtocolVersion: protocol,
          observedAt: this.now(),
        };
        await this.deps.store.save(connected);
        await this.deps.retargetUi({
          connectionId: input.connectionId,
          hostId: input.hostId,
          origin: localOrigin,
          protocolVersion: protocol,
        });
        this.active = { input, tunnel, record: connected };
        this.watchExit(tunnel);
        this.armMonitor(this.monitorIntervalMs);
        return connected;
      } catch (error) {
        lastError = error;
        await lease.release();
        await tunnel?.stop();
        if (this.active?.tunnel === tunnel) this.active = null;
        if (connecting) {
          const failed: PersistedLocalWorkspaceHostConnection = {
            ...connecting,
            status: 'failed',
            observedAt: this.now(),
            lastError: messageOf(error),
          };
          await this.deps.store.save(failed);
        }
        if (error instanceof IncompatibleWorkspaceHostProtocolError) throw error;
        if (attempt < this.portAttempts) await this.delay(this.reconnectDelayMs);
      }
    }
    this.armMonitor(this.reconnectDelayMs);
    throw lastError instanceof Error ? lastError : new Error(messageOf(lastError));
  }

  private async probeStartup(origin: string, tunnel: OpenSshTunnelHandle): Promise<WorkspaceHostProtocolRange> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.startupProbeAttempts; attempt += 1) {
      if (!tunnel.isRunning()) throw new Error('OpenSSH ControlMaster exited before the remote operator became ready');
      try {
        return await this.deps.probeProtocol(origin);
      } catch (error) {
        lastError = error;
        if (attempt < this.startupProbeAttempts) await this.delay(this.startupProbeDelayMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(messageOf(lastError));
  }

  private async persistStatus(status: LocalWorkspaceHostConnectionStatus): Promise<void> {
    if (!this.active) return;
    const record = { ...this.active.record, status, observedAt: this.now() };
    this.active.record = record;
    await this.deps.store.save(record);
  }

  private async failActive(error: unknown): Promise<void> {
    if (!this.active) return;
    const failed: PersistedLocalWorkspaceHostConnection = {
      ...this.active.record,
      status: 'failed',
      observedAt: this.now(),
      lastError: messageOf(error),
    };
    await this.deps.store.save(failed);
    await this.stopActive();
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    this.active = null;
    await active?.tunnel.stop();
  }

  private watchExit(tunnel: OpenSshTunnelHandle): void {
    void tunnel.exited.then(() => {
      if (this.active?.tunnel !== tunnel || this.stopped) return;
      this.armMonitor(this.reconnectDelayMs);
    });
  }

  private armMonitor(delayMs: number): void {
    if (this.stopped || !this.selected) return;
    this.cancelMonitor();
    this.cancelScheduled = this.schedule(delayMs, () => {
      this.cancelScheduled = null;
      void this.reconcile().catch(() => {
        if (!this.stopped) this.armMonitor(this.reconnectDelayMs);
      });
    });
  }

  private cancelMonitor(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
  }
}
