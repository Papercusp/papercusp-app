/**
 * P-521 F3 physical Phase H: serving identity on two hosts.
 *
 * The VM is the mutated host. The tower is the fleet's live bg-host, so it is
 * never frozen or restarted; it only runs its production receive tick. Every
 * publish attempt runs in THIS producer, an OS process that is not the serving
 * owner, through the production ref-announce leg (`runRefAnnounceLeg`). The
 * owner's capability is resolved only from its cross-process advertisement.
 * The producer cannot boot a substitute owner: its boot seam refuses every
 * call and counts it.
 *
 * Steps (the scenario performs the host mutation before each one):
 *   pre        owner live: the captured capability signs, publication advances
 *   omitted    owner frozen past the lease: the advertisement expires, the
 *              captured capability refuses retryably, and no ref moves
 *   restarted  owner restarted on the same artifact: new runtime, the old
 *              capability refuses, the fresh one publishes
 *   replaced   store rebuilt: new store generation, the restarted capability
 *              refuses, the fresh one publishes and reaches the tower
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { PHASE_A_POT_HOME, PHASE_A_REPO_KEY, type PhysicalDrillHost } from './physical-drill-phase-a';
import {
  GIT_SERVING_LEASE_MS,
  guardGitServingSigner,
  type GitServingCapability,
  type GitServingRequest,
  type GitServingState,
} from './serving-capability';
import { storeGenerationOrdinal } from './signed-context';
import { STORE_INCARNATION_REF } from './signed-context-store';
import { SIGREFS_REF, verifySigrefs, type SignedSigrefs } from './sigrefs';
import { deviceNamespaceKey } from './storage';

export const PHASE_H_OBSERVATION_SCHEMA = 'hive-git-physical-phase-h-observation/v1' as const;
export const PHASE_H_ATTEMPT_SCHEMA = 'hive-git-physical-phase-h-attempt/v1' as const;
export const PHASE_H_INPUT_SCHEMA = 'hive-git-physical-phase-h-input/v1' as const;
export const PHASE_H_RESULT_SCHEMA = 'hive-git-physical-phase-h-result/v1' as const;
export const PHASE_H_PLAN_ITEM = 'P-521' as const;
export const PHASE_H_WORKSPACE_ID = 'papercusp-workspace' as const;
/** The freeze must outlive both the capability lease and the 30s advertisement row age. */
export const PHASE_H_MIN_OMISSION_MS = GIT_SERVING_LEASE_MS + 5_000;
export const PHASE_H_STEPS = ['pre', 'omitted', 'restarted', 'replaced'] as const;
export type PhysicalPhaseHStep = (typeof PHASE_H_STEPS)[number];

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;
const ZERO_OID = '0'.repeat(40);
const PAYLOAD_FILE = 'p521-phase-h.json';

export type PhaseHCapabilitySummary = {
  runtimeId: string;
  storeGeneration: string;
  devicePubkeyBase64: string;
  issuedAtMs: number;
  expiresAtMs: number;
};

export type PhaseHNamespaceSigrefs = {
  deviceKey: string;
  sigrefsOid: string | null;
  version: number | null;
  storeGeneration: string | null;
  signatureValid: boolean;
  refs: Array<{ ref: string; sha: string }>;
};

export type PhysicalPhaseHObservation = {
  schemaVersion: typeof PHASE_H_OBSERVATION_SCHEMA;
  hostId: PhysicalDrillHost;
  step: PhysicalPhaseHStep;
  observedAt: string;
  observerPid: number;
  advertisement: { present: boolean; publisherId: string | null; sentAtMs: number | null; ageMs: number | null };
  serving: { status: string; retryable: boolean; reason: string | null; capability: GitServingCapability | null };
  storeIncarnation: string | null;
  namespaces: PhaseHNamespaceSigrefs[];
};

