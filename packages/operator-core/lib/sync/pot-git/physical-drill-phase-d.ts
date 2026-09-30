/**
 * Fixed production-spine adapter for P-505 physical Phase D / P-305.
 *
 * The checked-in scenario drives the canonical `git-sync:run` action. This
 * module contributes only fixed, run-bound mutations and observations around
 * that action: a below-steer worktree head, the real integration-request row
 * and ratification helper, signed staging-advance rows on both physical hosts,
 * and the real worktree-bridge cursor/refs/worktree state. It does not run a
 * second integrator or bridge and exposes no caller-selected command, repo, or
 * worktree path.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { inWorkspaceTxn, tryAcquire, tryRelease } from '@papercusp/locks';
import { waitForConvergence } from '@papercusp/verification-harness';
// Side-effect import: wires @papercusp/locks to the same embedded-pg admin URL
// the operator (and this producer's getOrgPg) resolves on this host.
import '../../agent-tools/locks/configure';
import { projectDirForSlug } from '../../operator-notes';
import {
  commsTierAtLeast,
  effectiveCommsTier,
  isCommsTier,
  listCommsTrust,
  removeCommsTrust,
  setCommsTrust,
  type CommsTier,
  type CommsTrustEntry,
  type EffectiveCommsTier,
  type EffectiveCommsTierDeps,
} from '../../trust/comms-trust';
import { resolveAuthorCommsTier } from '../hyperbee/comms-tier-gate';
import {
  AUTO_INTEGRATE_TIER,
  listIntegrationRequests,
  ratifyIntegrationRequest,
  type IntegrationRequest,
} from './integration-requests';
import { STAGING_REF } from './integrator';
import {
  STAGING_ADVANCE_EVENT_KEY,
  compareEpochSeq,
  isSignedStagingAdvance,
  verifyStagingAdvance,
  type SignedStagingAdvance,
} from './staging-advance';
import { defaultRunGit, deviceNamespaceKey, hiveGitRepoPath } from './storage';
import { WORKTREE_STAGING_REF } from './worktree-bridge';
import {
  PHASE_A_POT_HOME,
  PHASE_A_REPO_KEY,
  physicalDrillGitSyncSlug,
  type PhysicalDrillGitSyncSlug,
} from './physical-drill-phase-a';

export const PHASE_D_INPUT_SCHEMA = 'hive-git-physical-phase-d-input/v1' as const;
export const PHASE_D_RESULT_SCHEMA = 'hive-git-physical-phase-d-result/v1' as const;
export const PHASE_D_MUTATION_SCHEMA = 'hive-git-physical-phase-d-mutation/v1' as const;
export const PHASE_D_OBSERVATION_SCHEMA = 'hive-git-physical-phase-d-observation/v1' as const;
export const PHASE_D_EVENT_SCHEMA = 'hive-git-physical-phase-d-event/v1' as const;
export const PHASE_D_RATIFICATION_SCHEMA = 'hive-git-physical-phase-d-ratification/v1' as const;
export const PHASE_D_PLAN_ITEM = 'P-305' as const;
export const PHASE_D_WORKSPACE = 'papercusp-workspace' as const;
export const PHASE_D_SENTINEL = 'p505-phase-d-overlap.txt' as const;

const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export type PhysicalPhaseDHost = 'tower' | 'vm';
export type PhysicalPhaseDMutationKind = 'below-steer' | 'dirty-overlap';
export type PhysicalPhaseDObservationStage = 'first-source' | 'first-destination' | 'dirty-before' | 'dirty-after';

export type PhysicalPhaseDMutation = {
  schemaVersion: typeof PHASE_D_MUTATION_SCHEMA;
  runId: string;
  kind: PhysicalPhaseDMutationKind;
  sourceHost: PhysicalPhaseDHost;
  sourceDeviceKey: string;
  method: 'fixed-worktree-commit';
  worktreePath: string;
  protectedPath: typeof PHASE_D_SENTINEL;
  baseOid: string;
  headOid: string;
  payloadSha256: string;
  createdAt: string;
};

export type PhysicalPhaseDTrigger = {
  tool: 'git-sync:run';
  installSlug: PhysicalDrillGitSyncSlug;
  host: PhysicalPhaseDHost;
  role:
    | 'below-steer-publish'
    | 'queue-receive'
    | 'ratified-integrate'
    | 'first-bridge'
    | 'dirty-integrate'
    | 'dirty-bridge';
  fired: true;
  startedAt: string;
  finishedAt: string;
};

export type PhysicalPhaseDRatification = {
  schemaVersion: typeof PHASE_D_RATIFICATION_SCHEMA;
  tool: 'ratifyIntegrationRequest';
  accepted: true;
  observedAt: string;
  pending: IntegrationRequest;
  ratified: IntegrationRequest;
};

export type PhysicalPhaseDEvent = {
  schemaVersion: typeof PHASE_D_EVENT_SCHEMA;
  hostId: PhysicalPhaseDHost;
  rowId: number;
  observedAt: string;
  key: typeof STAGING_ADVANCE_EVENT_KEY;
  source: 'git-sync-integrator';
  repoKey: typeof PHASE_A_REPO_KEY;
  payload: SignedStagingAdvance;
};

export type PhysicalPhaseDObservation = {
  schemaVersion: typeof PHASE_D_OBSERVATION_SCHEMA;
  hostId: PhysicalPhaseDHost;
  runId: string;
  stage: PhysicalPhaseDObservationStage;
  observedAt: string;
  repoPath: string;
  worktreePath: string;
  integratorDeviceKey: string;
  integratorNamespaceStagingOid: string | null;
  canonicalStagingOid: string | null;
  worktreeHeadOid: string;
  dirtyPaths: string[];
  protectedPath: typeof PHASE_D_SENTINEL;
  protectedFileSha256: string | null;
  cursor: {
    lastEventId: number;
    epochSeq: { epoch: number; seq: number } | null;
    stagingSha: string | null;
  };
};

export type PhysicalPhaseDAdvance = {
  integratorTrigger: PhysicalPhaseDTrigger;
  sourceEvent: PhysicalPhaseDEvent;
  destinationEvent: PhysicalPhaseDEvent;
  destinationTrigger: PhysicalPhaseDTrigger;
};

export type PhysicalPhaseDInput = {
  schemaVersion: typeof PHASE_D_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  belowSteer: {
    mutation: PhysicalPhaseDMutation;
    publishTrigger: PhysicalPhaseDTrigger;
    queueTrigger: PhysicalPhaseDTrigger;
    pendingReceipt: IntegrationRequest;
    ratification: PhysicalPhaseDRatification;
  };
  firstAdvance: PhysicalPhaseDAdvance & {
    sourceObservation: PhysicalPhaseDObservation;
    destinationObservation: PhysicalPhaseDObservation;
  };
  dirtyAdvance: PhysicalPhaseDAdvance & {
    mutation: PhysicalPhaseDMutation;
    dirtyBefore: PhysicalPhaseDObservation;
    dirtyAfter: PhysicalPhaseDObservation;
  };
};

export type PhysicalPhaseDVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_D_RESULT_SCHEMA;
    phase: 'D';
    planItem: typeof PHASE_D_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      freshBelowSteerHeadQueuedWithVisibleReceipt: true;
      exactRequestRatifiedThroughProductionSurface: true;
      productionGitSyncPublishedSignedCanonicalStaging: true;
      signedAdvanceFederatedToOtherPhysicalHost: true;
      otherPhysicalHostFastForwardedCanonicalAndWorktree: true;
      secondOverlappingAdvanceMovedMirrorAndCursor: true;
      dirtyWorktreeAndProtectedFileRemainedUntouched: true;
    };
    oids: { firstStaging: string; secondStaging: string };
    cursor: { firstEventId: number; secondEventId: number };
  };
};

type OrgSql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Live file-lock seam for Phase D's planted dirt (WI-10003741).
 *
 * The planted overlap file stands for an in-flight local edit. The product
 * protects such an edit from git-sync's commit sweep only through a live file
 * lock: git-sync reads every live holding and excludes that path from
 * `git add`. Without one, the VM's next git-sync (the scheduled tick or the
 * scenario's own bridge run) commits the planted file, so the dirty-bridge
 * contract can never hold. Measured in P-505 run 21: VM commit 17c13c5
 * 'sync(root): p505-phase-d-overlap.txt'.
 */
