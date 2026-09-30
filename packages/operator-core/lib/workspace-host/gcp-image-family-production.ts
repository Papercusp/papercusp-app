/**
 * Production composition for the GCP workspace-host image release contract.
 *
 * The contract and its concrete adapter are deliberately dependency-injected so they can be
 * exercised in isolation.  This module is the small, typed seam used by release automation:
 * it binds the persisted connection's project and credential reference, removes forbidden
 * process-global key-file credentials from child commands, and then invokes the real seven-step
 * release executor.  A factory by itself is not a production call path; the exported execute
 * function is the call path consumed by the release CLI.
 */
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdtemp, readFile, realpath, rm, statfs, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import {
  WorkspaceHostRevokedCredentialGenerationError,
  assertWorkspaceHostSecretIsolation,
  describeWorkspaceHostCredentialBinding,
  parseWorkspaceHostCredentialReference,
  workspaceHostCredentialReferenceDigest,
  workspaceHostGetOnlyGitCredentialEnvironment,
  type AgentCredentialRef,
  type GitCredentialRef,
  type WorkspaceHostCredentialDelivery,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';

import {
  createGcpWorkspaceHostAcquireAuth,
  GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF,
  type GcpResolvedAuth,
} from '../cloud-workspaces/gcp-preflight';
import {
  executeGcpImageFamilyRelease,
  type GcpImageFamilyReleaseAdapter,
  type GcpImageFamilyReleaseExecutionOptions,
  type GcpImageFamilyReleaseRequest,
  type GcpImageFamilyReleaseResult,
} from './gcp-image-family';
import {
  createGcpImageFamilyReleaseAdapter,
  NodeGcpImageFamilyCommandRunner,
  type GcpImageFamilyCommand,
  type GcpImageFamilyCommandResult,
  type GcpImageFamilyCommandRunner,
  type GcpImageFamilyReleaseAdapterOptions,
} from './gcp-image-family-adapter';
import {
  assertWorkspaceHostAgentCredentialAdmissionEvidence,
  verifyWorkspaceHostAgentCredentialAdmission,
  type WorkspaceHostAgentCredentialAdmissionEvidence,
  type WorkspaceHostAgentCredentialAdmissionInput,
} from './agent-credential-admission';
import {
  createOperatorWorkspaceHostCredentialMaterialSource,
  type WorkspaceHostCredentialMaterialSource,
} from './credential-material-source';

const GCP_TARGET = 'gcp';
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SAFE_CREDENTIAL_REF = /^adc:\/\/[^\s]+$/;
const SAFE_EXECUTABLE = /^[A-Za-z0-9_./:+-]+$/;

/**
 * The ONE definition of which credential references this composition seam will accept.
 *
 * Producers that build a connection (the image-release request CLI, for one) have to reject an
 * unusable reference at their own edge, or the release dies here — after the operator has already
 * paid for whatever came before the connection parse. They must not carry a second copy of the
 * rule: a divergent copy either refuses a reference this seam would have taken, or waves through
 * one it will not, and both read as a bug in the wrong file. Import this instead.
 */
export function isSupportedGcpImageFamilyCredentialRef(ref: string): boolean {
  const trimmed = ref.trim();
  return trimmed === GCP_GCLOUD_ACTIVE_USER_CREDENTIAL_REF || SAFE_CREDENTIAL_REF.test(trimmed);
}

/** Executable defaults owned by the image release protocol. */
export const GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES = {
  packer: 'packer',
  scanner: 'papercusp-image-scan',
  /** POST-build canary: boots the built candidate image and proves it self-attests. */
  cleanRoom: 'papercusp-gcp-clean-room',
  /**
   * PRE-build acceptance: boots stock Ubuntu and proves the signed bundle installs and
   * self-attests there. Its report is what the release gate ratifies BEFORE authorizing the
   * image build, which is why it cannot boot the candidate image.
   */
  bootstrapAcceptance: 'papercusp-gcp-bootstrap-acceptance',
} as const;

/**
 * Options accepted by the production composition.  Adapter seams remain injectable for tests,
 * while credential selection is owned by the persisted connection and cannot be overridden by a
 * second, accidentally divergent field.
 */
export interface GcpImageFamilyReleaseCompositionOptions extends Omit<
  GcpImageFamilyReleaseAdapterOptions,
  'credentialRef' | 'acquireAuth' | 'commandRunner' | 'commands' | 'packerRunner'
> {
  /** Optional test seam; production callers should use the connection's reference. */
  commandRunner?: GcpImageFamilyCommandRunner;
  /** Optional auth seam for deterministic tests; production auth is derived from credentialRef. */
  acquireAuth?: () => Promise<GcpResolvedAuth>;
}

export interface GcpImageFamilyReleaseComposition {
  projectId: string;
  credentialRef: string;
  adapter: GcpImageFamilyReleaseAdapter;
}

export interface GcpImageFamilyCredentialProbe {
  ok: boolean;
  projectId: string;
  credentialRef: string;
  identity?: string;
  resolvedProjectId?: string;
  error?: string;
}

export const GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION =
  'papercusp-gcp-image-family-exact-path-readiness-v1';

const SOURCE_REVISION = /^[0-9a-f]{40,64}$/i;
const DELIVERY_KINDS: readonly WorkspaceHostCredentialDelivery['kind'][] = [
  'provider-identity',
  'forwarded-agent',
  'short-lived-delegation',
  'encrypted-reference',
];
const AMBIENT_GIT_ENVIRONMENT =
  /^(?:GIT_ASKPASS|SSH_ASKPASS|GCM_INTERACTIVE|GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\d+|VALUE_\d+))$/;