export type PhaseHGuardOutcome =
  | { outcome: 'signed'; capability: PhaseHCapabilitySummary; signatureValid: boolean }
  | { outcome: 'refused'; capability: PhaseHCapabilitySummary; code: string | null; retryable: boolean; message: string };

export type PhysicalPhaseHAttempt = {
  schemaVersion: typeof PHASE_H_ATTEMPT_SCHEMA;
  hostId: 'vm';
  step: PhysicalPhaseHStep;
  runId: string;
  startedAt: string;
  finishedAt: string;
  publisherPid: number;
  resolution: { status: string; retryable: boolean; reason: string | null; capability: PhaseHCapabilitySummary | null };
  capturedGuard: PhaseHGuardOutcome;
  /** Calls the producer's boot seam received; every one was refused. */
  bootAttempts: number;
  commit: { ref: string; oid: string };
  /** The announcement THIS process signed and persisted, or null. */
  published: { version: number; sigrefsOid: string } | null;
  sigrefsBefore: PhaseHNamespaceSigrefs;
  sigrefsAfter: PhaseHNamespaceSigrefs;
};

// build is the owner's health sha, or `version:<v>` for a release build whose
// health reports no sha (the installed artifact).
export type PhaseHOwnerIdentity = { pid: number; build: string; launcher: string };

export type PhysicalPhaseHStepInput = {
  vm: PhysicalPhaseHObservation;
  attempt: PhysicalPhaseHAttempt;
  /** Tower observation after its production receive tick. */
  tower: PhysicalPhaseHObservation;
};

export type PhysicalPhaseHInput = {
  schemaVersion: typeof PHASE_H_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  vmOwner: { before: PhaseHOwnerIdentity; after: PhaseHOwnerIdentity; frozenMs: number };
  steps: Record<PhysicalPhaseHStep, PhysicalPhaseHStepInput>;
};

export type PhysicalPhaseHVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_H_RESULT_SCHEMA;
    phase: 'H';
    planItem: typeof PHASE_H_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      separateProcessPublishUsedOwnerCapability: true;
      discoveryLossRefusedRetryablyWithoutRefMovement: true;
      ownerRestartRefusedOldRuntime: true;
      freshRuntimeRestoredPublication: true;
      storeReplacementRefusedOldGeneration: true;
      freshGenerationRestoredPublicationOnBothHosts: true;
      artifactIdentityStableAcrossRestart: true;
    };
    identities: Record<PhysicalPhaseHStep, { runtimeId: string | null; storeGeneration: string | null; sigrefsOid: string | null }>;
  };
};

function git(repoPath: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}) {
  const result = spawnSync('git', ['--git-dir', repoPath, ...args], {
    encoding: 'utf8',
    input: options.input,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...options.env },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`physical Phase H git ${args.join(' ')} failed for ${repoPath}: ${result.stderr.trim()}`);
  }
  return { ok: result.status === 0, stdout: result.stdout.trim() };
}

function assertCanonicalRepoPath(repoPath: string): void {
  const suffix = join(PHASE_A_POT_HOME, `${PHASE_A_REPO_KEY}.git`);
  if (!isAbsolute(repoPath) || !resolvePath(repoPath).endsWith(suffix)) {
    throw new Error(`physical Phase H repo path must target ${suffix}: ${repoPath}`);
  }
  if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
    throw new Error(`physical Phase H expected a bare repo directory at ${repoPath}`);
  }
}

export function assertPhysicalPhaseHStep(step: string): asserts step is PhysicalPhaseHStep {
  if (!(PHASE_H_STEPS as readonly string[]).includes(step)) {
    throw new Error(`physical Phase H step must be one of ${PHASE_H_STEPS.join('|')}: ${step}`);
  }
}

export function summarizeCapability(capability: GitServingCapability): PhaseHCapabilitySummary {
  return {
    runtimeId: capability.runtimeId,
    storeGeneration: capability.context.store_generation,
    devicePubkeyBase64: capability.identity.devicePubkeyBase64,
    issuedAtMs: capability.issuedAtMs,
    expiresAtMs: capability.expiresAtMs,
  };
}

