/**
 * Server-side render of the workspace-host bootstrap at PROVISION time (P-046 / D-237, D-238).
 *
 * A provisioned host used to receive only the durable-filesystem mount. Nothing delivered the
 * bootstrap, so the instance came up with no privileged conduits, no `papercusp-workspace`
 * service and no reachable SSH account — and it did so SILENTLY, because provisioning itself
 * succeeded. The clean-room fixture was the bootstrap's only producer in the entire tree.
 *
 * This module is that missing producer, and three properties define it:
 *
 * 1. IT IS CONTROLLER-OWNED, NOT CALLER-SUPPLIED. The rendered script pins the release
 *    `bundleUrl`/`bundleSha256`/`signingPublicKey` AND the OpenSSH public key authorized for the
 *    workspace SSH account. Naming any of those chooses which code the host installs and who may
 *    log into it, so the provider REFUSES `desired.provider.startupScript` and reads the render
 *    off the provider context instead. Every input here comes from controller deployment
 *    configuration or the controller's own SSH identity; no per-host row can redirect one.
 *
 * 2. THE AUTHORIZED KEY IS THE CONTROLLER'S OWN PUBLIC KEY. The controller's initialization
 *    profile already names the private `identityFile` it will connect WITH; the host must
 *    authorize the matching public half or initialization cannot reach it. Deriving the key from
 *    that same profile — rather than accepting a second, independently configured value — is what
 *    makes "provisioned" and "reachable by the controller" the same fact instead of two settings
 *    that can disagree. D-238 is precisely what their disagreement costs.
 *
 * 3. IT FAILS CLOSED, LOUDLY, CONTROLLER-SIDE. A provision that cannot render a trusted bootstrap
 *    must refuse rather than create a host. The alternative is not "a host without a bootstrap" —
 *    it is a billing, unreachable brick whose provisioning operation reports success, which is
 *    the exact two-day failure this module exists to end. Every problem is collected and reported
 *    together so a half-configured controller names all of its gaps once.
 */
import { isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_WORKSPACE_HOST_AGENT_USER,
  WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION,
  WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
  buildWorkspaceHostBootstrap,
  validateWorkspaceHostImageArtifact,
  type WorkspaceHostAgentRuntimeInstall,
  type WorkspaceHostBootstrapRelease,
  type WorkspaceHostBootstrapService,
  type WorkspaceHostBootstrapStatusChannel,
  type WorkspaceHostImageArtifact,
} from '@papercusp/deployment-driver';
import { buildFrameworkInstallSpec } from '../endpoint-route/routes/desktop/setup-pty-commands';
import {
  resolveWorkspaceHostInitializationControllerProfile,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import { resolveOwnServiceUnit } from '../service-health';

/**
 * Controller deployment configuration. These mirror `CONTROLLER_ENV` in the initialization
 * resolver deliberately: same ownership story, same absolute-path discipline, same
 * collect-every-problem reporting.
 */
export const WORKSPACE_HOST_PROVISION_ENV = {
  /** Absolute path to the published `manifest.json` naming the release to install. */
  releaseManifestFile: 'PAPERCUSP_WORKSPACE_HOST_RELEASE_MANIFEST',
  /** Durable migration identity expected after the bundled migration command succeeds. */
  migrationId: 'PAPERCUSP_WORKSPACE_HOST_MIGRATION_ID',
  minimumNodeMajor: 'PAPERCUSP_WORKSPACE_HOST_MINIMUM_NODE_MAJOR',
  serviceName: 'PAPERCUSP_WORKSPACE_HOST_SERVICE_NAME',
  servicePort: 'PAPERCUSP_WORKSPACE_HOST_SERVICE_PORT',
  /**
   * D-403: bare HTTPS origin of the hosted control plane. When set, every host this controller
   * builds gets the desktop connector's enrollment conduit bound to it; unset renders none.
   */
  connectorOrigin: 'PAPERCUSP_WORKSPACE_HOST_CONNECTOR_ORIGIN',
} as const;

export const DEFAULT_WORKSPACE_HOST_SERVICE_NAME = 'papercusp-workspace';
export const DEFAULT_WORKSPACE_HOST_SERVICE_PORT = 3070;
export const DEFAULT_WORKSPACE_HOST_MINIMUM_NODE_MAJOR = 22;

/** Everything the render needs, with every value already validated. */
export interface WorkspaceHostProvisionBootstrapProfile {
  release: WorkspaceHostBootstrapRelease;
  migrationId: string;
  minimumNodeMajor: number;
  service: WorkspaceHostBootstrapService;
  /** Non-empty. The controller's own SSH public key(s). */
  workspaceAuthorizedKeys: readonly string[];
  /** D-403: present when the controller is configured to enroll desktop connectors. */
  hostedConnector?: { controlPlaneOrigin: string };
}

/** Raised when the controller cannot render a trusted bootstrap for a provision. */
export class WorkspaceHostProvisionBootstrapProfileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      'Workspace-host provision bootstrap cannot be rendered; provisioning would create an ' +
        `unreachable host: ${problems.join('; ')}`,
    );
    this.name = 'WorkspaceHostProvisionBootstrapProfileError';
    this.problems = problems;
  }
}

