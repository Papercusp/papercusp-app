/**
 * Fixed observation + falsifiability core for the P-505 physical Phase B
 * bidirectional ref-announcement transfer.
 *
 * The checked-in scenario creates one fresh run-bound commit in each physical
 * device's own namespace, drives the production git-sync ref-announce legs,
 * and supplies the observations here. This module never opens a transport: it
 * proves that the exact signed namespace snapshot, ref, commit payload, and
 * reachable objects appeared on the opposite physical store after the fixed
 * production triggers. There is no caller-provided command or manifest seam.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deviceNamespaceKey } from './storage';
import {
  PHASE_A_POT_HOME,
  PHASE_A_REPO_KEY,
  physicalDrillGitSyncSlug,
  type PhysicalDrillGitSyncSlug,
} from './physical-drill-phase-a';
import { SIGREFS_REF, verifySigrefs, type SignedSigrefs } from './sigrefs';

export const PHASE_B_OBSERVATION_SCHEMA = 'hive-git-physical-phase-b-observation/v1' as const;
export const PHASE_B_INPUT_SCHEMA = 'hive-git-physical-phase-b-input/v1' as const;
export const PHASE_B_RESULT_SCHEMA = 'hive-git-physical-phase-b-result/v1' as const;
export const PHASE_B_PLAN_ITEM = 'P-303' as const;
export const PHASE_B_TRANSFER_TIMEOUT_MS = 20 * 60_000;

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;
const ZERO_OID = '0'.repeat(40);
const PAYLOAD_FILE = 'p505-phase-b.json';

export type PhysicalPhaseBDirection = 'tower-to-vm' | 'vm-to-tower';
export type PhysicalPhaseBHost = 'tower' | 'vm';

export type PhysicalPhaseBObservation = {
  schemaVersion: typeof PHASE_B_OBSERVATION_SCHEMA;
  hostId: PhysicalPhaseBHost;
  direction: PhysicalPhaseBDirection;
  observedAt: string;
  repoPath: string;
  sourceDeviceKey: string;
  namespace: string;
  ref: string;
  refOid: string | null;
  objectExists: boolean;
  payloadSha256: string | null;
  sigrefsOid: string | null;
  signedSigrefs: SignedSigrefs | null;
  objectCounts: {
    loose: number;
    packed: number;
    packs: number;
    totalStored: number;
    reachableFromTransfer: number;
  };
};

export type PhysicalPhaseBMutation = {
  method: 'git-plumbing-commit';
  sourceHost: PhysicalPhaseBHost;
  repoPath: string;
  ref: string;
  oid: string;
  payloadSha256: string;
  createdAt: string;
};

export type PhysicalPhaseBTrigger = {
  tool: 'git-sync:run';
  installSlug: PhysicalDrillGitSyncSlug;
  host: PhysicalPhaseBHost;
  role: 'source-publish' | 'destination-receive';
  fired: true;
  startedAt: string;
  finishedAt: string;
};

export type PhysicalPhaseBDirectionInput = {
  direction: PhysicalPhaseBDirection;
  sourceHost: PhysicalPhaseBHost;
  destinationHost: PhysicalPhaseBHost;
  sourceDeviceKey: string;
  destinationDeviceKey: string;
  window: { startedAt: string; finishedAt: string };
  mutation: PhysicalPhaseBMutation;
  triggers: {
    sourcePublish: PhysicalPhaseBTrigger;
    destinationReceive: PhysicalPhaseBTrigger;
  };
  observations: {
    sourceBefore: PhysicalPhaseBObservation;
    destinationBefore: PhysicalPhaseBObservation;
    sourceAfter: PhysicalPhaseBObservation;
    destinationAfter: PhysicalPhaseBObservation;
  };
  latencyMs: number;
};

export type PhysicalPhaseBInput = {
  schemaVersion: typeof PHASE_B_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  directions: [PhysicalPhaseBDirectionInput, PhysicalPhaseBDirectionInput];
};

export type PhysicalPhaseBVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_B_RESULT_SCHEMA;
    phase: 'B';
    planItem: typeof PHASE_B_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      freshRunBoundCommitInEachDeviceNamespace: true;
      sourceSigrefsAdvancedAfterEachCommit: true;
      canonicalRefAnnouncePublishAndReceiveTicksTriggered: true;
      exactSignedNamespaceSnapshotReachedPeer: true;
      exactCommitAndPayloadReachedPeer: true;
      referencedObjectsExistOnBothHosts: true;
      bidirectionalTransferObserved: true;
      nativeV2PackPathOnly: true;
    };
    directions: Array<{
      direction: PhysicalPhaseBDirection;
      ref: string;
      oid: string;
      latencyMs: number;
      reachableObjectCount: number;
      sourceStoredObjectsAfter: number;
      destinationStoredObjectsBefore: number;
      destinationStoredObjectsAfter: number;
      sigrefsVersion: number;
    }>;
  };
};

function git(
  repoPath: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): { ok: boolean; stdout: string } {
  const result = spawnSync('git', ['--git-dir', repoPath, ...args], {
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...options.env },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`physical Phase B git ${args.join(' ')} failed for ${repoPath}: ${result.stderr.trim()}`);
  }
  return { ok: result.status === 0, stdout: result.stdout.trim() };
}

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase B runId is invalid: ${runId}`);
}

function assertCanonicalRepoPath(repoPath: string): void {
  const suffix = join(PHASE_A_POT_HOME, `${PHASE_A_REPO_KEY}.git`);
  if (!isAbsolute(repoPath) || !resolve(repoPath).endsWith(suffix)) {
    throw new Error(`physical Phase B repo path must target ${suffix}: ${repoPath}`);
  }
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`physical Phase B expected a bare repo directory at ${repoPath}`);
  }
  if (git(repoPath, ['rev-parse', '--is-bare-repository']).stdout !== 'true') {
    throw new Error(`physical Phase B target is not a bare repository: ${repoPath}`);
  }
}

function sourceHost(direction: PhysicalPhaseBDirection): PhysicalPhaseBHost {
  return direction === 'tower-to-vm' ? 'tower' : 'vm';
}

function destinationHost(direction: PhysicalPhaseBDirection): PhysicalPhaseBHost {
  return direction === 'tower-to-vm' ? 'vm' : 'tower';
}

export function physicalPhaseBRef(
  direction: PhysicalPhaseBDirection,
  sourceDeviceKey: string,
  runId: string,
): string {
  assertRunId(runId);
  const namespace = deviceNamespaceKey(sourceDeviceKey);
  return `refs/namespaces/${namespace}/refs/heads/p505-phase-b-${direction}-${runId}`;
}

function countObjects(repoPath: string): { loose: number; packed: number; packs: number; totalStored: number } {
  const values = new Map<string, number>();
  for (const line of git(repoPath, ['count-objects', '-v']).stdout.split('\n')) {
    const match = line.match(/^([a-z-]+): (\d+)$/);
    if (match) values.set(match[1]!, Number(match[2]));
  }
  const loose = values.get('count') ?? -1;
  const packed = values.get('in-pack') ?? -1;
  const packs = values.get('packs') ?? -1;
  if (![loose, packed, packs].every(Number.isSafeInteger) || loose < 0 || packed < 0 || packs < 0) {
    throw new Error(`physical Phase B could not parse git count-objects for ${repoPath}`);
  }
  return { loose, packed, packs, totalStored: loose + packed };
}

function readSignedSigrefs(repoPath: string, sourceDeviceKey: string): {
  oid: string | null;
  signed: SignedSigrefs | null;
} {
  const namespace = deviceNamespaceKey(sourceDeviceKey);
  const ref = `refs/namespaces/${namespace}/${SIGREFS_REF}`;
  const resolved = git(repoPath, ['show-ref', '--verify', '--hash', ref], { allowFailure: true });
  if (!resolved.ok) return { oid: null, signed: null };
  if (!OID.test(resolved.stdout)) throw new Error(`physical Phase B observed malformed sigrefs OID: ${resolved.stdout}`);
  try {
    return {
      oid: resolved.stdout,
      signed: JSON.parse(git(repoPath, ['cat-file', 'blob', resolved.stdout]).stdout) as SignedSigrefs,
    };
  } catch {
    throw new Error(`physical Phase B sigrefs blob is not JSON for namespace ${namespace}`);
  }
}

export function capturePhysicalPhaseBRepo(input: {
  hostId: PhysicalPhaseBHost;
  direction: PhysicalPhaseBDirection;
  state: 'absent' | 'present';
  repoPath: string;
  sourceDeviceKey: string;
  runId: string;
  observedAt?: string;
}): PhysicalPhaseBObservation {
  assertCanonicalRepoPath(input.repoPath);
  const ref = physicalPhaseBRef(input.direction, input.sourceDeviceKey, input.runId);
  const resolved = git(input.repoPath, ['show-ref', '--verify', '--hash', ref], { allowFailure: true });
  if (input.state === 'absent' && resolved.ok) {
    throw new Error(`physical Phase B expected transfer ref absent but found ${ref}`);
  }
  if (input.state === 'present' && !resolved.ok) {
    throw new Error(`physical Phase B expected transfer ref present but did not find ${ref}`);
  }
  const refOid = resolved.ok ? resolved.stdout : null;
  if (refOid && !OID.test(refOid)) throw new Error(`physical Phase B observed malformed ref OID: ${refOid}`);
  const objectExists = refOid ? git(input.repoPath, ['cat-file', '-e', `${refOid}^{commit}`], { allowFailure: true }).ok : false;
  const payload = refOid
    ? git(input.repoPath, ['show', `${refOid}:${PAYLOAD_FILE}`], { allowFailure: true })
    : { ok: false, stdout: '' };
  const reachable = refOid
    ? git(input.repoPath, ['rev-list', '--objects', refOid]).stdout.split('\n').filter(Boolean).length
    : 0;
  const sigrefs = readSignedSigrefs(input.repoPath, input.sourceDeviceKey);
  const counts = countObjects(input.repoPath);
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error(`physical Phase B observedAt must be ISO-8601: ${observedAt}`);
  }
  return {
    schemaVersion: PHASE_B_OBSERVATION_SCHEMA,
    hostId: input.hostId,
    direction: input.direction,
    observedAt,
    repoPath: input.repoPath,
    sourceDeviceKey: input.sourceDeviceKey,
    namespace: deviceNamespaceKey(input.sourceDeviceKey),
    ref,
    refOid,
    objectExists,
    payloadSha256: payload.ok ? createHash('sha256').update(payload.stdout).digest('hex') : null,
    sigrefsOid: sigrefs.oid,
    signedSigrefs: sigrefs.signed,
    objectCounts: { ...counts, reachableFromTransfer: reachable },
  };
}

/**
 * What a `present` observation still lacks before it shows the post-commit
 * signed snapshot validateDirection requires (empty = converged): the transfer
 * ref at the fresh OID, a sigrefs version past the pre-commit one, and that
 * version signing the transfer ref at the same OID. The scenario polls on it
 * through `phase-b-observe ... <expected-oid> <before-sigrefs-version>`, which
 * exits 3 while it is non-empty. P-505 run 33b read the tower source once, 11s
 * after the fresh sigrefs were signed and announced but before its local
 * sigrefs ref moved, and rejected a transfer that had already reached the VM.
 */
