/**
 * Target -> concrete initialization host adapter (P-046 / WI-40474).
 *
 * `runWorkspaceHostInitialization` takes an injected `operations` seam so it stays testable and
 * provider-agnostic. This is the production resolver that decides which real adapter fills that
 * seam for a given host, and it is deliberately the ONLY place that mapping exists.
 *
 * Two properties matter here:
 *
 * 1. THE INSTANCE IDENTITY IS NOT DERIVED HERE. It comes from
 *    `resolveGcpWorkspaceHostInstanceIdentity`, the same exported function the GCP provider's own
 *    `readSettings` uses when it PROVISIONS the instance. Deriving the instance name here
 *    independently would be a silent bug: initialization would open an IAP tunnel to a name that
 *    was never created, failing only at runtime and only against real cloud. Sharing the
 *    derivation makes that class of divergence impossible rather than merely unlikely.
 *
 * 2. AN UNSUPPORTED TARGET REFUSES LOUDLY. AWS and Azure initialization adapters are separate
 *    plan items (P-030 / P-035) and do not exist yet. A transport kind never implies command,
 *    transfer, pairing or credential-delivery parity — the contract says so explicitly — so
 *    falling back to "some other adapter" would be actively wrong. Refusing names the gap.
 *
 * 3. THE ADAPTER IT RETURNS DELIVERS CREDENTIAL MATERIAL BEFORE IT BINDS IT (D-215). `bind()` on
 *    the host is an OBSERVATION — it checks that the material file exists — so an adapter that
 *    only spoke the initialization protocol could never make the `git` or `agent` channels pass.
 *    The delivering wrapper is applied unconditionally, including when no material source is
 *    configured, because the difference it makes then is WHICH error a binding fails with: a
 *    controller-side refusal naming the missing configuration, or the host's `material is not
 *    present`, which blames the host for the controller's gap.
 */
import { createHash, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
// @ts-expect-error -- buildless plain-JS mutex module intentionally has no declaration file.
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import {
  DEFAULT_WORKSPACE_HOST_WORKSPACE_USER,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_KEY,
  WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_NAMESPACE,
  WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT,
  WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT,
  parseWorkspaceHostBootstrapReportedStatus,
  type WorkspaceHostDeliveryCapabilities,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostInitializationHostOperations,
} from '@papercusp/deployment-driver';
import { createGcpWorkspaceHostAcquireAuth } from '../cloud-workspaces/gcp-preflight';
import { createGcpWorkspaceHostApiClient } from './gcp-api-client';
import {
  UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE,
  type WorkspaceHostCredentialMaterialSource,
} from './credential-material-source';
import { GcpIapDeliveringWorkspaceHostInitializationOperations } from './gcp-iap-credential-delivery';
import { isHostedProviderCredentialRef, resolveHostedGcpAuth } from './hosted-gcp-auth';
import {
  GcpIapWorkspaceHostInitializationOperations,
  gcpIapHostKeyAlias,
  gcpIapHostKeyAliasFamily,
  type GcpIapWorkspaceHostBootstrapStatusSource,
  type GcpIapWorkspaceHostInitializationProfile,
  type GcpIapWorkspaceHostTransportProfile,
} from './gcp-iap-initialization-operations';
import {
  GCP_WORKSPACE_HOST_TARGET,
  GCP_WORKSPACE_HOST_TRANSPORT_FEATURES,
  resolveGcpWorkspaceHostInstanceIdentity,
  type GcpInstanceGuestAttribute,
  type GcpWorkspaceHostApiClient,
} from './gcp-provider';
import { readWorkspaceHostConnection, readWorkspaceHostDesiredSpec } from './observability-store';

/** Public typed initializer transport; keep implementation-private fields out of the seam. */
export type WorkspaceHostControllerOperations = WorkspaceHostInitializationHostOperations &
  Pick<GcpIapDeliveringWorkspaceHostInitializationOperations, 'execute'>;

/**
 * Controller-owned, host-independent settings. These are NOT per-host database columns: the
 * known-hosts file is a controller-managed trust store and the remote entrypoint is a fixed
 * binary shipped in the signed workspace-host release. Keeping them out of the host record is
 * what stops a per-host row from being able to redirect the controller at an arbitrary binary.
 */
export interface WorkspaceHostInitializationControllerProfile {
  sshUser: string;
  /** Absolute path to a controller-owned, pre-enrolled known_hosts file. */
  knownHostsFile: string;
  /** Absolute path to the fixed initializer binary in the signed release. */
  remoteEntrypoint: string;
  /**
   * Absolute path to the fixed credential-DELIVERY binary in the signed release.
   *
   * Its own field rather than a reuse of `remoteEntrypoint`: they are two different programs
   * speaking two different protocols, and a profile carrying one path for both would send
   * delivery requests to the initializer, which refuses them as a version mismatch — a
   * misconfigured profile reported as a broken step.
   */
  deliveryEntrypoint: string;
  identityFile?: string;
  sshExecutable?: string;
  gcloudExecutable?: string;
}

export class WorkspaceHostInitializationHostKeyError extends Error {
  constructor(message: string) {
    super(`Workspace-host SSH trust refused: ${message}`);
    this.name = 'WorkspaceHostInitializationHostKeyError';
  }
}

export interface GcpIapHostKeyEnrollmentInput {
  /** `instanceId` is the incarnation that PUBLISHED `attributes` — read around that read. */
  identity: { projectId: string; zone: string; instanceName: string; instanceId: string };
  knownHostsFile: string;
  attributes: readonly GcpInstanceGuestAttribute[];
}

const HOST_KEY_ALGORITHMS = ['ecdsa-sha2-nistp256', 'ssh-ed25519', 'ssh-rsa'] as const;
type HostKeyAlgorithm = (typeof HOST_KEY_ALGORITHMS)[number];
const HOST_KEY_BY_ATTRIBUTE = new Map<string, (typeof HOST_KEY_ALGORITHMS)[number]>([
  ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp256'],
  ['ssh-ed25519', 'ssh-ed25519'],
  ['ssh-rsa', 'ssh-rsa'],
]);

const hostKeyEnrollmentQueues = new Map<string, Promise<void>>();
const HOST_KEY_ENROLLMENT_MUTEX_PREFIX = 'workspace-host-known-hosts-';

interface GcpIapHostKeyEnrollmentTestHooks {
  /** Test seam: synchronize independent processes immediately before cross-process acquisition. */
  beforeMutex?: () => Promise<void>;
  /** Test seam: widen the stale-snapshot window after the trust file is read. */
  afterRead?: () => Promise<void>;
}

export interface GcpIapHostKeyPruneInput {
  /** The stable GCP identity used by the same alias-family writer as enrollment. */
  identity: Pick<GcpIapWorkspaceHostInitializationProfile, 'projectId' | 'zone' | 'instanceName'>;
  knownHostsFile: string;
  /** Re-read workspace_hosts inside the enrollment mutex; prune only after desired AND observed absent. */
  confirmHostAbsent: () => Promise<boolean>;
}

export interface GcpIapHostKeyPruneResult {
  aliasFamily: string;
  removedEntries: number;
  remainingEntries: number;
}

export interface GcpIapHostKeyPruneTestHooks {
  /** Test seam: synchronize independent processes immediately before cross-process acquisition. */
  beforeMutex?: () => Promise<void>;
  /** Test seam: widen the stale-snapshot window after the trust file is read. */
  afterRead?: () => Promise<void>;
}

function hostKeyEnrollmentMutexName(knownHostsFile: string): string {
  return `${HOST_KEY_ENROLLMENT_MUTEX_PREFIX}${createHash('sha256').update(knownHostsFile).digest('hex')}`;
}

function hostKeyFailure(message: string): never {
  throw new WorkspaceHostInitializationHostKeyError(message);
}

function readSshString(blob: Buffer, offset: number, label: string): { value: Buffer; nextOffset: number } {
  if (offset + 4 > blob.length) hostKeyFailure(`${label} is truncated`);
  const length = blob.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > blob.length) hostKeyFailure(`${label} is truncated`);
  return { value: blob.subarray(start, end), nextOffset: end };
}

