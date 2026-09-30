import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS,
  WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS,
  WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION,
  WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS,
  assertWorkspaceHostSecretIsolation,
  encodeWorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostBootstrapReadinessOptions,
  type WorkspaceHostBootstrapReadinessResult,
  type WorkspaceHostBootstrapReportedStatus,
  type WorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostInitializationHostOperationResult,
  type WorkspaceHostInitializationHostOperations,
  type WorkspaceHostInitializationStep,
  type WorkspaceHostRemoteInitializerStep,
} from '@papercusp/deployment-driver';
import { quotePosixShellArg } from './local-connection-manager';
import { redactWorkspaceHostText } from './observability-store';

/**
 * Bound on the stderr tail carried into a non-zero-exit error message.
 *
 * The transport's stderr is the ONLY evidence of WHY a remote initialization failed
 * (exit 255 alone spans auth, tunnel, firewall, IAP permission and a missing remote
 * initializer). It is captured, redacted and truncated rather than discarded.
 */
const MAX_DIAGNOSTIC_TAIL_CHARS = 2000;

/**
 * Redacted, bounded, single-block stderr tail for an operator-facing failure message.
 *
 * Deliberately accepts `unknown`: a runner that omits stderr must degrade to the bare
 * exit-code message, never throw. A formatter that crashes here would replace the real
 * failure with its own — the exact evidence-destroying class this tail exists to fix.
 * NOTE: stdout is NEVER routed here. That channel carries the protocol response and may
 * hold secret-shaped evidence; only stderr, the diagnostic channel, is surfaced.
 */
export function formatGcpIapDiagnosticTail(stderr: unknown): string {
  if (typeof stderr !== 'string' || stderr.length === 0) return '';
  const redacted = redactWorkspaceHostText(stderr).trim();
  if (redacted.length === 0) return '';
  const tail =
    redacted.length > MAX_DIAGNOSTIC_TAIL_CHARS
      ? `…${redacted.slice(-MAX_DIAGNOSTIC_TAIL_CHARS)}`
      : redacted;
  return `; stderr: ${tail}`;
}

/**
 * DERIVED, not restated. The remote initializer that answers this protocol owns the constant
 * (`workspace-host-remote-initializer.ts`); re-declaring the literal here would let the two ends
 * of the same pipe drift apart with nothing failing until a real host rejected a real request.
 */
export const GCP_IAP_INITIALIZATION_PROTOCOL_VERSION = WORKSPACE_HOST_REMOTE_INITIALIZER_PROTOCOL_VERSION;

const GCP_IAP_INITIALIZATION_TRANSPORT_HEADROOM_MS = 60_000;
export const DEFAULT_GCP_IAP_INITIALIZATION_TIMEOUT_MS =
  DEFAULT_WORKSPACE_HOST_AGENT_VERIFICATION_TIMEOUT_BUDGET_MS +
  GCP_IAP_INITIALIZATION_TRANSPORT_HEADROOM_MS;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const GCP_NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** GCE instance ids are unsigned 64-bit integers, serialized as decimal strings. */
const GCE_INSTANCE_ID = /^[0-9]{1,20}$/;
const SSH_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const EXECUTABLE = /^(?:\/[A-Za-z0-9._+-]+)+$|^[A-Za-z0-9._+-]+$/;

export interface GcpIapWorkspaceHostInitializationProfile {
  projectId: string;
  zone: string;
  instanceName: string;
  /**
   * GCE numeric instance id — the INCARNATION behind `instanceName`. GCP assigns a fresh id on
   * every insert, so a delete + re-insert under the same name (an upgrade, a repair) is a different
   * machine with different host keys. The trust pin is bound to this, not to the name (WI-10002493).
   */
  instanceId: string;
  sshUser: string;
  /** Absolute path to a controller-owned, pre-enrolled known_hosts file. */
  knownHostsFile: string;
  /** Optional explicit OS Login identity; authorization material is never serialized. */
  identityFile?: string;
  /** Fixed binary shipped in the signed workspace-host release. */
  remoteEntrypoint: string;
  sshExecutable?: string;
  gcloudExecutable?: string;
}

export interface GcpIapWorkspaceHostInitializationCommand {
  command: string;
  args: readonly string[];
  stdin: string;
}

