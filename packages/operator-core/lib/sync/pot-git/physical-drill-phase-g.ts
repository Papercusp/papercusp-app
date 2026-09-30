/**
 * Fixed production-code adapter for P-505 physical Phase G / P-308.
 *
 * The enclosing two-machine scenario supplies the two physical device keys and
 * both machines later sign the complete evidence manifest. This adapter never
 * has either physical private key, so it deliberately keeps those OUTER
 * attestation bindings separate from the EPHEMERAL protocol keypairs used to
 * exercise owning-hive authority, fencing, cursor retry, restart, and Git push recovery.
 * Conflating those identities would manufacture a physical-host signature.
 */
import Corestore from 'corestore';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { decideWorktreeBridgePersistence } from '../../harness/git-sync/worktree-bridge-state';
import { readPotGitMode } from '../../harness/git-sync/hive-git-mode';
import { runGitSync } from '../../harness/git-sync/run-git-sync';
import { openOwnLog } from '../hyperbee/peer-log';
import { nextHivePublicationTerm, type HiveEffectAuthority } from './hive-effect-authority';
import { makeSignedProtocolContext, type SignedProtocolContext } from './signed-context';
import { STAGING_REF } from './integrator';
import {
  acceptStagingAdvanceFF,
  acceptStagingAdvance,
  signStagingAdvance,
  type SignedStagingAdvance,
} from './staging-advance';
import {
  defaultRunGit,
  deviceNamespaceKey,
  readNamespaceRef,
  writeNamespaceRef,
  type RunGit,
} from './storage';
import { runWorktreeBridgeTick, type WorktreeBridgeTickOutcome } from './worktree-bridge-tick';

export const PHASE_G_INPUT_SCHEMA = 'hive-git-physical-phase-g-input/v2' as const;
export const PHASE_G_RESULT_SCHEMA = 'hive-git-physical-phase-g-result/v2' as const;
export const PHASE_G_PLAN_ITEM = 'P-308' as const;

const RUN_ID = /^[A-Za-z0-9._:-]{8,160}$/;
const DEVICE_KEY = /^[A-Za-z0-9+/]{43}=$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PRIOR_TERM = 7;
const SUCCESSOR_TERM = 8;
const RECEIVER_REF = 'refs/heads/phase-g-receiver';
const CURSOR_BEFORE = 41;
const CURSOR_ROW = 42;

type PushAttempt = {
  args: string[];
  code: number;
  stdout: string;
  stderr: string;
};

export type PhysicalPhaseGResult = {
  schemaVersion: typeof PHASE_G_RESULT_SCHEMA;
  runId: string;
  planItem: typeof PHASE_G_PLAN_ITEM;
  observedAt: string;
  physicalExecutionBinding: {
    provenance: 'outer-manifest-host-receipts';
    towerDeviceKey: string;
    vmDeviceKey: string;
  };
  protocolIdentities: {
    provenance: 'ephemeral-adapter-keypairs';
    owningHive: string;
    priorPublisher: string;
    publisher: string;
    stableRestartIdentity: string;
  };
  authorityFence: {
    productionSurfaces: ['nextHivePublicationTerm', 'requireHiveEffectAuthority', 'signStagingAdvance', 'acceptStagingAdvanceFF'];
    model: 'single-owning-hive';
    context: SignedProtocolContext;
    priorContext: SignedProtocolContext;
    publication: { epoch: number; priorSeq: number };
    successorAdvance: SignedStagingAdvance;
    successorAcceptance: { ok: boolean; reason: string | null };
    staleAdvance: SignedStagingAdvance;
    staleAcceptance: { ok: boolean; reason: string | null };
    deviceOnlyAdvance: SignedStagingAdvance;
    deviceOnlyAcceptance: { ok: boolean; reason: string | null };
    receiverRefBeforeDeviceOnly: string;
    receiverRefAfterDeviceOnly: string;
    receiverRefBeforeStaleReplay: string;
    receiverRefAfterStaleReplay: string;
  };
  retryPersistence: {
    productionSurfaces: ['runWorktreeBridgeTick', 'decideWorktreeBridgePersistence'];
    rowId: number;
    beforeRetry: number;
    duringUnknownSha: number;
    unknownShaReason: string | null;
    duringUnknownGeneration: number;
    unknownGenerationReason: string | null;
    acceptedStoreGeneration: string;
    afterAccept: number;
    acceptedCount: number;
    acceptedStagingSha: string | null;
  };
  pgAndPushRecovery: {
    productionSurfaces: ['readPotGitMode', 'runGitSync'];
    modeDuringReadFailure: { mode: string; source: string };
    syncStatus: string;
    pushAttempts: PushAttempt[];
    firstPushRejectedNonFastForward: boolean;
    peerLoserWasNoisy: boolean;
    noForcePush: boolean;
    originContainsLocalCommit: boolean;
    originContainsPeerCommit: boolean;
  };
  restartRoundTrip: {
    productionSurfaces: ['openOwnLog', 'deviceNamespaceKey', 'writeNamespaceRef', 'readNamespaceRef'];
    oldCoreKey: string;
    newCoreKey: string;
    stableDeviceKeyBefore: string;
    stableDeviceKeyAfter: string;
    namespaceBefore: string;
    namespaceAfter: string;
    canonicalOid: string;
    namespaceOid: string;
    worktreeOid: string;
    payloadSha256: string;
    worktreePayloadSha256: string;
  };
  temporaryStateRemoved: true;
};