function requireNoTrailingKeyData(blob: Buffer, offset: number): void {
  if (offset !== blob.length) hostKeyFailure('host key contains trailing encoded data');
}

function positiveMpint(value: Buffer, label: string): Buffer {
  if (value.length === 0 || (value[0]! & 0x80) !== 0) {
    return hostKeyFailure(`${label} is not a positive SSH mpint`);
  }
  if (value.length > 1 && value[0] === 0 && (value[1]! & 0x80) === 0) {
    return hostKeyFailure(`${label} is not canonically encoded`);
  }
  return value[0] === 0 ? value.subarray(1) : value;
}

function validatePublicKeyObject(makeKey: () => KeyObject): KeyObject {
  try {
    return makeKey();
  } catch {
    return hostKeyFailure('host key contains invalid cryptographic material');
  }
}

function validatePublicKeyBlob(algorithm: HostKeyAlgorithm, blob: Buffer): void {
  if (blob.length > 16 * 1024) hostKeyFailure('host key material is unreasonably large');
  const encodedAlgorithm = readSshString(blob, 0, 'host key algorithm');
  if (encodedAlgorithm.value.toString('utf8') !== algorithm) {
    hostKeyFailure('host key algorithm does not match its encoded key');
  }

  if (algorithm === 'ssh-ed25519') {
    const publicBytes = readSshString(blob, encodedAlgorithm.nextOffset, 'Ed25519 public key');
    if (publicBytes.value.length !== 32) hostKeyFailure('Ed25519 public key must be 32 bytes');
    requireNoTrailingKeyData(blob, publicBytes.nextOffset);
    validatePublicKeyObject(() =>
      createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: publicBytes.value.toString('base64url') },
        format: 'jwk',
      }),
    );
    return;
  }

  if (algorithm === 'ecdsa-sha2-nistp256') {
    const curve = readSshString(blob, encodedAlgorithm.nextOffset, 'ECDSA curve');
    const point = readSshString(blob, curve.nextOffset, 'ECDSA public point');
    if (curve.value.toString('utf8') !== 'nistp256') hostKeyFailure('ECDSA host key must use nistp256');
    if (point.value.length !== 65 || point.value[0] !== 0x04) {
      hostKeyFailure('ECDSA nistp256 public point is malformed');
    }
    requireNoTrailingKeyData(blob, point.nextOffset);
    validatePublicKeyObject(() =>
      createPublicKey({
        key: {
          kty: 'EC',
          crv: 'P-256',
          x: point.value.subarray(1, 33).toString('base64url'),
          y: point.value.subarray(33).toString('base64url'),
        },
        format: 'jwk',
      }),
    );
    return;
  }

  const exponent = readSshString(blob, encodedAlgorithm.nextOffset, 'RSA exponent');
  const modulus = readSshString(blob, exponent.nextOffset, 'RSA modulus');
  requireNoTrailingKeyData(blob, modulus.nextOffset);
  validatePublicKeyObject(() =>
    createPublicKey({
      key: {
        kty: 'RSA',
        e: positiveMpint(exponent.value, 'RSA exponent').toString('base64url'),
        n: positiveMpint(modulus.value, 'RSA modulus').toString('base64url'),
      },
      format: 'jwk',
    }),
  );
}

function parsePublicKeyBlob(algorithm: HostKeyAlgorithm, key: string): { algorithm: HostKeyAlgorithm; key: string } {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new WorkspaceHostInitializationHostKeyError('host key material is malformed');
  }
  const blob = Buffer.from(key, 'base64');
  const canonical = blob.toString('base64');
  if (blob.length < 4 || (key !== canonical && key !== canonical.replace(/=+$/, ''))) {
    throw new WorkspaceHostInitializationHostKeyError('host key material is malformed');
  }
  validatePublicKeyBlob(algorithm, blob);
  return { algorithm, key: canonical };
}