export function phaseBObservationLag(
  observation: PhysicalPhaseBObservation,
  expected: { oid: string; beforeSigrefsVersion: number },
): string[] {
  const lagging: string[] = [];
  if (observation.refOid !== expected.oid) lagging.push('transfer ref');
  const signed = observation.signedSigrefs;
  if (!signed || signed.version <= expected.beforeSigrefsVersion) lagging.push('sigrefs version');
  const namespacedRef = observation.ref.split(`/namespaces/${observation.namespace}/`)[1];
  if (!signed?.refs.some((entry) => entry.ref === namespacedRef && entry.sha === expected.oid)) {
    lagging.push('signed transfer ref');
  }
  return lagging;
}

export function createPhysicalPhaseBCommit(input: {
  sourceHost: PhysicalPhaseBHost;
  direction: PhysicalPhaseBDirection;
  repoPath: string;
  sourceDeviceKey: string;
  runId: string;
  createdAt?: string;
}): PhysicalPhaseBMutation {
  assertCanonicalRepoPath(input.repoPath);
  if (input.sourceHost !== sourceHost(input.direction)) {
    throw new Error(`physical Phase B ${input.direction} must be authored on ${sourceHost(input.direction)}`);
  }
  const ref = physicalPhaseBRef(input.direction, input.sourceDeviceKey, input.runId);
  if (git(input.repoPath, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true }).ok) {
    throw new Error(`physical Phase B refuses a pre-existing transfer ref: ${ref}`);
  }
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`physical Phase B createdAt must be ISO-8601: ${createdAt}`);
  }
  const payload = `${JSON.stringify({
    schemaVersion: 'hive-git-physical-phase-b-payload/v1',
    runId: input.runId,
    direction: input.direction,
    sourceHost: input.sourceHost,
    sourceDeviceKey: input.sourceDeviceKey,
    createdAt,
  })}\n`;
  const payloadOid = git(input.repoPath, ['hash-object', '-w', '--stdin'], { input: payload }).stdout;
  const treeOid = git(input.repoPath, ['mktree'], {
    input: `100644 blob ${payloadOid}\t${PAYLOAD_FILE}\n`,
  }).stdout;
  const oid = git(input.repoPath, ['commit-tree', treeOid], {
    input: `P-505 Phase B ${input.direction} ${input.runId}\n`,
    env: {
      GIT_AUTHOR_NAME: 'Papercusp P-505 physical drill',
      GIT_AUTHOR_EMAIL: 'p505-physical@papercusp.local',
      GIT_AUTHOR_DATE: createdAt,
      GIT_COMMITTER_NAME: 'Papercusp P-505 physical drill',
      GIT_COMMITTER_EMAIL: 'p505-physical@papercusp.local',
      GIT_COMMITTER_DATE: createdAt,
    },
  }).stdout;
  if (!OID.test(oid)) throw new Error(`physical Phase B created malformed commit OID: ${oid}`);
  git(input.repoPath, ['update-ref', ref, oid, ZERO_OID]);
  return {
    method: 'git-plumbing-commit',
    sourceHost: input.sourceHost,
    repoPath: input.repoPath,
    ref,
    oid,
    payloadSha256: createHash('sha256').update(payload.trimEnd()).digest('hex'),
    createdAt,
  };
}