export interface GcpImageFamilyReadinessBinding<Reference extends GitCredentialRef | AgentCredentialRef> {
  readonly credentialRef: Reference;
  readonly delivery: WorkspaceHostCredentialDelivery;
  /** Public high-water mark from the credential lifecycle record used to compose this request. */
  readonly revokedThrough: number;
}

export interface GcpImageFamilySourceGitlink {
  readonly path: string;
  readonly revision: string;
}

/** Public, secret-free request data that pins every exact-path readiness observation. */
export interface GcpImageFamilyExactPathReadinessConfig {
  readonly contractVersion: typeof GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION;
  readonly requestedAt: string;
  readonly expected: {
    readonly username: string;
    readonly cwd: string;
  };
  readonly source: {
    readonly repository: string;
    readonly revision: string;
    readonly gitlinks: readonly GcpImageFamilySourceGitlink[];
  };
  readonly credentials: {
    readonly git: GcpImageFamilyReadinessBinding<GitCredentialRef>;
    readonly agent: GcpImageFamilyReadinessBinding<AgentCredentialRef>;
  };
  readonly storage: {
    readonly minimumFreeBytes: number;
    readonly minimumFreeInodes: number;
    readonly retainedPaths: readonly string[];
  };
}

export type GcpImageFamilyExactPathReadinessFailureCode =
  | 'invalid-config'
  | 'revoked-credential'
  | 'expired-credential'
  | 'wrong-repository'
  | 'wrong-identity'
  | 'wrong-cwd'
  | 'insufficient-storage'
  | 'missing-retained-state'
  | 'ambient-git-helper'
  | 'source-revision-mismatch'
  | 'source-origin-mismatch'
  | 'gitlink-mismatch'
  | 'credential-unavailable'
  | 'git-helper-write'
  | 'git-authentication-failed'
  | 'agent-authentication-failed';

export class GcpImageFamilyExactPathReadinessError extends Error {
  constructor(
    readonly code: GcpImageFamilyExactPathReadinessFailureCode,
    detail: string,
  ) {
    super(`GCP image-family exact-path readiness '${code}' failed: ${detail}`);
    this.name = 'GcpImageFamilyExactPathReadinessError';
  }
}

export interface GcpImageFamilyExactPathRuntimeObservation {
  readonly username: string;
  readonly cwd: string;
  readonly freeBytes: number;
  readonly freeInodes: number;
  readonly missingRetainedPaths: readonly string[];
}

export interface GcpImageFamilyExactPathReadinessEvidence {
  readonly contractVersion: typeof GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION;
  readonly ok: true;
  readonly observedAt: string;
  readonly identity: { readonly username: string; readonly cwd: string };
  readonly storage: {
    readonly freeBytes: number;
    readonly freeInodes: number;
    readonly retainedPathCount: number;
  };
  readonly source: {
    readonly repositoryDigest: string;
    readonly revision: string;
    readonly gitlinkCount: number;
    readonly gitlinksDigest: string;
  };
  readonly bindings: {
    readonly git: {
      readonly family: string;
      readonly generation: number;
      readonly referenceDigest: string;
      readonly revokedThrough: number;
      readonly repositoryScope: 'exact';
      readonly materialImmutable: true;
      readonly remoteReachable: true;
    };
    readonly agent: {
      readonly family: string;
      readonly generation: number;
      readonly referenceDigest: string;
      readonly revokedThrough: number;
      readonly authenticated: true;
    };
  };
}

export interface GcpImageFamilyExactPathReadinessDependencies {
  readonly commandRunner?: GcpImageFamilyCommandRunner;
  readonly materialSource?: WorkspaceHostCredentialMaterialSource;
  readonly verifyAgentCredentialAdmission?: (
    input: WorkspaceHostAgentCredentialAdmissionInput,
  ) => Promise<WorkspaceHostAgentCredentialAdmissionEvidence>;
  readonly inspectRuntime?: (
    config: GcpImageFamilyExactPathReadinessConfig,
  ) => Promise<GcpImageFamilyExactPathRuntimeObservation>;
  readonly now?: () => Date;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly temporaryParent?: string;
}

export interface GcpImageFamilyExactPathReadinessCapture {
  readonly username: string;
  readonly cwd: string;
  readonly source: { readonly repository: string; readonly revision: string };
  readonly requestedAt?: string;
}

function readinessFailure(code: GcpImageFamilyExactPathReadinessFailureCode, detail: string): never {
  throw new GcpImageFamilyExactPathReadinessError(code, detail);
}

function readinessRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    readinessFailure('invalid-config', `${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function readinessString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    readinessFailure('invalid-config', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function readinessCount(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    readinessFailure('invalid-config', `${label} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function readinessPath(value: unknown, label: string): string {
  const path = readinessString(value, label);
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    readinessFailure('invalid-config', `${label} must be a normalized repository-relative POSIX path`);
  }
  return path;
}