function parsePublicKeyLine(value: string): { algorithm: HostKeyAlgorithm; key: string } {
  const match = /^(ecdsa-sha2-nistp256|ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?$/.exec(value);
  if (!match) throw new WorkspaceHostInitializationHostKeyError('host key material is malformed');
  return parsePublicKeyBlob(match[1] as HostKeyAlgorithm, match[2]!);
}

function guestHostKeys(attributes: readonly GcpInstanceGuestAttribute[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const attribute of attributes) {
    if (attribute.namespace !== 'hostkeys') {
      throw new WorkspaceHostInitializationHostKeyError(
        `unexpected guest-attribute namespace '${attribute.namespace}'`,
      );
    }
    const expected = HOST_KEY_BY_ATTRIBUTE.get(attribute.key);
    if (!expected)
      throw new WorkspaceHostInitializationHostKeyError(`unsupported host-key attribute '${attribute.key}'`);
    // Compute's JSON contract keeps the algorithm in item.key and the SSH wire blob in
    // item.value. Keep this separate from the known_hosts full-line parser: accepting a guessed
    // prefix here would hide a response-shape mismatch.
    const parsed = parsePublicKeyBlob(expected, attribute.value);
    if (keys.has(parsed.algorithm)) {
      throw new WorkspaceHostInitializationHostKeyError(`duplicate '${parsed.algorithm}' host-key attribute`);
    }
    keys.set(parsed.algorithm, parsed.key);
  }
  for (const algorithm of HOST_KEY_ALGORITHMS) {
    if (!keys.has(algorithm)) {
      throw new WorkspaceHostInitializationHostKeyError(`hostkeys/ is missing '${algorithm}'`);
    }
  }
  return keys;
}

/**
 * How long to wait for the guest agent to publish `hostkeys/` on a freshly-created VM (WI-10001685).
 *
 * MEASURED on a real GCP e2-standard-2 in active-alcove-504205-q3, 2026-09-16:
 *   23:29:40Z  hostkeys/ -> HTTP 404 (initialize died here, 2s in, and wrote NO operation row)
 *   23:30:40Z  hostkeys/ -> all three keys present
 * i.e. publication lands ~70s after create. The budget is ~4x that rather than tight, because the
 * cost of being wrong is asymmetric: too short re-introduces the race this exists to absorb, while
 * too long only delays a host that was never going to come up.
 *
 * ⚠ This is deliberately SHORTER than the bootstrap gate's 1200s. They are not the same wait: the
 * bootstrap gate waits for a ~2GB bundle plus three CLI installs, this one waits for the guest
 * agent to write three strings. Reusing the bootstrap budget here would hide a genuinely broken
 * guest agent behind twenty minutes of silence.
 */
const HOST_KEY_PUBLICATION_TIMEOUT_MS = 300_000;
const HOST_KEY_PUBLICATION_POLL_INTERVAL_MS = 5_000;

/**
 * Is this the "guest agent has not published hostkeys/ YET" 404, as opposed to any other 404?
 *
 * ⚠ THE DISCRIMINATION IS THE WHOLE POINT, and getting it wrong is worse than not retrying at all.
 * A 404 for a NONEXISTENT INSTANCE is the exact failure this resolver's own docstring says must
 * refuse immediately ("a tunnel to an instance that does not exist"). Retrying that blindly would
 * convert a clear 2-second refusal into a five-minute hang and then report a timeout, which names
 * the wrong cause. So we require the 404 to name a *Guest Attribute* — GCP puts the missing
 * resource's type in the message — and let every other 404 through untouched.
 */
function isHostKeyPublicationPending(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { status?: unknown }).status !== 404) return false;
  const reason = String(
    (error as { reason?: unknown }).reason ?? (error as { message?: unknown }).message ?? '',
  );
  return /type\s+'Guest Attribute'/i.test(reason);
}

/**
 * Presence-only completeness check — deliberately NOT a parse.
 *
 * The 404 is only half the race. The guest agent publishes the three keys as separate attributes,
 * so a read landing mid-publication returns a PARTIAL set, which `guestHostKeys` rejects with
 * "hostkeys/ is missing '<algorithm>'". That is transient and must be waited out.
 *
 * ⚠ It checks presence and NOTHING else on purpose. Validation stays in `guestHostKeys`, so
 * MALFORMED or duplicate key material still fails fast instead of being retried for five minutes
 * and then reported as a publication timeout — a corrupt key is a real defect, not a slow one.
 */
function hostKeyPublicationComplete(attributes: readonly GcpInstanceGuestAttribute[]): boolean {
  const present = new Set<HostKeyAlgorithm>();
  for (const attribute of attributes) {
    if (attribute.namespace !== 'hostkeys') continue;
    const algorithm = HOST_KEY_BY_ATTRIBUTE.get(attribute.key);
    if (algorithm) present.add(algorithm);
  }
  return HOST_KEY_ALGORITHMS.every((algorithm) => present.has(algorithm));
}

export interface WorkspaceHostHostKeyPublicationOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /**
   * Called after each not-yet-published probe so the caller can write durable progress.
   *
   * Mirrors the bootstrap gate's `onWaiting` for the reason that gate documents: without it the
   * wait is indistinguishable from a hang to anyone reading the operation row. It also supplies the
   * only positive evidence that this gate ran at all — a fast clean initialize proves nothing,
   * because the non-waiting path emits nothing by construction.
   */
  readonly onWaiting?: (status: { elapsedMs: number; timeoutMs: number }) => void | Promise<void>;
  /** Test seam; production sleeps for real. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam; production reads the wall clock. */
  readonly now?: () => number;
}

export class WorkspaceHostHostKeyPublicationTimeoutError extends Error {
  constructor(instanceName: string, waitedMs: number) {
    super(
      `host keys were not published by instance '${instanceName}' after ${Math.round(waitedMs / 1000)}s`,
    );
    this.name = 'WorkspaceHostHostKeyPublicationTimeoutError';
  }
}

/**
 * Read `hostkeys/`, waiting out the publication race on a freshly-created VM.
 *
 * Ordering context (WI-10001685): `initialize.ts` resolves operations BEFORE it runs the
 * initializer that owns the bootstrap gate, and this read sits at the end of that resolution. So
 * on a genuinely fresh host the resolver threw and the bootstrap gate was STRUCTURALLY
 * UNREACHABLE — no operation row was written at all. No prior attempt saw it because the two
 * historical reproductions used 117s and 304s provision->initialize gaps, both already past
 * publication; only a ~0s gap reaches it.
 */