export function readPhaseHNamespaceSigrefs(repoPath: string, deviceKey: string): PhaseHNamespaceSigrefs {
  const ref = `refs/namespaces/${deviceNamespaceKey(deviceKey)}/${SIGREFS_REF}`;
  const resolved = git(repoPath, ['show-ref', '--verify', '--hash', ref], { allowFailure: true });
  if (!resolved.ok) return { deviceKey, sigrefsOid: null, version: null, storeGeneration: null, signatureValid: false, refs: [] };
  if (!OID.test(resolved.stdout)) throw new Error(`physical Phase H observed malformed sigrefs OID: ${resolved.stdout}`);
  const signed = JSON.parse(git(repoPath, ['cat-file', 'blob', resolved.stdout]).stdout) as SignedSigrefs;
  return {
    deviceKey,
    sigrefsOid: resolved.stdout,
    version: Number.isSafeInteger(signed.version) ? signed.version : null,
    storeGeneration: signed.store_generation ?? null,
    signatureValid: verifySigrefs(signed, deviceKey),
    refs: Array.isArray(signed.refs) ? signed.refs.map(({ ref: name, sha }) => ({ ref: name, sha })) : [],
  };
}

async function phaseHServingRequest(): Promise<GitServingRequest> {
  const { getHiveBySlug } = await import('../../hive-store');
  const hive = await getHiveBySlug(PHASE_H_WORKSPACE_ID, PHASE_A_POT_HOME);
  if (!hive?.pubkeyBase64) throw new Error(`physical Phase H: no hive identity for ${PHASE_A_POT_HOME}`);
  return {
    workspaceId: PHASE_H_WORKSPACE_ID,
    installSlug: PHASE_A_POT_HOME,
    potHomeSlug: PHASE_A_POT_HOME,
    scope: { hive_id: hive.pubkeyBase64, repo_key: PHASE_A_REPO_KEY },
  };
}

export async function observePhysicalPhaseH(input: {
  hostId: PhysicalDrillHost;
  step: string;
  repoPath: string;
  deviceKeys: string[];
}): Promise<PhysicalPhaseHObservation> {
  assertPhysicalPhaseHStep(input.step);
  assertCanonicalRepoPath(input.repoPath);
  const request = await phaseHServingRequest();
  const [{ readOperatorState }, { getPgGitServingCapability }] = await Promise.all([
    import('../../operator-state-pg'),
    import('../hyperbee/substrate-booted-handles-pg'),
  ]);
  const row = await readOperatorState<{ publisherId?: string; sentAt?: number }>(
    'substrate_booted_handles_status', undefined, { fresh: true },
  ).catch(() => null);
  const serving = await getPgGitServingCapability(request);
  const now = Date.now();
  const sentAtMs = Number.isFinite(row?.sentAt) ? row!.sentAt! : null;
  const incarnation = git(input.repoPath, ['rev-parse', '--verify', '--quiet', STORE_INCARNATION_REF], { allowFailure: true });
  return {
    schemaVersion: PHASE_H_OBSERVATION_SCHEMA,
    hostId: input.hostId,
    step: input.step,
    observedAt: new Date(now).toISOString(),
    observerPid: process.pid,
    advertisement: {
      present: Boolean(row),
      publisherId: row?.publisherId ?? null,
      sentAtMs,
      ageMs: sentAtMs === null ? null : now - sentAtMs,
    },
    serving: serving.status === 'ready'
      ? { status: 'ready', retryable: false, reason: null, capability: serving.capability }
      : { status: serving.status, retryable: serving.retryable, reason: serving.reason, capability: null },
    storeIncarnation: incarnation.ok ? incarnation.stdout : null,
    namespaces: input.deviceKeys.map((key) => readPhaseHNamespaceSigrefs(input.repoPath, key)),
  };
}