export interface ResolveWorkspaceHostProvisionBootstrapProfileInput {
  env?: Readonly<Record<string, string | undefined>>;
  /** Test seam; production reads the real filesystem. */
  readTextFile?: (path: string) => Promise<string>;
  /**
   * Test seam. Production derives it from the controller's initialization profile, so the key the
   * host authorizes is by construction the key the controller connects with.
   */
  controllerProfile?: WorkspaceHostInitializationControllerProfile;
  /** Test seam for identifying the process that resolves the release manifest. */
  resolveServiceUnit?: () => Promise<string | null>;
  /** Test seam for making the evaluator PID deterministic in diagnostics. */
  evaluatorPid?: number;
}

interface WorkspaceHostProvisionManifestResolutionContext {
  evaluator: string;
  remediation: string;
}

/**
 * The controller's OWN public key, read from `${identityFile}.pub`.
 *
 * The `.pub` sibling is OpenSSH's own convention and is what `ssh-keygen` writes, so this reads
 * the key the controller already has rather than introducing a second place to configure one.
 * A controller with no `identityFile` cannot authorize anything, and saying so here is better
 * than rendering a bootstrap whose authorized-keys file is empty — `harden-os` would then lock
 * the host to publickey-only for an account with no key, which is D-238 exactly.
 */
