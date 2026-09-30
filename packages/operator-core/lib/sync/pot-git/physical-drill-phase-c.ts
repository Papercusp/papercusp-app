/**
 * Fixed real-Git/real-Ed25519 negative controls for P-505 physical Phase C.
 *
 * Phase B proves the production transport. Phase C independently exercises
 * the production trust primitives on each physical store: a relay-mutated
 * third-device head must disagree with the still-valid signed snapshot, a
 * stale signed snapshot must fail the monotonic version fence, and a
 * non-member scope-repo fetch must fail the roster serve gate. The executor
 * creates every key, ref, commit, and scope path itself from the fixed target
 * plus a run id; callers cannot supply a command or pre-authored manifest.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { ensureScopeRepo, formatScopeId, scopeRepoPath, type ScopeId } from './scope-repo';
import { authorizeScopeRepoServe, type ScopeRepoServeRefusal } from './scope-serve-gate';
import {
  acceptFetchedSigrefs,
  buildSigrefs,
  reconcileFetchedHeads,
  verifySigrefs,
  type SignedSigrefs,
} from './sigrefs';
import { defaultRunGit, deviceNamespaceKey, hiveGitRepoPath, readNamespaceRef, writeNamespaceRef } from './storage';
import { PHASE_A_POT_HOME, PHASE_A_REPO_KEY } from './physical-drill-phase-a';

export const PHASE_C_HOST_SCHEMA = 'hive-git-physical-phase-c-host-result/v1' as const;
export const PHASE_C_INPUT_SCHEMA = 'hive-git-physical-phase-c-input/v1' as const;
export const PHASE_C_RESULT_SCHEMA = 'hive-git-physical-phase-c-result/v1' as const;
export const PHASE_C_PLAN_ITEM = 'P-304' as const;

const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SCOPE_OWNER_GITHUB_USER_ID = 424_242;
const NON_MEMBER_GITHUB_USER_ID = 999_999;

export type PhysicalPhaseCHost = 'tower' | 'vm';

type HeadMismatch = { ref: string; expected: string; actual: string | null };

export type PhysicalPhaseCHostResult = {
  schemaVersion: typeof PHASE_C_HOST_SCHEMA;
  hostId: PhysicalPhaseCHost;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  repoPath: string;
  physicalDeviceKey: string;
  peerDeviceKey: string;
  thirdDeviceKey: string;
  thirdNamespace: string;
  ref: string;
  honestOid: string;
  rogueOid: string;
  signedSigrefs: SignedSigrefs;
  signatureAcceptance: { ok: true };
  relayMismatches: HeadMismatch[];
  rollback: {
    priorVersion: number;
    decision: { ok: false; reason: 'rollback' };
  };
  nonMember: {
    scopeId: string;
    scopeRepoPath: string;
    scopeRepoBare: true;
    peerGithubUserId: number;
    membershipChecks: 1;
    decision: { ok: false; refusal: ScopeRepoServeRefusal };
  };
  restoredMismatches: [];
};

export type PhysicalPhaseCInput = {
  schemaVersion: typeof PHASE_C_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  hostResults: [PhysicalPhaseCHostResult, PhysicalPhaseCHostResult];
};

export type PhysicalPhaseCVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_C_RESULT_SCHEMA;
    phase: 'C';
    planItem: typeof PHASE_C_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      runBoundThirdDeviceNamespacesOnBothHosts: true;
      realGitAndEd25519ControlsOnBothHosts: true;
      relayLieRefusedBySignedHeadReconciliation: true;
      staleSigrefsRollbackRefused: true;
      nonMemberScopeServeRefused: true;
      honestHeadsRestoredAfterTamperControls: true;
    };
    hosts: Array<{
      hostId: PhysicalPhaseCHost;
      thirdDeviceKey: string;
      ref: string;
      honestOid: string;
      rogueOid: string;
      sigrefsVersion: number;
      scopeId: string;
    }>;
  };
};

function assertRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`physical Phase C runId is invalid: ${runId}`);
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await defaultRunGit(args, repoPath);
  if (result.code !== 0) {
    throw new Error(`physical Phase C git ${args.join(' ')} failed for ${repoPath}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function assertCanonicalRepoPath(repoPath: string): Promise<void> {
  const expected = hiveGitRepoPath(PHASE_A_POT_HOME, PHASE_A_REPO_KEY);
  if (!isAbsolute(repoPath) || resolve(repoPath) !== resolve(expected)) {
    throw new Error(`physical Phase C repo path must be the fixed ${expected}: ${repoPath}`);
  }
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`physical Phase C expected a bare repo directory at ${repoPath}`);
  }
  if ((await git(repoPath, ['rev-parse', '--is-bare-repository'])) !== 'true') {
    throw new Error(`physical Phase C target is not a bare repository: ${repoPath}`);
  }
}

async function mintCommit(repoPath: string, message: string): Promise<string> {
  const tree = await git(repoPath, ['hash-object', '-w', '-t', 'tree', '/dev/null']);
  const oid = await git(repoPath, [
    '-c',
    'user.name=p505-phase-c',
    '-c',
    'user.email=p505-phase-c@papercusp.invalid',
    'commit-tree',
    tree,
    '-m',
    message,
  ]);
  if (!OID.test(oid)) throw new Error(`physical Phase C created malformed commit OID: ${oid}`);
  return oid;
}

export function physicalPhaseCRef(hostId: PhysicalPhaseCHost, runId: string): string {
  assertRunId(runId);
  return `refs/heads/p505-phase-c-${hostId}-${runId}`;
}

export function physicalPhaseCScope(runId: string): ScopeId {
  assertRunId(runId);
  const suffix = createHash('sha256').update(runId).digest('hex').slice(0, 20);
  return { kind: 'fleet', ownerGithubUserId: SCOPE_OWNER_GITHUB_USER_ID, slug: `p505-c-${suffix}` };
}

/** Run all three Phase C negative controls on one physical host. */
export async function executePhysicalPhaseCHost(input: {
  hostId: PhysicalPhaseCHost;
  runId: string;
  repoPath: string;
  physicalDeviceKey: string;
  peerDeviceKey: string;
}): Promise<PhysicalPhaseCHostResult> {
  assertRunId(input.runId);
  await assertCanonicalRepoPath(input.repoPath);
  const physicalNamespace = deviceNamespaceKey(input.physicalDeviceKey);
  const peerNamespace = deviceNamespaceKey(input.peerDeviceKey);
  if (physicalNamespace === peerNamespace) {
    throw new Error('physical Phase C physical and peer device identities must be distinct');
  }

  const startedAt = new Date().toISOString();
  let third = generateEd25519KeypairDer();
  while (third.pubkeyBase64 === input.physicalDeviceKey || third.pubkeyBase64 === input.peerDeviceKey) {
    third = generateEd25519KeypairDer();
  }
  const thirdNamespace = deviceNamespaceKey(third.pubkeyBase64);
  const ref = physicalPhaseCRef(input.hostId, input.runId);
  if ((await readNamespaceRef(input.repoPath, third.pubkeyBase64, ref)) !== null) {
    throw new Error(`physical Phase C refuses a pre-existing run-bound ref: ${ref}`);
  }

  const honestOid = await mintCommit(input.repoPath, `P-505 Phase C ${input.hostId} honest ${input.runId}`);
  const rogueOid = await mintCommit(input.repoPath, `P-505 Phase C ${input.hostId} relay-lie ${input.runId}`);
  await writeNamespaceRef(input.repoPath, third.pubkeyBase64, ref, honestOid);
  const signedSigrefs = await buildSigrefs(
    input.repoPath,
    third.pubkeyBase64,
    (bytes) => Promise.resolve(signWithPrivateKeyDer(third.privateKeyDer, bytes)),
    { nowMs: Date.now(), version: 1 },
  );
  const signatureAcceptance = acceptFetchedSigrefs(signedSigrefs, third.pubkeyBase64, null, { allowLegacy: true });
  if (!signatureAcceptance.ok) {
    throw new Error(`physical Phase C authentic sigrefs was rejected: ${signatureAcceptance.reason}`);
  }

  let relayMismatches: HeadMismatch[] = [];
  let rogueInstalled = false;
  try {
    await writeNamespaceRef(input.repoPath, third.pubkeyBase64, ref, rogueOid, defaultRunGit, honestOid);
    rogueInstalled = true;
    relayMismatches = await reconcileFetchedHeads(input.repoPath, third.pubkeyBase64, signedSigrefs);
    if (
      relayMismatches.length !== 1 ||
      relayMismatches[0]?.ref !== ref ||
      relayMismatches[0]?.expected !== honestOid ||
      relayMismatches[0]?.actual !== rogueOid
    ) {
      throw new Error('physical Phase C relay lie did not produce the exact signed-head mismatch');
    }
  } finally {
    if (rogueInstalled) {
      await writeNamespaceRef(input.repoPath, third.pubkeyBase64, ref, honestOid, defaultRunGit, rogueOid);
    }
  }

  const restoredMismatches = await reconcileFetchedHeads(input.repoPath, third.pubkeyBase64, signedSigrefs);
  if (restoredMismatches.length !== 0) {
    throw new Error('physical Phase C failed to restore the honest signed namespace after the relay control');
  }
  const rollbackDecision = acceptFetchedSigrefs(signedSigrefs, third.pubkeyBase64, signedSigrefs.version, { allowLegacy: true });
  if (rollbackDecision.ok || rollbackDecision.reason !== 'rollback') {
    throw new Error('physical Phase C stale sigrefs did not fail the monotonic rollback fence');
  }

  const scope = physicalPhaseCScope(input.runId);
  const physicalScopeRepo = await ensureScopeRepo(PHASE_A_POT_HOME, scope);
  const scopeRepoBare = (await git(physicalScopeRepo, ['rev-parse', '--is-bare-repository'])) === 'true';
  if (!scopeRepoBare) throw new Error('physical Phase C scope control did not target a real bare repo');
  let membershipChecks = 0;
  const nonMemberDecision = await authorizeScopeRepoServe({
    repoPath: physicalScopeRepo,
    peerGithubUserId: NON_MEMBER_GITHUB_USER_ID,
    isScopeMember: (observedScope, peerGithubUserId) => {
      membershipChecks += 1;
      if (formatScopeId(observedScope) !== formatScopeId(scope)) {
        throw new Error('scope gate parsed an unexpected run-bound scope');
      }
      if (peerGithubUserId !== NON_MEMBER_GITHUB_USER_ID) {
        throw new Error('scope gate checked an unexpected peer');
      }
      return false;
    },
  });
  if (nonMemberDecision.ok || nonMemberDecision.refusal.reason !== 'not-a-member' || membershipChecks !== 1) {
    throw new Error('physical Phase C non-member scope serve did not fail closed exactly once');
  }

  return {
    schemaVersion: PHASE_C_HOST_SCHEMA,
    hostId: input.hostId,
    runId: input.runId,
    window: { startedAt, finishedAt: new Date().toISOString() },
    repoPath: input.repoPath,
    physicalDeviceKey: input.physicalDeviceKey,
    peerDeviceKey: input.peerDeviceKey,
    thirdDeviceKey: third.pubkeyBase64,
    thirdNamespace,
    ref,
    honestOid,
    rogueOid,
    signedSigrefs,
    signatureAcceptance,
    relayMismatches,
    rollback: {
      priorVersion: signedSigrefs.version,
      decision: { ok: false, reason: 'rollback' },
    },
    nonMember: {
      scopeId: formatScopeId(scope),
      scopeRepoPath: physicalScopeRepo,
      scopeRepoBare: true,
      peerGithubUserId: NON_MEMBER_GITHUB_USER_ID,
      membershipChecks: 1,
      decision: nonMemberDecision,
    },
    restoredMismatches: [],
  };
}