export type PhysicalPhaseDDirtLock = {
  acquire(input: {
    coordinationDomain: string;
    owner: string;
    path: string;
    intent: string;
    ttlSec: number;
  }): Promise<{ lockId: string; expiresAt: string }>;
  release(input: { coordinationDomain: string; owner: string }): Promise<{ released: number }>;
};

/** Covers the scenario's 20-minute dirty-bridge deadline plus observation margin. */
export const PHASE_D_DIRT_LOCK_TTL_SEC = 1800;

/** Opaque, non-session owner: the ended-session reaper keeps an unknown owner's lock. */
export function phaseDDirtLockOwner(runId: string): string {
  assertRunId(runId);
  return `p505-phase-d:${runId}`;
}

// Static on purpose: the VM source preflight loads this module graph, so an
// unresolvable lock dependency fails there instead of mid-Phase D.
function defaultPhaseDDirtLock(): PhysicalPhaseDDirtLock {
  return {
    async acquire(input) {
      const result = await inWorkspaceTxn(input.coordinationDomain, input.owner, (tx) =>
        tryAcquire(tx, {
          coordinationDomain: input.coordinationDomain,
          owner: input.owner,
          ownerLabel: input.owner,
          paths: [input.path],
          intent: input.intent,
          ttlSec: input.ttlSec,
        }),
      );
      if (!result.ok) {
        throw new Error(
          `physical Phase D could not lock ${input.path}: held by ${result.busy.map((b) => b.owner).join(', ') || 'unknown'}`,
        );
      }
      return { lockId: result.lock_id, expiresAt: result.expires_ts.toISOString() };
    },
    async release(input) {
      const result = await inWorkspaceTxn(input.coordinationDomain, input.owner, (tx) =>
        tryRelease(tx, { coordinationDomain: input.coordinationDomain, owner: input.owner, allMine: true }),
      );
      return { released: result.released.length };
    },
  };
}

type PhysicalPhaseDDeps = {
  repoPath?: string;
  worktreePath?: string;
  sql?: OrgSql;
  dirtLock?: PhysicalPhaseDDirtLock;
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase D runId is invalid: ${runId}`);
}

function assertDeviceKey(deviceKey: string): void {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(deviceKey) || Buffer.from(deviceKey, 'base64').length !== 32) {
    throw new Error('physical Phase D requires a raw 32-byte Ed25519 device key in base64');
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await defaultRunGit(args, cwd);
  if (result.code !== 0) {
    throw new Error(`physical Phase D git ${args.join(' ')} failed for ${cwd}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Worktree paths reported by `git status`, parsed from NUL-delimited porcelain.
 *
 * Never parse porcelain through git(): it trims stdout, and a porcelain line for
 * a tracked file modified only in the worktree starts with a SPACE (` M path`).
 * Trimming eats that column, so a fixed `slice(3)` then drops the path's first
 * character. The Phase D sentinel is tracked on every rig since run 15, so its
 * planted dirt read as `505-phase-d-overlap.txt` and both dirty-advance clauses
 * rejected a correct run (P-505 run 24, WI-10003767). `-z` also disables path
 * quoting and emits a rename's source as its own record, which is skipped.
 */
export async function porcelainDirtyPaths(worktreePath: string): Promise<string[]> {
  const result = await defaultRunGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktreePath);
  if (result.code !== 0) {
    throw new Error(`physical Phase D git status failed for ${worktreePath}: ${result.stderr.trim()}`);
  }
  const records = result.stdout.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.length < 4) continue;
    paths.push(record.slice(3));
    if (record[0] === 'R' || record[0] === 'C') i += 1;
  }
  return paths.sort();
}

async function fixedPaths(deps: PhysicalPhaseDDeps = {}): Promise<{ repoPath: string; worktreePath: string }> {
  const repoPath = deps.repoPath ?? hiveGitRepoPath(PHASE_A_POT_HOME, PHASE_A_REPO_KEY);
  const worktreePath = deps.worktreePath ?? (await projectDirForSlug(PHASE_A_POT_HOME));
  if (!worktreePath) throw new Error(`physical Phase D cannot resolve fixed worktree ${PHASE_A_POT_HOME}`);
  if (!isAbsolute(repoPath) || !isAbsolute(worktreePath)) {
    throw new Error('physical Phase D fixed repo and worktree paths must be absolute');
  }
  if (!deps.repoPath) {
    const suffix = join(PHASE_A_POT_HOME, `${PHASE_A_REPO_KEY}.git`);
    if (!resolve(repoPath).endsWith(suffix)) throw new Error(`physical Phase D repo path must target ${suffix}`);
  }
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`physical Phase D fixed bare repo is missing: ${repoPath}`);
  }
  if (!existsSync(worktreePath) || !statSync(worktreePath).isDirectory()) {
    throw new Error(`physical Phase D fixed worktree is missing: ${worktreePath}`);
  }
  if ((await git(repoPath, ['rev-parse', '--is-bare-repository'])) !== 'true') {
    throw new Error(`physical Phase D target is not a bare repo: ${repoPath}`);
  }
  if ((await git(worktreePath, ['rev-parse', '--is-inside-work-tree'])) !== 'true') {
    throw new Error(`physical Phase D target is not a worktree: ${worktreePath}`);
  }
  return { repoPath, worktreePath };
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Refuse a Phase D mutation whose base cannot merge cleanly with canonical
 * staging. The integrator parks such a head as a conflict, so no signed
 * staging event can ever name it and the phase fails 20 minutes later with an
 * unexplained "expected exactly one signed production staging event".
 * Measured: P-505 run 22 parked the VM head on p505-phase-d-overlap.txt
 * because run 21's leaked dirt commit sat under it (WI-10003741). A base that
 * merely lags staging still merges cleanly and is accepted, so this checks
 * mergeability, not ancestry. With no canonical staging yet there is nothing
 * to conflict with.
 *
 * The base merging cleanly is necessary but NOT sufficient: the mutation then
 * rewrites the sentinel, so a lagging base whose canonical side ALSO rewrote
 * the sentinel after it yields a head that conflicts at the integrator anyway.
 * Measured: P-505 run 25 committed below-steer f852d80 on 489e075, the parent
 * of canonical daee50f, which had rewritten the sentinel; integrate returned
 * 'nothing' and the phase failed on the missing event. The VM had been left
 * trailing canonical by a deferred-dirty advance nothing retried (WI-10003772).
 */