function parseReadinessBinding<Channel extends 'git' | 'agent'>(
  value: unknown,
  channel: Channel,
): GcpImageFamilyReadinessBinding<Channel extends 'git' ? GitCredentialRef : AgentCredentialRef> {
  const body = readinessRecord(value, `credentials.${channel}`);
  const refBody = readinessRecord(body.credentialRef, `credentials.${channel}.credentialRef`);
  if (refBody.kind !== channel) {
    readinessFailure('invalid-config', `credentials.${channel}.credentialRef.kind must be '${channel}'`);
  }
  const deliveryBody = readinessRecord(body.delivery, `credentials.${channel}.delivery`);
  if (typeof deliveryBody.kind !== 'string' || !DELIVERY_KINDS.some((kind) => kind === deliveryBody.kind)) {
    readinessFailure('invalid-config', `credentials.${channel}.delivery.kind is unsupported`);
  }
  const expiresAt =
    deliveryBody.expiresAt === undefined
      ? undefined
      : readinessString(deliveryBody.expiresAt, `credentials.${channel}.delivery.expiresAt`);
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    readinessFailure('invalid-config', `credentials.${channel}.delivery.expiresAt must be an ISO timestamp`);
  }
  const binding = {
    credentialRef: {
      kind: channel,
      ref: readinessString(refBody.ref, `credentials.${channel}.credentialRef.ref`),
    },
    delivery: {
      kind: deliveryBody.kind as WorkspaceHostCredentialDelivery['kind'],
      generation: readinessCount(deliveryBody.generation, `credentials.${channel}.delivery.generation`, 1),
      audience: readinessString(deliveryBody.audience, `credentials.${channel}.delivery.audience`),
      revocationRef: readinessString(deliveryBody.revocationRef, `credentials.${channel}.delivery.revocationRef`),
      ...(expiresAt ? { expiresAt } : {}),
    },
    revokedThrough: readinessCount(body.revokedThrough, `credentials.${channel}.revokedThrough`),
  };
  return binding as unknown as GcpImageFamilyReadinessBinding<
    Channel extends 'git' ? GitCredentialRef : AgentCredentialRef
  >;
}

interface GithubRepositoryIdentity {
  readonly owner: string;
  readonly repository: string;
  readonly credentialPath: string;
}

function githubRepositoryIdentity(repositoryUrl: string): GithubRepositoryIdentity {
  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    readinessFailure('invalid-config', 'source.repository must be a valid URL');
  }
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.toLowerCase() !== 'github.com' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    segments.length !== 2
  ) {
    readinessFailure(
      'invalid-config',
      'source.repository must be a credential-free https://github.com/<owner>/<repository>[.git] URL',
    );
  }
  const owner = segments[0]!;
  const repository = segments[1]!.replace(/\.git$/i, '');
  if (!owner || !repository) readinessFailure('invalid-config', 'source.repository is incomplete');
  return {
    owner,
    repository,
    credentialPath: `${owner}/${repository}.git`,
  };
}

/** Parse an untrusted request envelope into the closed, public readiness contract. */
export function parseGcpImageFamilyExactPathReadinessConfig(value: unknown): GcpImageFamilyExactPathReadinessConfig {
  assertWorkspaceHostSecretIsolation(value, 'gcpImageFamily.exactPathReadiness');
  const body = readinessRecord(value, 'readiness');
  if (body.contractVersion !== GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION) {
    readinessFailure('invalid-config', 'readiness.contractVersion is unsupported');
  }
  const requestedAt = readinessString(body.requestedAt, 'readiness.requestedAt');
  if (!Number.isFinite(Date.parse(requestedAt))) {
    readinessFailure('invalid-config', 'readiness.requestedAt must be an ISO timestamp');
  }
  const expectedBody = readinessRecord(body.expected, 'readiness.expected');
  const username = readinessString(expectedBody.username, 'readiness.expected.username');
  const cwd = readinessString(expectedBody.cwd, 'readiness.expected.cwd');
  if (username === 'root') readinessFailure('wrong-identity', 'the expected release identity may not be root');
  if (!isAbsolute(cwd)) readinessFailure('invalid-config', 'readiness.expected.cwd must be absolute');

  const sourceBody = readinessRecord(body.source, 'readiness.source');
  const repository = readinessString(sourceBody.repository, 'readiness.source.repository');
  githubRepositoryIdentity(repository);
  const revision = readinessString(sourceBody.revision, 'readiness.source.revision').toLowerCase();
  if (!SOURCE_REVISION.test(revision)) {
    readinessFailure('invalid-config', 'readiness.source.revision must be a full Git object id');
  }
  if (!Array.isArray(sourceBody.gitlinks)) {
    readinessFailure('invalid-config', 'readiness.source.gitlinks must be an array');
  }
  const gitlinks = sourceBody.gitlinks.map((entry, index) => {
    const link = readinessRecord(entry, `readiness.source.gitlinks[${index}]`);
    const linkRevision = readinessString(link.revision, `readiness.source.gitlinks[${index}].revision`).toLowerCase();
    if (!SOURCE_REVISION.test(linkRevision)) {
      readinessFailure('invalid-config', `readiness.source.gitlinks[${index}].revision must be a full Git object id`);
    }
    return {
      path: readinessPath(link.path, `readiness.source.gitlinks[${index}].path`),
      revision: linkRevision,
    };
  });
  const uniqueGitlinks = new Set(gitlinks.map((entry) => entry.path));
  if (uniqueGitlinks.size !== gitlinks.length) {
    readinessFailure('invalid-config', 'readiness.source.gitlinks contains duplicate paths');
  }

  const credentialsBody = readinessRecord(body.credentials, 'readiness.credentials');
  const git = parseReadinessBinding(credentialsBody.git, 'git');
  const agent = parseReadinessBinding(credentialsBody.agent, 'agent');
  try {
    describeWorkspaceHostCredentialBinding({
      channel: 'git',
      credentialRef: git.credentialRef,
      delivery: git.delivery,
      requestedAt,
    });
    describeWorkspaceHostCredentialBinding({
      channel: 'agent',
      credentialRef: agent.credentialRef,
      delivery: agent.delivery,
      requestedAt,
    });
  } catch (error) {
    readinessFailure('invalid-config', error instanceof Error ? error.message : 'credential binding is invalid');
  }

  const storageBody = readinessRecord(body.storage, 'readiness.storage');
  if (!Array.isArray(storageBody.retainedPaths) || storageBody.retainedPaths.length === 0) {
    readinessFailure('invalid-config', 'readiness.storage.retainedPaths must be a non-empty array');
  }
  const retainedPaths = storageBody.retainedPaths.map((path, index) =>
    readinessPath(path, `readiness.storage.retainedPaths[${index}]`),
  );
  if (new Set(retainedPaths).size !== retainedPaths.length) {
    readinessFailure('invalid-config', 'readiness.storage.retainedPaths contains duplicates');
  }
  const config: GcpImageFamilyExactPathReadinessConfig = {
    contractVersion: GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION,
    requestedAt,
    expected: { username, cwd },
    source: { repository, revision, gitlinks },
    credentials: { git, agent },
    storage: {
      minimumFreeBytes: readinessCount(storageBody.minimumFreeBytes, 'readiness.storage.minimumFreeBytes', 1),
      minimumFreeInodes: readinessCount(storageBody.minimumFreeInodes, 'readiness.storage.minimumFreeInodes', 1),
      retainedPaths,
    },
  };
  assertWorkspaceHostSecretIsolation(config, 'gcpImageFamily.exactPathReadiness');
  return config;
}

