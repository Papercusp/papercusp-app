/**
 * A valid physical Phase I input, shared by the Phase I tests and the outer
 * physical-evidence guard. Every value is synthetic and deterministic except
 * the owning hive key, which is a freshly generated Ed25519 keypair so the
 * captured owner proof is a GENUINE signature (the validator re-verifies it).
 * The real end-to-end leg is exercised by physical-drill-phase-i.test.ts.
 */
import { createHash } from 'node:crypto';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  PHASE_I_ATTEMPT_SCHEMA,
  PHASE_I_EFFECTS,
  PHASE_I_INPUT_SCHEMA,
  PHASE_I_OWNER_SCHEMA,
  PHASE_I_PLAN,
  phaseIRepoKey,
  phaseIRosterEpoch,
  type PhaseIEffect,
  type PhaseIEffectAttempt,
  type PhaseIHost,
  type PhaseITargetSnapshot,
  type PhaseIVariant,
  type PhysicalPhaseIAttempt,
  type PhysicalPhaseIInput,
  type PhysicalPhaseIStep,
} from './physical-drill-phase-i';
import type { SignedSigrefs } from './sigrefs';

export const PHASE_I_FIXTURE_OWNER_PIDS = { first: 70_001, restored: 70_002 } as const;
const ATTEMPT_PID: Record<PhaseIHost, number> = { vm: 71_001, tower: 72_001 };

type Snap = PhaseITargetSnapshot;

function freshSnapshot(oid: (label: string) => string): Snap {
  return {
    protected: {
      stagingRef: null,
      releaseRef: null,
      githubMain: null,
      submoduleOriginMain: oid('sub-base'),
      superOriginMain: oid('super-base'),
      forkExists: false,
      forkRefs: [],
      pullRequests: [],
    },
    local: { workHead: oid('work-base'), submoduleLocalHead: oid('sub-base') },
  };
}

function applyEffect(s: Snap, effect: PhaseIEffect, candidate: string): void {
  const p = s.protected;
  if (effect === 'canonical-staging') p.stagingRef = candidate;
  if (effect === 'release-promotion') p.releaseRef = candidate;
  if (effect === 'github-push') p.githubMain = candidate;
  if (effect === 'submodule-origin-push') p.submoduleOriginMain = candidate;
  if (effect === 'fork-pr') {
    p.forkExists = true;
    p.forkRefs.push({ ref: `refs/heads/p521-phase-i/${candidate.slice(0, 12)}`, sha: candidate });
    p.pullRequests.push({ number: p.pullRequests.length + 1, headRef: `p521-phase-i/${candidate.slice(0, 12)}` });
  }
}