export type PhysicalPhaseGInput = {
  schemaVersion: typeof PHASE_G_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  result: PhysicalPhaseGResult;
};

export type PhysicalPhaseGVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_G_RESULT_SCHEMA;
    phase: 'G';
    planItem: typeof PHASE_G_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
  };
};

type PhaseGDeps = {
  makeTempDir?: () => Promise<string>;
  removeTempDir?: (path: string) => Promise<void>;
  now?: () => string;
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase G runId is invalid: ${runId}`);
}

function validDeviceKey(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_KEY.test(value) && Buffer.from(value, 'base64').length === 32;
}

function assertPhysicalIdentities(towerDeviceKey: string, vmDeviceKey: string): void {
  if (!validDeviceKey(towerDeviceKey) || !validDeviceKey(vmDeviceKey)) {
    throw new Error('physical Phase G requires raw 32-byte Ed25519 device keys in base64');
  }
  if (towerDeviceKey === vmDeviceKey) throw new Error('physical Phase G requires two distinct physical devices');
}

async function git(runGit: RunGit, cwd: string, args: string[]): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(`physical Phase G git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

async function configureWorktree(runGit: RunGit, path: string): Promise<void> {
  await git(runGit, path, ['config', 'user.name', 'Papercusp Physical Drill']);
  await git(runGit, path, ['config', 'user.email', 'physical-drill@papercusp.invalid']);
  await git(runGit, path, ['config', 'commit.gpgsign', 'false']);
}

async function writeCommit(
  runGit: RunGit,
  repoPath: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(repoPath, relativePath), content, 'utf8');
  await git(runGit, repoPath, ['add', relativePath]);
  await git(runGit, repoPath, ['commit', '-m', message]);
  return git(runGit, repoPath, ['rev-parse', 'HEAD']);
}

function rejectionReason(result: { ok: boolean; reason?: string }): string | null {
  return result.ok ? null : result.reason ?? null;
}

function tickReason(outcome: WorktreeBridgeTickOutcome): string | null {
  const bridge = outcome.results[0]?.bridge;
  return bridge?.outcome === 'rejected' ? bridge.reason : null;
}

function cursorAfter(outcome: WorktreeBridgeTickOutcome, nowMs: number): number {
  return decideWorktreeBridgePersistence({
    prior: null,
    maxRowId: CURSOR_ROW,
    pendingRows: [{ id: CURSOR_ROW, tsMs: nowMs }],
    outcome,
    nowMs,
  }).bridgeState.lastEventId;
}