/** Add producer-observed identity/cwd and manifest source pins to whitelisted public input. */
export function buildGcpImageFamilyExactPathReadinessConfig(
  value: unknown,
  capture: GcpImageFamilyExactPathReadinessCapture,
): GcpImageFamilyExactPathReadinessConfig {
  // Scan BEFORE whitelisting. Silently dropping an ignored secret-shaped field would keep it out
  // of the emitted request but conceal that an upstream producer tried to put material there.
  assertWorkspaceHostSecretIsolation(value, 'gcpImageFamily.exactPathReadiness.input');
  const body = readinessRecord(value, 'readiness input');
  return parseGcpImageFamilyExactPathReadinessConfig({
    contractVersion: GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION,
    requestedAt: capture.requestedAt ?? new Date().toISOString(),
    expected: { username: capture.username, cwd: capture.cwd },
    source: {
      repository: capture.source.repository,
      revision: capture.source.revision,
      gitlinks: body.sourceGitlinks ?? [],
    },
    credentials: body.credentials,
    storage: body.storage,
  });
}

async function inspectExactPathRuntime(
  config: GcpImageFamilyExactPathReadinessConfig,
): Promise<GcpImageFamilyExactPathRuntimeObservation> {
  const [cwd, filesystem] = await Promise.all([realpath(process.cwd()), statfs(config.expected.cwd)]);
  const missingRetainedPaths: string[] = [];
  for (const retainedPath of config.storage.retainedPaths) {
    try {
      await access(resolve(config.expected.cwd, retainedPath), fsConstants.F_OK);
    } catch {
      missingRetainedPaths.push(retainedPath);
    }
  }
  return {
    username: userInfo().username,
    cwd,
    freeBytes: filesystem.bavail * filesystem.bsize,
    freeInodes: filesystem.ffree,
    missingRetainedPaths,
  };
}

function canonicalGitlinks(entries: readonly GcpImageFamilySourceGitlink[]): readonly GcpImageFamilySourceGitlink[] {
  return [...entries].sort((left, right) => left.path.localeCompare(right.path));
}

function parseGitSubmoduleStatus(stdout: string): readonly GcpImageFamilySourceGitlink[] {
  const entries: GcpImageFamilySourceGitlink[] = [];
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line[0] !== ' ') {
      readinessFailure('gitlink-mismatch', 'a recursive submodule is absent, conflicted, or off its pinned revision');
    }
    const match = line.match(/^ ([0-9a-f]{40,64}) (.+?)(?: \(.+\))?$/i);
    if (!match) readinessFailure('gitlink-mismatch', 'recursive submodule status is malformed');
    entries.push({ path: readinessPath(match[2], 'recursive submodule path'), revision: match[1].toLowerCase() });
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    readinessFailure('gitlink-mismatch', 'recursive submodule status contains duplicate paths');
  }
  return canonicalGitlinks(entries);
}

function gitlinksEqual(
  left: readonly GcpImageFamilySourceGitlink[],
  right: readonly GcpImageFamilySourceGitlink[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry.path === right[index]?.path && entry.revision === right[index]?.revision)
  );
}

function publicDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function safeGitEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return {
    ...environment,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GCM_INTERACTIVE: 'never',
  };
}