function createPhaseHCommit(repoPath: string, deviceKey: string, runId: string, step: PhysicalPhaseHStep) {
  const ref = `refs/namespaces/${deviceNamespaceKey(deviceKey)}/refs/heads/p521-phase-h-${step}-${runId}`;
  if (git(repoPath, ['show-ref', '--verify', '--quiet', ref], { allowFailure: true }).ok) {
    throw new Error(`physical Phase H refuses a pre-existing ref: ${ref}`);
  }
  const createdAt = new Date().toISOString();
  const payload = `${JSON.stringify({ schemaVersion: 'hive-git-physical-phase-h-payload/v1', runId, step, deviceKey, createdAt })}\n`;
  const blob = git(repoPath, ['hash-object', '-w', '--stdin'], { input: payload }).stdout;
  const tree = git(repoPath, ['mktree'], { input: `100644 blob ${blob}\t${PAYLOAD_FILE}\n` }).stdout;
  const identity = { GIT_AUTHOR_NAME: 'Papercusp P-521 physical drill', GIT_AUTHOR_EMAIL: 'p521-physical@papercusp.local',
    GIT_AUTHOR_DATE: createdAt, GIT_COMMITTER_NAME: 'Papercusp P-521 physical drill',
    GIT_COMMITTER_EMAIL: 'p521-physical@papercusp.local', GIT_COMMITTER_DATE: createdAt };
  const oid = git(repoPath, ['commit-tree', tree], { input: `P-521 Phase H ${step} ${runId}\n`, env: identity }).stdout;
  if (!OID.test(oid)) throw new Error(`physical Phase H created malformed commit OID: ${oid}`);
  git(repoPath, ['update-ref', ref, oid, ZERO_OID]);
  return { ref, oid };
}

/**
 * Drive one step from this non-owner process: resolve the owner's capability,
 * test the CAPTURED capability through the production signer guard, then run
 * the production ref-announce leg on a fresh run-bound commit.
 */
export async function attemptPhysicalPhaseH(input: {
  step: string;
  repoPath: string;
  deviceKey: string;
  runId: string;
  captured: GitServingCapability;
}): Promise<PhysicalPhaseHAttempt> {
  assertPhysicalPhaseHStep(input.step);
  assertCanonicalRepoPath(input.repoPath);
  if (!RUN_ID.test(input.runId)) throw new Error(`physical Phase H runId is invalid: ${input.runId}`);
  const step = input.step;
  const startedAt = new Date().toISOString();
  const request = await phaseHServingRequest();
  const [{ resolveGitServingStateWithBootRecovery, runRefAnnounceLeg }, { signWithDeviceKey }, { verifyEd25519 }] =
    await Promise.all([
      import('../../harness/git-sync/git-sync-action'),
      import('../../identity/sign-with-device-key'),
      import('../../identity/ed25519'),
    ]);
  let bootAttempts = 0;
  const servingDeps = {
    getBootedHarness: () => null,
    bootSingleHarness: async () => {
      bootAttempts += 1;
      return { state: 'deferred' as const, error: 'physical Phase H publisher never boots a serving owner' };
    },
  };
  const resolve = (): Promise<GitServingState> => resolveGitServingStateWithBootRecovery(request, servingDeps);
  const resolved = await resolve();

  const captured = summarizeCapability(input.captured);
  const probe = Buffer.from(JSON.stringify({ phase: 'H', step, runId: input.runId, runtimeId: captured.runtimeId }));
  let capturedGuard: PhaseHGuardOutcome;
  try {
    const signature = await guardGitServingSigner(input.captured, request, resolve,
      (bytes) => signWithDeviceKey(input.captured.identity.keychainId, bytes))(probe);
    capturedGuard = { outcome: 'signed', capability: captured,
      signatureValid: verifyEd25519(probe, captured.devicePubkeyBase64, signature) };
  } catch (error) {
    const e = error as { code?: unknown; retryable?: unknown; message?: unknown };
    capturedGuard = { outcome: 'refused', capability: captured, code: typeof e.code === 'string' ? e.code : null,
      retryable: e.retryable === true, message: String(e.message ?? error) };
  }

  const sigrefsBefore = readPhaseHNamespaceSigrefs(input.repoPath, input.deviceKey);
  const commit = createPhaseHCommit(input.repoPath, input.deviceKey, input.runId, step);
  let published: PhysicalPhaseHAttempt['published'] = null;
  await runRefAnnounceLeg(PHASE_A_POT_HOME, PHASE_H_WORKSPACE_ID, {
    receive: false,
    servingDeps,
    onPublished: (announcement) => { published = { version: announcement.version, sigrefsOid: announcement.sigrefs_oid }; },
  });
  return {
    schemaVersion: PHASE_H_ATTEMPT_SCHEMA,
    hostId: 'vm',
    step,
    runId: input.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    publisherPid: process.pid,
    resolution: resolved.status === 'ready'
      ? { status: 'ready', retryable: false, reason: null, capability: summarizeCapability(resolved.capability) }
      : { status: resolved.status, retryable: resolved.retryable, reason: resolved.reason, capability: null },
    capturedGuard,
    bootAttempts,
    commit,
    published,
    sigrefsBefore,
    sigrefsAfter: readPhaseHNamespaceSigrefs(input.repoPath, input.deviceKey),
  };
}