function time(value: string, label: string, errors: string[]): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

function validateObservation(
  observation: PhysicalPhaseBObservation,
  expected: {
    label: string;
    host: PhysicalPhaseBHost;
    direction: PhysicalPhaseBDirection;
    sourceDeviceKey: string;
    ref: string;
    present: boolean;
  },
  errors: string[],
): void {
  if (observation.schemaVersion !== PHASE_B_OBSERVATION_SCHEMA) {
    errors.push(`${expected.label} observation schema is invalid`);
  }
  if (observation.hostId !== expected.host) errors.push(`${expected.label} hostId is invalid`);
  if (observation.direction !== expected.direction) errors.push(`${expected.label} direction is invalid`);
  if (observation.sourceDeviceKey !== expected.sourceDeviceKey) {
    errors.push(`${expected.label} source device is invalid`);
  }
  if (observation.namespace !== deviceNamespaceKey(expected.sourceDeviceKey)) {
    errors.push(`${expected.label} namespace is not identity-derived`);
  }
  if (observation.ref !== expected.ref) errors.push(`${expected.label} transfer ref is invalid`);
  const counts = observation.objectCounts;
  if (
    !counts ||
    ![counts.loose, counts.packed, counts.packs, counts.totalStored, counts.reachableFromTransfer].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    counts.totalStored !== counts.loose + counts.packed
  ) {
    errors.push(`${expected.label} object counts are invalid`);
  }
  if (expected.present) {
    if (!observation.refOid || !OID.test(observation.refOid) || !observation.objectExists) {
      errors.push(`${expected.label} transfer commit must exist locally`);
    }
    if (!observation.payloadSha256 || !/^[0-9a-f]{64}$/.test(observation.payloadSha256)) {
      errors.push(`${expected.label} transfer payload hash is missing`);
    }
    if (counts?.reachableFromTransfer < 3) {
      errors.push(`${expected.label} transfer must expose commit, tree, and payload objects`);
    }
  } else if (
    observation.refOid !== null ||
    observation.objectExists ||
    observation.payloadSha256 !== null ||
    counts?.reachableFromTransfer !== 0
  ) {
    errors.push(`${expected.label} must prove the transfer ref absent before mutation`);
  }
}