export interface GcpIapWorkspaceHostInitializationProcessResult {
  exitCode: number;
  stdout: string;
  /**
   * Captured transport stderr, bounded by the runner's response limit. Redact before
   * surfacing; a non-zero exit is undiagnosable without it.
   */
  stderr: string;
}

export interface GcpIapWorkspaceHostInitializationCommandRunner {
  run(command: GcpIapWorkspaceHostInitializationCommand): Promise<GcpIapWorkspaceHostInitializationProcessResult>;
}

export interface NodeGcpIapWorkspaceHostInitializationRunnerOptions {
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface RemoteInitializationResponse {
  protocolVersion: typeof GCP_IAP_INITIALIZATION_PROTOCOL_VERSION;
  stepId: string;
  status: 'succeeded';
  observedAt: string;
  publicEvidence?: Readonly<Record<string, unknown>>;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function requireGcpName(value: string, label: string): string {
  requireCondition(typeof value === 'string' && GCP_NAME.test(value), `${label} has an invalid value`);
  return value;
}

function requireExecutable(value: string, label: string, absolute = false): string {
  requireCondition(
    typeof value === 'string' && EXECUTABLE.test(value) && (!absolute || value.startsWith('/')),
    `${label} must be ${absolute ? 'an absolute ' : 'a '}single executable path`,
  );
  return value;
}

function requireAbsolutePath(value: string, label: string): string {
  requireCondition(
    typeof value === 'string' && value.startsWith('/') && !/[\0\r\n\s]/.test(value),
    `${label} must be an absolute path without whitespace`,
  );
  return value;
}

function positiveInteger(value: number, label: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
  return value;
}

/**
 * The alias shared by every incarnation of one instance NAME. Never a pin by itself: it is the
 * prefix that lets enrollment recognise, and prune, pins left behind by an earlier incarnation.
 */
export function gcpIapHostKeyAliasFamily(
  profile: Pick<GcpIapWorkspaceHostInitializationProfile, 'projectId' | 'zone' | 'instanceName'>,
): string {
  return `gcp-iap-${createHash('sha256')
    .update(`${profile.projectId}\0${profile.zone}\0${profile.instanceName}`)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * The one canonical alias derivation shared by command construction and trust enrollment.
 *
 * Bound to the INCARNATION (WI-10002493). A name-only alias made every controller-driven recreate
 * permanently unreachable: GCP upgrade deletes the VM and inserts a new one under the same name,
 * the new machine generates new host keys, and the name-keyed pin refused them on every later op.
 * Keying on the GCE instance id gives a recreated machine its own pin — enrolled from the same
 * authenticated guest-attribute source as the first — while a key change on the SAME incarnation
 * still refuses.
 */
export function gcpIapHostKeyAlias(
  profile: Pick<GcpIapWorkspaceHostInitializationProfile, 'projectId' | 'zone' | 'instanceName' | 'instanceId'>,
): string {
  requireCondition(
    typeof profile.instanceId === 'string' && GCE_INSTANCE_ID.test(profile.instanceId),
    'GCP instance id has an invalid value',
  );
  return `${gcpIapHostKeyAliasFamily(profile)}-${profile.instanceId}`;
}

export type GcpIapWorkspaceHostInitializationStep =
  | WorkspaceHostInitializationStep
  | WorkspaceHostCredentialLifecycleStep
  | WorkspaceHostRemoteInitializerStep;

function isWorkspaceHostCredentialLifecycleStep(
  step: GcpIapWorkspaceHostInitializationStep,
): step is WorkspaceHostCredentialLifecycleStep {
  return (WORKSPACE_HOST_CREDENTIAL_LIFECYCLE_STEP_KINDS as readonly string[]).includes(step.kind);
}

/** The transport half of a profile: everything except which program to run at the far end. */
export type GcpIapWorkspaceHostTransportProfile = Omit<
  GcpIapWorkspaceHostInitializationProfile,
  'remoteEntrypoint'
>;

/** One program to run on the host, with the bytes to feed its stdin. */
export interface GcpIapRemoteInvocation {
  /** Absolute path to a binary shipped in the signed workspace-host release. */
  readonly entrypoint: string;
  readonly entrypointLabel: string;
  /** argv AFTER the entrypoint. */
  readonly args: readonly string[];
  readonly stdin: string;
}

/**
 * Build one non-interactive OpenSSH invocation over GCP IAP.
 *
 * SHARED BY EVERY HOST PROGRAM ON PURPOSE — initialization and credential delivery both route
 * through here. The options below are security-critical (`IdentitiesOnly`, `StrictHostKeyChecking`,
 * the pinned `HostKeyAlias`, `ClearAllForwardings`), and a second builder that re-derived them
 * would be free to drift: both would keep connecting, one of them less safely, and nothing would
 * fail until it mattered. One definition means a hardening change reaches every caller at once.
 *
 * NOTE WHAT THIS FUNCTION DOES NOT DO: it asserts nothing about `stdin`. Secret-isolation is the
 * CALLER's obligation, because the two callers have opposite duties — initialization must never
 * carry material and asserts so, delivery carries it by definition (D-215). Asserting here would
 * have to be conditional, and a conditional assertion proves only that the condition was not met.
 */
export function buildGcpIapSshInvocation(
  profile: GcpIapWorkspaceHostTransportProfile,
  invocation: GcpIapRemoteInvocation,
): GcpIapWorkspaceHostInitializationCommand {
  requireCondition(GCP_PROJECT_ID.test(profile.projectId), 'GCP project id has an invalid value');
  const zone = requireGcpName(profile.zone, 'GCP zone');
  const instanceName = requireGcpName(profile.instanceName, 'GCP instance name');
  requireCondition(SSH_USER.test(profile.sshUser), 'OpenSSH user has an invalid value');
  const knownHostsFile = requireAbsolutePath(profile.knownHostsFile, 'OpenSSH known_hosts file');
  // Every other option in this builder is validated; `identityFile` was the one field
  // permitted to be absent, and that asymmetry is what broke the P-318 r38 canary on
  // 2026-09-22. PROVISION refuses to render a bootstrap without a controller identity
  // (provision-bootstrap.ts:128-136), because an empty authorized_keys combined with the
  // harden-os publickey-only lock bricks the host (D-238). The CONNECT side silently
  // dropped `-i` instead, so ssh fell back to whatever default key the operator process
  // happened to own — and because `IdentitiesOnly=yes` is set unconditionally below, that
  // fallback can never be the controller key the host authorized at provision time. Every
  // probe then failed `Permission denied (publickey)` (74/74 over 1199s on r38) and the
  // timeout surfaced as GcpIapWorkspaceHostBootstrapNotReadyError — naming the guest's
  // bootstrap when the guest was healthy and the controller was misconfigured. Refusing
  // here keeps both halves symmetric and names the exact knob to set.
  requireCondition(
    typeof profile.identityFile === 'string' && profile.identityFile.trim().length > 0,
    'OpenSSH identity file is required: the controller cannot authenticate to a host that ' +
      'authorized the controller public key at provision time. Set ' +
      'PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE to the controller keypair.',
  );
  const identityFile = requireAbsolutePath(profile.identityFile, 'OpenSSH identity file');
  const sshExecutable = requireExecutable(profile.sshExecutable ?? 'ssh', 'OpenSSH executable');
  const gcloudExecutable = requireExecutable(profile.gcloudExecutable ?? 'gcloud', 'gcloud executable');
  const remoteEntrypoint = requireExecutable(
    invocation.entrypoint,
    invocation.entrypointLabel,
    true,
  );

  const proxyCommand = [
    gcloudExecutable,
    'compute',
    'start-iap-tunnel',
    '%h',
    '%p',
    '--listen-on-stdin',
    `--project=${profile.projectId}`,
    `--zone=${zone}`,
    '--verbosity=error',
  ].join(' ');
  const target = `${profile.sshUser}@${instanceName}`;
  const remoteCommand = [remoteEntrypoint, ...invocation.args]
    .map(quotePosixShellArg)
    .join(' ');

  return {
    command: sshExecutable,
    args: [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHostsFile}`,
      '-o',
      `HostKeyAlias=${gcpIapHostKeyAlias(profile)}`,
      // IdentitiesOnly is UNCONDITIONAL, not paired with -i. Without it, OpenSSH offers every
      // key held by the ambient ssh-agent before any pinned identity. sshd's default
      // MaxAuthTries is 6, so on a host whose agent carries more keys than that the connection
      // is disconnected ("Too many authentication failures") BEFORE the correct credential is
      // ever presented — observed live on p046-canary-02 with 7 agent keys, surfacing only as
      // an opaque exit 255. Pinning this also keeps controller auth independent of whatever
      // happens to be loaded in the operator's agent.
      '-o',
      'IdentitiesOnly=yes',
      // Unconditional, and it pairs with the IdentitiesOnly above: the builder now refuses a
      // profile without an identityFile, so there is no longer a path that reaches here with
      // nothing to pin. A conditional `-i` is precisely what let a misconfigured controller
      // connect as the wrong principal instead of failing.
      '-i',
      identityFile,
      '-o',
      `ProxyCommand=${proxyCommand}`,
      '--',
      target,
      remoteCommand,
    ],
    stdin: invocation.stdin,
  };
}