function time(value: string, label: string, errors: string[]): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

function validateHost(
  host: PhysicalPhaseCHostResult,
  expected: {
    hostId: PhysicalPhaseCHost;
    physicalDeviceKey: string;
    peerDeviceKey: string;
    runId: string;
  },
  errors: string[],
): void {
  const label = `Phase C ${expected.hostId}`;
  if (host.schemaVersion !== PHASE_C_HOST_SCHEMA) errors.push(`${label} host schema is invalid`);
  if (host.hostId !== expected.hostId) errors.push(`${label} hostId is invalid`);
  if (host.runId !== expected.runId) errors.push(`${label} runId is invalid`);
  if (host.physicalDeviceKey !== expected.physicalDeviceKey || host.peerDeviceKey !== expected.peerDeviceKey) {
    errors.push(`${label} physical identities are invalid`);
  }
  const suffix = join(PHASE_A_POT_HOME, `${PHASE_A_REPO_KEY}.git`);
  if (!isAbsolute(host.repoPath) || !resolve(host.repoPath).endsWith(suffix)) {
    errors.push(`${label} repo path is not the fixed physical target`);
  }
  try {
    const thirdNamespace = deviceNamespaceKey(host.thirdDeviceKey);
    if (host.thirdDeviceKey === expected.physicalDeviceKey || host.thirdDeviceKey === expected.peerDeviceKey) {
      errors.push(`${label} third-device identity is not independent`);
    }
    if (host.thirdNamespace !== thirdNamespace) {
      errors.push(`${label} third-device namespace is not identity-derived`);
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const expectedRef = physicalPhaseCRef(expected.hostId, expected.runId);
  if (host.ref !== expectedRef) errors.push(`${label} run-bound ref is invalid`);
  if (!OID.test(host.honestOid) || !OID.test(host.rogueOid) || host.honestOid === host.rogueOid) {
    errors.push(`${label} honest and rogue Git commits are invalid`);
  }

  if (!verifySigrefs(host.signedSigrefs, host.thirdDeviceKey)) {
    errors.push(`${label} signed snapshot is not valid Ed25519 evidence`);
  }
  if (
    host.signedSigrefs.version !== 1 ||
    host.signedSigrefs.refs.length !== 1 ||
    host.signedSigrefs.refs[0]?.ref !== expectedRef ||
    host.signedSigrefs.refs[0]?.sha !== host.honestOid
  ) {
    errors.push(`${label} signed snapshot does not bind the exact honest run ref`);
  }
  if (!host.signatureAcceptance?.ok || !acceptFetchedSigrefs(host.signedSigrefs, host.thirdDeviceKey, null, { allowLegacy: true }).ok) {
    errors.push(`${label} authentic signed snapshot was not accepted before tamper`);
  }
  if (
    host.relayMismatches.length !== 1 ||
    host.relayMismatches[0]?.ref !== expectedRef ||
    host.relayMismatches[0]?.expected !== host.honestOid ||
    host.relayMismatches[0]?.actual !== host.rogueOid
  ) {
    errors.push(`${label} relay lie is not the exact signed-head mismatch`);
  }
  const rollback = acceptFetchedSigrefs(host.signedSigrefs, host.thirdDeviceKey, host.rollback.priorVersion, { allowLegacy: true });
  if (
    host.rollback.priorVersion !== host.signedSigrefs.version ||
    host.rollback.decision.ok !== false ||
    host.rollback.decision.reason !== 'rollback' ||
    rollback.ok ||
    rollback.reason !== 'rollback'
  ) {
    errors.push(`${label} stale signed snapshot was not refused by the rollback fence`);
  }

  const scope = physicalPhaseCScope(expected.runId);
  const expectedScopeId = formatScopeId(scope);
  const expectedScopeSuffix = join(
    PHASE_A_POT_HOME,
    'scopes',
    `fleet-${SCOPE_OWNER_GITHUB_USER_ID}`,
    `${scope.slug}.git`,
  );
  const refusal = host.nonMember.decision.ok === false ? host.nonMember.decision.refusal : null;
  if (
    host.nonMember.scopeId !== expectedScopeId ||
    !isAbsolute(host.nonMember.scopeRepoPath) ||
    !resolve(host.nonMember.scopeRepoPath).endsWith(expectedScopeSuffix) ||
    host.nonMember.scopeRepoBare !== true ||
    host.nonMember.peerGithubUserId !== NON_MEMBER_GITHUB_USER_ID ||
    host.nonMember.membershipChecks !== 1 ||
    !refusal ||
    refusal.reason !== 'not-a-member' ||
    refusal.repoPath !== host.nonMember.scopeRepoPath ||
    refusal.scopeId !== expectedScopeId ||
    refusal.peerGithubUserId !== NON_MEMBER_GITHUB_USER_ID
  ) {
    errors.push(`${label} non-member scope serve was not refused by the fixed roster gate`);
  }
  if (!Array.isArray(host.restoredMismatches) || host.restoredMismatches.length !== 0) {
    errors.push(`${label} honest head was not restored after the relay control`);
  }
  const startedAt = time(host.window.startedAt, `${label}.window.startedAt`, errors);
  const finishedAt = time(host.window.finishedAt, `${label}.window.finishedAt`, errors);
  if (finishedAt < startedAt) errors.push(`${label} window must finish after it starts`);
  if (
    !Number.isSafeInteger(host.signedSigrefs.ts) ||
    host.signedSigrefs.ts < startedAt ||
    host.signedSigrefs.ts > finishedAt
  ) {
    errors.push(`${label} signed snapshot must be fresh inside the host control window`);
  }
}

export function validatePhysicalPhaseC(input: PhysicalPhaseCInput): PhysicalPhaseCVerdict {
  const errors: string[] = [];
  if (input.schemaVersion !== PHASE_C_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_C_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input.runId)) errors.push('runId is invalid');
  try {
    if (deviceNamespaceKey(input.identities.towerDeviceKey) === deviceNamespaceKey(input.identities.vmDeviceKey)) {
      errors.push('tower and vm identities must be distinct');
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const startedAt = time(input.window.startedAt, 'window.startedAt', errors);
  const finishedAt = time(input.window.finishedAt, 'window.finishedAt', errors);
  if (finishedAt < startedAt) errors.push('Phase C window must finish after it starts');

  if (!Array.isArray(input.hostResults) || input.hostResults.length !== 2) {
    errors.push('Phase C requires exactly two physical host results');
  } else {
    const byHost = new Map(input.hostResults.map((host) => [host.hostId, host]));
    if (byHost.size !== 2 || !byHost.has('tower') || !byHost.has('vm')) {
      errors.push('Phase C requires tower and vm results exactly once');
    } else {
      validateHost(
        byHost.get('tower')!,
        {
          hostId: 'tower',
          physicalDeviceKey: input.identities.towerDeviceKey,
          peerDeviceKey: input.identities.vmDeviceKey,
          runId: input.runId,
        },
        errors,
      );
      validateHost(
        byHost.get('vm')!,
        {
          hostId: 'vm',
          physicalDeviceKey: input.identities.vmDeviceKey,
          peerDeviceKey: input.identities.towerDeviceKey,
          runId: input.runId,
        },
        errors,
      );
      for (const host of [byHost.get('tower')!, byHost.get('vm')!]) {
        const hostStartedAt = Date.parse(host.window.startedAt);
        const hostFinishedAt = Date.parse(host.window.finishedAt);
        if (
          Number.isFinite(startedAt) &&
          Number.isFinite(finishedAt) &&
          Number.isFinite(hostStartedAt) &&
          Number.isFinite(hostFinishedAt) &&
          (hostStartedAt < startedAt || hostFinishedAt > finishedAt)
        ) {
          errors.push(`Phase C ${host.hostId} control is outside the aggregate same-run window`);
        }
      }
      if (byHost.get('tower')!.thirdDeviceKey === byHost.get('vm')!.thirdDeviceKey) {
        errors.push('Phase C hosts must generate distinct third-device identities');
      }
      if (resolve(byHost.get('tower')!.repoPath) === resolve(byHost.get('vm')!.repoPath)) {
        errors.push('Phase C host results must come from distinct physical store paths');
      }
    }
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    result:
      uniqueErrors.length > 0
        ? null
        : {
            schemaVersion: PHASE_C_RESULT_SCHEMA,
            phase: 'C',
            planItem: PHASE_C_PLAN_ITEM,
            status: 'complete',
            complete: true,
            missingAssertions: [],
            observedAt: input.window.finishedAt,
            assertions: {
              runBoundThirdDeviceNamespacesOnBothHosts: true,
              realGitAndEd25519ControlsOnBothHosts: true,
              relayLieRefusedBySignedHeadReconciliation: true,
              staleSigrefsRollbackRefused: true,
              nonMemberScopeServeRefused: true,
              honestHeadsRestoredAfterTamperControls: true,
            },
            hosts: [...input.hostResults]
              .sort((a, b) => a.hostId.localeCompare(b.hostId))
              .map((host) => ({
                hostId: host.hostId,
                thirdDeviceKey: host.thirdDeviceKey,
                ref: host.ref,
                honestOid: host.honestOid,
                rogueOid: host.rogueOid,
                sigrefsVersion: host.signedSigrefs.version,
                scopeId: host.nonMember.scopeId,
              })),
          },
  };
}