function validateTrigger(
  trigger: PhysicalPhaseBTrigger,
  expectedHost: PhysicalPhaseBHost,
  expectedRole: PhysicalPhaseBTrigger['role'],
  errors: string[],
): void {
  if (
    trigger.tool !== 'git-sync:run' ||
    trigger.installSlug !== physicalDrillGitSyncSlug(expectedHost) ||
    trigger.host !== expectedHost ||
    trigger.role !== expectedRole ||
    trigger.fired !== true
  ) {
    errors.push(`Phase B ${expectedHost} ${expectedRole} must use the fixed canonical git-sync:run trigger`);
  }
}

function validateDirection(
  input: PhysicalPhaseBDirectionInput,
  runId: string,
  expectedSourceKey: string,
  expectedDestinationKey: string,
  errors: string[],
): void {
  const expectedSource = sourceHost(input.direction);
  const expectedDestination = destinationHost(input.direction);
  const expectedRef = physicalPhaseBRef(input.direction, expectedSourceKey, runId);
  if (input.sourceHost !== expectedSource || input.destinationHost !== expectedDestination) {
    errors.push(`${input.direction} physical endpoints are invalid`);
  }
  if (input.sourceDeviceKey !== expectedSourceKey || input.destinationDeviceKey !== expectedDestinationKey) {
    errors.push(`${input.direction} physical identities are invalid`);
  }
  if (
    input.mutation.method !== 'git-plumbing-commit' ||
    input.mutation.sourceHost !== expectedSource ||
    input.mutation.ref !== expectedRef ||
    !OID.test(input.mutation.oid) ||
    !/^[0-9a-f]{64}$/.test(input.mutation.payloadSha256)
  ) {
    errors.push(`${input.direction} mutation is not the fixed fresh Git-plumbing commit`);
  }
  validateTrigger(input.triggers.sourcePublish, expectedSource, 'source-publish', errors);
  validateTrigger(input.triggers.destinationReceive, expectedDestination, 'destination-receive', errors);

  const observations = input.observations;
  validateObservation(
    observations.sourceBefore,
    { label: `${input.direction}.sourceBefore`, host: expectedSource, direction: input.direction, sourceDeviceKey: expectedSourceKey, ref: expectedRef, present: false },
    errors,
  );
  validateObservation(
    observations.destinationBefore,
    { label: `${input.direction}.destinationBefore`, host: expectedDestination, direction: input.direction, sourceDeviceKey: expectedSourceKey, ref: expectedRef, present: false },
    errors,
  );
  validateObservation(
    observations.sourceAfter,
    { label: `${input.direction}.sourceAfter`, host: expectedSource, direction: input.direction, sourceDeviceKey: expectedSourceKey, ref: expectedRef, present: true },
    errors,
  );
  validateObservation(
    observations.destinationAfter,
    { label: `${input.direction}.destinationAfter`, host: expectedDestination, direction: input.direction, sourceDeviceKey: expectedSourceKey, ref: expectedRef, present: true },
    errors,
  );

  const ordered = [
    time(input.window.startedAt, `${input.direction}.window.startedAt`, errors),
    time(observations.sourceBefore.observedAt, `${input.direction}.sourceBefore.observedAt`, errors),
    time(observations.destinationBefore.observedAt, `${input.direction}.destinationBefore.observedAt`, errors),
    time(input.mutation.createdAt, `${input.direction}.mutation.createdAt`, errors),
    time(input.triggers.sourcePublish.startedAt, `${input.direction}.sourcePublish.startedAt`, errors),
    time(input.triggers.sourcePublish.finishedAt, `${input.direction}.sourcePublish.finishedAt`, errors),
    time(observations.sourceAfter.observedAt, `${input.direction}.sourceAfter.observedAt`, errors),
    time(input.triggers.destinationReceive.startedAt, `${input.direction}.destinationReceive.startedAt`, errors),
    time(input.triggers.destinationReceive.finishedAt, `${input.direction}.destinationReceive.finishedAt`, errors),
    time(observations.destinationAfter.observedAt, `${input.direction}.destinationAfter.observedAt`, errors),
    time(input.window.finishedAt, `${input.direction}.window.finishedAt`, errors),
  ];
  if (ordered.some((value, index) => index > 0 && value < ordered[index - 1]!)) {
    errors.push(`${input.direction} observations do not preserve commit-before-publish-before-receive causal order`);
  }
  const measuredLatency = ordered[9]! - ordered[4]!;
  if (
    !Number.isSafeInteger(input.latencyMs) ||
    input.latencyMs < 0 ||
    input.latencyMs > PHASE_B_TRANSFER_TIMEOUT_MS ||
    input.latencyMs !== measuredLatency
  ) {
    errors.push(`${input.direction} latencyMs must exactly measure the bounded physical transfer`);
  }

  const sourceBeforeSigrefs = observations.sourceBefore.signedSigrefs;
  const destinationBeforeSigrefs = observations.destinationBefore.signedSigrefs;
  const sourceAfterSigrefs = observations.sourceAfter.signedSigrefs;
  const destinationAfterSigrefs = observations.destinationAfter.signedSigrefs;
  for (const [label, observation, signed] of [
    ['sourceBefore', observations.sourceBefore, sourceBeforeSigrefs],
    ['destinationBefore', observations.destinationBefore, destinationBeforeSigrefs],
    ['sourceAfter', observations.sourceAfter, sourceAfterSigrefs],
    ['destinationAfter', observations.destinationAfter, destinationAfterSigrefs],
  ] as const) {
    if (!signed || !observation.sigrefsOid || !OID.test(observation.sigrefsOid) || !verifySigrefs(signed, expectedSourceKey)) {
      errors.push(`${input.direction}.${label} must contain the source device's valid signed sigrefs`);
    }
  }
  if (
    observations.sourceBefore.sigrefsOid !== observations.destinationBefore.sigrefsOid ||
    sourceBeforeSigrefs?.version !== destinationBeforeSigrefs?.version
  ) {
    errors.push(`${input.direction} must start from the same source sigrefs snapshot on both physical stores`);
  }
  if (
    observations.sourceAfter.sigrefsOid !== observations.destinationAfter.sigrefsOid ||
    sourceAfterSigrefs?.version !== destinationAfterSigrefs?.version
  ) {
    errors.push(`${input.direction} destination must receive the exact post-commit signed sigrefs snapshot`);
  }
  if ((sourceAfterSigrefs?.version ?? -1) <= (sourceBeforeSigrefs?.version ?? Number.MAX_SAFE_INTEGER)) {
    errors.push(`${input.direction} source sigrefs version must advance after the fresh commit`);
  }
  const signedTransfer = sourceAfterSigrefs?.refs.find((entry) => entry.ref === expectedRef.split(`/namespaces/${deviceNamespaceKey(expectedSourceKey)}/`)[1]);
  if (!signedTransfer || signedTransfer.sha !== input.mutation.oid) {
    errors.push(`${input.direction} post-commit sigrefs must sign the exact fresh transfer ref and OID`);
  }
  if (
    observations.sourceAfter.refOid !== input.mutation.oid ||
    observations.destinationAfter.refOid !== input.mutation.oid ||
    observations.sourceAfter.payloadSha256 !== input.mutation.payloadSha256 ||
    observations.destinationAfter.payloadSha256 !== input.mutation.payloadSha256
  ) {
    errors.push(`${input.direction} source and destination must contain the exact fresh commit payload`);
  }
  if (
    observations.sourceAfter.objectCounts.reachableFromTransfer !==
    observations.destinationAfter.objectCounts.reachableFromTransfer
  ) {
    errors.push(`${input.direction} source and destination reachable object counts must match exactly`);
  }
}