/**
 * Build the initialization invocation. The remote side receives one typed request on stdin; no
 * shell script, scp staging, or resolved credential bytes cross THIS boundary — the assertions
 * below are what make that true, and they run on the step and on the encoded request separately
 * so a leak is attributed to whichever of the two introduced it.
 */
export function buildGcpIapWorkspaceHostInitializationCommand(
  profile: GcpIapWorkspaceHostInitializationProfile,
  step: GcpIapWorkspaceHostInitializationStep,
): GcpIapWorkspaceHostInitializationCommand {
  assertWorkspaceHostSecretIsolation(step, `workspaceHost.gcpIap.initialization.${step.id}`);

  const protocolRequest = {
    protocolVersion: GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
    step: isWorkspaceHostCredentialLifecycleStep(step) ? encodeWorkspaceHostCredentialLifecycleStep(step) : step,
  };
  assertWorkspaceHostSecretIsolation(protocolRequest, 'workspaceHost.gcpIap.initialization.request');

  return buildGcpIapSshInvocation(profile, {
    entrypoint: profile.remoteEntrypoint,
    entrypointLabel: 'Remote initializer',
    args: ['--protocol-version', GCP_IAP_INITIALIZATION_PROTOCOL_VERSION, '--json-stdin'],
    stdin: `${JSON.stringify(protocolRequest)}\n`,
  });
}