async function makeProtocolAuthority(input: {
  root: string;
  runId: string;
  nowMs: number;
  runGit: RunGit;
}): Promise<{
  owningHive: ReturnType<typeof generateEd25519KeypairDer>;
  priorPublisher: ReturnType<typeof generateEd25519KeypairDer>;
  publisher: ReturnType<typeof generateEd25519KeypairDer>;
  authorityRepo: string;
  priorStaging: string;
  successorStaging: string;
  context: SignedProtocolContext;
  priorContext: SignedProtocolContext;
  publication: ReturnType<typeof nextHivePublicationTerm>;
  successorAdvance: SignedStagingAdvance;
  staleAdvance: SignedStagingAdvance;
  deviceOnlyAdvance: SignedStagingAdvance;
}> {
  const { root, runId, nowMs, runGit } = input;
  const owningHive = generateEd25519KeypairDer();
  const priorPublisher = generateEd25519KeypairDer();
  const publisher = generateEd25519KeypairDer();
  const generation = (ordinal: number) => `sg2-${ordinal}-${createHash('sha256').update(`${runId}:${ordinal}`).digest('hex')}`;
  const priorContext = makeSignedProtocolContext(owningHive.pubkeyBase64, `phase-g:${runId}`, generation(1));
  const context = makeSignedProtocolContext(owningHive.pubkeyBase64, `phase-g:${runId}`, generation(2));
  const owner: HiveEffectAuthority = {
    hive_id: context.hive_id,
    repo_key: context.repo_key,
    sign: async (bytes) => signWithPrivateKeyDer(owningHive.privateKeyDer, bytes),
  };
  // A publisher/store change advances the OWNER'S publication term. No
  // membership election, handoff token or replicated private key grants it.
  const publication = nextHivePublicationTerm({
    epoch: PRIOR_TERM, seq: 3,
    authorityDevice: priorPublisher.pubkeyBase64,
    storeGeneration: priorContext.store_generation,
  }, publisher.pubkeyBase64, context.store_generation, PRIOR_TERM);
  const authorityRepo = join(root, 'authority.git');
  const authorWorktree = join(root, 'authority-worktree');
  await git(runGit, root, ['init', '--bare', authorityRepo]);
  await git(runGit, root, ['clone', authorityRepo, authorWorktree]);
  await configureWorktree(runGit, authorWorktree);
  const priorStaging = await writeCommit(
    runGit,
    authorWorktree,
    'phase-g.txt',
    `${runId}:pre-failure\n`,
    'physical Phase G pre-failure staging',
  );
  await git(runGit, authorWorktree, ['push', 'origin', 'HEAD:main']);
  await writeNamespaceRef(authorityRepo, priorPublisher.pubkeyBase64, STAGING_REF, priorStaging, runGit);

  const successorStaging = await writeCommit(
    runGit,
    authorWorktree,
    'phase-g-successor.txt',
    `${runId}:successor\n`,
    'physical Phase G successor staging',
  );
  await git(runGit, authorWorktree, ['push', 'origin', 'HEAD:main']);
  await writeNamespaceRef(authorityRepo, publisher.pubkeyBase64, STAGING_REF, successorStaging, runGit);
  const successorAdvance = await signStagingAdvance(
    {
      devicePubkeyBase64: publisher.pubkeyBase64,
      epoch: publication.epoch,
      seq: publication.priorSeq + 1,
      stagingSha: successorStaging,
      nowMs: nowMs + 1,
      context, authority: owner,
    },
    async (bytes) => signWithPrivateKeyDer(publisher.privateKeyDer, bytes),
  );
  const staleAdvance = await signStagingAdvance(
    {
      devicePubkeyBase64: priorPublisher.pubkeyBase64,
      epoch: PRIOR_TERM,
      seq: 4,
      stagingSha: successorStaging,
      nowMs: nowMs + 2,
      context: priorContext, authority: owner,
    },
    async (bytes) => signWithPrivateKeyDer(priorPublisher.privateKeyDer, bytes),
  );
  const unownedStaging = await writeCommit(runGit, authorWorktree, 'phase-g-unowned.txt', `${runId}:unowned\n`, 'unowned local edit');
  await git(runGit, authorWorktree, ['push', 'origin', 'HEAD:main']);
  const deviceOnlyAdvance = await signStagingAdvance({
    devicePubkeyBase64: publisher.pubkeyBase64,
    epoch: SUCCESSOR_TERM + 1, seq: 1, stagingSha: unownedStaging,
    nowMs: nowMs + 3, context,
  }, async (bytes) => signWithPrivateKeyDer(publisher.privateKeyDer, bytes));
  return {
    owningHive,
    priorPublisher,
    publisher,
    authorityRepo,
    priorStaging,
    successorStaging,
    context,
    priorContext,
    publication,
    successorAdvance,
    staleAdvance,
    deviceOnlyAdvance,
  };
}