export function validatePhysicalPhaseB(input: PhysicalPhaseBInput): PhysicalPhaseBVerdict {
  const errors: string[] = [];
  if (input.schemaVersion !== PHASE_B_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_B_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input.runId)) errors.push('runId is invalid');
  let towerNamespace = '';
  let vmNamespace = '';
  try {
    towerNamespace = deviceNamespaceKey(input.identities.towerDeviceKey);
    vmNamespace = deviceNamespaceKey(input.identities.vmDeviceKey);
    if (towerNamespace === vmNamespace) errors.push('tower and vm identities must be distinct');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const startedAt = time(input.window.startedAt, 'window.startedAt', errors);
  const finishedAt = time(input.window.finishedAt, 'window.finishedAt', errors);
  if (finishedAt < startedAt) errors.push('Phase B window must finish after it starts');
  if (!Array.isArray(input.directions) || input.directions.length !== 2) {
    errors.push('Phase B requires exactly two physical directions');
  } else {
    const byDirection = new Map(input.directions.map((direction) => [direction.direction, direction]));
    if (byDirection.size !== 2 || !byDirection.has('tower-to-vm') || !byDirection.has('vm-to-tower')) {
      errors.push('Phase B requires tower-to-vm and vm-to-tower exactly once');
    } else {
      validateDirection(
        byDirection.get('tower-to-vm')!,
        input.runId,
        input.identities.towerDeviceKey,
        input.identities.vmDeviceKey,
        errors,
      );
      validateDirection(
        byDirection.get('vm-to-tower')!,
        input.runId,
        input.identities.vmDeviceKey,
        input.identities.towerDeviceKey,
        errors,
      );
      const towerFinished = Date.parse(byDirection.get('tower-to-vm')!.window.finishedAt);
      const reverseStarted = Date.parse(byDirection.get('vm-to-tower')!.window.startedAt);
      if (!Number.isFinite(towerFinished) || !Number.isFinite(reverseStarted) || reverseStarted < towerFinished) {
        errors.push('Phase B reverse direction must start after tower-to-vm completes');
      }
    }
  }
  const uniqueErrors = [...new Set(errors)];
  const directions = input.directions ?? [];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    result:
      uniqueErrors.length > 0
        ? null
        : {
            schemaVersion: PHASE_B_RESULT_SCHEMA,
            phase: 'B',
            planItem: PHASE_B_PLAN_ITEM,
            status: 'complete',
            complete: true,
            missingAssertions: [],
            observedAt: input.window.finishedAt,
            assertions: {
              freshRunBoundCommitInEachDeviceNamespace: true,
              sourceSigrefsAdvancedAfterEachCommit: true,
              canonicalRefAnnouncePublishAndReceiveTicksTriggered: true,
              exactSignedNamespaceSnapshotReachedPeer: true,
              exactCommitAndPayloadReachedPeer: true,
              referencedObjectsExistOnBothHosts: true,
              bidirectionalTransferObserved: true,
              nativeV2PackPathOnly: true,
            },
            directions: directions.map((direction) => ({
              direction: direction.direction,
              ref: direction.mutation.ref,
              oid: direction.mutation.oid,
              latencyMs: direction.latencyMs,
              reachableObjectCount: direction.observations.destinationAfter.objectCounts.reachableFromTransfer,
              sourceStoredObjectsAfter: direction.observations.sourceAfter.objectCounts.totalStored,
              destinationStoredObjectsBefore: direction.observations.destinationBefore.objectCounts.totalStored,
              destinationStoredObjectsAfter: direction.observations.destinationAfter.objectCounts.totalStored,
              sigrefsVersion: direction.observations.destinationAfter.signedSigrefs!.version,
            })),
          },
  };
}