/**
 * POSIX `test`, used as the readiness probe. Absolute on purpose: `buildGcpIapSshInvocation`
 * requires an absolute entrypoint, and resolving `test` off the remote PATH would make the probe
 * depend on the login shell of a host we are probing precisely because it is half-configured.
 */
const POSIX_TEST_EXECUTABLE = '/bin/test';

/**
 * Defaults sized from the measured record rather than guessed (WI-10001677): conduit-missing
 * failures occurred at 117s and 304s, while every attempt at 901s or later found the conduit
 * present. 20 minutes therefore covers the observed spread with headroom, and is still far
 * below the point at which a stuck bootstrap should be reported instead of waited on.
 */
export const DEFAULT_GCP_IAP_BOOTSTRAP_READINESS_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_GCP_IAP_BOOTSTRAP_READINESS_POLL_INTERVAL_MS = 15_000;

/**
 * The remote command answered cleanly and said the conduit is absent — bootstrap is genuinely
 * still working. Distinct from a transport failure, where we never got to ask at all.
 */
const PROBE_EXIT_READY = 0;
const PROBE_EXIT_NOT_READY = 1;

/**
 * Build the bootstrap-readiness probe: does the remote initializer conduit exist and is it
 * executable?
 *
 * Deliberately NOT a no-op invocation of the conduit itself. The conduit speaks a JSON protocol,
 * so a "harmless" call would still be a real request whose failure modes overlap the ones we are
 * trying to tell apart; `test -x` cannot have side effects and answers exactly one question.
 */
export function buildGcpIapWorkspaceHostBootstrapReadinessProbe(
  profile: GcpIapWorkspaceHostInitializationProfile,
): GcpIapWorkspaceHostInitializationCommand {
  return buildGcpIapSshInvocation(profile, {
    entrypoint: POSIX_TEST_EXECUTABLE,
    entrypointLabel: 'POSIX test',
    args: ['-x', profile.remoteEntrypoint],
    stdin: '',
  });
}

/**
 * The readiness budget elapsed.
 *
 * `answered` is the load-bearing field, and the reason this is one error class rather than a
 * bare timeout: it separates "we asked repeatedly and the host kept saying the conduit is not
 * there yet" (a slow or stuck bootstrap) from "we never once got a clean answer" (a transport,
 * auth or IAP problem wearing a timeout's clothes). Waiting out the second for twenty minutes
 * and then blaming bootstrap would replace a loud misconfiguration with a slow lie.
 */