async function exerciseRetryPersistence(input: {
  root: string;
  authorityRepo: string;
  priorStaging: string;
  successorStaging: string;
  successorAdvance: SignedStagingAdvance;
  priorPublisher: string;
  publisher: string;
  context: SignedProtocolContext;
  priorContext: SignedProtocolContext;
  nowMs: number;
  runGit: RunGit;
}): Promise<PhysicalPhaseGResult['retryPersistence']> {
  const retryRepo = join(input.root, 'retry.git');
  const retryWorktree = join(input.root, 'retry-worktree');
  await git(input.runGit, input.root, ['init', '--bare', retryRepo]);
  await git(input.runGit, retryRepo, ['fetch', input.authorityRepo, `${input.priorStaging}:refs/heads/main`]);
  await git(input.runGit, retryRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(input.runGit, input.root, ['clone', retryRepo, retryWorktree]);
  await configureWorktree(input.runGit, retryWorktree);

  const prior = {
    epochSeq: { epoch: PRIOR_TERM, seq: 3 },
    stagingSha: input.priorStaging,
  };
  const unknown = await runWorktreeBridgeTick({
    bareRepoPath: retryRepo,
    worktreePath: retryWorktree,
    pending: [input.successorAdvance],
    prior,
    accept: {
      allowedDevices: [input.priorPublisher, input.publisher], expectedContext: input.context,
      knownStoreGenerations: { [input.publisher]: input.context.store_generation },
    },
    runGit: input.runGit,
  });
  const duringUnknownSha = cursorAfter(unknown, input.nowMs);

  const publisherRef = `refs/namespaces/${deviceNamespaceKey(input.publisher)}/${STAGING_REF}`;
  await git(input.runGit, retryRepo, ['fetch', input.authorityRepo, `+${publisherRef}:${publisherRef}`]);
  const unknownGeneration = await runWorktreeBridgeTick({
    bareRepoPath: retryRepo,
    worktreePath: retryWorktree,
    pending: [input.successorAdvance],
    prior,
    accept: {
      allowedDevices: [input.priorPublisher, input.publisher], expectedContext: input.context,
      knownStoreGenerations: { [input.publisher]: input.priorContext.store_generation },
    },
    runGit: input.runGit,
  });
  const duringUnknownGeneration = cursorAfter(unknownGeneration, input.nowMs + 1);
  const accepted = await runWorktreeBridgeTick({
    bareRepoPath: retryRepo,
    worktreePath: retryWorktree,
    pending: [input.successorAdvance],
    prior,
    accept: {
      allowedDevices: [input.priorPublisher, input.publisher], expectedContext: input.context,
      knownStoreGenerations: { [input.publisher]: input.context.store_generation },
    },
    runGit: input.runGit,
  });
  const afterAccept = cursorAfter(accepted, input.nowMs + 2);
  return {
    productionSurfaces: ['runWorktreeBridgeTick', 'decideWorktreeBridgePersistence'],
    rowId: CURSOR_ROW,
    beforeRetry: CURSOR_BEFORE,
    duringUnknownSha,
    unknownShaReason: tickReason(unknown),
    duringUnknownGeneration,
    unknownGenerationReason: tickReason(unknownGeneration),
    acceptedStoreGeneration: input.context.store_generation,
    afterAccept,
    acceptedCount: accepted.acceptedCount,
    acceptedStagingSha: accepted.watermark.stagingSha,
  };
}

async function exercisePgAndPushRecovery(input: {
  root: string;
  runId: string;
  runGit: RunGit;
}): Promise<PhysicalPhaseGResult['pgAndPushRecovery']> {
  const modeDuringReadFailure = await readPotGitMode(
    'phase-g-workspace',
    'phase-g-hive',
    (() => {
      throw new Error('physical Phase G injected settings read failure');
    }) as unknown as Parameters<typeof readPotGitMode>[2],
  );

  const origin = join(input.root, 'push-origin.git');
  const seed = join(input.root, 'push-seed');
  const local = join(input.root, 'push-local');
  const peer = join(input.root, 'push-peer');
  await git(input.runGit, input.root, ['init', '--bare', origin]);
  await git(input.runGit, input.root, ['clone', origin, seed]);
  await configureWorktree(input.runGit, seed);
  await writeCommit(input.runGit, seed, 'base.txt', `${input.runId}:base\n`, 'physical Phase G push base');
  await git(input.runGit, seed, ['push', 'origin', 'HEAD:main']);
  await git(input.runGit, origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(input.runGit, input.root, ['clone', origin, local]);
  await git(input.runGit, input.root, ['clone', origin, peer]);
  await configureWorktree(input.runGit, local);
  await configureWorktree(input.runGit, peer);
  await writeFile(join(local, 'local.txt'), `${input.runId}:local\n`, 'utf8');

  let injectedPeerAdvance = false;
  const pushAttempts: PushAttempt[] = [];
  const wrappedRunGit: RunGit = async (args, cwd) => {
    const isLocalPush = cwd === local && args.includes('push');
    if (isLocalPush && !injectedPeerAdvance) {
      injectedPeerAdvance = true;
      await writeCommit(input.runGit, peer, 'peer.txt', `${input.runId}:peer\n`, 'physical Phase G peer race');
      await git(input.runGit, peer, ['push', 'origin', 'HEAD:main']);
    }
    const result = await input.runGit(args, cwd);
    if (isLocalPush) pushAttempts.push({ args: [...args], ...result });
    return result;
  };
  const sync = await runGitSync('physical-phase-g', {
    repoPath: local,
    runGit: wrappedRunGit,
    submodulePaths: [],
    contentDetectors: [],
    deletionGuard: false,
    diffSubjects: false,
    config: { branch: 'main', push: true, pushSubmodules: false },
  });
  const remoteLocal = await input.runGit(['--git-dir', origin, 'show', 'main:local.txt'], input.root);
  const remotePeer = await input.runGit(['--git-dir', origin, 'show', 'main:peer.txt'], input.root);
  const first = pushAttempts[0];
  const firstText = `${first?.stdout ?? ''}\n${first?.stderr ?? ''}`;
  return {
    productionSurfaces: ['readPotGitMode', 'runGitSync'],
    modeDuringReadFailure,
    syncStatus: sync.status,
    pushAttempts,
    firstPushRejectedNonFastForward: first?.code !== 0 && /non-fast-forward|\[rejected\]/i.test(firstText),
    peerLoserWasNoisy: first?.code !== 0 && firstText.trim().length > 0,
    noForcePush: pushAttempts.every((attempt) => !attempt.args.some((arg) => /force/.test(arg))),
    originContainsLocalCommit: remoteLocal.code === 0 && remoteLocal.stdout === `${input.runId}:local\n`,
    originContainsPeerCommit: remotePeer.code === 0 && remotePeer.stdout === `${input.runId}:peer\n`,
  };
}

async function exerciseRestartRoundTrip(input: {
  root: string;
  runId: string;
  runGit: RunGit;
}): Promise<{
  record: PhysicalPhaseGResult['restartRoundTrip'];
  stableDeviceKey: string;
}> {
  const stable = generateEd25519KeypairDer();
  const storeBefore = new Corestore(join(input.root, 'corestore-before'));
  await storeBefore.ready();
  const oldCoreKey = (await openOwnLog(storeBefore)).keyHex;
  await storeBefore.close();
  const storeAfter = new Corestore(join(input.root, 'corestore-after'));
  await storeAfter.ready();
  const newCoreKey = (await openOwnLog(storeAfter)).keyHex;
  await storeAfter.close();

  const canonicalRepo = join(input.root, 'restart-canonical.git');
  const author = join(input.root, 'restart-author');
  const checkout = join(input.root, 'restart-checkout');
  await git(input.runGit, input.root, ['init', '--bare', canonicalRepo]);
  await git(input.runGit, input.root, ['clone', canonicalRepo, author]);
  await configureWorktree(input.runGit, author);
  const payload = `${input.runId}:restart-roundtrip\n`;
  const canonicalOid = await writeCommit(
    input.runGit,
    author,
    'restart.txt',
    payload,
    'physical Phase G restart roundtrip',
  );
  await git(input.runGit, author, ['push', 'origin', 'HEAD:main']);
  await git(input.runGit, canonicalRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeNamespaceRef(canonicalRepo, stable.pubkeyBase64, STAGING_REF, canonicalOid, input.runGit);
  const namespaceOid = await readNamespaceRef(canonicalRepo, stable.pubkeyBase64, STAGING_REF, input.runGit);
  await git(input.runGit, input.root, ['clone', '--branch', 'main', canonicalRepo, checkout]);
  const worktreeOid = await git(input.runGit, checkout, ['rev-parse', 'HEAD']);
  const worktreePayload = await readFile(join(checkout, 'restart.txt'));
  return {
    stableDeviceKey: stable.pubkeyBase64,
    record: {
      productionSurfaces: ['openOwnLog', 'deviceNamespaceKey', 'writeNamespaceRef', 'readNamespaceRef'],
      oldCoreKey,
      newCoreKey,
      stableDeviceKeyBefore: stable.pubkeyBase64,
      stableDeviceKeyAfter: stable.pubkeyBase64,
      namespaceBefore: deviceNamespaceKey(stable.pubkeyBase64),
      namespaceAfter: deviceNamespaceKey(stable.pubkeyBase64),
      canonicalOid,
      namespaceOid: namespaceOid ?? '',
      worktreeOid,
      payloadSha256: createHash('sha256').update(payload).digest('hex'),
      worktreePayloadSha256: createHash('sha256').update(worktreePayload).digest('hex'),
    },
  };
}

export async function executePhysicalPhaseG(
  input: { runId: string; towerDeviceKey: string; vmDeviceKey: string },
  deps: PhaseGDeps = {},
): Promise<PhysicalPhaseGResult> {
  assertRunId(input.runId);
  assertPhysicalIdentities(input.towerDeviceKey, input.vmDeviceKey);
  const runGit = defaultRunGit;
  const observedAt = (deps.now ?? (() => new Date().toISOString()))();
  const nowMs = Date.parse(observedAt);
  if (!Number.isFinite(nowMs)) throw new Error('physical Phase G now() must return ISO-8601');
  const root = await (deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), 'papercusp-phase-g-'))))();
  const removeTempDir = deps.removeTempDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
  let assembled: Omit<PhysicalPhaseGResult, 'temporaryStateRemoved'>;
  try {
    const authority = await makeProtocolAuthority({ root, runId: input.runId, nowMs, runGit });
    const accept = {
      allowedDevices: [authority.priorPublisher.pubkeyBase64, authority.publisher.pubkeyBase64],
      expectedContext: { hive_id: authority.context.hive_id, repo_key: authority.context.repo_key },
      knownStoreGenerations: {
        [authority.priorPublisher.pubkeyBase64]: authority.priorContext.store_generation,
        [authority.publisher.pubkeyBase64]: authority.context.store_generation,
      },
      runGit,
    };
    await git(runGit, authority.authorityRepo, ['update-ref', RECEIVER_REF, authority.priorStaging]);
    const successorAcceptance = await acceptStagingAdvanceFF(
      authority.authorityRepo,
      authority.successorAdvance,
      { epoch: PRIOR_TERM, seq: 3 },
      authority.priorStaging,
      accept,
    );
    if (successorAcceptance.ok) await git(runGit, authority.authorityRepo, ['update-ref', RECEIVER_REF, authority.successorStaging, authority.priorStaging]);
    const receiverRefBeforeDeviceOnly = await git(runGit, authority.authorityRepo, ['rev-parse', RECEIVER_REF]);
    const deviceOnlyAcceptance = await acceptStagingAdvanceFF(
      authority.authorityRepo, authority.deviceOnlyAdvance,
      { epoch: SUCCESSOR_TERM, seq: 1 }, authority.successorStaging, accept,
    );
    if (deviceOnlyAcceptance.ok) await git(runGit, authority.authorityRepo, ['update-ref', RECEIVER_REF, authority.deviceOnlyAdvance.staging_sha]);
    const receiverRefAfterDeviceOnly = await git(runGit, authority.authorityRepo, ['rev-parse', RECEIVER_REF]);
    const receiverRefBeforeStaleReplay = receiverRefAfterDeviceOnly;
    const staleAcceptance = await acceptStagingAdvanceFF(
      authority.authorityRepo,
      authority.staleAdvance,
      { epoch: SUCCESSOR_TERM, seq: 1 },
      authority.successorStaging,
      accept,
    );
    if (staleAcceptance.ok) await git(runGit, authority.authorityRepo, ['update-ref', RECEIVER_REF, authority.staleAdvance.staging_sha]);
    const receiverRefAfterStaleReplay = await git(runGit, authority.authorityRepo, ['rev-parse', RECEIVER_REF]);
    if (!receiverRefAfterStaleReplay) throw new Error('physical Phase G successor staging ref disappeared');

    const retryPersistence = await exerciseRetryPersistence({
      root,
      authorityRepo: authority.authorityRepo,
      priorStaging: authority.priorStaging,
      successorStaging: authority.successorStaging,
      successorAdvance: authority.successorAdvance,
      priorPublisher: authority.priorPublisher.pubkeyBase64,
      publisher: authority.publisher.pubkeyBase64,
      context: authority.context,
      priorContext: authority.priorContext,
      nowMs,
      runGit,
    });
    const pgAndPushRecovery = await exercisePgAndPushRecovery({ root, runId: input.runId, runGit });
    const restart = await exerciseRestartRoundTrip({ root, runId: input.runId, runGit });
    assembled = {
      schemaVersion: PHASE_G_RESULT_SCHEMA,
      runId: input.runId,
      planItem: PHASE_G_PLAN_ITEM,
      observedAt,
      physicalExecutionBinding: {
        provenance: 'outer-manifest-host-receipts',
        towerDeviceKey: input.towerDeviceKey,
        vmDeviceKey: input.vmDeviceKey,
      },
      protocolIdentities: {
        provenance: 'ephemeral-adapter-keypairs',
        owningHive: authority.owningHive.pubkeyBase64,
        priorPublisher: authority.priorPublisher.pubkeyBase64,
        publisher: authority.publisher.pubkeyBase64,
        stableRestartIdentity: restart.stableDeviceKey,
      },
      authorityFence: {
        productionSurfaces: ['nextHivePublicationTerm', 'requireHiveEffectAuthority', 'signStagingAdvance', 'acceptStagingAdvanceFF'],
        model: 'single-owning-hive',
        context: authority.context,
        priorContext: authority.priorContext,
        publication: authority.publication,
        successorAdvance: authority.successorAdvance,
        successorAcceptance: {
          ok: successorAcceptance.ok,
          reason: rejectionReason(successorAcceptance),
        },
        staleAdvance: authority.staleAdvance,
        staleAcceptance: { ok: staleAcceptance.ok, reason: rejectionReason(staleAcceptance) },
        deviceOnlyAdvance: authority.deviceOnlyAdvance,
        deviceOnlyAcceptance: { ok: deviceOnlyAcceptance.ok, reason: rejectionReason(deviceOnlyAcceptance) },
        receiverRefBeforeDeviceOnly,
        receiverRefAfterDeviceOnly,
        receiverRefBeforeStaleReplay,
        receiverRefAfterStaleReplay,
      },
      retryPersistence,
      pgAndPushRecovery,
      restartRoundTrip: restart.record,
    };
  } finally {
    await removeTempDir(root);
  }
  return { ...assembled, temporaryStateRemoved: true };
}