async function readPublishedHostKeys(
  client: Pick<GcpWorkspaceHostApiClient, 'getInstanceGuestAttributes'>,
  identity: { projectId: string; zone: string; instanceName: string },
  options: WorkspaceHostHostKeyPublicationOptions = {},
): Promise<readonly GcpInstanceGuestAttribute[]> {
  const timeoutMs = options.timeoutMs ?? HOST_KEY_PUBLICATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? HOST_KEY_PUBLICATION_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const startedAt = now();

  for (;;) {
    let attributes: readonly GcpInstanceGuestAttribute[] | undefined;
    try {
      attributes = await client.getInstanceGuestAttributes(
        identity.projectId,
        identity.zone,
        identity.instanceName,
        'hostkeys/',
      );
    } catch (error) {
      // Anything that is not the publication race propagates UNCHANGED, keeping a wrong-instance
      // 404, an auth failure and a quota error as fast and as legible as they were before.
      if (!isHostKeyPublicationPending(error)) throw error;
    }

    if (attributes && hostKeyPublicationComplete(attributes)) return attributes;

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new WorkspaceHostHostKeyPublicationTimeoutError(identity.instanceName, elapsedMs);
    }
    await options.onWaiting?.({ elapsedMs, timeoutMs });
    await sleep(pollIntervalMs);
  }
}