async function assertBaseMergesWithCanonicalStaging(
  repoPath: string,
  worktreePath: string,
  baseOid: string,
): Promise<void> {
  const canonical = await defaultRunGit(
    ['rev-parse', '--verify', '-q', `${WORKTREE_STAGING_REF}^{commit}`],
    repoPath,
  );
  if (canonical.code !== 0) return;
  const stagingOid = canonical.stdout.trim();
  const present = await defaultRunGit(['cat-file', '-e', `${stagingOid}^{commit}`], worktreePath);
  if (present.code !== 0) {
    // Writes objects and FETCH_HEAD only; no ref or worktree file changes.
    await git(worktreePath, ['fetch', '-q', '--no-tags', repoPath, WORKTREE_STAGING_REF]);
  }
  const merged = await defaultRunGit(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', stagingOid, baseOid],
    worktreePath,
  );
  if (merged.code === 0) {
    const mergeBase = await git(worktreePath, ['merge-base', stagingOid, baseOid]);
    const canonicalRewroteSentinel = await git(worktreePath, [
      'diff',
      '--name-only',
      mergeBase,
      stagingOid,
      '--',
      PHASE_D_SENTINEL,
    ]);
    if (canonicalRewroteSentinel) {
      throw new Error(
        `physical Phase D refuses to mutate: worktree HEAD ${baseOid.slice(0, 12)} trails canonical staging ` +
          `${stagingOid.slice(0, 12)}, which rewrote ${PHASE_D_SENTINEL} after it, so the mutated head would ` +
          'conflict at the integrator. The worktree never caught up to an accepted staging advance ' +
          '(WI-10003772): advance the fixed worktree to canonical staging first.',
      );
    }
    return;
  }
  if (merged.code === 1) {
    const conflicted = [...new Set(merged.stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
    throw new Error(
      `physical Phase D refuses to mutate: worktree HEAD ${baseOid.slice(0, 12)} conflicts with canonical ` +
        `staging ${stagingOid.slice(0, 12)} on ${conflicted.join(', ') || 'unreported paths'}, so the integrator ` +
        'would park this head. Residue from an earlier run: merge canonical staging into the fixed worktree first.',
    );
  }
  throw new Error(`physical Phase D merge-tree check failed for ${worktreePath}: ${merged.stderr.trim()}`);
}

/** Create one fixed canary worktree commit. No caller-selected path or command. */
export async function createPhysicalPhaseDMutation(
  input: {
    runId: string;
    kind: PhysicalPhaseDMutationKind;
    sourceHost: PhysicalPhaseDHost;
    sourceDeviceKey: string;
  },
  deps: PhysicalPhaseDDeps = {},
): Promise<PhysicalPhaseDMutation> {
  assertRunId(input.runId);
  assertDeviceKey(input.sourceDeviceKey);
  const { repoPath, worktreePath } = await fixedPaths(deps);
  const status = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error('physical Phase D refuses to create a mutation in a dirty fixed worktree');
  const baseOid = await git(worktreePath, ['rev-parse', 'HEAD^{commit}']);
  await assertBaseMergesWithCanonicalStaging(repoPath, worktreePath, baseOid);
  const payload = `p505-phase-d/${input.runId}/${input.kind}\n`;
  const protectedPath = join(worktreePath, PHASE_D_SENTINEL);
  // A prior run's integrated commit leaves the sentinel TRACKED in the shared
  // worktree (measured: P-505 run 15 left it at 1e6ffc4 on the VM), so an
  // exclusive create can never succeed twice on the same rig. The freshness
  // this phase needs is the run-bound payload, not a new path: the tree is
  // already required clean above, a pre-existing sentinel must be tracked, and
  // the content must differ so the commit below is a new head.
  if (existsSync(protectedPath)) {
    await git(worktreePath, ['ls-files', '--error-unmatch', '--', PHASE_D_SENTINEL]);
    if (readFileSync(protectedPath, 'utf8') === payload) {
      throw new Error('physical Phase D refuses to reuse a runId whose sentinel payload is already committed');
    }
  }
  writeFileSync(protectedPath, payload, { flag: 'w', mode: 0o600 });
  await git(worktreePath, ['add', '--', PHASE_D_SENTINEL]);
  await git(worktreePath, [
    '-c',
    'user.name=p505-phase-d',
    '-c',
    'user.email=p505-phase-d@papercusp.invalid',
    'commit',
    '-q',
    '-m',
    `P-505 Phase D ${input.kind} ${input.runId}`,
    '--',
    PHASE_D_SENTINEL,
  ]);
  const headOid = await git(worktreePath, ['rev-parse', 'HEAD^{commit}']);
  if (!OID.test(baseOid) || !OID.test(headOid) || baseOid === headOid) {
    throw new Error('physical Phase D failed to create a fresh worktree commit');
  }
  return {
    schemaVersion: PHASE_D_MUTATION_SCHEMA,
    runId: input.runId,
    kind: input.kind,
    sourceHost: input.sourceHost,
    sourceDeviceKey: input.sourceDeviceKey,
    method: 'fixed-worktree-commit',
    worktreePath,
    protectedPath: PHASE_D_SENTINEL,
    baseOid,
    headOid,
    payloadSha256: sha256(payload),
    createdAt: new Date().toISOString(),
  };
}

/** Make the fixed overlap file dirty without staging or committing it. */
export async function dirtyPhysicalPhaseDWorktree(
  input: { runId: string },
  deps: PhysicalPhaseDDeps = {},
): Promise<{
  runId: string;
  protectedPath: typeof PHASE_D_SENTINEL;
  sha256: string;
  lock: { lockId: string; owner: string; coordinationDomain: string; expiresAt: string };
  observedAt: string;
}> {
  assertRunId(input.runId);
  const { worktreePath } = await fixedPaths(deps);
  const before = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (before) throw new Error('physical Phase D refuses to dirty an already-dirty fixed worktree');
  // Lock BEFORE writing, as a real editor does, so no git-sync sweep can land
  // between the write and the lock (WI-10003741).
  const dirtLock = deps.dirtLock ?? defaultPhaseDDirtLock();
  const owner = phaseDDirtLockOwner(input.runId);
  const held = await dirtLock.acquire({
    coordinationDomain: worktreePath,
    owner,
    path: PHASE_D_SENTINEL,
    intent: `P-505 Phase D ${input.runId}: planted dirty overlap must survive the bridge`,
    ttlSec: PHASE_D_DIRT_LOCK_TTL_SEC,
  });
  try {
    const payload = `p505-phase-d/${input.runId}/local-dirty-must-survive\n`;
    writeFileSync(join(worktreePath, PHASE_D_SENTINEL), payload, { flag: 'w', mode: 0o600 });
    const after = await git(worktreePath, ['status', '--porcelain=v1', '--', PHASE_D_SENTINEL]);
    if (!after) throw new Error('physical Phase D failed to make the fixed overlap file dirty');
    return {
      runId: input.runId,
      protectedPath: PHASE_D_SENTINEL,
      sha256: sha256(payload),
      lock: { lockId: held.lockId, owner, coordinationDomain: worktreePath, expiresAt: held.expiresAt },
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    await dirtLock.release({ coordinationDomain: worktreePath, owner }).catch(() => undefined);
    throw error;
  }
}

/**
 * Discard ONLY this run's own planted dirt once Phase D has observed it, so the
 * shared worktree is clean for the next phase and the next run. Anything else —
 * a different payload, or any other dirty path — is someone's real work and is
 * refused, never discarded.
 */
export async function resetPhysicalPhaseDDirt(
  input: { runId: string },
  deps: PhysicalPhaseDDeps = {},
): Promise<{
  runId: string;
  reset: boolean;
  reason: 'discarded-run-dirt' | 'already-clean';
  locksReleased: number;
  observedAt: string;
}> {
  assertRunId(input.runId);
  const { worktreePath } = await fixedPaths(deps);
  const dirtLock = deps.dirtLock ?? defaultPhaseDDirtLock();
  const owner = phaseDDirtLockOwner(input.runId);
  // Release the run's lock on every exit, including a refusal: its TTL would
  // otherwise keep git-sync from committing the path for up to 30 minutes.
  try {
    const outcome = await discardPhysicalPhaseDDirt(input.runId, worktreePath);
    const { released } = await dirtLock.release({ coordinationDomain: worktreePath, owner });
    return { runId: input.runId, ...outcome, locksReleased: released, observedAt: new Date().toISOString() };
  } catch (error) {
    await dirtLock.release({ coordinationDomain: worktreePath, owner }).catch(() => undefined);
    throw error;
  }
}

async function discardPhysicalPhaseDDirt(
  runId: string,
  worktreePath: string,
): Promise<{ reset: boolean; reason: 'discarded-run-dirt' | 'already-clean' }> {
  const input = { runId };
  const status = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status) {
    return { reset: false, reason: 'already-clean' };
  }
  const expected = `p505-phase-d/${input.runId}/local-dirty-must-survive\n`;
  // Name-only listings, not porcelain: the git() helper trims stdout, which
  // would eat the leading status column of the first porcelain line.
  const changed = [
    ...(await git(worktreePath, ['diff', '--name-only', 'HEAD', '--'])).split('\n'),
    ...(await git(worktreePath, ['ls-files', '--others', '--exclude-standard'])).split('\n'),
  ].filter(Boolean);
  const onlySentinel = changed.length > 0 && changed.every((path) => path === PHASE_D_SENTINEL);
  const protectedPath = join(worktreePath, PHASE_D_SENTINEL);
  if (!onlySentinel || !existsSync(protectedPath) || readFileSync(protectedPath, 'utf8') !== expected) {
    throw new Error('physical Phase D refuses to discard worktree changes it did not plant in this run');
  }
  await git(worktreePath, ['checkout', '--', PHASE_D_SENTINEL]);
  const after = await git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (after) throw new Error('physical Phase D reset left the fixed worktree dirty');
  return { reset: true, reason: 'discarded-run-dirt' };
}

/** Read the exact production request row for the run-bound head. */
export async function capturePhysicalPhaseDRequest(
  input: { devicePubkey: string; headSha: string; state: 'pending' | 'ratified' },
  deps: PhysicalPhaseDDeps = {},
): Promise<IntegrationRequest> {
  const rows = await listIntegrationRequests(
    {
      workspaceId: PHASE_D_WORKSPACE,
      potSlug: PHASE_A_POT_HOME,
      repoKey: PHASE_A_REPO_KEY,
      devicePubkey: input.devicePubkey,
      state: input.state,
      limit: 100,
    },
    deps.sql,
  );
  const exact = rows.filter((row) => row.headSha === input.headSha);
  if (exact.length !== 1) {
    throw new Error(`physical Phase D expected exactly one ${input.state} request for the run-bound head`);
  }
  return exact[0]!;
}

/** Ratify exactly the visible pending row through the production helper. */
export async function ratifyPhysicalPhaseDRequest(
  input: { devicePubkey: string; headSha: string },
  deps: PhysicalPhaseDDeps = {},
): Promise<PhysicalPhaseDRatification> {
  const pending = await capturePhysicalPhaseDRequest({ ...input, state: 'pending' }, deps);
  const accepted = await ratifyIntegrationRequest(
    {
      workspaceId: PHASE_D_WORKSPACE,
      potSlug: PHASE_A_POT_HOME,
      repoKey: PHASE_A_REPO_KEY,
      devicePubkey: input.devicePubkey,
      headSha: input.headSha,
    },
    deps.sql,
  );
  if (!accepted) throw new Error('physical Phase D production ratification did not update the exact pending row');
  const ratified = await capturePhysicalPhaseDRequest({ ...input, state: 'ratified' }, deps);
  return {
    schemaVersion: PHASE_D_RATIFICATION_SCHEMA,
    tool: 'ratifyIntegrationRequest',
    accepted: true,
    observedAt: new Date().toISOString(),
    pending,
    ratified,
  };
}

export const PHASE_D_TIER_HOLD_SCHEMA = 'hive-git-physical-phase-d-tier-hold/v1' as const;
export const PHASE_D_TIER_RESTORE_SCHEMA = 'hive-git-physical-phase-d-tier-restore/v1' as const;
export const PHASE_D_TIER_HOLD_FILE = 'phase-d-tier-hold.json' as const;
/** Below AUTO_INTEGRATE_TIER, so the integrator must queue instead of integrating. */
export const PHASE_D_TIER_HOLD_TIER: CommsTier = 'message';
/** Bounds a hold whose restore never ran: it lapses to the policy default, never to a grant. */
export const PHASE_D_TIER_HOLD_TTL_MS = 45 * 60_000;
export const PHASE_D_TIER_ACTOR = 'p505-physical-drill' as const;
/** Every hold row's note starts with this, so a never-restored hold is recognisable (physical-drill-preflight). */
export const PHASE_D_TIER_HOLD_NOTE_PREFIX = 'P-505 Phase D below-steer hold' as const;

/** The on-disk restore record, written BEFORE the tier is mutated. */
export type PhysicalPhaseDTierHoldRecord = {
  schemaVersion: typeof PHASE_D_TIER_HOLD_SCHEMA;
  runId: string;
  workspaceId: typeof PHASE_D_WORKSPACE;
  potHomeSlug: typeof PHASE_A_POT_HOME;
  devicePubkey: string;
  githubUserId: number;
  /** The exact prior comms-trust row, or null when none existed. */
  prior: CommsTrustEntry | null;
  heldAt: string;
};

export type PhysicalPhaseDTierHold = PhysicalPhaseDTierHoldRecord & {
  holdPath: string;
  held: { tier: CommsTier; expiresAtMs: number; effective: EffectiveCommsTier };
};

export type PhysicalPhaseDTierRestore =
  | { schemaVersion: typeof PHASE_D_TIER_RESTORE_SCHEMA; restored: false; reason: 'no-hold'; observedAt: string }
  | {
      schemaVersion: typeof PHASE_D_TIER_RESTORE_SCHEMA;
      restored: true;
      runId: string;
      githubUserId: number;
      prior: CommsTrustEntry | null;
      current: CommsTrustEntry | null;
      observedAt: string;
    };

type PhysicalPhaseDTierDeps = {
  sql?: OrgSql;
  /** The VM device's attested github user; production resolves the hive_members chain. */
  resolveGithubUserId?: (devicePubkey: string) => Promise<number | null>;
  loadPolicyDefaultTier?: EffectiveCommsTierDeps['loadPolicyDefaultTier'];
  nowMs?: () => number;
};

function assertHoldPath(holdPath: string): void {
  if (!isAbsolute(holdPath) || basename(holdPath) !== PHASE_D_TIER_HOLD_FILE) {
    throw new Error(`physical Phase D tier hold path must be an absolute ${PHASE_D_TIER_HOLD_FILE}`);
  }
  if (!existsSync(dirname(holdPath)) || !statSync(dirname(holdPath)).isDirectory()) {
    throw new Error(`physical Phase D tier hold directory is missing: ${dirname(holdPath)}`);
  }
}

function sameTrustRow(a: CommsTrustEntry | null, b: CommsTrustEntry | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.githubUserId === b.githubUserId &&
    a.tier === b.tier &&
    a.gate === b.gate &&
    a.note === b.note &&
    a.expiresAtMs === b.expiresAtMs
  );
}

function parseTierHoldRecord(raw: string): PhysicalPhaseDTierHoldRecord {
  const record = JSON.parse(raw) as Partial<PhysicalPhaseDTierHoldRecord>;
  const prior = record.prior;
  if (
    record.schemaVersion !== PHASE_D_TIER_HOLD_SCHEMA ||
    record.workspaceId !== PHASE_D_WORKSPACE ||
    record.potHomeSlug !== PHASE_A_POT_HOME ||
    typeof record.runId !== 'string' ||
    !RUN_ID.test(record.runId) ||
    !Number.isInteger(record.githubUserId) ||
    (record.githubUserId as number) <= 0 ||
    (prior !== null &&
      (typeof prior !== 'object' ||
        prior.githubUserId !== record.githubUserId ||
        !isCommsTier(prior.tier) ||
        typeof prior.gate !== 'boolean'))
  ) {
    throw new Error('physical Phase D tier hold record is malformed; refusing to guess a restore');
  }
  return record as PhysicalPhaseDTierHoldRecord;
}

/**
 * Hold the VM device's author below AUTO_INTEGRATE_TIER for the below-steer
 * window, through the production comms-trust surface (WI-10003723).
 *
 * The tower's `comms_trust_list` can pin the VM user at 'steer' (an owner
 * canary unblock did exactly that), and then the integrator auto-integrates
 * the VM head and never writes the pending request Phase D has to observe.
 * The exact prior row is persisted to `holdPath` before anything changes, so
 * `restorePhysicalPhaseDTier` can put it back byte-for-byte; the hold itself
 * expires on its own, so an unrestored hold lapses toward LESS trust, never
 * more.
 */
export async function holdPhysicalPhaseDBelowSteer(
  input: { vmDevicePubkey: string; runId: string; holdPath: string },
  deps: PhysicalPhaseDTierDeps = {},
): Promise<PhysicalPhaseDTierHold> {
  assertRunId(input.runId);
  assertDeviceKey(input.vmDevicePubkey);
  assertHoldPath(input.holdPath);
  if (existsSync(input.holdPath)) {
    throw new Error('physical Phase D tier hold already exists; run phase-d-tier-restore before holding again');
  }
  const now = (deps.nowMs ?? Date.now)();
  const githubUserId = deps.resolveGithubUserId
    ? await deps.resolveGithubUserId(input.vmDevicePubkey)
    : (
        await resolveAuthorCommsTier({
          workspaceId: PHASE_D_WORKSPACE,
          potHomeSlug: PHASE_A_POT_HOME,
          devicePubkey: input.vmDevicePubkey,
          nowMs: now,
        })
      ).githubUserId;
  if (githubUserId == null) {
    throw new Error('physical Phase D cannot resolve the VM device to an attested hive member');
  }
  const prior = (await listCommsTrust(PHASE_D_WORKSPACE, deps.sql)).find((e) => e.githubUserId === githubUserId) ?? null;
  if (prior && prior.tier === null) {
    // setCommsTrust cannot write a NULL tier back, so an exact restore is impossible.
    throw new Error('physical Phase D refuses to hold a gate-only comms-trust row it cannot restore exactly');
  }
  const record: PhysicalPhaseDTierHoldRecord = {
    schemaVersion: PHASE_D_TIER_HOLD_SCHEMA,
    runId: input.runId,
    workspaceId: PHASE_D_WORKSPACE,
    potHomeSlug: PHASE_A_POT_HOME,
    devicePubkey: input.vmDevicePubkey,
    githubUserId,
    prior,
    heldAt: new Date(now).toISOString(),
  };
  writeFileSync(input.holdPath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const expiresAtMs = now + PHASE_D_TIER_HOLD_TTL_MS;
  await setCommsTrust(
    PHASE_D_WORKSPACE,
    {
      githubUserId,
      tier: PHASE_D_TIER_HOLD_TIER,
      note: `${PHASE_D_TIER_HOLD_NOTE_PREFIX} ${input.runId}; restore the prior row via phase-d-tier-restore`,
      expiresAtMs,
      nowMs: now,
      actor: PHASE_D_TIER_ACTOR,
    },
    deps.sql,
  );
  const effective = await effectiveCommsTier(
    { workspaceId: PHASE_D_WORKSPACE, potHomeSlug: PHASE_A_POT_HOME, githubUserId, nowMs: now },
    deps.loadPolicyDefaultTier ? { loadPolicyDefaultTier: deps.loadPolicyDefaultTier } : undefined,
    deps.sql,
  );
  if (commsTierAtLeast(effective.tier, AUTO_INTEGRATE_TIER)) {
    await restorePhysicalPhaseDTier({ holdPath: input.holdPath }, deps);
    throw new Error(
      `physical Phase D tier hold did not take effect: effective tier ${effective.tier} (${effective.source})`,
    );
  }
  return {
    ...record,
    holdPath: input.holdPath,
    held: { tier: PHASE_D_TIER_HOLD_TIER, expiresAtMs, effective },
  };
}

/**
 * Put back exactly the comms-trust row a hold replaced (or remove the row the
 * hold created). Idempotent: a missing hold file is a no-op, and the file is
 * deleted only after the restored row reads back identical to the prior.
 */
export async function restorePhysicalPhaseDTier(
  input: { holdPath: string },
  deps: PhysicalPhaseDTierDeps = {},
): Promise<PhysicalPhaseDTierRestore> {
  assertHoldPath(input.holdPath);
  if (!existsSync(input.holdPath)) {
    return {
      schemaVersion: PHASE_D_TIER_RESTORE_SCHEMA,
      restored: false,
      reason: 'no-hold',
      observedAt: new Date().toISOString(),
    };
  }
  const record = parseTierHoldRecord(readFileSync(input.holdPath, 'utf8'));
  const now = (deps.nowMs ?? Date.now)();
  if (record.prior === null) {
    await removeCommsTrust(PHASE_D_WORKSPACE, record.githubUserId, PHASE_D_TIER_ACTOR, deps.sql);
  } else {
    await setCommsTrust(
      PHASE_D_WORKSPACE,
      {
        githubUserId: record.githubUserId,
        tier: record.prior.tier as CommsTier,
        note: record.prior.note,
        expiresAtMs: record.prior.expiresAtMs,
        nowMs: now,
        actor: PHASE_D_TIER_ACTOR,
      },
      deps.sql,
    );
  }
  const current =
    (await listCommsTrust(PHASE_D_WORKSPACE, deps.sql)).find((e) => e.githubUserId === record.githubUserId) ?? null;
  if (!sameTrustRow(record.prior, current)) {
    throw new Error('physical Phase D tier restore did not read back the exact prior row; hold file kept for retry');
  }
  unlinkSync(input.holdPath);
  return {
    schemaVersion: PHASE_D_TIER_RESTORE_SCHEMA,
    restored: true,
    runId: record.runId,
    githubUserId: record.githubUserId,
    prior: record.prior,
    current,
    observedAt: new Date(now).toISOString(),
  };
}

/** Ceiling for {@link capturePhysicalPhaseDEvent}'s wait; matches the scenario's 20-minute phase deadlines. */
export const PHASE_D_EVENT_WAIT_MAX_MS = 20 * 60_000;
/** Poll interval while {@link capturePhysicalPhaseDEvent} waits for the event to land. */
export const PHASE_D_EVENT_POLL_MS = 5_000;
/** Marker in the error thrown when MORE than one signed event names the head; callers must not retry it. */
export const PHASE_D_EVENT_DUPLICATE_MARKER = 'duplicate signed production staging events' as const;

type PhysicalPhaseDEventDeps = PhysicalPhaseDDeps & {
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Read a cryptographically valid staging event from this host's production fed-event log.
 *
 * `waitMs` (default 0, capped at {@link PHASE_D_EVENT_WAIT_MAX_MS}) polls until the
 * event lands. The scenario reads the tower's event straight after a tower
 * git-sync:run, and that call legitimately returns `in_progress` once the pass
 * outlasts its 45s window. A one-shot read then finds nothing and fails the phase
 * although the one event arrives seconds later. Measured: P-505 run 27, integrate
 * returned in_progress and the single seq-56 event for the head landed 67s after
 * ratification (WI-10003787).
 *
 * Zero matches keep waiting. More than one match fails at once with
 * {@link PHASE_D_EVENT_DUPLICATE_MARKER}: a re-announced sha is a producer
 * defect (WI-10003781), and waiting would only turn it into a timeout.
 */
export async function capturePhysicalPhaseDEvent(
  input: {
    hostId: PhysicalPhaseDHost;
    afterRowId: number;
    integratorDeviceKey: string;
    stagingSha: string;
    waitMs?: number;
  },
  deps: PhysicalPhaseDEventDeps = {},
): Promise<PhysicalPhaseDEvent> {
  const sql = deps.sql ?? getOrgPg().sql;
  const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, PHASE_D_EVENT_WAIT_MAX_MS));
  type EventMatch = {
    row: { id: number; observed_at: string; body: Record<string, unknown> };
    payload: SignedStagingAdvance;
  };
  // The shared convergence helper (PDS P-004): read now, then re-read until exactly one
  // event matches. A duplicate is a producer defect, so the read throws at once.
  const readMatches = async (): Promise<EventMatch[]> => {
    const rows = await sql<Array<{ id: number; observed_at: string; body: Record<string, unknown> }>>`
      SELECT id, ts::text AS observed_at, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${PHASE_D_WORKSPACE}
         AND harness_slug = ${PHASE_A_POT_HOME}
         AND surface = 'messages'
         AND id > ${input.afterRowId}
         AND body->'fed_event'->>'key' = ${STAGING_ADVANCE_EVENT_KEY}
         AND body->'fed_event'->>'repo_key' = ${PHASE_A_REPO_KEY}
       ORDER BY id ASC
       LIMIT 200
    `;
    const matches = rows.flatMap((row): EventMatch[] => {
      const fed = row.body?.fed_event as Record<string, unknown> | undefined;
      const payload = fed?.payload;
      if (
        fed?.source !== 'git-sync-integrator' ||
        !isSignedStagingAdvance(payload) ||
        payload.device_pubkey !== input.integratorDeviceKey ||
        payload.staging_sha !== input.stagingSha ||
        !verifyStagingAdvance(payload, input.integratorDeviceKey)
      ) {
        return [];
      }
      return [{ row, payload }];
    });
    if (matches.length > 1) {
      const seen = matches.map((m) => `row ${m.row.id} seq ${m.payload.seq}`).join(', ');
      throw new Error(
        `physical Phase D found ${matches.length} ${PHASE_D_EVENT_DUPLICATE_MARKER} for the run-bound head (${seen}); expected exactly one`,
      );
    }
    return matches;
  };
  const converged = await waitForConvergence({
    what: `physical Phase D ${input.hostId} signed staging event for ${input.stagingSha}`,
    observe: readMatches,
    lagging: (matches) => (matches.length === 1 ? [] : ['no signed production staging event yet']),
    budgetMs: waitMs,
    pollMs: PHASE_D_EVENT_POLL_MS,
    maxBudgetMs: PHASE_D_EVENT_WAIT_MAX_MS,
    ...(deps.nowMs ? { now: deps.nowMs } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  if (!converged.converged) {
    throw new Error(
      `physical Phase D expected exactly one signed production staging event for the run-bound head; none arrived within ${Math.round(waitMs / 1000)}s`,
    );
  }
  const match = converged.value[0]!;
  return {
    schemaVersion: PHASE_D_EVENT_SCHEMA,
    hostId: input.hostId,
    rowId: match.row.id,
    observedAt: new Date(match.row.observed_at).toISOString(),
    key: STAGING_ADVANCE_EVENT_KEY,
    source: 'git-sync-integrator',
    repoKey: PHASE_A_REPO_KEY,
    payload: match.payload,
  };
}

async function loadCursor(sql: OrgSql): Promise<PhysicalPhaseDObservation['cursor']> {
  const rows = await sql<
    Array<{
      worktree_bridge: {
        lastEventId?: number;
        epochSeq?: { epoch: number; seq: number } | null;
        stagingSha?: string | null;
      } | null;
    }>
  >`
    SELECT metadata->'worktree_bridge' AS worktree_bridge
      FROM harness_shared.routines
     WHERE workspace_id = ${PHASE_D_WORKSPACE}
       AND install_slug = ${PHASE_A_POT_HOME}
       AND target_role = 'system:git-sync'
     LIMIT 1
  `;
  const cursor = rows[0]?.worktree_bridge;
  return {
    lastEventId: cursor?.lastEventId ?? 0,
    epochSeq: cursor?.epochSeq ?? null,
    stagingSha: cursor?.stagingSha ?? null,
  };
}

/** Capture fixed Git + bridge cursor state without accepting caller paths. */
export async function capturePhysicalPhaseDObservation(
  input: {
    hostId: PhysicalPhaseDHost;
    runId: string;
    stage: PhysicalPhaseDObservationStage;
    integratorDeviceKey: string;
  },
  deps: PhysicalPhaseDDeps = {},
): Promise<PhysicalPhaseDObservation> {
  assertRunId(input.runId);
  assertDeviceKey(input.integratorDeviceKey);
  const { repoPath, worktreePath } = await fixedPaths(deps);
  const namespace = deviceNamespaceKey(input.integratorDeviceKey);
  const rev = async (cwd: string, ref: string): Promise<string | null> => {
    const result = await defaultRunGit(['rev-parse', '--verify', '-q', `${ref}^{commit}`], cwd);
    return result.code === 0 ? result.stdout.trim() || null : null;
  };
  const dirtyPaths = await porcelainDirtyPaths(worktreePath);
  const protectedFile = join(worktreePath, PHASE_D_SENTINEL);
  return {
    schemaVersion: PHASE_D_OBSERVATION_SCHEMA,
    hostId: input.hostId,
    runId: input.runId,
    stage: input.stage,
    observedAt: new Date().toISOString(),
    repoPath,
    worktreePath,
    integratorDeviceKey: input.integratorDeviceKey,
    integratorNamespaceStagingOid: await rev(repoPath, `refs/namespaces/${namespace}/${STAGING_REF}`),
    canonicalStagingOid: await rev(repoPath, WORKTREE_STAGING_REF),
    worktreeHeadOid: (await rev(worktreePath, 'HEAD')) ?? '',
    dirtyPaths,
    protectedPath: PHASE_D_SENTINEL,
    protectedFileSha256: existsSync(protectedFile) ? sha256(readFileSync(protectedFile)) : null,
    cursor: await loadCursor(deps.sql ?? getOrgPg().sql),
  };
}

function time(value: string, label: string, errors: string[]): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

function sameRequest(a: IntegrationRequest, b: IntegrationRequest): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.potSlug === b.potSlug &&
    a.repoKey === b.repoKey &&
    a.devicePubkey === b.devicePubkey &&
    a.headSha === b.headSha &&
    a.authorGithubUserId === b.authorGithubUserId &&
    a.reason === b.reason &&
    a.createdTs === b.createdTs
  );
}

function validateTrigger(
  trigger: PhysicalPhaseDTrigger,
  expected: { host: PhysicalPhaseDHost; role: PhysicalPhaseDTrigger['role'] },
  window: { startedAt: number; finishedAt: number },
  errors: string[],
): void {
  const label = `Phase D ${expected.role}`;
  if (
    trigger.tool !== 'git-sync:run' ||
    trigger.installSlug !== physicalDrillGitSyncSlug(expected.host) ||
    trigger.host !== expected.host ||
    trigger.role !== expected.role ||
    trigger.fired !== true
  ) {
    errors.push(`${label} must be the fixed production git-sync trigger`);
  }
  const startedAt = time(trigger.startedAt, `${label}.startedAt`, errors);
  const finishedAt = time(trigger.finishedAt, `${label}.finishedAt`, errors);
  if (finishedAt < startedAt || startedAt < window.startedAt || finishedAt > window.finishedAt) {
    errors.push(`${label} must fall inside the same-run window`);
  }
}

function validateMutation(
  mutation: PhysicalPhaseDMutation,
  expected: { runId: string; kind: PhysicalPhaseDMutationKind; host: PhysicalPhaseDHost; deviceKey: string },
  errors: string[],
): void {
  const label = `Phase D ${expected.kind} mutation`;
  if (
    mutation.schemaVersion !== PHASE_D_MUTATION_SCHEMA ||
    mutation.runId !== expected.runId ||
    mutation.kind !== expected.kind ||
    mutation.sourceHost !== expected.host ||
    mutation.sourceDeviceKey !== expected.deviceKey ||
    mutation.method !== 'fixed-worktree-commit' ||
    mutation.protectedPath !== PHASE_D_SENTINEL
  ) {
    errors.push(`${label} is not the fixed run-bound worktree commit`);
  }
  if (!isAbsolute(mutation.worktreePath)) errors.push(`${label} worktreePath must be absolute`);
  if (!OID.test(mutation.baseOid) || !OID.test(mutation.headOid) || mutation.baseOid === mutation.headOid) {
    errors.push(`${label} must bind distinct real Git commits`);
  }
  if (!SHA256.test(mutation.payloadSha256)) errors.push(`${label} payload hash is invalid`);
  time(mutation.createdAt, `${label}.createdAt`, errors);
}

function sameAdvance(a: SignedStagingAdvance, b: SignedStagingAdvance): boolean {
  return (
    a.v === b.v &&
    a.device_pubkey === b.device_pubkey &&
    a.epoch === b.epoch &&
    a.seq === b.seq &&
    a.staging_sha === b.staging_sha &&
    a.ts === b.ts &&
    a.sig === b.sig
  );
}

function validateEventPair(
  advance: PhysicalPhaseDAdvance,
  expected: { stagingSha: string; sourceRole: PhysicalPhaseDTrigger['role']; destinationRole: PhysicalPhaseDTrigger['role']; integratorDeviceKey: string },
  window: { startedAt: number; finishedAt: number },
  errors: string[],
): void {
  validateTrigger(advance.integratorTrigger, { host: 'tower', role: expected.sourceRole }, window, errors);
  validateTrigger(advance.destinationTrigger, { host: 'vm', role: expected.destinationRole }, window, errors);
  for (const [hostId, event] of [
    ['tower', advance.sourceEvent],
    ['vm', advance.destinationEvent],
  ] as const) {
    if (
      event.schemaVersion !== PHASE_D_EVENT_SCHEMA ||
      event.hostId !== hostId ||
      !Number.isSafeInteger(event.rowId) ||
      event.rowId <= 0 ||
      event.key !== STAGING_ADVANCE_EVENT_KEY ||
      event.source !== 'git-sync-integrator' ||
      event.repoKey !== PHASE_A_REPO_KEY ||
      event.payload.device_pubkey !== expected.integratorDeviceKey ||
      event.payload.staging_sha !== expected.stagingSha ||
      !verifyStagingAdvance(event.payload, expected.integratorDeviceKey)
    ) {
      errors.push(`Phase D ${hostId} event is not the exact signed production staging advance`);
    }
    const observedAt = time(event.observedAt, `Phase D ${hostId} event.observedAt`, errors);
    if (observedAt < window.startedAt || observedAt > window.finishedAt) {
      errors.push(`Phase D ${hostId} event must fall inside the same-run window`);
    }
  }
  if (!sameAdvance(advance.sourceEvent.payload, advance.destinationEvent.payload)) {
    errors.push('Phase D destination event must exactly match the source signed advance');
  }
}

function validateObservation(
  observation: PhysicalPhaseDObservation,
  expected: {
    host: PhysicalPhaseDHost;
    stage: PhysicalPhaseDObservationStage;
    runId: string;
    integratorDeviceKey: string;
  },
  errors: string[],
): void {
  const label = `Phase D ${expected.stage}`;
  if (
    observation.schemaVersion !== PHASE_D_OBSERVATION_SCHEMA ||
    observation.hostId !== expected.host ||
    observation.stage !== expected.stage ||
    observation.runId !== expected.runId ||
    observation.integratorDeviceKey !== expected.integratorDeviceKey ||
    observation.protectedPath !== PHASE_D_SENTINEL ||
    !isAbsolute(observation.repoPath) ||
    !isAbsolute(observation.worktreePath)
  ) {
    errors.push(`${label} is not a fixed physical-host observation`);
  }
  if (!OID.test(observation.worktreeHeadOid)) errors.push(`${label} worktree head is invalid`);
  if (!Array.isArray(observation.dirtyPaths)) errors.push(`${label} dirtyPaths must be an array`);
  if (!Number.isSafeInteger(observation.cursor.lastEventId) || observation.cursor.lastEventId < 0) {
    errors.push(`${label} cursor is invalid`);
  }
  time(observation.observedAt, `${label}.observedAt`, errors);
}

/**
 * Names the refs of a Phase D observation that have not yet reached
 * `expectedSha`; an empty list means the host has converged for `stage`
 * (WI-10003811).
 *
 * Each host reaches the signed head asynchronously, and P-505 run 30 read both
 * hosts once, mid-flight. Twenty seconds after the tower's own integrator
 * published, its canonical ref, worktree and cursor were still on the prior
 * head. The VM had advanced everything except its mirror of the integrator's
 * namespace ref. Both converged minutes later. The observe CLI waits on this
 * predicate and the validator below judges with it, so the wait and the verdict
 * cannot disagree about which refs must match.
 *
 * `dirty-after` leaves the worktree out on purpose: that stage proves the
 * bridge advanced the mirror and cursor while leaving the dirty worktree alone.
 */
export function phaseDObservationLag(
  observation: PhysicalPhaseDObservation,
  stage: PhysicalPhaseDObservationStage,
  expectedSha: string,
): string[] {
  const fields: Array<[string, string | null]> = [];
  if (stage !== 'dirty-before') fields.push(['integrator namespace', observation.integratorNamespaceStagingOid]);
  fields.push(['canonical', observation.canonicalStagingOid]);
  if (stage !== 'dirty-after') fields.push(['worktree', observation.worktreeHeadOid]);
  if (stage !== 'dirty-before') fields.push(['cursor', observation.cursor.stagingSha]);
  const lagging = fields.filter(([, oid]) => oid !== expectedSha).map(([name]) => name);
  if (stage !== 'dirty-before' && !observation.cursor.epochSeq) lagging.push('cursor epoch/seq');
  return lagging;
}

/** Strict, pure causal validator for the assembled two-host Phase D evidence. */
export function validatePhysicalPhaseD(input: PhysicalPhaseDInput): PhysicalPhaseDVerdict {
  const errors: string[] = [];
  if (input.schemaVersion !== PHASE_D_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_D_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input.runId)) errors.push('Phase D runId is invalid');
  try {
    assertDeviceKey(input.identities.towerDeviceKey);
    assertDeviceKey(input.identities.vmDeviceKey);
    if (input.identities.towerDeviceKey === input.identities.vmDeviceKey) {
      errors.push('Phase D tower and vm device identities must be distinct');
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const startedAt = time(input.window.startedAt, 'Phase D window.startedAt', errors);
  const finishedAt = time(input.window.finishedAt, 'Phase D window.finishedAt', errors);
  if (finishedAt <= startedAt) errors.push('Phase D window must be ordered');
  const window = { startedAt, finishedAt };

  const tower = input.identities.towerDeviceKey;
  const vm = input.identities.vmDeviceKey;
  validateMutation(input.belowSteer.mutation, { runId: input.runId, kind: 'below-steer', host: 'vm', deviceKey: vm }, errors);
  validateTrigger(input.belowSteer.publishTrigger, { host: 'vm', role: 'below-steer-publish' }, window, errors);
  validateTrigger(input.belowSteer.queueTrigger, { host: 'tower', role: 'queue-receive' }, window, errors);

  const pending = input.belowSteer.pendingReceipt;
  if (
    pending.workspaceId !== PHASE_D_WORKSPACE ||
    pending.potSlug !== PHASE_A_POT_HOME ||
    pending.repoKey !== PHASE_A_REPO_KEY ||
    pending.devicePubkey !== vm ||
    pending.headSha !== input.belowSteer.mutation.headOid ||
    pending.reason !== 'below-steer-tier' ||
    pending.state !== 'pending' ||
    pending.ratifiedTs !== null
  ) {
    errors.push('Phase D pending receipt must be the exact visible below-steer request');
  }

  const ratification = input.belowSteer.ratification;
  if (
    ratification.schemaVersion !== PHASE_D_RATIFICATION_SCHEMA ||
    ratification.tool !== 'ratifyIntegrationRequest' ||
    ratification.accepted !== true ||
    !sameRequest(pending, ratification.pending) ||
    !sameRequest(pending, ratification.ratified) ||
    ratification.ratified.state !== 'ratified' ||
    ratification.ratified.ratifiedTs === null ||
    ratification.ratified.ratifiedTs < ratification.ratified.createdTs
  ) {
    errors.push('Phase D ratification must promote the exact pending request through the production surface');
  }

  validateEventPair(
    input.firstAdvance,
    {
      stagingSha: input.belowSteer.mutation.headOid,
      sourceRole: 'ratified-integrate',
      destinationRole: 'first-bridge',
      integratorDeviceKey: tower,
    },
    window,
    errors,
  );
  validateObservation(input.firstAdvance.sourceObservation, { host: 'tower', stage: 'first-source', runId: input.runId, integratorDeviceKey: tower }, errors);
  validateObservation(input.firstAdvance.destinationObservation, { host: 'vm', stage: 'first-destination', runId: input.runId, integratorDeviceKey: tower }, errors);

  const firstSha = input.firstAdvance.sourceEvent.payload.staging_sha;
  const firstDestination = input.firstAdvance.destinationObservation;
  for (const [label, stage, observation] of [
    ['source', 'first-source', input.firstAdvance.sourceObservation],
    ['destination', 'first-destination', firstDestination],
  ] as const) {
    if (
      phaseDObservationLag(observation, stage, firstSha).length > 0 ||
      !observation.cursor.epochSeq ||
      compareEpochSeq(observation.cursor.epochSeq, input.firstAdvance.sourceEvent.payload) !== 0
    ) {
      errors.push(`Phase D first ${label} observation must converge canonical, cursor, and worktree to the signed staging head`);
    }
  }
  if (firstDestination.cursor.lastEventId < input.firstAdvance.destinationEvent.rowId) {
    errors.push('Phase D first destination cursor must consume the replicated signed event');
  }

  validateMutation(input.dirtyAdvance.mutation, { runId: input.runId, kind: 'dirty-overlap', host: 'tower', deviceKey: tower }, errors);
  if (input.dirtyAdvance.mutation.baseOid !== firstSha) {
    errors.push('Phase D dirty-overlap commit must descend directly from the first canonical staging head');
  }
  validateEventPair(
    input.dirtyAdvance,
    {
      stagingSha: input.dirtyAdvance.mutation.headOid,
      sourceRole: 'dirty-integrate',
      destinationRole: 'dirty-bridge',
      integratorDeviceKey: tower,
    },
    window,
    errors,
  );
  validateObservation(input.dirtyAdvance.dirtyBefore, { host: 'vm', stage: 'dirty-before', runId: input.runId, integratorDeviceKey: tower }, errors);
  validateObservation(input.dirtyAdvance.dirtyAfter, { host: 'vm', stage: 'dirty-after', runId: input.runId, integratorDeviceKey: tower }, errors);

  const secondSha = input.dirtyAdvance.sourceEvent.payload.staging_sha;
  const dirtyBefore = input.dirtyAdvance.dirtyBefore;
  const dirtyAfter = input.dirtyAdvance.dirtyAfter;
  if (
    phaseDObservationLag(dirtyBefore, 'dirty-before', firstSha).length > 0 ||
    !dirtyBefore.dirtyPaths.includes(PHASE_D_SENTINEL) ||
    !dirtyBefore.protectedFileSha256 ||
    !SHA256.test(dirtyBefore.protectedFileSha256)
  ) {
    errors.push('Phase D dirty-before observation must bind the overlapping dirty file at the first staging head');
  }
  if (
    phaseDObservationLag(dirtyAfter, 'dirty-after', secondSha).length > 0 ||
    !dirtyAfter.cursor.epochSeq ||
    compareEpochSeq(dirtyAfter.cursor.epochSeq, input.dirtyAdvance.sourceEvent.payload) !== 0 ||
    dirtyAfter.cursor.lastEventId < input.dirtyAdvance.destinationEvent.rowId ||
    dirtyAfter.cursor.lastEventId <= dirtyBefore.cursor.lastEventId
  ) {
    errors.push('Phase D dirty-after observation must advance the mirror and production bridge cursor');
  }
  if (
    dirtyAfter.worktreeHeadOid !== dirtyBefore.worktreeHeadOid ||
    dirtyAfter.protectedFileSha256 !== dirtyBefore.protectedFileSha256 ||
    !dirtyAfter.dirtyPaths.includes(PHASE_D_SENTINEL)
  ) {
    errors.push('Phase D dirty bridge must leave the worktree head and protected dirty file untouched');
  }
  if (compareEpochSeq(input.dirtyAdvance.sourceEvent.payload, input.firstAdvance.sourceEvent.payload) <= 0) {
    errors.push('Phase D second signed advance must be newer than the first epoch/seq');
  }
  if (
    input.dirtyAdvance.sourceEvent.rowId <= input.firstAdvance.sourceEvent.rowId ||
    input.dirtyAdvance.destinationEvent.rowId <= input.firstAdvance.destinationEvent.rowId
  ) {
    errors.push('Phase D second advance must use newer production event rows on both physical hosts');
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    result:
      uniqueErrors.length > 0
        ? null
        : {
            schemaVersion: PHASE_D_RESULT_SCHEMA,
            phase: 'D',
            planItem: PHASE_D_PLAN_ITEM,
            status: 'complete',
            complete: true,
            missingAssertions: [],
            observedAt: input.window.finishedAt,
            assertions: {
              freshBelowSteerHeadQueuedWithVisibleReceipt: true,
              exactRequestRatifiedThroughProductionSurface: true,
              productionGitSyncPublishedSignedCanonicalStaging: true,
              signedAdvanceFederatedToOtherPhysicalHost: true,
              otherPhysicalHostFastForwardedCanonicalAndWorktree: true,
              secondOverlappingAdvanceMovedMirrorAndCursor: true,
              dirtyWorktreeAndProtectedFileRemainedUntouched: true,
            },
            oids: { firstStaging: firstSha, secondStaging: secondSha },
            cursor: {
              firstEventId: firstDestination.cursor.lastEventId,
              secondEventId: dirtyAfter.cursor.lastEventId,
            },
          },
  };
}