export async function resolveWorkspaceHostControllerAuthorizedKeys(
  profile: WorkspaceHostInitializationControllerProfile,
  readTextFile: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<{ keys: readonly string[]; problems: readonly string[] }> {
  const identityFile = profile.identityFile;
  if (!identityFile) {
    return {
      keys: [],
      problems: [
        'controller has no identityFile, so no public key can be authorized on the host ' +
          '(set PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE)',
      ],
    };
  }
  const publicKeyFile = `${identityFile}.pub`;
  let contents: string;
  try {
    contents = await readTextFile(publicKeyFile);
  } catch (error) {
    return {
      keys: [],
      problems: [`controller public key '${publicKeyFile}' could not be read: ${message(error)}`],
    };
  }
  const keys = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (keys.length === 0) {
    return { keys: [], problems: [`controller public key '${publicKeyFile}' is empty`] };
  }
  return { keys, problems: [] };
}

/**
 * Build the controller's provision profile, or throw naming every gap.
 *
 * The release is read from the published manifest and validated with
 * `validateWorkspaceHostImageArtifact` — the SAME validator that admits a release everywhere
 * else, so the provision surface cannot drift away from the surface that accepts one. That
 * validator already proves `signingKeySha256 === sha256(signingPublicKey)` and that the release
 * version matches the image, which is why this function does not restate those checks.
 */
export async function resolveWorkspaceHostProvisionBootstrapProfile(
  input: ResolveWorkspaceHostProvisionBootstrapProfileInput = {},
): Promise<WorkspaceHostProvisionBootstrapProfile> {
  const env = input.env ?? process.env;
  const readTextFile = input.readTextFile ?? ((path: string) => readFile(path, 'utf8'));
  const problems: string[] = [];
  const manifestResolutionContext = await resolveManifestResolutionContext(
    input.resolveServiceUnit ?? resolveOwnServiceUnit,
    input.evaluatorPid ?? process.pid,
  );

  const manifestPath = (env[WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile] ?? '').trim();
  let release: WorkspaceHostBootstrapRelease | undefined;
  if (!manifestPath) {
    problems.push(`${WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile} is not set`);
  } else if (!isAbsolute(manifestPath)) {
    // Same reasoning as the controller trust store: a relative path resolves against whatever
    // working directory the controller happened to start in, which makes the release a function
    // of how the process was launched.
    problems.push(
      `${WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile} must be an absolute path (got '${manifestPath}')`,
    );
  } else {
    release = await readRelease(manifestPath, readTextFile, problems, manifestResolutionContext);
  }

  const migrationId = (env[WORKSPACE_HOST_PROVISION_ENV.migrationId] ?? '').trim();
  if (!migrationId) problems.push(`${WORKSPACE_HOST_PROVISION_ENV.migrationId} is not set`);

  const minimumNodeMajor = readInteger(
    env[WORKSPACE_HOST_PROVISION_ENV.minimumNodeMajor],
    WORKSPACE_HOST_PROVISION_ENV.minimumNodeMajor,
    DEFAULT_WORKSPACE_HOST_MINIMUM_NODE_MAJOR,
    problems,
  );
  const servicePort = readInteger(
    env[WORKSPACE_HOST_PROVISION_ENV.servicePort],
    WORKSPACE_HOST_PROVISION_ENV.servicePort,
    DEFAULT_WORKSPACE_HOST_SERVICE_PORT,
    problems,
  );
  const serviceName =
    (env[WORKSPACE_HOST_PROVISION_ENV.serviceName] ?? '').trim() || DEFAULT_WORKSPACE_HOST_SERVICE_NAME;
  // Validated by the render itself (bare HTTPS origin); an invalid value fails the provision there.
  const connectorOrigin = (env[WORKSPACE_HOST_PROVISION_ENV.connectorOrigin] ?? '').trim();

  let controllerProfile = input.controllerProfile;
  if (!controllerProfile) {
    try {
      controllerProfile = resolveWorkspaceHostInitializationControllerProfile(env);
    } catch (error) {
      problems.push(`controller initialization profile is unusable: ${message(error)}`);
    }
  }
  let workspaceAuthorizedKeys: readonly string[] = [];
  if (controllerProfile) {
    const resolved = await resolveWorkspaceHostControllerAuthorizedKeys(controllerProfile, readTextFile);
    workspaceAuthorizedKeys = resolved.keys;
    problems.push(...resolved.problems);
  }

  if (problems.length > 0 || !release) {
    throw new WorkspaceHostProvisionBootstrapProfileError(
      problems.length > 0 ? problems : ['release could not be resolved'],
    );
  }

  return {
    release,
    migrationId,
    minimumNodeMajor,
    service: { name: serviceName, port: servicePort },
    workspaceAuthorizedKeys,
    ...(connectorOrigin ? { hostedConnector: { controlPlaneOrigin: connectorOrigin } } : {}),
  };
}

/**
 * Render the install bootstrap for one host.
 *
 * Separate from resolution so the expensive, IO-bound profile can be resolved once per operation
 * while the render stays a pure function of (hostId, profile) — which is also what makes the
 * rendered script reproducible for a given controller configuration.
 */
export function renderWorkspaceHostProvisionBootstrap(
  hostId: string,
  profile: WorkspaceHostProvisionBootstrapProfile,
  /** The provider's declared report channel (WI-10002837); omitted renders no report. */
  options: { statusChannel?: WorkspaceHostBootstrapStatusChannel } = {},
): string {
  return buildWorkspaceHostBootstrap({
    contractVersion: WORKSPACE_HOST_BOOTSTRAP_CONTRACT_VERSION,
    action: 'install',
    hostId,
    release: profile.release,
    migrationId: profile.migrationId,
    minimumNodeMajor: profile.minimumNodeMajor,
    service: profile.service,
    workspaceAuthorizedKeys: profile.workspaceAuthorizedKeys,
    agentRuntimeInstalls: workspaceHostAgentRuntimeInstalls(),
    ...(profile.hostedConnector ? { hostedConnector: profile.hostedConnector } : {}),
    ...(options.statusChannel ? { statusChannel: options.statusChannel } : {}),
  });
}

/** Where the bootstrap creates the agent identity's home (`/home/<agentUser>`). */
const WORKSPACE_HOST_AGENT_HOME = `/home/${DEFAULT_WORKSPACE_HOST_AGENT_USER}`;

/**
 * The vendor agent runtimes to install on a provisioned host (D-259).
 *
 * Evaluated HERE, at render time, from the ONE existing spec table the desktop onboarding uses —
 * deliberately not re-derived, and deliberately not fetched over HTTP from
 * `/api/desktop/setup-pty-commands`. That endpoint only maps this same pure builder, and the
 * operator it is served by is not running during `install-runtime`, so a fetch could not succeed
 * at the point the bootstrap needs the answer.
 *
 * `cwd` and `env` from the spec are intentionally dropped: the Linux scripts address their targets
 * through `~` rather than relative paths, and the bootstrap runs each argv under an explicit
 * `HOME=$AGENT_HOME`, which is what makes them land in the agent identity's own home.
 */
function workspaceHostAgentRuntimeInstalls(): WorkspaceHostAgentRuntimeInstall[] {
  return (['claude', 'codex', 'omp'] as const).map((agent) => {
    const spec = buildFrameworkInstallSpec(agent, 'linux', WORKSPACE_HOST_AGENT_HOME);
    return { agent, command: spec.command, args: spec.args };
  });
}

async function readRelease(
  manifestPath: string,
  readTextFile: (path: string) => Promise<string>,
  problems: string[],
  manifestResolutionContext: WorkspaceHostProvisionManifestResolutionContext,
): Promise<WorkspaceHostBootstrapRelease | undefined> {
  let raw: string;
  try {
    raw = await readTextFile(manifestPath);
  } catch (error) {
    problems.push(`release manifest '${manifestPath}' could not be read: ${message(error)}`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(`release manifest '${manifestPath}' is not valid JSON: ${message(error)}`);
    return undefined;
  }
  const artifact = (parsed as { artifact?: unknown } | null)?.artifact;
  if (!artifact || typeof artifact !== 'object') {
    problems.push(`release manifest '${manifestPath}' has no 'artifact' object`);
    return undefined;
  }
  // The validator is fed UNTRUSTED file bytes here, unlike its in-process callers who hand it an
  // artifact they just built. It reaches into nested build-manifest structure, so a
  // partially-shaped document makes it throw rather than return errors. A throw escaping this
  // function would surface as a bare TypeError instead of the fail-closed, named refusal the rest
  // of this module promises — so an unparseable manifest is reported as what it is.
  let errors: readonly string[];
  try {
    errors = validateWorkspaceHostImageArtifact(artifact as WorkspaceHostImageArtifact);
  } catch (error) {
    problems.push(`release manifest '${manifestPath}' is not a valid image artifact: ${message(error)}`);
    return undefined;
  }
  if (errors.length > 0) {
    problems.push(`release manifest '${manifestPath}' is not a valid image artifact: ${errors.join('; ')}`);
    return undefined;
  }
  const validated = artifact as WorkspaceHostImageArtifact;
  const unsupported = agentHomeBundleSupportProblem(validated, manifestPath, manifestResolutionContext);
  if (unsupported) {
    problems.push(unsupported);
    return undefined;
  }
  return validated.release;
}

/**
 * Refuse a publication that cannot parse the agent-home material this controller will send
 * (WI-10001751).
 *
 * This is property 3 of this module — "fails closed, LOUDLY, controller-side" — applied one layer
 * out. The module already refuses to render a bootstrap it cannot trust, on the reasoning that the
 * alternative "is not 'a host without a bootstrap' — it is a billing, unreachable brick whose
 * provisioning operation reports success". A publication whose host program predates the agent-home
 * contract version the controller emits produces the SAME outcome by a different route: provision
 * succeeds, the instance boots, the bootstrap installs and runs, and only ~5.5 minutes later does
 * agent bind fail on a version mismatch — by which time a VM and a NAT are billing and cannot ever
 * become usable. Both halves of that pincer are closed here rather than only the first.
 *
 * Measured instance: publication r31 (2026-09-07T09:18Z, source 7d85b492) shipped a parser
 * accepting {v2, v1}; agent-home v3 landed at 16:10Z the SAME DAY (96b0d248). Only v3 is
 * admission-eligible (D-311) and only the v3 path strips the refresh token (WI-10001691), so the
 * controller cannot downgrade to meet the host — the sets simply do not intersect, and every
 * provision against that publication was doomed before it started.
 *
 * An ABSENT declaration is refused rather than waved through. "No declaration" and "supports
 * everything" are indistinguishable to a reader but opposite in consequence, and here the
 * permissive reading is known to be the wrong one: every publication cut before this field existed
 * predates v3 by construction. Refusing costs a re-cut; assuming costs a billing brick and a
 * multi-hour misdiagnosis pointed at the wrong artifact entirely.
 */
function agentHomeBundleSupportProblem(
  artifact: WorkspaceHostImageArtifact,
  manifestPath: string,
  manifestResolutionContext: WorkspaceHostProvisionManifestResolutionContext,
): string | undefined {
  // Fed untrusted file bytes, so the declared value is validated rather than trusted to be shaped.
  const declared = new Set<string>();
  for (const rule of artifact.compatibility ?? []) {
    const versions = rule.agentHomeBundleContractVersions;
    if (!Array.isArray(versions)) continue;
    for (const version of versions) {
      if (typeof version === 'string' && version.trim().length > 0) declared.add(version);
    }
  }
  if (declared.size === 0) {
    return (
      `release manifest '${manifestPath}' declares no compatibility[].agentHomeBundleContractVersions, ` +
      `so it cannot be shown to parse the '${WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION}' agent-home ` +
      `material this controller emits. A publication cut before that field existed also predates the ` +
      `contract version it would have to accept. Re-cut the publication from current source and ` +
      `republish, then repoint ${WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile}. ` +
      `${manifestResolutionContext.evaluator}. ${manifestResolutionContext.remediation}`
    );
  }
  if (!declared.has(WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION)) {
    return (
      `release manifest '${manifestPath}' supports agent-home bundle [${[...declared].sort().join(', ')}] ` +
      `but this controller emits '${WORKSPACE_HOST_AGENT_HOME_BUNDLE_VERSION}', the only ` +
      `admission-eligible version (D-311). A host bootstrapped from this publication would provision, ` +
      `boot and bootstrap successfully and then fail agent bind, leaving a billing host that can never ` +
      `be initialized. Re-cut the publication from current source and republish. ` +
      `${manifestResolutionContext.evaluator}. ${manifestResolutionContext.remediation}`
    );
  }
  return undefined;
}

async function resolveManifestResolutionContext(
  resolveServiceUnit: () => Promise<string | null>,
  evaluatorPid: number,
): Promise<WorkspaceHostProvisionManifestResolutionContext> {
  let serviceUnit: string | null = null;
  try {
    serviceUnit = await resolveServiceUnit();
  } catch {
    // Diagnostics must never turn a trusted-profile refusal into an unrelated resolver failure.
  }
  if (serviceUnit) {
    return {
      evaluator: `manifest was read by systemd unit '${serviceUnit}' (MainPID ${evaluatorPid}) after request forwarding`,
      remediation:
        `update ${WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile} in '~/.config/systemd/user/${serviceUnit}.d/53-workspace-host-identity.conf', then run 'systemctl --user daemon-reload' and 'systemctl --user restart ${serviceUnit}' (repointing the request-only endpoint's unit has no effect)`,
    };
  }
  return {
    evaluator: `manifest was read by process PID ${evaluatorPid}; no systemd .service unit could be resolved`,
    remediation:
      `if this request was forwarded, update ${WORKSPACE_HOST_PROVISION_ENV.releaseManifestFile} on the background controller that received it, not the request-only endpoint, then restart that controller`,
  };
}

function readInteger(
  raw: string | undefined,
  label: string,
  fallback: number,
  problems: string[],
): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    problems.push(`${label} must be a positive integer (got '${value}')`);
    return fallback;
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