async function enrollGcpIapHostKeysUnlocked(
  input: GcpIapHostKeyEnrollmentInput,
  hooks: GcpIapHostKeyEnrollmentTestHooks,
): Promise<void> {
  const alias = gcpIapHostKeyAlias(input.identity);
  // Every incarnation of this instance NAME shares the family prefix. A pin under the family with
  // any other suffix — or none, the pre-WI-10002493 name-only alias — belongs to a machine GCP has
  // already deleted (ids are never reused), so it can never match again and is pruned here, under
  // the same mutex as the rewrite. A pin for THIS incarnation is still checked below and a changed
  // key on it still refuses: that is the guard, and binding to the id is what keeps it meaningful.
  const family = gcpIapHostKeyAliasFamily(input.identity);
  const inFamily = (host: string) => host === family || host.startsWith(`${family}-`);
  const received = guestHostKeys(input.attributes);
  const directory = dirname(input.knownHostsFile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let current = '';
  try {
    const metadata = await lstat(input.knownHostsFile);
    if (!metadata.isFile()) {
      throw new WorkspaceHostInitializationHostKeyError('known_hosts path is not a regular file');
    }
    current = await readFile(input.knownHostsFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await hooks.afterRead?.();

  const kept: string[] = [];
  const trusted = new Map<string, string>();
  for (const line of current.replace(/\n$/, '').split('\n')) {
    if (!line && current === '') continue;
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const marked = fields[0]?.startsWith('@') === true;
    const hostField = fields[marked ? 1 : 0] ?? '';
    if (hostField === alias) {
      if (marked) {
        throw new WorkspaceHostInitializationHostKeyError('known_hosts contains a marked controller-alias entry');
      }
      const parsed = parsePublicKeyLine(trimmed.slice(hostField.length).trimStart());
      if (trusted.has(parsed.algorithm)) {
        throw new WorkspaceHostInitializationHostKeyError(`known_hosts contains duplicate '${parsed.algorithm}' keys`);
      }
      trusted.set(parsed.algorithm, parsed.key);
      continue;
    }
    if (inFamily(hostField)) {
      if (marked) {
        throw new WorkspaceHostInitializationHostKeyError('known_hosts contains a marked controller-alias entry');
      }
      continue;
    }
    if (hostField.split(',').some(inFamily)) {
      throw new WorkspaceHostInitializationHostKeyError(
        'known_hosts embeds the controller alias in a multi-host entry',
      );
    }
    kept.push(line);
  }
  for (const [algorithm, key] of trusted) {
    if (received.get(algorithm) !== key) {
      throw new WorkspaceHostInitializationHostKeyError(`'${algorithm}' host key changed or disappeared`);
    }
  }

  const enrolled = HOST_KEY_ALGORITHMS.flatMap((algorithm) => {
    const key = received.get(algorithm);
    return key ? [`${alias} ${algorithm} ${key}`] : [];
  });
  const next = [...kept, ...enrolled].join('\n') + '\n';
  if (next === current) {
    await chmod(input.knownHostsFile, 0o600);
    return;
  }

  const temporary = `${input.knownHostsFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, input.knownHostsFile);
    await chmod(input.knownHostsFile, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Every clustered dev-api worker shares the same systemd StateDirectory. The in-process queue
 * avoids redundant contention inside one worker; the filesystem mutex is the authoritative
 * cross-process guard. Both key off the normalized trust-file path so two atomic renames cannot
 * each preserve a stale snapshot and lose the other host's alias.
 */
export function enrollGcpIapHostKeys(
  input: GcpIapHostKeyEnrollmentInput,
  hooks: GcpIapHostKeyEnrollmentTestHooks = {},
): Promise<void> {
  if (!isAbsolute(input.knownHostsFile)) {
    return Promise.reject(new WorkspaceHostInitializationHostKeyError('known_hosts path must be absolute'));
  }
  const knownHostsFile = resolve(input.knownHostsFile);
  const prior = hostKeyEnrollmentQueues.get(knownHostsFile) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(async () => {
      await hooks.beforeMutex?.();
      return withFsMutex(
        hostKeyEnrollmentMutexName(knownHostsFile),
        () => enrollGcpIapHostKeysUnlocked({ ...input, knownHostsFile }, hooks),
        { timeoutMs: 30_000, staleMs: 60_000, retryMs: 20 },
      );
    });
  hostKeyEnrollmentQueues.set(knownHostsFile, run);
  return run.finally(() => {
    if (hostKeyEnrollmentQueues.get(knownHostsFile) === run) hostKeyEnrollmentQueues.delete(knownHostsFile);
  });
}

async function pruneGcpIapHostKeysForAbsentHostUnlocked(
  input: GcpIapHostKeyPruneInput,
  hooks: GcpIapHostKeyPruneTestHooks,
): Promise<GcpIapHostKeyPruneResult> {
  if (!(await input.confirmHostAbsent())) {
    throw new WorkspaceHostInitializationHostKeyError(
      'controller pins may be pruned only after a fresh workspace-host read confirms desired and observed absent',
    );
  }

  const family = gcpIapHostKeyAliasFamily(input.identity);
  const inFamily = (host: string) => host === family || host.startsWith(`${family}-`);
  let current = '';
  try {
    const metadata = await lstat(input.knownHostsFile);
    if (!metadata.isFile()) {
      throw new WorkspaceHostInitializationHostKeyError('known_hosts path is not a regular file');
    }
    current = await readFile(input.knownHostsFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await hooks.afterRead?.();

  const kept: string[] = [];
  let removedEntries = 0;
  for (const line of current === '' ? [] : current.replace(/\n$/, '').split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) {
      kept.push(line);
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const marked = fields[0]?.startsWith('@') === true;
    const hostField = fields[marked ? 1 : 0] ?? '';
    if (inFamily(hostField)) {
      if (marked) {
        throw new WorkspaceHostInitializationHostKeyError('known_hosts contains a marked controller-alias entry');
      }
      removedEntries += 1;
      continue;
    }
    if (hostField.split(',').some(inFamily)) {
      throw new WorkspaceHostInitializationHostKeyError(
        'known_hosts embeds the controller alias in a multi-host entry',
      );
    }
    kept.push(line);
  }

  if (removedEntries > 0) {
    const next = kept.length > 0 ? `${kept.join('\n')}\n` : '';
    const temporary = `${input.knownHostsFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, input.knownHostsFile);
      await chmod(input.knownHostsFile, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  // Verify the replacement while still holding the same cross-process lock used by enrollment.
  const written = removedEntries > 0 ? await readFile(input.knownHostsFile, 'utf8') : current;
  let remainingEntries = 0;
  for (const line of written === '' ? [] : written.replace(/\n$/, '').split('\n')) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(/\s+/);
    const hostField = fields[fields[0]?.startsWith('@') === true ? 1 : 0] ?? '';
    if (inFamily(hostField) || hostField.split(',').some(inFamily)) remainingEntries += 1;
  }
  if (remainingEntries > 0) {
    throw new WorkspaceHostInitializationHostKeyError(
      `known_hosts still contains ${remainingEntries} pin(s) for an absent host alias family`,
    );
  }
  return { aliasFamily: family, removedEntries, remainingEntries };
}

/**
 * Remove every incarnation pin for a GCP instance name, but only after the caller's fresh host-row
 * read confirms desired=observed=absent. This shares both the in-process queue and filesystem mutex
 * with enrollment, so a concurrent reenrollment cannot be lost to an atomic rewrite of a stale
 * snapshot.
 */
export function pruneGcpIapHostKeysForAbsentHost(
  input: GcpIapHostKeyPruneInput,
  hooks: GcpIapHostKeyPruneTestHooks = {},
): Promise<GcpIapHostKeyPruneResult> {
  if (!isAbsolute(input.knownHostsFile)) {
    return Promise.reject(new WorkspaceHostInitializationHostKeyError('known_hosts path must be absolute'));
  }
  const knownHostsFile = resolve(input.knownHostsFile);
  const prior = hostKeyEnrollmentQueues.get(knownHostsFile) ?? Promise.resolve();
  const run = prior
    .catch(() => undefined)
    .then(async () => {
      await hooks.beforeMutex?.();
      return withFsMutex(
        hostKeyEnrollmentMutexName(knownHostsFile),
        () => pruneGcpIapHostKeysForAbsentHostUnlocked({ ...input, knownHostsFile }, hooks),
        { timeoutMs: 30_000, staleMs: 60_000, retryMs: 20 },
      );
    });
  hostKeyEnrollmentQueues.set(knownHostsFile, run);
  return run.finally(() => {
    if (hostKeyEnrollmentQueues.get(knownHostsFile) === run) hostKeyEnrollmentQueues.delete(knownHostsFile);
  });
}

/** Raised when no initialization adapter exists for a host's provider target. */
export class UnsupportedWorkspaceHostInitializationTargetError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(
      `No workspace-host initialization adapter for target '${target}'. ` +
        `Only '${GCP_WORKSPACE_HOST_TARGET}' is implemented; AWS and Azure adapters are separate plan items.`,
    );
    this.name = 'UnsupportedWorkspaceHostInitializationTargetError';
    this.target = target;
  }
}

/**
 * The IAP SSH profile that reaches ONE incarnation of a GCP host through the controller's own,
 * already-enrolled trust store. It enrolls nothing: a caller that must DETECT a recreated machine
 * (the soak, D-391) uses this directly, so a new incarnation fails the host-key check instead of
 * being quietly re-pinned. Initialization builds its adapter from the same function, so the two
 * cannot disagree about the alias, user or trust store a host is reached with.
 */
export function resolveGcpIapWorkspaceHostInitializationProfile(
  desired: WorkspaceHostDesiredSpec,
  controller: WorkspaceHostInitializationControllerProfile,
  incarnation: { instanceId: string },
): GcpIapWorkspaceHostInitializationProfile {
  if (desired.target !== GCP_WORKSPACE_HOST_TARGET) {
    throw new UnsupportedWorkspaceHostInitializationTargetError(String(desired.target));
  }
  const identity = resolveGcpWorkspaceHostInstanceIdentity(desired);
  return {
    projectId: identity.projectId,
    zone: identity.zone,
    instanceName: identity.instanceName,
    instanceId: incarnation.instanceId,
    sshUser: controller.sshUser,
    knownHostsFile: controller.knownHostsFile,
    ...(controller.identityFile ? { identityFile: controller.identityFile } : {}),
    ...(controller.sshExecutable ? { sshExecutable: controller.sshExecutable } : {}),
    ...(controller.gcloudExecutable ? { gcloudExecutable: controller.gcloudExecutable } : {}),
    remoteEntrypoint: controller.remoteEntrypoint,
  };
}

/**
 * The Compute client a host's own recorded credential reference authorizes. Hosted delegation
 * refs resolve through the verified delegation on the host's CONNECTION — the same place
 * provisioning reads it (gcp-provider.ts); the desired spec never carries it. Every other ref
 * uses the controller's ADC.
 */
export function createGcpWorkspaceHostApiClientForDesired(
  desired: WorkspaceHostDesiredSpec,
  seams: {
    connectionProvider?: Readonly<Record<string, unknown>>;
    resolveHostedAuth?: typeof resolveHostedGcpAuth;
    gcpFetch?: typeof fetch;
  } = {},
): GcpWorkspaceHostApiClient {
  const credentialRef = desired.credentials.cloudCredentialRef.ref;
  const hosted = isHostedProviderCredentialRef(credentialRef);
  const { connectionProvider } = seams;
  if (hosted && !connectionProvider) throw new Error('gcp_workspace_host_hosted_connection_required');
  const acquireAuth = hosted
    ? () => (seams.resolveHostedAuth ?? resolveHostedGcpAuth)({ credentialRef, provider: connectionProvider! })
    : createGcpWorkspaceHostAcquireAuth(credentialRef);
  return createGcpWorkspaceHostApiClient({
    acquireAuth,
    credentialRef,
    ...(seams.gcpFetch ? { fetch: seams.gcpFetch } : {}),
  });
}

/**
 * Read the bootstrap's own status report from the instance's guest attributes — the channel
 * `bootstrapStatusChannel: 'gce-guest-attributes'` renders into the script (WI-10002837). An
 * absent or unparseable report is null (keep waiting); a Compute error propagates, and the
 * readiness wait treats it as no report.
 */
export function gcpBootstrapStatusSource(
  client: Pick<GcpWorkspaceHostApiClient, 'getInstanceGuestAttributes'>,
  identity: { projectId: string; zone: string; instanceName: string },
): GcpIapWorkspaceHostBootstrapStatusSource {
  const namespace = WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_NAMESPACE;
  return async () => {
    const attributes = await client.getInstanceGuestAttributes(
      identity.projectId,
      identity.zone,
      identity.instanceName,
      `${namespace}/`,
    );
    const report = attributes.find(
      (attribute) =>
        attribute.namespace === namespace &&
        attribute.key === WORKSPACE_HOST_BOOTSTRAP_STATUS_GUEST_ATTRIBUTE_KEY,
    );
    return report ? parseWorkspaceHostBootstrapReportedStatus(report.value) : null;
  };
}

/**
 * Build the concrete host adapter for a desired spec.
 *
 * Throws `UnsupportedWorkspaceHostInitializationTargetError` for a target with no adapter, and
 * propagates the provider's own validation errors (bad zone/region pairing, scope mismatch,
 * secret material in the provider record) unchanged — those are the provider's rules and this
 * resolver deliberately does not soften them.
 */
export function resolveWorkspaceHostInitializationOperations(
  desired: WorkspaceHostDesiredSpec,
  controller: WorkspaceHostInitializationControllerProfile,
  /** The live incarnation the trust pin was enrolled for — the SSH alias must name the same one. */
  incarnation: { instanceId: string },
  credentialMaterialSource?: WorkspaceHostCredentialMaterialSource,
  /** The bootstrap's out-of-band report, which lets the readiness wait fail fast (WI-10002837). */
  bootstrapStatus?: GcpIapWorkspaceHostBootstrapStatusSource,
): WorkspaceHostControllerOperations {
  const profile = resolveGcpIapWorkspaceHostInitializationProfile(desired, controller, incarnation);
  const { remoteEntrypoint: _remoteEntrypoint, ...transport } = profile;

  // The delivering wrapper is UNCONDITIONAL, not applied only when a material source is
  // configured. Delivery is required by the `git` and `agent` families whether or not this
  // controller can satisfy it, so the difference an absent source makes is WHICH error a binding
  // step fails with — a controller-side refusal naming the missing configuration, or the host's
  // `material is not present` message, which blames the host for the controller's gap. Wrapping
  // always is what keeps the honest one.
  return new GcpIapDeliveringWorkspaceHostInitializationOperations(
    new GcpIapWorkspaceHostInitializationOperations(profile, undefined, undefined, bootstrapStatus),
    { ...transport, deliveryEntrypoint: controller.deliveryEntrypoint },
    credentialMaterialSource ?? UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE,
  );
}

/**
 * The declared transport capabilities of the provider that will execute this host's operations.
 *
 * Read from the provider's own feature declaration rather than assumed: a target whose transport
 * cannot transfer files cannot carry the git or agent credential channels, and the planner refuses
 * those at plan time (D-215 point 6). Dispatching on target here — beside the adapter resolution
 * that already dispatches on it — is what keeps a future AWS/Azure adapter from silently
 * inheriting GCP's answer.
 */
export function resolveWorkspaceHostDeliveryCapabilities(
  desired: WorkspaceHostDesiredSpec,
): WorkspaceHostDeliveryCapabilities {
  if (desired.target !== GCP_WORKSPACE_HOST_TARGET) {
    throw new UnsupportedWorkspaceHostInitializationTargetError(String(desired.target));
  }
  return GCP_WORKSPACE_HOST_TRANSPORT_FEATURES;
}

/** Raised when the controller's own initialization settings are missing or unusable. */
export class WorkspaceHostInitializationControllerProfileError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Workspace-host initialization controller profile is not configured: ${problems.join('; ')}`);
    this.name = 'WorkspaceHostInitializationControllerProfileError';
    this.problems = problems;
  }
}

const CONTROLLER_ENV = {
  sshUser: 'PAPERCUSP_WORKSPACE_HOST_SSH_USER',
  knownHostsFile: 'PAPERCUSP_WORKSPACE_HOST_KNOWN_HOSTS',
  remoteEntrypoint: 'PAPERCUSP_WORKSPACE_HOST_REMOTE_ENTRYPOINT',
  deliveryEntrypoint: 'PAPERCUSP_WORKSPACE_HOST_CREDENTIAL_DELIVERY_ENTRYPOINT',
  identityFile: 'PAPERCUSP_WORKSPACE_HOST_IDENTITY_FILE',
  sshExecutable: 'PAPERCUSP_WORKSPACE_HOST_SSH_EXECUTABLE',
  gcloudExecutable: 'PAPERCUSP_WORKSPACE_HOST_GCLOUD_EXECUTABLE',
} as const;

const DEFAULT_CONTROLLER_REMOTE_ENTRYPOINT = WORKSPACE_HOST_REMOTE_INITIALIZER_CONDUIT;
const DEFAULT_CONTROLLER_DELIVERY_ENTRYPOINT = WORKSPACE_HOST_CREDENTIAL_DELIVERY_CONDUIT;
const SYSTEMD_STATE_DIRECTORY_ENV = 'STATE_DIRECTORY';

/**
 * Build the controller's own initialization profile from deployment configuration.
 *
 * These are controller-owned and host-INDEPENDENT on purpose: the known-hosts file is the
 * controller's trust store and the remote entrypoint is a fixed binary in the signed
 * workspace-host release. The SSH user and entrypoint come from the deployment-driver contract;
 * explicit environment values remain supported for development/test overrides. The packaged
 * systemd user service supplies one private StateDirectory, whose absolute runtime value becomes
 * the default trust-store parent. No per-host row can redirect any of these values.
 *
 * Both paths must be ABSOLUTE. A relative path would resolve against whatever working directory
 * the controller happened to start in, which turns the trust store and the entrypoint into
 * values that depend on how the process was launched — the exact property a trust store must not
 * have. Every problem is collected and reported together: a half-configured controller should
 * name all of its gaps once, not surface them one restart at a time.
 */
export function resolveWorkspaceHostInitializationControllerProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WorkspaceHostInitializationControllerProfile {
  const problems: string[] = [];

  const configured = (key: keyof typeof CONTROLLER_ENV, requireAbsolute: boolean): string | undefined => {
    const name = CONTROLLER_ENV[key];
    const raw = env[name];
    if (raw === undefined) return undefined;
    const value = raw.trim();
    if (!value) {
      problems.push(`${name} must not be empty when set`);
      return undefined;
    }
    if (requireAbsolute && !isAbsolute(value)) {
      problems.push(`${name} must be an absolute path (got '${value}')`);
      return undefined;
    }
    return value;
  };

  const sshUser = configured('sshUser', false) ?? DEFAULT_WORKSPACE_HOST_WORKSPACE_USER;
  const remoteEntrypoint = configured('remoteEntrypoint', true) ?? DEFAULT_CONTROLLER_REMOTE_ENTRYPOINT;
  const deliveryEntrypoint = configured('deliveryEntrypoint', true) ?? DEFAULT_CONTROLLER_DELIVERY_ENTRYPOINT;
  const configuredKnownHostsFile = configured('knownHostsFile', true);
  let knownHostsFile = configuredKnownHostsFile ?? '';
  if (!configuredKnownHostsFile && env[CONTROLLER_ENV.knownHostsFile] === undefined) {
    const stateDirectory = (env[SYSTEMD_STATE_DIRECTORY_ENV] ?? '').trim();
    if (!stateDirectory) {
      problems.push(`${CONTROLLER_ENV.knownHostsFile} is unset and ${SYSTEMD_STATE_DIRECTORY_ENV} is unavailable`);
    } else if (!isAbsolute(stateDirectory) || stateDirectory.includes(':')) {
      problems.push(`${SYSTEMD_STATE_DIRECTORY_ENV} must name one absolute directory`);
    } else {
      knownHostsFile = join(stateDirectory, 'known_hosts');
    }
  }

  const optional = (key: keyof typeof CONTROLLER_ENV, requireAbsolute: boolean): string | undefined => {
    const name = CONTROLLER_ENV[key];
    const value = (env[name] ?? '').trim();
    if (!value) return undefined;
    if (requireAbsolute && !isAbsolute(value)) {
      problems.push(`${name} must be an absolute path (got '${value}')`);
      return undefined;
    }
    return value;
  };

  const identityFile = optional('identityFile', true);
  const sshExecutable = optional('sshExecutable', false);
  const gcloudExecutable = optional('gcloudExecutable', false);

  if (problems.length > 0) throw new WorkspaceHostInitializationControllerProfileError(problems);

  return {
    sshUser,
    knownHostsFile,
    remoteEntrypoint,
    deliveryEntrypoint,
    ...(identityFile ? { identityFile } : {}),
    ...(sshExecutable ? { sshExecutable } : {}),
    ...(gcloudExecutable ? { gcloudExecutable } : {}),
  };
}

/** Raised when a host cannot be initialized because its provisioning intent is unavailable. */
export class WorkspaceHostDesiredSpecUnavailableError extends Error {
  readonly hostId: string;
  readonly reason: 'host-not-found' | 'no-recorded-spec';

  constructor(hostId: string, reason: 'host-not-found' | 'no-recorded-spec') {
    super(
      reason === 'host-not-found'
        ? `No workspace host '${hostId}' in this workspace`
        : `Workspace host '${hostId}' has no recorded provisioning intent, so the cloud instance ` +
            `to initialize cannot be identified. It was provisioned before the intent was persisted ` +
            `(migration 956), or by a provisioner that did not record it.`,
    );
    this.name = 'WorkspaceHostDesiredSpecUnavailableError';
    this.hostId = hostId;
    this.reason = reason;
  }
}

export interface ResolveOperationsForHostInput {
  workspaceId: string;
  hostId: string;
  controller: WorkspaceHostInitializationControllerProfile;
  /**
   * Resolves the authorization bytes a binding names. Omitted here means the controller has none,
   * and a channel that requires delivered material refuses by name instead of failing on the host.
   */
  credentialMaterialSource?: WorkspaceHostCredentialMaterialSource;
  /** Test seam; defaults to the durable host record. */
  readDesiredSpec?: typeof readWorkspaceHostDesiredSpec;
  /** Test seam; defaults to the durable connection record a hosted credential ref resolves through. */
  readConnection?: typeof readWorkspaceHostConnection;
  /** Test seam; production uses the persisted cloud credential reference. */
  gcpClient?: Pick<GcpWorkspaceHostApiClient, 'getInstance' | 'getInstanceGuestAttributes'>;
  /** Test seam for the real GCP client path. */
  gcpFetch?: typeof fetch;
  /** Test seam; production resolves only verified hosted delegation metadata to a short-lived token. */
  resolveHostedAuth?: typeof resolveHostedGcpAuth;
  /** Test seam; production atomically updates the controller-owned trust store. */
  enrollHostKeys?: (input: GcpIapHostKeyEnrollmentInput) => Promise<void>;
  /**
   * Budget/progress for waiting out the guest agent's `hostkeys/` publication (WI-10001685).
   * Omitted means the measured defaults; callers pass `onWaiting` to record durable progress.
   */
  awaitHostKeys?: WorkspaceHostHostKeyPublicationOptions;
}

/**
 * Resolve the concrete host adapter for an ALREADY-PROVISIONED host, by id.
 *
 * This is the production entry point: initialization is handed a hostId, and the instance it must
 * reach is recovered from the intent the provisioner recorded — never re-derived from the host's
 * observed columns, which do not carry the zone, the project, or an explicit instance name.
 * A host whose intent was never recorded REFUSES here rather than proceeding against a guessed
 * instance name, because the failure mode of guessing is a tunnel to an instance that does not
 * exist, visible only against real cloud.
 */
export async function resolveWorkspaceHostInitializationOperationsForHost(
  input: ResolveOperationsForHostInput,
): Promise<{
  desired: WorkspaceHostDesiredSpec;
  operations: WorkspaceHostControllerOperations;
  deliveryCapabilities: WorkspaceHostDeliveryCapabilities;
  /** The pinned SSH transport the operations use, for programs outside that protocol (D-403). */
  transport: GcpIapWorkspaceHostTransportProfile;
}> {
  const read = input.readDesiredSpec ?? readWorkspaceHostDesiredSpec;
  const lookup = await read(input.workspaceId, input.hostId);
  if (!lookup.desired) {
    throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, lookup.miss ?? 'no-recorded-spec');
  }
  const desired = lookup.desired;

  // Keep the provider boundary ahead of the GCP-only trust enrollment. Unsupported targets must
  // refuse without making a cloud call (or attempting to interpret an AWS/Azure spec as GCP).
  const deliveryCapabilities = resolveWorkspaceHostDeliveryCapabilities(desired);
  const identity = resolveGcpWorkspaceHostInstanceIdentity(desired);
  let connectionProvider: Readonly<Record<string, unknown>> | undefined;
  if (!input.gcpClient && isHostedProviderCredentialRef(desired.credentials.cloudCredentialRef.ref)) {
    const stored = lookup.connectionId
      ? await (input.readConnection ?? readWorkspaceHostConnection)(input.workspaceId, lookup.connectionId)
      : null;
    if (!stored) throw new Error('gcp_workspace_host_hosted_connection_missing');
    connectionProvider = stored.connection.provider ?? {};
  }
  const client =
    input.gcpClient ??
    createGcpWorkspaceHostApiClientForDesired(desired, {
      ...(connectionProvider ? { connectionProvider } : {}),
      ...(input.resolveHostedAuth ? { resolveHostedAuth: input.resolveHostedAuth } : {}),
      ...(input.gcpFetch ? { gcpFetch: input.gcpFetch } : {}),
    });
  // WI-10001685: wait out the guest agent's hostkeys/ publication instead of throwing on a fresh
  // VM. This read is the LAST thing resolution does and it runs BEFORE the initializer that owns
  // the bootstrap gate, so throwing here made that gate structurally unreachable and wrote no
  // operation row at all — the failure presented as `gcp_preflight_http_404 'hostkeys/'`.
  //
  // WI-10002493: the keys are pinned to the incarnation that published them, so the incarnation is
  // read on BOTH sides of the key read. A delete + re-insert landing in between would otherwise pin
  // one machine's keys under the other's id.
  const instanceId = await readInstanceIncarnation(client, identity);
  const attributes = await readPublishedHostKeys(
    client,
    identity,
    input.awaitHostKeys ?? {},
  );
  const confirmedInstanceId = await readInstanceIncarnation(client, identity);
  if (confirmedInstanceId !== instanceId) {
    throw new WorkspaceHostInitializationHostKeyError(
      `instance '${identity.instanceName}' was recreated while its host keys were read ` +
        `(incarnation ${instanceId} -> ${confirmedInstanceId}); retry the operation`,
    );
  }
  await (input.enrollHostKeys ?? enrollGcpIapHostKeys)({
    identity: { ...identity, instanceId },
    knownHostsFile: input.controller.knownHostsFile,
    attributes,
  });

  const { remoteEntrypoint: _remoteEntrypoint, ...transport } = resolveGcpIapWorkspaceHostInitializationProfile(
    desired,
    input.controller,
    { instanceId },
  );
  return {
    desired,
    operations: resolveWorkspaceHostInitializationOperations(
      desired,
      input.controller,
      { instanceId },
      input.credentialMaterialSource ?? UNCONFIGURED_WORKSPACE_HOST_CREDENTIAL_MATERIAL_SOURCE,
      gcpBootstrapStatusSource(client, identity),
    ),
    deliveryCapabilities,
    transport,
  };
}

/** Raised when the instance a host's intent names does not exist, or GCP will not identify it. */
export class WorkspaceHostInstanceUnavailableError extends Error {
  readonly instanceName: string;

  constructor(identity: { projectId: string; zone: string; instanceName: string }, detail: string) {
    super(
      `GCP instance '${identity.instanceName}' in ${identity.projectId}/${identity.zone} ${detail}`,
    );
    this.name = 'WorkspaceHostInstanceUnavailableError';
    this.instanceName = identity.instanceName;
  }
}

async function readInstanceIncarnation(
  client: Pick<GcpWorkspaceHostApiClient, 'getInstance'>,
  identity: { projectId: string; zone: string; instanceName: string },
): Promise<string> {
  const instance = await client.getInstance(identity.projectId, identity.zone, identity.instanceName);
  if (!instance) throw new WorkspaceHostInstanceUnavailableError(identity, 'does not exist');
  if (!instance.instanceId) {
    throw new WorkspaceHostInstanceUnavailableError(identity, 'was returned without an instance id');
  }
  return instance.instanceId;
}