function time(value: string, label: string, errors: string[]): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

function namespaceOf(observation: PhysicalPhaseHObservation, deviceKey: string): PhaseHNamespaceSigrefs | null {
  return observation.namespaces.find((n) => n.deviceKey === deviceKey) ?? null;
}

/** The attempt's OWN announcement is on the ref, signed by the device, in the expected generation, carrying the commit. */
function requirePublished(label: string, a: PhysicalPhaseHAttempt, vmDeviceKey: string, storeGeneration: string | null, errors: string[]): void {
  const after = a.sigrefsAfter;
  if (!a.published) { errors.push(`${label}: this process did not sign and persist an announcement`); return; }
  if (a.published.sigrefsOid !== after.sigrefsOid) errors.push(`${label}: sigrefs ref is not the announcement this process published`);
  if (after.version === null || a.sigrefsBefore.version !== null && after.version <= a.sigrefsBefore.version) {
    errors.push(`${label}: sigrefs version did not advance`);
  }
  if (!after.signatureValid || after.deviceKey !== vmDeviceKey) errors.push(`${label}: sigrefs are not validly signed by the VM device`);
  if (!storeGeneration || after.storeGeneration !== storeGeneration) {
    errors.push(`${label}: signed store generation ${after.storeGeneration} != capability ${storeGeneration}`);
  }
  const suffix = a.commit.ref.split(`/namespaces/${deviceNamespaceKey(vmDeviceKey)}/`)[1];
  if (!after.refs.some((r) => r.ref === suffix && r.sha === a.commit.oid)) errors.push(`${label}: signed snapshot omits the run commit`);
}

function requireRefusal(label: string, a: PhysicalPhaseHAttempt, runtimeId: string | null, errors: string[]): void {
  const g = a.capturedGuard;
  if (g.outcome !== 'refused') { errors.push(`${label}: the stale captured capability still signed`); return; }
  if (g.capability.runtimeId !== runtimeId) errors.push(`${label}: tested the wrong captured capability`);
  if (g.code !== 'GIT_SERVING_UNAVAILABLE' || !g.retryable) errors.push(`${label}: refusal was not the retryable serving-unavailable error`);
}