async function requireGitCommand(
  runner: GcpImageFamilyCommandRunner,
  input: GcpImageFamilyCommand,
  code: GcpImageFamilyExactPathReadinessFailureCode,
  detail: string,
): Promise<string> {
  const result = await runner.run(input);
  if (result.exitCode !== 0) readinessFailure(code, detail);
  return result.stdout;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function liveBinding(config: GcpImageFamilyExactPathReadinessConfig, channel: 'git' | 'agent', now: Date) {
  const binding = config.credentials[channel];
  const descriptor = describeWorkspaceHostCredentialBinding({
    channel,
    credentialRef: binding.credentialRef,
    delivery: binding.delivery,
    requestedAt: config.requestedAt,
  });
  if (descriptor.generation <= binding.revokedThrough) {
    readinessFailure(
      'revoked-credential',
      `${channel} generation ${descriptor.generation} is at or below its revocation high-water mark`,
    );
  }
  if (descriptor.expiresAt && Date.parse(descriptor.expiresAt) <= now.getTime()) {
    readinessFailure('expired-credential', `${channel} generation ${descriptor.generation} has expired`);
  }
  return descriptor;
}

/**
 * Run every exact-path check before the release executor can invoke Packer or a provider API.
 * Every command here is read-only except Git's approve/reject protocol calls, which are confined
 * to a get-only helper and followed by byte-for-byte immutability checks.
 */
export async function verifyGcpImageFamilyExactPathReadiness(
  input: unknown,
  dependencies: GcpImageFamilyExactPathReadinessDependencies = {},
): Promise<GcpImageFamilyExactPathReadinessEvidence> {
  const config = parseGcpImageFamilyExactPathReadinessConfig(input);
  const now = dependencies.now ?? (() => new Date());
  const observedAt = now();
  const gitBinding = liveBinding(config, 'git', observedAt);
  const agentBinding = liveBinding(config, 'agent', observedAt);
  const gitRepository = githubRepositoryIdentity(config.source.repository);
  if (
    gitBinding.reference.fields.forge?.toLowerCase() !== 'github' ||
    gitBinding.reference.fields.owner?.toLowerCase() !== gitRepository.owner.toLowerCase() ||
    gitBinding.reference.fields.repository?.replace(/\.git$/i, '').toLowerCase() !==
      gitRepository.repository.toLowerCase()
  ) {
    readinessFailure('wrong-repository', 'the selected Git reference is not scoped to the manifest repository');
  }

  const inspectRuntime = dependencies.inspectRuntime ?? inspectExactPathRuntime;
  const runtime = await inspectRuntime(config);
  if (runtime.username === 'root' || runtime.username !== config.expected.username) {
    readinessFailure(
      'wrong-identity',
      'the actual release identity is root or differs from the producer-captured identity',
    );
  }
  if (runtime.cwd !== config.expected.cwd) {
    readinessFailure(
      'wrong-cwd',
      'the actual canonical working directory differs from the producer-captured repository root',
    );
  }
  if (
    !Number.isSafeInteger(runtime.freeBytes) ||
    !Number.isSafeInteger(runtime.freeInodes) ||
    runtime.freeBytes < config.storage.minimumFreeBytes ||
    runtime.freeInodes < config.storage.minimumFreeInodes
  ) {
    readinessFailure(
      'insufficient-storage',
      `available storage (${runtime.freeBytes} bytes, ${runtime.freeInodes} inodes) is below the declared floor`,
    );
  }
  if (runtime.missingRetainedPaths.length > 0) {
    readinessFailure(
      'missing-retained-state',
      `required retained paths are absent (${runtime.missingRetainedPaths.join(', ')})`,
    );
  }

  const environment = dependencies.environment ?? process.env;
  const ambientEnvironment = Object.entries(environment)
    .filter(([name, value]) => AMBIENT_GIT_ENVIRONMENT.test(name) && typeof value === 'string' && value.length > 0)
    .map(([name]) => name);
  if (ambientEnvironment.length > 0) {
    readinessFailure(
      'ambient-git-helper',
      `ambient Git authorization settings are present (${ambientEnvironment.join(', ')})`,
    );
  }
  const runner = dependencies.commandRunner ?? new NodeGcpImageFamilyCommandRunner();
  const commandEnvironment = safeGitEnvironment(environment);
  const ambientHelper = await runner.run({
    command: 'git',
    args: ['-C', config.expected.cwd, 'config', '--get-all', 'credential.helper'],
    cwd: config.expected.cwd,
    env: commandEnvironment,
  });
  if (ambientHelper.exitCode === 0 && ambientHelper.stdout.trim()) {
    readinessFailure(
      'ambient-git-helper',
      'repository, global, or system Git configuration declares a credential helper',
    );
  }
  if (ambientHelper.exitCode !== 0 && ambientHelper.exitCode !== 1) {
    readinessFailure('ambient-git-helper', 'Git credential-helper configuration could not be inspected');
  }

  const head = (
    await requireGitCommand(
      runner,
      {
        command: 'git',
        args: ['-C', config.expected.cwd, 'rev-parse', 'HEAD'],
        cwd: config.expected.cwd,
        env: commandEnvironment,
      },
      'source-revision-mismatch',
      'the local source revision could not be resolved',
    )
  )
    .trim()
    .toLowerCase();
  if (head !== config.source.revision) {
    readinessFailure('source-revision-mismatch', 'local HEAD differs from the manifest source revision');
  }
  const origin = (
    await requireGitCommand(
      runner,
      {
        command: 'git',
        args: ['-C', config.expected.cwd, 'remote', 'get-url', 'origin'],
        cwd: config.expected.cwd,
        env: commandEnvironment,
      },
      'source-origin-mismatch',
      'the local origin could not be resolved',
    )
  ).trim();
  let originIdentity: GithubRepositoryIdentity;
  try {
    originIdentity = githubRepositoryIdentity(origin);
  } catch {
    readinessFailure('source-origin-mismatch', 'local origin is not the manifest repository');
  }
  if (
    originIdentity.owner.toLowerCase() !== gitRepository.owner.toLowerCase() ||
    originIdentity.repository.toLowerCase() !== gitRepository.repository.toLowerCase()
  ) {
    readinessFailure('source-origin-mismatch', 'local origin is not the manifest repository');
  }
  const actualGitlinks = parseGitSubmoduleStatus(
    await requireGitCommand(
      runner,
      {
        command: 'git',
        args: ['-C', config.expected.cwd, 'submodule', 'status', '--recursive'],
        cwd: config.expected.cwd,
        env: commandEnvironment,
      },
      'gitlink-mismatch',
      'recursive submodule status could not be read',
    ),
  );
  const expectedGitlinks = canonicalGitlinks(config.source.gitlinks);
  if (!gitlinksEqual(actualGitlinks, expectedGitlinks)) {
    readinessFailure('gitlink-mismatch', 'recursive submodule revisions differ from the request pins');
  }

  const materialSource = dependencies.materialSource ?? createOperatorWorkspaceHostCredentialMaterialSource();
  let material;
  try {
    material = await materialSource.resolve({
      channel: 'git',
      credentialRef: config.credentials.git.credentialRef.ref,
      family: gitBinding.family,
      generation: gitBinding.generation,
    });
  } catch (error) {
    if (error instanceof WorkspaceHostRevokedCredentialGenerationError) {
      readinessFailure('revoked-credential', 'the selected Git generation is revoked');
    }
    readinessFailure('credential-unavailable', 'the exact Git generation is unavailable from its configured source');
  }
  const materialBytes = material.reveal();
  const originalBytes = Buffer.from(materialBytes);
  let temporary: string | undefined;
  let filled = '';
  try {
    temporary = await mkdtemp(join(dependencies.temporaryParent ?? tmpdir(), 'papercusp-gcp-readiness-'));
    await chmod(temporary, 0o700);
    const materialPath = join(temporary, 'git-credential');
    const ambientPath = join(temporary, 'ambient-credential');
    const globalConfigPath = join(temporary, 'ambient.gitconfig');
    await writeFile(materialPath, materialBytes, { flag: 'wx', mode: 0o600 });
    await chmod(materialPath, 0o600);
    await writeFile(globalConfigPath, `[credential]\n\thelper = store --file=${ambientPath}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    const credentialEnvironment = {
      ...commandEnvironment,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: globalConfigPath,
      ...workspaceHostGetOnlyGitCredentialEnvironment(materialPath),
    };
    const credentialInput = `protocol=https\nhost=github.com\npath=${gitRepository.credentialPath}\n\n`;
    const fill = await runner.run({
      command: 'git',
      args: ['credential', 'fill'],
      cwd: config.expected.cwd,
      env: credentialEnvironment,
      stdin: credentialInput,
    });
    filled = fill.stdout;
    if (fill.exitCode !== 0 || !/(?:^|\n)username=[^\n]+/.test(filled) || !/(?:^|\n)password=[^\n]+/.test(filled)) {
      readinessFailure(
        'git-authentication-failed',
        'the exact Git generation did not answer its scoped credential query',
      );
    }
    for (const action of ['approve', 'reject'] as const) {
      await requireGitCommand(
        runner,
        {
          command: 'git',
          args: ['credential', action],
          cwd: config.expected.cwd,
          env: credentialEnvironment,
          stdin: `${filled}\n`,
        },
        'git-helper-write',
        `the get-only Git helper rejected the ${action} protocol check`,
      );
    }
    const afterProtocol = await readFile(materialPath);
    if (!afterProtocol.equals(originalBytes) || (await pathExists(ambientPath))) {
      readinessFailure('git-helper-write', 'Git approve/reject mutated delivered or ambient authorization state');
    }
    await requireGitCommand(
      runner,
      {
        command: 'git',
        args: ['ls-remote', '--exit-code', config.source.repository, 'HEAD'],
        cwd: config.expected.cwd,
        env: credentialEnvironment,
      },
      'git-authentication-failed',
      'the exact Git generation cannot read the manifest repository',
    );
    const afterRemote = await readFile(materialPath);
    if (!afterRemote.equals(originalBytes) || (await pathExists(ambientPath))) {
      readinessFailure('git-helper-write', 'the repository access probe mutated authorization state');
    }
  } finally {
    filled = '';
    originalBytes.fill(0);
    materialBytes.fill(0);
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }

  const verifyAgent = dependencies.verifyAgentCredentialAdmission ?? verifyWorkspaceHostAgentCredentialAdmission;
  let agentAdmission: WorkspaceHostAgentCredentialAdmissionEvidence;
  try {
    agentAdmission = await verifyAgent({
      credentialRef: config.credentials.agent.credentialRef,
      delivery: config.credentials.agent.delivery,
      materialSource,
    });
    assertWorkspaceHostAgentCredentialAdmissionEvidence(agentAdmission, {
      credentialRef: config.credentials.agent.credentialRef,
      delivery: config.credentials.agent.delivery,
    });
  } catch (error) {
    if (error instanceof WorkspaceHostRevokedCredentialGenerationError) {
      readinessFailure('revoked-credential', 'the selected agent generation is revoked');
    }
    readinessFailure('agent-authentication-failed', 'the exact agent generation failed live authentication');
  }

  const evidence: GcpImageFamilyExactPathReadinessEvidence = {
    contractVersion: GCP_IMAGE_FAMILY_EXACT_PATH_READINESS_CONTRACT_VERSION,
    ok: true,
    observedAt: observedAt.toISOString(),
    identity: { username: runtime.username, cwd: runtime.cwd },
    storage: {
      freeBytes: runtime.freeBytes,
      freeInodes: runtime.freeInodes,
      retainedPathCount: config.storage.retainedPaths.length,
    },
    source: {
      repositoryDigest: publicDigest(config.source.repository),
      revision: config.source.revision,
      gitlinkCount: expectedGitlinks.length,
      gitlinksDigest: publicDigest(expectedGitlinks),
    },
    bindings: {
      git: {
        family: gitBinding.family,
        generation: gitBinding.generation,
        referenceDigest: workspaceHostCredentialReferenceDigest(config.credentials.git.credentialRef.ref),
        revokedThrough: config.credentials.git.revokedThrough,
        repositoryScope: 'exact',
        materialImmutable: true,
        remoteReachable: true,
      },
      agent: {
        family: agentBinding.family,
        generation: agentBinding.generation,
        referenceDigest: workspaceHostCredentialReferenceDigest(config.credentials.agent.credentialRef.ref),
        revokedThrough: config.credentials.agent.revokedThrough,
        authenticated: true,
      },
    },
  };
  assertWorkspaceHostSecretIsolation(evidence, 'gcpImageFamily.exactPathReadiness.evidence');
  return evidence;
}

function requiredProject(value: unknown, path: string): string {
  if (typeof value !== 'string' || !PROJECT_ID.test(value.trim())) {
    throw new Error(`${path} must be a valid GCP project id`);
  }
  return value.trim();
}

function connectionProject(connection: WorkspaceHostProviderConnection): string {
  if (!connection || connection.target !== GCP_TARGET) {
    throw new Error(`GCP image-family release requires a '${GCP_TARGET}' connection`);
  }
  if (connection.scope && connection.scope.kind !== 'project') {
    throw new Error('GCP image-family connection scope must be a project');
  }
  const scopeProject = connection.scope?.kind === 'project' ? connection.scope.id : undefined;
  const providerProject =
    typeof connection.provider?.projectId === 'string' ? connection.provider.projectId : undefined;
  const projectId = requiredProject(scopeProject ?? providerProject, 'connection.projectId');
  if (scopeProject && providerProject && scopeProject.trim() !== providerProject.trim()) {
    throw new Error('GCP image-family connection project scope and provider project disagree');
  }
  return projectId;
}

function connectionCredentialRef(connection: WorkspaceHostProviderConnection): string {
  const ref = connection.cloudCredentialRef?.ref?.trim();
  if (!ref) throw new Error('GCP image-family connection requires cloudCredentialRef');
  // Local image release is intentionally restricted to the same short-lived Google chains as
  // workspace-host provisioning. Hosted/encrypted references need a hosted resolver and are not
  // silently interpreted as process-global ADC here.
  if (!isSupportedGcpImageFamilyCredentialRef(ref)) {
    throw new Error(
      'GCP image-family credentialRef must use adc://<safe-chain> or gcloud://active-user; hosted references require an explicit resolver',
    );
  }
  return ref;
}

/**
 * Child commands must not inherit a service-account key selected by
 * GOOGLE_APPLICATION_CREDENTIALS.  Setting the entries to undefined lets Node omit them from
 * the spawned environment without mutating the parent process.  The gcloud/ADC resolver still
 * supplies short-lived authorization through the selected reference.
 */
export function safeGcpImageFamilyCommandEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string | undefined>> {
  return {
    ...env,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    GOOGLE_OAUTH_ACCESS_TOKEN: undefined,
    CLOUDSDK_AUTH_ACCESS_TOKEN: undefined,
  };
}

/** Command runner wrapper that applies the credential-safety environment to every invocation. */
export class CredentialScopedGcpImageFamilyCommandRunner implements GcpImageFamilyCommandRunner {
  constructor(
    private readonly inner: GcpImageFamilyCommandRunner,
    private readonly environment: Readonly<Record<string, string | undefined>> = safeGcpImageFamilyCommandEnvironment(),
  ) {}

  run(
    command: string | GcpImageFamilyCommand,
    args: readonly string[] = [],
    options: Omit<GcpImageFamilyCommand, 'command' | 'args'> = {},
  ): Promise<GcpImageFamilyCommandResult> {
    const callerEnv = typeof command === 'string' ? options.env : command.env;
    const merged = { ...this.environment, ...(callerEnv ?? {}) };
    // A caller may add harmless build variables, but may not re-introduce one of the forbidden
    // process-global token/key channels through the per-call override.
    merged.GOOGLE_APPLICATION_CREDENTIALS = undefined;
    merged.GOOGLE_OAUTH_ACCESS_TOKEN = undefined;
    merged.CLOUDSDK_AUTH_ACCESS_TOKEN = undefined;
    if (typeof command === 'string') {
      return this.inner.run(command, args, { ...options, env: merged });
    }
    return this.inner.run({ ...command, env: merged });
  }

  execute(
    command: string | GcpImageFamilyCommand,
    args?: readonly string[],
    options?: Omit<GcpImageFamilyCommand, 'command' | 'args'>,
  ): Promise<GcpImageFamilyCommandResult> {
    if (this.inner.execute) {
      const callerEnv = typeof command === 'string' ? options?.env : command.env;
      const merged = { ...this.environment, ...(callerEnv ?? {}) };
      merged.GOOGLE_APPLICATION_CREDENTIALS = undefined;
      merged.GOOGLE_OAUTH_ACCESS_TOKEN = undefined;
      merged.CLOUDSDK_AUTH_ACCESS_TOKEN = undefined;
      if (typeof command === 'string') return this.inner.execute(command, args, { ...options, env: merged });
      return this.inner.execute({ ...command, env: merged });
    }
    return this.run(command, args, options);
  }
}

/**
 * Resolve a connection-bound production adapter.  This is intentionally the only constructor
 * used by the release CLI, so a release cannot accidentally fall back to ambient ADC or an
 * unscoped command environment.
 */
export function composeGcpImageFamilyReleaseAdapter(
  connection: WorkspaceHostProviderConnection,
  options: GcpImageFamilyReleaseCompositionOptions = {},
): GcpImageFamilyReleaseComposition {
  const projectId = connectionProject(connection);
  const credentialRef = connectionCredentialRef(connection);
  const acquireAuth =
    options.acquireAuth ??
    createGcpWorkspaceHostAcquireAuth(credentialRef, {
      env: safeGcpImageFamilyCommandEnvironment(),
    });
  const commandRunner = new CredentialScopedGcpImageFamilyCommandRunner(
    options.commandRunner ?? new NodeGcpImageFamilyCommandRunner(),
  );
  const { acquireAuth: _acquireAuth, commandRunner: _commandRunner, ...adapterOptions } = options;
  const adapter = createGcpImageFamilyReleaseAdapter({
    ...adapterOptions,
    acquireAuth,
    credentialRef,
    commandRunner,
  });
  return { projectId, credentialRef, adapter };
}

/**
 * Resolve the connection-bound short-lived credential without exposing the bearer token.  This
 * is intentionally a separate read-only probe so release automation can fail before Packer or
 * any Compute mutation when the selected chain is unavailable.
 */
export async function probeGcpImageFamilyCredential(
  connection: WorkspaceHostProviderConnection,
  options: Pick<GcpImageFamilyReleaseCompositionOptions, 'acquireAuth'> = {},
): Promise<GcpImageFamilyCredentialProbe> {
  const projectId = connectionProject(connection);
  const credentialRef = connectionCredentialRef(connection);
  const acquireAuth =
    options.acquireAuth ??
    createGcpWorkspaceHostAcquireAuth(credentialRef, {
      env: safeGcpImageFamilyCommandEnvironment(),
    });
  try {
    const auth = await acquireAuth();
    if (auth.projectId && auth.projectId !== projectId) {
      return {
        ok: false,
        projectId,
        credentialRef,
        ...(auth.identity ? { identity: auth.identity } : {}),
        resolvedProjectId: auth.projectId,
        error: 'selected credential resolved a different GCP project',
      };
    }
    return {
      ok: true,
      projectId,
      credentialRef,
      ...(auth.identity ? { identity: auth.identity } : {}),
      ...(auth.projectId ? { resolvedProjectId: auth.projectId } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      projectId,
      credentialRef,
      error: error instanceof Error ? error.message : 'GCP credential resolution failed',
    };
  }
}

/**
 * The real production call path.  It binds the connection first, checks that the request targets
 * the same project, and then runs the fail-closed executor with the concrete Google adapter.
 *
 * `execution` is kept SEPARATE from `options` on purpose: `options` says how to COMPOSE the
 * adapter (seams, executables, repo root) and is reused by the read-only probes, while `execution`
 * says what THIS run should do — resume from an already-built candidate instead of rebuilding.
 * Forwarding it is the whole reachability of the resume path (WI-1613086): this seam previously
 * called the executor with two arguments, which silently defaulted every production release to a
 * full rebuild while the library's resume validation sat there looking implemented.
 */
export async function executeConfiguredGcpImageFamilyRelease(
  request: GcpImageFamilyReleaseRequest,
  connection: WorkspaceHostProviderConnection,
  options: GcpImageFamilyReleaseCompositionOptions = {},
  execution: GcpImageFamilyReleaseExecutionOptions = {},
): Promise<GcpImageFamilyReleaseResult> {
  const composition = composeGcpImageFamilyReleaseAdapter(connection, options);
  const requestProject = requiredProject(request?.projectId, 'request.projectId');
  if (requestProject !== composition.projectId) {
    throw new Error('GCP image-family release request project does not match the selected connection');
  }
  return executeGcpImageFamilyRelease(request, composition.adapter, execution);
}

/**
 * Read-only executable preflight used before a potentially billable release.  It resolves PATH
 * without spawning a shell and reports every missing binary; callers can stop before Packer or a
 * provider mutation starts.
 */
export async function probeGcpImageFamilyExecutables(
  options: Pick<
    GcpImageFamilyReleaseCompositionOptions,
    | 'packerExecutable'
    | 'packerPath'
    | 'scanExecutable'
    | 'scannerExecutable'
    | 'cleanRoomExecutable'
    | 'cleanRoomCommand'
    | 'bootstrapAcceptanceExecutable'
  > = {},
): Promise<{ ok: boolean; executables: Readonly<Record<string, string | null>>; missing: readonly string[] }> {
  const configured = {
    packer: options.packerExecutable ?? options.packerPath ?? GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.packer,
    scanner: options.scanExecutable ?? options.scannerExecutable ?? GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.scanner,
    cleanRoom:
      options.cleanRoomExecutable ?? options.cleanRoomCommand ?? GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.cleanRoom,
    /**
     * The PRE-build acceptance binary produces the clean-room report the gate ratifies, so an
     * absent one must fail this read-only preflight rather than surfacing mid-release. It was
     * registered in GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES but never probed here, which let the
     * preflight report `ok` while the release could not actually produce its gate evidence.
     */
    bootstrapAcceptance:
      options.bootstrapAcceptanceExecutable ?? GCP_IMAGE_FAMILY_RELEASE_EXECUTABLES.bootstrapAcceptance,
  };
  const found: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const [name, raw] of Object.entries(configured)) {
    const executable = String(raw).trim();
    if (!SAFE_EXECUTABLE.test(executable) || executable.includes(' ')) {
      found[name] = null;
      missing.push(name);
      continue;
    }
    const candidates = isAbsolute(executable)
      ? [executable]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((entry) => resolve(entry, executable));
    // Probe sequentially so the result is deterministic and bounded.
    let selected: string | null = null;
    for (const path of candidates) {
      try {
        await access(path, fsConstants.X_OK);
        selected = path;
        break;
      } catch {
        // Keep looking through PATH entries.
      }
    }
    found[name] = selected;
    if (!selected) missing.push(name);
  }
  return { ok: missing.length === 0, executables: found, missing };
}