export class GcpIapWorkspaceHostBootstrapNotReadyError extends Error {
  readonly conduitPath: string;
  readonly probes: number;
  readonly waitedMs: number;
  readonly answered: boolean;
  readonly lastExitCode: number | undefined;

  constructor(input: {
    conduitPath: string;
    probes: number;
    waitedMs: number;
    answered: boolean;
    lastExitCode?: number;
    lastStderr?: string;
  }) {
    const seconds = Math.round(input.waitedMs / 1000);
    const diagnosis = input.answered
      ? `the host answered ${input.probes} probe(s) and reported the conduit still absent, so its bootstrap ` +
        'is unfinished or stuck (it installs the conduit only after fetching and verifying the release bundle)'
      : `NO probe ever completed cleanly (last exit code ${input.lastExitCode ?? 'unknown'}), so this is a ` +
        'transport, OS Login or IAP failure rather than a slow bootstrap — the conduit was never actually checked';
    super(
      `Workspace host bootstrap did not become ready within ${seconds}s: ${input.conduitPath} is not an ` +
        `executable on the host. ${diagnosis}.` +
        formatGcpIapDiagnosticTail(input.lastStderr),
    );
    this.name = 'GcpIapWorkspaceHostBootstrapNotReadyError';
    this.conduitPath = input.conduitPath;
    this.probes = input.probes;
    this.waitedMs = input.waitedMs;
    this.answered = input.answered;
    this.lastExitCode = input.lastExitCode;
  }
}

/**
 * Reads the bootstrap's own lifecycle report out of band (WI-10002837), or null when there is
 * none yet. It never goes through SSH: the workspace key is authorized only after `harden-os`
 * installs packages, so a host that dies there is unreachable by the probe that waits on it.
 */
export type GcpIapWorkspaceHostBootstrapStatusSource =
  () => Promise<WorkspaceHostBootstrapReportedStatus | null>;

/**
 * The bootstrap reported that it exited with a failure. The script is gone, so the conduit will
 * never appear: waiting out the rest of the readiness budget (up to twenty minutes) would only
 * delay a verdict that is already final (WI-10002837).
 */
export class GcpIapWorkspaceHostBootstrapFailedError extends Error {
  readonly exitCode: number;
  readonly phase: string | null;
  readonly reportedError: string | null;
  readonly probes: number;
  readonly waitedMs: number;

  constructor(input: {
    exitCode: number;
    phase: string | null;
    error: string | null;
    probes: number;
    waitedMs: number;
  }) {
    const where = input.phase ? `in phase ${input.phase}` : 'before its first phase';
    const why = input.error
      ? `: ${input.error}`
      : ' (stopped by set -e; the serial console has the full log)';
    super(
      `Workspace host bootstrap failed with exit code ${input.exitCode} ${where}${why}. ` +
        `Reported after ${Math.round(input.waitedMs / 1000)}s and ${input.probes} readiness probe(s).`,
    );
    this.name = 'GcpIapWorkspaceHostBootstrapFailedError';
    this.exitCode = input.exitCode;
    this.phase = input.phase;
    this.reportedError = input.error;
    this.probes = input.probes;
    this.waitedMs = input.waitedMs;
  }
}

/** Real process runner with bounded output and secret-safe failures. */
export class NodeGcpIapWorkspaceHostInitializationCommandRunner implements GcpIapWorkspaceHostInitializationCommandRunner {
  private readonly spawn: typeof nodeSpawn;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: NodeGcpIapWorkspaceHostInitializationRunnerOptions = {}) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_GCP_IAP_INITIALIZATION_TIMEOUT_MS,
      'Initialization timeout',
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'Initialization response limit',
    );
  }

  async run(
    command: GcpIapWorkspaceHostInitializationCommand,
  ): Promise<GcpIapWorkspaceHostInitializationProcessResult> {
    return await new Promise((resolve, reject) => {
      // ssh launches gcloud as its ProxyCommand. Own one POSIX process group so every
      // failure bound covers both processes rather than orphaning the proxy after ssh dies.
      const ownsProcessGroup = process.platform !== 'win32';
      const child = this.spawn(command.command, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: ownsProcessGroup,
      }) as ChildProcessWithoutNullStreams;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const killTransport = (): void => {
        if (ownsProcessGroup && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
            return;
          } catch {
            // The group may already have exited; retain the child-handle fallback.
          }
        }
        child.kill('SIGKILL');
      };

      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTransport();
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail(`GCP IAP initialization timed out after ${this.timeoutMs}ms`),
        this.timeoutMs,
      );
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > this.maxResponseBytes) {
          fail('GCP IAP initialization response exceeded the configured limit');
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > this.maxResponseBytes) {
          fail('GCP IAP initialization diagnostic output exceeded the configured limit');
          return;
        }
        stderr.push(chunk);
      });
      child.once('error', () => fail('Failed to start GCP IAP initialization transport'));
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: typeof code === 'number' ? code : 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      child.stdin.once('error', () => fail('Failed to write GCP IAP initialization request'));
      child.stdin.end(command.stdin, 'utf8');
    });
  }
}