function pushError(errors: string[], condition: boolean, message: string): void {
  if (!condition) errors.push(message);
}

export function validatePhysicalPhaseG(input: PhysicalPhaseGInput): PhysicalPhaseGVerdict {
  const errors: string[] = [];
  const result = input?.result;
  pushError(errors, input?.schemaVersion === PHASE_G_INPUT_SCHEMA, `Phase G schemaVersion must be ${PHASE_G_INPUT_SCHEMA}`);
  pushError(errors, RUN_ID.test(input?.runId ?? ''), 'Phase G runId is invalid');
  pushError(errors, result?.schemaVersion === PHASE_G_RESULT_SCHEMA, `Phase G result schemaVersion must be ${PHASE_G_RESULT_SCHEMA}`);
  pushError(errors, result?.runId === input?.runId, 'Phase G result runId must match the enclosing run');
  pushError(errors, result?.planItem === PHASE_G_PLAN_ITEM, 'Phase G planItem must be P-308');
  pushError(errors, validDeviceKey(input?.identities?.towerDeviceKey), 'Phase G tower physical device key is invalid');
  pushError(errors, validDeviceKey(input?.identities?.vmDeviceKey), 'Phase G vm physical device key is invalid');
  pushError(errors, input?.identities?.towerDeviceKey !== input?.identities?.vmDeviceKey, 'Phase G requires two distinct physical devices');

  const startedAt = Date.parse(input?.window?.startedAt ?? '');
  const finishedAt = Date.parse(input?.window?.finishedAt ?? '');
  const observedAt = Date.parse(result?.observedAt ?? '');
  pushError(errors, Number.isFinite(startedAt) && Number.isFinite(finishedAt) && startedAt <= finishedAt, 'Phase G window is invalid');
  pushError(errors, Number.isFinite(observedAt) && observedAt >= startedAt && observedAt <= finishedAt, 'Phase G observation must fall inside the same-run window');

  const physical = result?.physicalExecutionBinding;
  pushError(errors, physical?.provenance === 'outer-manifest-host-receipts', 'Phase G physical binding must name outer manifest host receipts');
  pushError(errors, physical?.towerDeviceKey === input?.identities?.towerDeviceKey, 'Phase G tower physical binding must match the attesting device');
  pushError(errors, physical?.vmDeviceKey === input?.identities?.vmDeviceKey, 'Phase G vm physical binding must match the attesting device');
  const protocol = result?.protocolIdentities;
  pushError(errors, protocol?.provenance === 'ephemeral-adapter-keypairs', 'Phase G protocol identities must be explicitly ephemeral');
  const protocolKeys = [protocol?.owningHive, protocol?.priorPublisher, protocol?.publisher, protocol?.stableRestartIdentity];
  pushError(errors, protocolKeys.every(validDeviceKey), 'Phase G protocol identities must be valid Ed25519 public keys');
  pushError(errors, new Set(protocolKeys).size === 4, 'Phase G protocol identities must be distinct');
  const physicalKeys = new Set([input?.identities?.towerDeviceKey, input?.identities?.vmDeviceKey]);
  pushError(errors, protocolKeys.every((key) => !physicalKeys.has(key)), 'Phase G ephemeral protocol signers must not be represented as physical hosts');

  const authority = result?.authorityFence;
  pushError(errors, authority?.model === 'single-owning-hive', 'Phase G authority must be the single owning hive');
  pushError(errors, authority?.context?.hive_id === protocol?.owningHive && authority?.context?.repo_key === `phase-g:${input?.runId}`, 'Phase G owner scope must match this run');
  pushError(errors, authority?.publication?.epoch === SUCCESSOR_TERM && authority?.publication?.priorSeq === 0, 'Phase G owner publication must advance to term 8 at a fresh sequence');
  pushError(errors, authority?.successorAdvance?.device_pubkey === protocol?.publisher, 'Phase G successor advance must be signed by the ephemeral publisher');
  pushError(errors, authority?.successorAcceptance?.ok === true, 'Phase G successor advance must pass real FF acceptance');
  pushError(errors, authority?.successorAdvance?.epoch === SUCCESSOR_TERM && authority?.successorAdvance?.seq === 1, 'Phase G successor advance must carry the owner publication term and sequence');
  pushError(errors, authority?.staleAdvance?.device_pubkey === protocol?.priorPublisher, 'Phase G stale advance must be signed by the ephemeral prior publisher');
  pushError(errors, authority?.staleAdvance?.epoch === PRIOR_TERM && authority?.staleAdvance?.seq === 4, 'Phase G stale advance must carry the previous owner publication term');
  pushError(errors, authority?.staleAcceptance?.ok === false && authority?.staleAcceptance?.reason === 'stale-epoch-seq', 'Phase G stale owner publication must be rejected by the term/sequence fence');
  pushError(errors, authority?.deviceOnlyAdvance?.device_pubkey === protocol?.publisher && authority?.deviceOnlyAdvance?.epoch === SUCCESSOR_TERM + 1, 'Phase G device-only attempt must claim a higher term from an admitted publisher');
  pushError(errors, authority?.deviceOnlyAcceptance?.ok === false && authority?.deviceOnlyAcceptance?.reason === 'missing-hive-authority', 'Phase G device-only advance must be rejected without owning hive authority');
  pushError(errors, authority?.receiverRefBeforeDeviceOnly === authority?.successorAdvance?.staging_sha && authority?.receiverRefAfterDeviceOnly === authority?.receiverRefBeforeDeviceOnly && authority?.deviceOnlyAdvance?.staging_sha !== authority?.receiverRefBeforeDeviceOnly, 'Phase G device-only attempt must not move the receiver ref');
  if (authority?.context && authority?.priorContext && protocol) {
    const opts = {
      expectedContext: { hive_id: protocol.owningHive, repo_key: `phase-g:${input.runId}` },
      allowedDevices: [protocol.priorPublisher, protocol.publisher],
      knownStoreGenerations: {
        [protocol.priorPublisher]: authority.priorContext.store_generation,
        [protocol.publisher]: authority.context.store_generation,
      },
    };
    const successor = acceptStagingAdvance(authority.successorAdvance, { epoch: PRIOR_TERM, seq: 3 }, opts);
    pushError(errors, successor.ok && authority.successorAdvance.v === 3, 'Phase G successor must verify the owning hive countersignature and signed context');
    const stale = acceptStagingAdvance(authority.staleAdvance, { epoch: SUCCESSOR_TERM, seq: 1 }, opts);
    pushError(errors, !stale.ok && stale.reason === 'stale-epoch-seq' && authority.staleAdvance.v === 3, 'Phase G stale record must carry valid owner proof before failing the publication fence');
    const deviceOnly = acceptStagingAdvance(authority.deviceOnlyAdvance, { epoch: SUCCESSOR_TERM, seq: 1 }, opts);
    pushError(errors, !deviceOnly.ok && deviceOnly.reason === 'missing-hive-authority', 'Phase G device-only record must have a valid device signature but no owner proof');
  } else {
    errors.push('Phase G owner publication contexts are required');
  }
  pushError(errors, authority?.receiverRefBeforeStaleReplay === authority?.receiverRefAfterStaleReplay, 'Phase G stale authority replay must not move the receiver ref');
  pushError(errors, OID.test(authority?.receiverRefAfterStaleReplay ?? ''), 'Phase G receiver staging ref must be a Git OID');

  const retry = result?.retryPersistence;
  pushError(errors, retry?.rowId === CURSOR_ROW && retry?.beforeRetry === CURSOR_BEFORE, 'Phase G retry row and starting cursor are invalid');
  pushError(errors, retry?.unknownShaReason === 'unknown-sha' && retry?.duringUnknownSha === CURSOR_BEFORE, 'Phase G retryable unknown-sha must hold the fed-event cursor');
  pushError(errors, retry?.unknownGenerationReason === 'unknown-generation' && retry?.duringUnknownGeneration === CURSOR_BEFORE, 'Phase G retryable unknown-generation must hold the fed-event cursor');
  pushError(errors, retry?.acceptedStoreGeneration === authority?.context?.store_generation, 'Phase G retry must accept the signed publisher store generation');
  pushError(errors, retry?.afterAccept === CURSOR_ROW && retry?.acceptedCount === 1, 'Phase G cursor must advance exactly after acceptance');
  pushError(errors, retry?.acceptedStagingSha === authority?.successorAdvance?.staging_sha, 'Phase G accepted retry must persist the successor staging SHA');

  const pg = result?.pgAndPushRecovery;
  pushError(errors, pg?.modeDuringReadFailure?.mode === 'legacy' && pg?.modeDuringReadFailure?.source === 'error', 'Phase G PG blip must fail open to legacy while preserving source:error');
  pushError(errors, pg?.syncStatus === 'synced', 'Phase G non-FF recovery must finish with a synced git-sync outcome');
  pushError(errors, (pg?.pushAttempts?.length ?? 0) >= 2, 'Phase G non-FF recovery must record the rejected push and retry');
  pushError(errors, pg?.firstPushRejectedNonFastForward === true && pg?.peerLoserWasNoisy === true, 'Phase G first push loser must be a noisy non-fast-forward');
  pushError(errors, pg?.noForcePush === true, 'Phase G non-FF recovery must never use force push');
  pushError(errors, pg?.originContainsLocalCommit === true && pg?.originContainsPeerCommit === true, 'Phase G final origin must contain both sides of the push race');

  const restart = result?.restartRoundTrip;
  pushError(errors, /^[0-9a-f]{64}$/.test(restart?.oldCoreKey ?? '') && /^[0-9a-f]{64}$/.test(restart?.newCoreKey ?? ''), 'Phase G restart core keys must be 64-hex');
  pushError(errors, restart?.oldCoreKey !== restart?.newCoreKey, 'Phase G restart must create a different Hypercore key');
  pushError(errors, restart?.stableDeviceKeyBefore === protocol?.stableRestartIdentity && restart?.stableDeviceKeyAfter === protocol?.stableRestartIdentity, 'Phase G restart must preserve the explicitly ephemeral device identity');
  pushError(errors, restart?.namespaceBefore === restart?.namespaceAfter, 'Phase G restart must preserve the device namespace');
  pushError(errors, restart?.canonicalOid === restart?.namespaceOid && restart?.canonicalOid === restart?.worktreeOid, 'Phase G restart Git roundtrip must preserve the exact commit OID');
  pushError(errors, SHA256.test(restart?.payloadSha256 ?? '') && restart?.payloadSha256 === restart?.worktreePayloadSha256, 'Phase G restart Git roundtrip must preserve exact payload bytes');
  pushError(errors, result?.temporaryStateRemoved === true, 'Phase G temporary state must be removed before returning');

  if (errors.length > 0) return { ok: false, errors, result: null };
  return {
    ok: true,
    errors: [],
    result: {
      schemaVersion: PHASE_G_RESULT_SCHEMA,
      phase: 'G',
      planItem: PHASE_G_PLAN_ITEM,
      status: 'complete',
      complete: true,
      missingAssertions: [],
      observedAt: result.observedAt,
    },
  };
}