export function validatePhysicalPhaseH(input: PhysicalPhaseHInput): PhysicalPhaseHVerdict {
  const errors: string[] = [];
  const fail = (): PhysicalPhaseHVerdict => ({ ok: false, errors, result: null });
  if (input?.schemaVersion !== PHASE_H_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_H_INPUT_SCHEMA}`);
  if (!RUN_ID.test(input?.runId ?? '')) errors.push('runId is invalid');
  const { towerDeviceKey, vmDeviceKey } = input?.identities ?? ({} as PhysicalPhaseHInput['identities']);
  if (!towerDeviceKey || !vmDeviceKey || towerDeviceKey === vmDeviceKey) errors.push('tower and VM device keys must be distinct');
  if (errors.length) return fail();

  const { before, after, frozenMs } = input.vmOwner;
  const ownerPids = new Set([before.pid, after.pid]);
  let cursor = time(input.window.startedAt, 'window.startedAt', errors);
  for (const step of PHASE_H_STEPS) {
    const s = input.steps[step];
    if (!s) { errors.push(`${step}: missing step evidence`); continue; }
    if (s.vm.hostId !== 'vm' || s.tower.hostId !== 'tower' || s.attempt.hostId !== 'vm') errors.push(`${step}: host mismatch`);
    if (s.vm.step !== step || s.tower.step !== step || s.attempt.step !== step) errors.push(`${step}: step label mismatch`);
    if (s.attempt.runId !== input.runId || !s.attempt.commit.ref.includes(`p521-phase-h-${step}-${input.runId}`)) {
      errors.push(`${step}: attempt is not bound to this run`);
    }
    if (ownerPids.has(s.attempt.publisherPid)) errors.push(`${step}: publisher ran inside the serving owner process`);
    const order = [s.vm.observedAt, s.attempt.startedAt, s.attempt.finishedAt, s.tower.observedAt]
      .map((t, i) => time(t, `${step} timestamp ${i}`, errors));
    for (const t of order) {
      if (t < cursor) errors.push(`${step}: evidence is out of causal order`);
      cursor = Math.max(cursor, t);
    }
    const towerView = namespaceOf(s.tower, vmDeviceKey);
    if (!towerView || towerView.sigrefsOid !== s.attempt.sigrefsAfter.sigrefsOid || !towerView.signatureValid) {
      errors.push(`${step}: tower does not serve the VM's signed sigrefs ${s.attempt.sigrefsAfter.sigrefsOid}`);
    }
  }
  if (time(input.window.finishedAt, 'window.finishedAt', errors) < cursor) errors.push('window closes before its evidence');
  if (errors.length) return fail();

  const { pre, omitted, restarted, replaced } = input.steps;
  const c1 = pre.vm.serving.capability;
  const c2 = restarted.vm.serving.capability;
  const c3 = replaced.vm.serving.capability;
  // pre: the separate process publishes under the live owner's capability.
  if (!c1 || c1.identity.devicePubkeyBase64 !== vmDeviceKey) errors.push('pre: VM owner advertised no ready capability for the VM device');
  if (pre.attempt.resolution.capability?.runtimeId !== c1?.runtimeId) errors.push('pre: publisher resolved a different runtime than the owner advertised');
  if (pre.attempt.capturedGuard.outcome !== 'signed' || !pre.attempt.capturedGuard.signatureValid) errors.push('pre: live captured capability did not produce a valid signature');
  if (pre.attempt.bootAttempts !== 0) errors.push('pre: publisher fell through to its boot seam while the owner was live');
  requirePublished('pre', pre.attempt, vmDeviceKey, c1?.context.store_generation ?? null, errors);
  // omitted: discovery lost -> retryable refusal, nothing moves on either host.
  if (frozenMs < PHASE_H_MIN_OMISSION_MS) errors.push(`omitted: owner frozen ${frozenMs}ms < ${PHASE_H_MIN_OMISSION_MS}ms`);
  if (omitted.vm.serving.status === 'ready' || !omitted.vm.serving.retryable) errors.push('omitted: discovery still advertised a ready capability');
  if (omitted.vm.advertisement.present && (omitted.vm.advertisement.ageMs ?? 0) <= GIT_SERVING_LEASE_MS) errors.push('omitted: owner advertisement was still fresh');
  if (omitted.attempt.resolution.status === 'ready' || !omitted.attempt.resolution.retryable) errors.push('omitted: publisher resolved a usable capability');
  requireRefusal('omitted', omitted.attempt, c1?.runtimeId ?? null, errors);
  if (omitted.attempt.published || omitted.attempt.sigrefsAfter.sigrefsOid !== pre.attempt.sigrefsAfter.sigrefsOid) {
    errors.push('omitted: sigrefs moved while serving was unavailable');
  }
  // restarted: same artifact, new runtime; the old capability refuses, the fresh one publishes.
  const artifactStable = after.pid !== before.pid && Boolean(before.build) && after.build === before.build && after.launcher === before.launcher;
  if (!artifactStable) errors.push('restarted: owner was not restarted on the same artifact and launcher');
  if (!c2 || c2.runtimeId === c1?.runtimeId || c2.identity.devicePubkeyBase64 !== vmDeviceKey) errors.push('restarted: no fresh runtime capability for the VM device');
  if (restarted.vm.advertisement.publisherId === pre.vm.advertisement.publisherId) errors.push('restarted: advertisement publisher did not change');
  requireRefusal('restarted', restarted.attempt, c1?.runtimeId ?? null, errors);
  if (restarted.attempt.resolution.capability?.runtimeId !== c2?.runtimeId) errors.push('restarted: publisher did not resolve the fresh runtime');
  requirePublished('restarted', restarted.attempt, vmDeviceKey, c2?.context.store_generation ?? null, errors);
  // replaced: new physical store generation; the restarted capability refuses, the fresh one publishes.
  const g2 = storeGenerationOrdinal(c2?.context.store_generation);
  const g3 = storeGenerationOrdinal(c3?.context.store_generation);
  if (!c3 || g2 === null || g3 === null || g3 <= g2) errors.push('replaced: store generation did not advance');
  if (!replaced.vm.storeIncarnation || replaced.vm.storeIncarnation === pre.vm.storeIncarnation) errors.push('replaced: physical store incarnation did not change');
  requireRefusal('replaced', replaced.attempt, c2?.runtimeId ?? null, errors);
  if (replaced.attempt.capturedGuard.outcome === 'refused' &&
      replaced.attempt.capturedGuard.capability.storeGeneration !== c2?.context.store_generation) {
    errors.push('replaced: refusal tested a capability from the wrong generation');
  }
  requirePublished('replaced', replaced.attempt, vmDeviceKey, c3?.context.store_generation ?? null, errors);
  if (errors.length) return fail();

  const identity = (s: PhysicalPhaseHStepInput) => ({
    runtimeId: s.vm.serving.capability?.runtimeId ?? null,
    storeGeneration: s.vm.serving.capability?.context.store_generation ?? null,
    sigrefsOid: s.attempt.sigrefsAfter.sigrefsOid,
  });
  return {
    ok: true,
    errors: [],
    result: {
      schemaVersion: PHASE_H_RESULT_SCHEMA,
      phase: 'H',
      planItem: PHASE_H_PLAN_ITEM,
      status: 'complete',
      complete: true,
      missingAssertions: [],
      observedAt: new Date(cursor).toISOString(),
      assertions: {
        separateProcessPublishUsedOwnerCapability: true,
        discoveryLossRefusedRetryablyWithoutRefMovement: true,
        ownerRestartRefusedOldRuntime: true,
        freshRuntimeRestoredPublication: true,
        storeReplacementRefusedOldGeneration: true,
        freshGenerationRestoredPublicationOnBothHosts: true,
        artifactIdentityStableAcrossRestart: true,
      },
      identities: { pre: identity(pre), omitted: identity(omitted), restarted: identity(restarted), replaced: identity(replaced) },
    },
  };
}

/** Stable digest of the verify input, for the evidence manifest. */
export function physicalPhaseHInputDigest(input: PhysicalPhaseHInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