function parseResponse(stdout: string, stepId: string): WorkspaceHostInitializationHostOperationResult {
  let candidate: unknown;
  try {
    candidate = JSON.parse(stdout);
  } catch {
    throw new Error('GCP IAP initializer returned invalid JSON');
  }
  requireCondition(
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
    'GCP IAP initializer returned an invalid response',
  );
  const response = candidate as Partial<RemoteInitializationResponse>;
  requireCondition(
    response.protocolVersion === GCP_IAP_INITIALIZATION_PROTOCOL_VERSION,
    'GCP IAP initializer returned an incompatible protocol version',
  );
  requireCondition(response.stepId === stepId, 'GCP IAP initializer returned a response for another step');
  requireCondition(response.status === 'succeeded', 'GCP IAP initializer did not report success');
  requireCondition(
    typeof response.observedAt === 'string' && Number.isFinite(Date.parse(response.observedAt)),
    'GCP IAP initializer returned an invalid observedAt timestamp',
  );
  requireCondition(
    response.publicEvidence === undefined ||
      (response.publicEvidence !== null &&
        typeof response.publicEvidence === 'object' &&
        !Array.isArray(response.publicEvidence)),
    'GCP IAP initializer returned invalid public evidence',
  );
  assertWorkspaceHostSecretIsolation(
    response.publicEvidence ?? {},
    `workspaceHost.gcpIap.initialization.receipt.${stepId}`,
  );
  return {
    observedAt: response.observedAt,
    ...(response.publicEvidence ? { publicEvidence: response.publicEvidence } : {}),
  };
}

/** Concrete capability-declaring adapter for the signed remote initializer. */
export class GcpIapWorkspaceHostInitializationOperations implements WorkspaceHostInitializationHostOperations {
  // The replay-safe initializer accepts only initialization/lifecycle kinds. Optional pack
  // management shares the wire but must not enter that executor's capability manifest.
  readonly supportedStepKinds = WORKSPACE_HOST_REMOTE_INITIALIZER_STEP_KINDS.filter(
    (kind) => kind !== 'install-desktop-pack',
  );

  private readonly profile: GcpIapWorkspaceHostInitializationProfile;
  private readonly runner: GcpIapWorkspaceHostInitializationCommandRunner;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bootstrapStatus: GcpIapWorkspaceHostBootstrapStatusSource | undefined;