export function buildPhysicalPhaseIInput(options: {
  runId: string;
  towerDeviceKey: string;
  vmDeviceKey: string;
  startMs: number;
}): PhysicalPhaseIInput {
  const { runId, towerDeviceKey, vmDeviceKey, startMs } = options;
  let clock = startMs;
  const tick = () => new Date((clock += 1_000)).toISOString();
  let seq = 0;
  const oid = (label: string) => createHash('sha1').update(`phase-i-fixture:${runId}:${label}`).digest('hex');
  const nextOid = () => oid(`candidate-${(seq += 1)}`);
  const hive = generateEd25519KeypairDer();
  const repoKey = phaseIRepoKey(runId);
  const state: Record<PhaseIHost, Snap> = { vm: freshSnapshot(oid), tower: freshSnapshot(oid) };
  const deviceKey: Record<PhaseIHost, string> = { vm: vmDeviceKey, tower: towerDeviceKey };

  const attempt = (host: PhaseIHost, effect: PhaseIEffect, variant: PhaseIVariant, allow: boolean): PhaseIEffectAttempt => {
    const s = state[host];
    const candidate = nextOid();
    // A local commit precedes the sink; git-sync commits a submodule change inside it.
    if (effect !== 'submodule-origin-push') s.local.workHead = candidate;
    const before = structuredClone(s);
    if (effect === 'submodule-origin-push') s.local.submoduleLocalHead = candidate;
    if (allow) applyEffect(s, effect, candidate);
    return {
      effect,
      variant,
      candidate,
      ok: allow,
      reason: allow ? null : variant === 'missing' ? 'missing-hive-authority' : 'protected effect requires the owning hive key',
      signerCalls: variant === 'missing' ? 0 : 1,
      before,
      after: structuredClone(s),
      pushArgs: allow ? [['push', '--porcelain', `/phase-i/${host}/${effect}.git`, `${candidate}:refs/heads/main`]] : [],
    };
  };

  const header = (host: PhaseIHost, step: PhysicalPhaseIStep, startedAt: string) => ({
    schemaVersion: PHASE_I_ATTEMPT_SCHEMA,
    hostId: host,
    step,
    runId,
    startedAt,
    attemptPid: ATTEMPT_PID[host],
    hiveId: hive.pubkeyBase64,
    repoKey,
    advisory: {
      provenance: 'drill-supplied-roster-inputs' as const,
      rosterEpoch: phaseIRosterEpoch(runId),
      isSelf: true,
      leaderDevicePubkey: deviceKey[host],
    },
    deviceSigner: { devicePubkey: deviceKey[host], verified: true },
    ownerKeyMaterialOnHost: host === 'vm',
  });

  const step = (host: PhaseIHost, name: PhysicalPhaseIStep, extra: Partial<PhysicalPhaseIAttempt> = {}): PhysicalPhaseIAttempt => {
    const startedAt = tick();
    const attempts: PhaseIEffectAttempt[] = [];
    for (const variant of PHASE_I_PLAN[host][name] ?? []) {
      for (const effect of PHASE_I_EFFECTS) attempts.push(attempt(host, effect, variant, host === 'vm' && variant === 'owner'));
    }
    const local = nextOid();
    state[host].local.workHead = local;
    return {
      ...header(host, name, startedAt),
      attempts,
      localCommit: { oid: local, landed: true },
      capturedOwnerProof: null,
      deviceHead: null,
      deviceHeadAcceptance: null,
      lost: null,
      ...extra,
      finishedAt: tick(),
    };
  };

  const windowStartedAt = tick();
  const first = {
    schemaVersion: PHASE_I_OWNER_SCHEMA, hostId: 'vm' as const, runId, hiveId: hive.pubkeyBase64,
    pid: PHASE_I_FIXTURE_OWNER_PIDS.first, startedAt: tick(), mintedKey: true,
  };

  const proofBytes = Buffer.from(`phase-i-fixture:${runId}:owner-proof`);
  const liveVm = step('vm', 'live', {
    capturedOwnerProof: {
      bytesBase64: proofBytes.toString('base64'),
      signatureBase64: signWithPrivateKeyDer(hive.privateKeyDer, proofBytes).toString('base64'),
    },
  });
  const liveTower = step('tower', 'live');

  const lostStartedAt = tick();
  const push1 = attempt('vm', 'github-push', 'owner', true);
  const vm = state.vm;
  const forkCandidate = nextOid();
  vm.local.workHead = forkCandidate;
  const forkBefore = structuredClone(vm);
  // The authorized fork push lands; the owner dies before the PR opens.
  vm.protected.forkExists = true;
  vm.protected.forkRefs.push({ ref: `refs/heads/p521-phase-i/${forkCandidate.slice(0, 12)}`, sha: forkCandidate });
  const forkPr: PhaseIEffectAttempt = {
    effect: 'fork-pr', variant: 'owner', candidate: forkCandidate, ok: false,
    reason: 'open PR authorization failed: protected effect requires the owning hive key',
    signerCalls: 2, before: forkBefore, after: structuredClone(vm),
    pushArgs: [['push', '--porcelain', '/phase-i/vm/fork.git', `${forkCandidate}:refs/heads/p521-phase-i/${forkCandidate.slice(0, 12)}`]],
  };
  const killedAt = tick();
  const push2 = attempt('vm', 'github-push', 'owner-unreachable', false);
  const submodule = attempt('vm', 'submodule-origin-push', 'owner-unreachable', false);
  const lostLocal = nextOid();
  vm.local.workHead = lostLocal;
  const lostVm: PhysicalPhaseIAttempt = {
    ...header('vm', 'lost', lostStartedAt),
    attempts: [],
    localCommit: { oid: lostLocal, landed: true },
    capturedOwnerProof: null,
    deviceHead: null,
    deviceHeadAcceptance: null,
    lost: { ownerPid: first.pid, killedAt, ownerGoneVerified: true, push1, forkPr, push2, submodule },
    finishedAt: tick(),
  };

  const deviceHead = {
    v: 1,
    device_pubkey: vmDeviceKey,
    version: 1,
    refs: {},
    sig: 'phase-i-fixture-signature',
  } as unknown as SignedSigrefs;
  const outageVm = step('vm', 'outage', { deviceHead });
  const outageTower = step('tower', 'outage', { deviceHeadAcceptance: { ok: true, reason: null } });

  const restored = { ...first, pid: PHASE_I_FIXTURE_OWNER_PIDS.restored, startedAt: tick(), mintedKey: false };
  const restoredVm = step('vm', 'restored');
  const restoredTower = step('tower', 'restored');

  return {
    schemaVersion: PHASE_I_INPUT_SCHEMA,
    runId,
    window: { startedAt: windowStartedAt, finishedAt: tick() },
    identities: { towerDeviceKey, vmDeviceKey },
    owner: { first, restored, goneAfterLost: true },
    steps: {
      live: { vm: liveVm, tower: liveTower },
      lost: { vm: lostVm },
      outage: { vm: outageVm, tower: outageTower },
      restored: { vm: restoredVm, tower: restoredTower },
    },
  };
}