  constructor(
    profile: GcpIapWorkspaceHostInitializationProfile,
    runner: GcpIapWorkspaceHostInitializationCommandRunner = new NodeGcpIapWorkspaceHostInitializationCommandRunner(),
    /**
     * Clock and delay seam. Injected rather than imported so the readiness gate's timeout and
     * backoff are testable without a twenty-minute test — a gate whose only proof is a live
     * provision is a gate nobody re-verifies.
     */
    timing: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
    /** The bootstrap's out-of-band report; omitted = wait on the conduit probe alone. */
    bootstrapStatus?: GcpIapWorkspaceHostBootstrapStatusSource,
  ) {
    this.profile = profile;
    this.runner = runner;
    this.bootstrapStatus = bootstrapStatus;
    this.now = timing.now ?? (() => Date.now());
    this.sleep =
      timing.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms).unref?.();
        }));
  }

  /**
   * Poll until the remote initializer conduit exists, or the budget elapses.
   *
   * Three outcomes, kept separate on purpose (WI-10001677):
   *  - probe exits 0        -> ready; return, recording whether any waiting was needed at all.
   *  - probe exits 1        -> the host ANSWERED and the conduit is absent: bootstrap is still
   *                            working. Keep waiting, and remember that we got a clean answer.
   *  - any other exit       -> we never reached the question (ssh exits 255 for auth, tunnel, IAP
   *                            and firewall failures alike). Keep polling, because the bootstrap
   *                            is what authorizes the controller's key and an early probe can
   *                            legitimately lose the race to it — but do NOT record it as an
   *                            answer, so a budget spent entirely on 255s is reported as the
   *                            transport failure it is instead of a slow bootstrap.
   */
  async awaitBootstrapReady(
    options: WorkspaceHostBootstrapReadinessOptions = {},
  ): Promise<WorkspaceHostBootstrapReadinessResult> {
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_GCP_IAP_BOOTSTRAP_READINESS_TIMEOUT_MS,
      'Bootstrap readiness timeout',
    );
    const pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_GCP_IAP_BOOTSTRAP_READINESS_POLL_INTERVAL_MS,
      'Bootstrap readiness poll interval',
    );
    const probe = buildGcpIapWorkspaceHostBootstrapReadinessProbe(this.profile);
    const startedAt = this.now();

    let probes = 0;
    let answered = false;
    let lastExitCode: number | undefined;
    let lastStderr: string | undefined;

    for (;;) {
      options.signal?.throwIfAborted();
      const result = await this.runner.run(probe);
      probes += 1;
      lastExitCode = result.exitCode;
      lastStderr = result.stderr;
      if (result.exitCode === PROBE_EXIT_READY) {
        return {
          waitedMs: this.now() - startedAt,
          probes,
          readyImmediately: probes === 1,
        };
      }
      if (result.exitCode === PROBE_EXIT_NOT_READY) answered = true;

      // Read only after a probe missed: a ready conduit is the authority and costs no extra call.
      // Only `failed` is final. `running`/`succeeded` keep the wait on the probe, because the
      // conduit, not the report, is what the next step actually needs.
      const reported = await this.readBootstrapStatus();
      if (reported?.state === 'failed') {
        throw new GcpIapWorkspaceHostBootstrapFailedError({
          exitCode: reported.exitCode,
          phase: reported.phase,
          error: reported.error,
          probes,
          waitedMs: this.now() - startedAt,
        });
      }

      const elapsedMs = this.now() - startedAt;
      // Checked AFTER a probe and BEFORE sleeping: a budget smaller than one interval must still
      // get one real observation, and we must never sleep past the deadline just to re-probe.
      if (elapsedMs + pollIntervalMs >= timeoutMs) {
        throw new GcpIapWorkspaceHostBootstrapNotReadyError({
          conduitPath: this.profile.remoteEntrypoint,
          probes,
          waitedMs: elapsedMs,
          answered,
          ...(lastExitCode !== undefined ? { lastExitCode } : {}),
          ...(lastStderr ? { lastStderr } : {}),
        });
      }
      await options.onWaiting?.({ elapsedMs, timeoutMs, probes });
      await this.sleep(pollIntervalMs);
    }
  }

  /**
   * An unreadable report reads as "no report". The report only shortens a wait on a script that
   * already exited; a transient Compute API error must never fail a bootstrap that is still
   * healthy, and without the report the gate is exactly what it was before WI-10002837.
   */
  private async readBootstrapStatus(): Promise<WorkspaceHostBootstrapReportedStatus | null> {
    if (!this.bootstrapStatus) return null;
    try {
      return await this.bootstrapStatus();
    } catch {
      return null;
    }
  }

  async execute(step: WorkspaceHostInitializationStep): Promise<WorkspaceHostInitializationHostOperationResult>;
  async execute(step: WorkspaceHostCredentialLifecycleStep): Promise<WorkspaceHostInitializationHostOperationResult>;
  async execute(step: WorkspaceHostRemoteInitializerStep): Promise<WorkspaceHostInitializationHostOperationResult>;
  async execute(step: GcpIapWorkspaceHostInitializationStep): Promise<WorkspaceHostInitializationHostOperationResult> {
    const command = buildGcpIapWorkspaceHostInitializationCommand(this.profile, step);
    const result = await this.runner.run(command);
    if (result.exitCode !== 0) {
      throw new Error(
        `GCP IAP initialization failed with exit code ${result.exitCode}` +
          formatGcpIapDiagnosticTail(result.stderr),
      );
    }
    return parseResponse(result.stdout, step.id);
  }
}
