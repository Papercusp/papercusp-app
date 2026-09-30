/**
 * Fixed observation + falsifiability core for the P-505 physical Phase A cold join.
 *
 * The scenario owns mutation and transport. This module only observes real bare
 * repositories, quarantines the one exact VM target, and verifies the causal
 * before/absence/bootstrap/after record. The production scenario supplies its
 * own private run files; there is no caller-provided "pass" manifest seam.
 */
import { existsSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { deviceNamespaceKey } from './storage';
import { githubOriginNamespaceKey } from './github-ingress';
import { SIGREFS_REF, verifySigrefs, type SignedSigrefs } from './sigrefs';

export const PHASE_A_REPO_SCHEMA = 'hive-git-physical-phase-a-repo/v1' as const;
export const PHASE_A_INPUT_SCHEMA = 'hive-git-physical-phase-a-input/v1' as const;
export const PHASE_A_RESULT_SCHEMA = 'hive-git-physical-phase-a-result/v1' as const;
export const PHASE_A_PLAN_ITEM = 'P-302' as const;
export const PHASE_A_POT_HOME = 'hello-world-3-pot' as const;
export const PHASE_A_TOWER_GIT_SYNC_SLUG = PHASE_A_POT_HOME;
// The VM joins through the canonical invite LINK (D-061/D-068), which registers
// the pot's own repo clone under the pot slug in the link-joined shape
// (joined_via_link + remote_hive + self_repo, WI-10003277) — git-sync eligible,
// and the entry that owns system:git-sync there. The old joinHiveAsView layout
// (a repo-less view + a separate 'hello-world' member) no longer exists on the
// rig after the P-007 fresh join (WI-10003546).
export const PHASE_A_VM_GIT_SYNC_SLUG = PHASE_A_POT_HOME;
// The fixed canary's registry pin was re-keyed from the original Hello-World
// upstream id (gh-1296269) to the self-hive repo id (gh-1303510992). Keep this
// explicit: the physical drill must target the same immutable bare store the
// registry advertises, never a stale retired store or a caller-selected path.
export const PHASE_A_REPO_KEY = 'gh-1303510992' as const;

/**
 * The target a drill run operates on. The physical rig ALWAYS gets the fixed canary above:
 * no environment can select another pot, repo or path there (forbiddenEvidence:
 * environmentSuppliedCommand). The same-box rehearsal rig (plan
 * physical-drill-iteration-speed-2026-09-29 D-003, D-005) runs throwaway owners on its own
 * pot, so under HIVE_GIT_RIG=same-box — and only then — the target comes from the rig
 * profile (rig-profile.sh exports it from the rig's rig.env) and is marked diagnostic. A
 * diagnostic target can never sign or finalize (physical-drill-producer).
 */
export type PhysicalDrillTarget = {
  potHome: string;
  repoKey: string;
  githubRemote: string;
  /**
   * The install that owns system:git-sync for the target repo on both hosts, whose registry
   * path is the working tree. The canary is a self_repo pot, so this is the pot slug. A
   * same-box pot comes from create-from-repo and is a pot home plus a member checkout: the
   * pot-git store is still keyed by the pot slug (git-sync resolves it through the member's
   * hive_slug), but git-sync and the tree belong to the member.
   */
  gitSyncSlug: string;
  diagnostic: boolean;
};
export const PHYSICAL_DRILL_TARGET_ENV = [
  'HIVE_GIT_DRILL_TARGET_POT_HOME',
  'HIVE_GIT_DRILL_TARGET_REPO_KEY',
  'HIVE_GIT_DRILL_TARGET_GITHUB_REMOTE',
  'HIVE_GIT_DRILL_TARGET_GIT_SYNC_SLUG',
] as const;

export function physicalDrillTarget(env: NodeJS.ProcessEnv = process.env): PhysicalDrillTarget {
  const supplied = PHYSICAL_DRILL_TARGET_ENV.filter((key) => (env[key] ?? '') !== '');
  if (env.HIVE_GIT_RIG !== 'same-box') {
    if (supplied.length > 0) {
      throw new Error(
        `physical drill target cannot come from the environment on the physical rig (${supplied.join(', ')} set without HIVE_GIT_RIG=same-box)`,
      );
    }
    return {
      potHome: PHASE_A_POT_HOME,
      repoKey: PHASE_A_REPO_KEY,
      githubRemote: PHASE_A_GITHUB_REMOTE,
      gitSyncSlug: PHASE_A_POT_HOME,
      diagnostic: false,
    };
  }
  const potHome = env.HIVE_GIT_DRILL_TARGET_POT_HOME ?? '';
  const repoKey = env.HIVE_GIT_DRILL_TARGET_REPO_KEY ?? '';
  const githubRemote = env.HIVE_GIT_DRILL_TARGET_GITHUB_REMOTE ?? '';
  const gitSyncSlug = env.HIVE_GIT_DRILL_TARGET_GIT_SYNC_SLUG ?? '';
  const SLUG = /^[a-z0-9][a-z0-9-]*$/;
  if (
    !SLUG.test(potHome) ||
    !SLUG.test(gitSyncSlug) ||
    !/^gh-[0-9]+$/.test(repoKey) ||
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(githubRemote)
  ) {
    throw new Error(
      `same-box drill target is incomplete or malformed (pot='${potHome}' gitSync='${gitSyncSlug}' repoKey='${repoKey}' remote='${githubRemote}'); apply the same-box rig profile`,
    );
  }
  if (potHome === PHASE_A_POT_HOME || gitSyncSlug === PHASE_A_POT_HOME || repoKey === PHASE_A_REPO_KEY) {
    throw new Error('a same-box drill target must not reuse the physical canary pot or repo');
  }
  return { potHome, repoKey, githubRemote, gitSyncSlug, diagnostic: true };
}

export type PhysicalDrillHost = 'tower' | 'vm';
/** The install that owns git-sync for the target repo (see physicalDrillGitSyncSlug). */
export type PhysicalDrillGitSyncSlug = string;

/**
 * The install that owns system:git-sync for the target repo on each host. On the
 * physical rig both are the canary pot slug: the tower is the pot's owner (self_repo
 * home), and the VM's link join registers the same repo under the same slug. On the
 * same-box rig both are the pot's member checkout (PhysicalDrillTarget.gitSyncSlug).
 * Kept as a function so a future per-host divergence stays a one-line change.
 */
export function physicalDrillGitSyncSlug(host: PhysicalDrillHost): PhysicalDrillGitSyncSlug {
  const target = physicalDrillTarget();
  if (target.diagnostic) return target.gitSyncSlug;
  return host === 'tower' ? PHASE_A_TOWER_GIT_SYNC_SLUG : PHASE_A_VM_GIT_SYNC_SLUG;
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RUN_ID = /^[A-Za-z0-9._-]{8,120}$/;

export type PhysicalPhaseARef = {
  name: string;
  oid: string;
  objectExists: boolean;
};

export type PhysicalPhaseARepoObservation = {
  schemaVersion: typeof PHASE_A_REPO_SCHEMA;
  hostId: 'tower' | 'vm';
  state: 'present' | 'absent';
  observedAt: string;
  repoPath: string;
  pathExists: boolean;
  ownNamespace: string;
  peerNamespace: string;
  repoFingerprint: string | null;
  objectDatabasePath: string | null;
  alternates: string[];
  refs: PhysicalPhaseARef[];
  namespaceWitnesses: PhysicalPhaseANamespaceWitness[];
};

export type PhysicalPhaseANamespaceWitness = {
  deviceKey: string;
  namespace: string;
  sigrefsOid: string;
  signed: SignedSigrefs;
};

export type PhysicalPhaseAInput = {
  schemaVersion: typeof PHASE_A_INPUT_SCHEMA;
  runId: string;
  window: { startedAt: string; finishedAt: string };
  identities: { towerDeviceKey: string; vmDeviceKey: string };
  quarantine: {
    method: 'atomic-rename';
    sourcePath: string;
    quarantinePath: string;
    observedAt: string;
  };
  bootstrap: {
    tool: 'git-sync:run';
    installSlug: PhysicalDrillGitSyncSlug;
    targetHost: 'vm';
    fired: true;
    startedAt: string;
    finishedAt: string;
  };
  observations: {
    towerBefore: PhysicalPhaseARepoObservation;
    vmAbsent: PhysicalPhaseARepoObservation;
    towerAfter: PhysicalPhaseARepoObservation;
    vmAfter: PhysicalPhaseARepoObservation;
  };
};

export type PhysicalPhaseAVerdict = {
  ok: boolean;
  errors: string[];
  result: null | {
    schemaVersion: typeof PHASE_A_RESULT_SCHEMA;
    phase: 'A';
    planItem: typeof PHASE_A_PLAN_ITEM;
    status: 'complete';
    complete: true;
    missingAssertions: [];
    observedAt: string;
    assertions: {
      towerStoreObservedBeforeMutation: true;
      vmStoreQuarantinedByScenario: true;
      vmAbsenceObservedBeforeBootstrap: true;
      canonicalGitSyncBootstrapTriggered: true;
      vmStoreRecreatedAfterBootstrap: true;
      bothPhysicalDeviceNamespacesOnBothHosts: true;
      namespaceRefOidsMatch: true;
      referencedObjectsExistOnBothHosts: true;
      oneObjectDatabasePerRepo: true;
      identityDerivedNamespacesObserved: true;
      eachDeviceWritesOnlyItsOwnNamespace: true;
    };
  };
};

function git(repoPath: string, args: string[]): string {
  const result = spawnSync('git', ['--git-dir', repoPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  if (result.status !== 0) {
    throw new Error(`physical Phase A git ${args.join(' ')} failed for ${repoPath}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function canonicalRepoSuffix(): string {
  const target = physicalDrillTarget();
  return join(target.potHome, `${target.repoKey}.git`);
}

function assertCanonicalRepoPath(repoPath: string): void {
  if (!isAbsolute(repoPath) || !resolve(repoPath).endsWith(canonicalRepoSuffix())) {
    throw new Error(`physical Phase A repo path must target ${canonicalRepoSuffix()}: ${repoPath}`);
  }
}

function observationTime(value: string | undefined): string {
  const observedAt = value ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error(`physical Phase A observedAt must be ISO-8601: ${observedAt}`);
  }
  return observedAt;
}

export function capturePhysicalPhaseARepo(input: {
  hostId: 'tower' | 'vm';
  state: 'present' | 'absent';
  repoPath: string;
  ownDeviceKey: string;
  peerDeviceKey: string;
  observedAt?: string;
}): PhysicalPhaseARepoObservation {
  assertCanonicalRepoPath(input.repoPath);
  const ownNamespace = deviceNamespaceKey(input.ownDeviceKey);
  const peerNamespace = deviceNamespaceKey(input.peerDeviceKey);
  if (ownNamespace === peerNamespace) {
    throw new Error('physical Phase A requires two distinct device namespaces');
  }
  const observedAt = observationTime(input.observedAt);
  const pathExists = existsSync(input.repoPath);
  if (input.state === 'absent') {
    if (pathExists) {
      throw new Error(`physical Phase A expected absent repo but found ${input.repoPath}`);
    }
    return {
      schemaVersion: PHASE_A_REPO_SCHEMA,
      hostId: input.hostId,
      state: 'absent',
      observedAt,
      repoPath: input.repoPath,
      pathExists: false,
      ownNamespace,
      peerNamespace,
      repoFingerprint: null,
      objectDatabasePath: null,
      alternates: [],
      refs: [],
      namespaceWitnesses: [],
    };
  }

  if (!pathExists || !statSync(input.repoPath).isDirectory()) {
    throw new Error(`physical Phase A expected a bare repo directory at ${input.repoPath}`);
  }
  if (git(input.repoPath, ['rev-parse', '--is-bare-repository']) !== 'true') {
    throw new Error(`physical Phase A target is not a bare repository: ${input.repoPath}`);
  }
  const repoReal = realpathSync(input.repoPath);
  const repoStat = statSync(repoReal);
  const objectPath = realpathSync(join(repoReal, 'objects'));
  const alternatesPath = join(objectPath, 'info', 'alternates');
  const alternates = existsSync(alternatesPath)
    ? readFileSync(alternatesPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const refLines = git(input.repoPath, ['for-each-ref', '--format=%(refname)\t%(objectname)', 'refs/namespaces']);
  const refs = refLines
    ? refLines.split('\n').map((line): PhysicalPhaseARef => {
        const [name, oid] = line.split('\t');
        if (!name || !oid || !OID.test(oid)) {
          throw new Error(`physical Phase A observed malformed namespaced ref: ${line}`);
        }
        const object = spawnSync('git', ['--git-dir', input.repoPath, 'cat-file', '-e', `${oid}^{object}`], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        });
        return { name, oid, objectExists: object.status === 0 };
      })
    : [];
  const namespaceWitnesses = [input.ownDeviceKey, input.peerDeviceKey].flatMap(
    (deviceKey): PhysicalPhaseANamespaceWitness[] => {
      const namespace = deviceNamespaceKey(deviceKey);
      const sigrefsRef = `refs/namespaces/${namespace}/${SIGREFS_REF}`;
      const sigrefsOid = refs.find((ref) => ref.name === sigrefsRef)?.oid;
      if (!sigrefsOid) return [];
      const blob = git(input.repoPath, ['cat-file', 'blob', sigrefsOid]);
      try {
        return [{ deviceKey, namespace, sigrefsOid, signed: JSON.parse(blob) as SignedSigrefs }];
      } catch {
        throw new Error(`physical Phase A sigrefs blob is not JSON for namespace ${namespace}`);
      }
    },
  );

  return {
    schemaVersion: PHASE_A_REPO_SCHEMA,
    hostId: input.hostId,
    state: 'present',
    observedAt,
    repoPath: input.repoPath,
    pathExists: true,
    ownNamespace,
    peerNamespace,
    repoFingerprint: `${repoStat.dev}:${repoStat.ino}`,
    objectDatabasePath: objectPath,
    alternates,
    refs,
    namespaceWitnesses,
  };
}

export function quarantinePhysicalPhaseARepo(input: {
  repoPath: string;
  runId: string;
}): PhysicalPhaseAInput['quarantine'] {
  assertCanonicalRepoPath(input.repoPath);
  if (!RUN_ID.test(input.runId)) throw new Error(`physical Phase A runId is invalid: ${input.runId}`);
  if (!existsSync(input.repoPath) || !statSync(input.repoPath).isDirectory()) {
    throw new Error(`physical Phase A cannot quarantine missing repo: ${input.repoPath}`);
  }
  const quarantinePath = `${input.repoPath}.p505-phase-a-${input.runId}`;
  if (existsSync(quarantinePath)) {
    throw new Error(`physical Phase A quarantine already exists: ${quarantinePath}`);
  }
  renameSync(input.repoPath, quarantinePath);
  if (existsSync(input.repoPath) || !existsSync(quarantinePath)) {
    throw new Error('physical Phase A atomic quarantine did not establish observed absence');
  }
  return {
    method: 'atomic-rename',
    sourcePath: input.repoPath,
    quarantinePath,
    observedAt: new Date().toISOString(),
  };
}

/**
 * Quarantine the VM store AND observe its absence in ONE process, microseconds
 * apart. The VM's own scheduled git-sync bootstrap tick is production code that
 * legitimately recreates a missing store from the tower, so any gap between
 * the rename and the absence observation is a race the drill loses whenever
 * the tick lands inside it. Measured on P-505 run 12 (WI-10003632): the two
 * steps were separate ssh + node + tsx launches, the rename landed at
 * 08:12:41Z, the scheduled tick rebuilt the store at 08:13:06Z, and the
 * separate absence observation then found it present.
 */
export function quarantineAndObservePhysicalPhaseAAbsence(input: {
  repoPath: string;
  runId: string;
  ownDeviceKey: string;
  peerDeviceKey: string;
}): {
  quarantine: PhysicalPhaseAInput['quarantine'];
  vmAbsent: PhysicalPhaseARepoObservation;
} {
  const quarantine = quarantinePhysicalPhaseARepo({ repoPath: input.repoPath, runId: input.runId });
  const vmAbsent = capturePhysicalPhaseARepo({
    hostId: 'vm',
    state: 'absent',
    repoPath: input.repoPath,
    ownDeviceKey: input.ownDeviceKey,
    peerDeviceKey: input.peerDeviceKey,
  });
  return { quarantine, vmAbsent };
}

function time(value: string, label: string, errors: string[]): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) errors.push(`${label} must be ISO-8601`);
  return parsed;
}

/**
 * The fixed pot's GitHub remote, and the synthetic github-origin namespace the
 * bridge ingresses it into (github-ingress.ts). That namespace is NOT replicated
 * device state: it has no sigrefs (GitHub cannot sign) and each host writes it
 * from its OWN GitHub ingress, per its own branch set and cadence — measured on
 * P-505 run 8 (WI-10003595): tower `refs/heads/staging`, VM `refs/heads/main`.
 * Exact parity there asserts "both hosts ingressed the same GitHub branches at
 * the same instant", which is not the cold-join property Phase A proves, so it
 * is excluded by its exact derivation (never by a "no sigrefs" heuristic, which
 * would also hide a real device namespace that lost its sigrefs).
 */
export const PHASE_A_GITHUB_REMOTE = 'https://github.com/papercupai/hello-world-3-pot' as const;
export const PHASE_A_GITHUB_ORIGIN_NAMESPACE = githubOriginNamespaceKey(PHASE_A_GITHUB_REMOTE);

/** The replicated refs whose OIDs must agree across hosts: every namespaced ref
 *  except the per-host synthetic github-origin namespace. */
function refMap(observation: PhysicalPhaseARepoObservation): string[] {
  const githubOriginPrefix = `refs/namespaces/${githubOriginNamespaceKey(physicalDrillTarget().githubRemote)}/`;
  return observation.refs
    .filter((ref) => !ref.name.startsWith(githubOriginPrefix))
    .map((ref) => `${ref.name}\t${ref.oid}`)
    .sort();
}

function validatePresent(
  observation: PhysicalPhaseARepoObservation,
  expectedHost: 'tower' | 'vm',
  expectedOwn: string,
  expectedPeer: string,
  errors: string[],
): void {
  if (observation.schemaVersion !== PHASE_A_REPO_SCHEMA) errors.push(`${expectedHost} observation schema is invalid`);
  if (observation.hostId !== expectedHost) errors.push(`${expectedHost} observation has the wrong hostId`);
  if (observation.state !== 'present' || !observation.pathExists)
    errors.push(`${expectedHost} repo must be observed present`);
  if (observation.ownNamespace !== expectedOwn || observation.peerNamespace !== expectedPeer) {
    errors.push(`${expectedHost} device namespaces must derive from the preflighted identities`);
  }
  if (!observation.repoFingerprint) errors.push(`${expectedHost} repo fingerprint is missing`);
  if (
    !observation.objectDatabasePath ||
    resolve(observation.objectDatabasePath) !== resolve(observation.repoPath, 'objects')
  ) {
    errors.push(`${expectedHost} must use the bare repo's single local object database`);
  }
  if (observation.alternates.length !== 0) errors.push(`${expectedHost} object database must not use alternates`);
  if (observation.refs.length === 0) errors.push(`${expectedHost} must expose namespaced refs`);
  for (const namespace of [expectedOwn, expectedPeer]) {
    if (!observation.refs.some((ref) => ref.name.startsWith(`refs/namespaces/${namespace}/`))) {
      errors.push(`${expectedHost} is missing physical device namespace ${namespace}`);
    }
  }
  for (const ref of observation.refs) {
    if (!OID.test(ref.oid) || !ref.objectExists) {
      errors.push(`${expectedHost} ref ${ref.name} does not resolve to a local object`);
    }
  }
}

function validateNamespaceWitnesses(
  observation: PhysicalPhaseARepoObservation,
  devices: readonly string[],
  errors: string[],
): void {
  for (const deviceKey of devices) {
    const namespace = deviceNamespaceKey(deviceKey);
    const matches = observation.namespaceWitnesses.filter(
      (witness) => witness.deviceKey === deviceKey && witness.namespace === namespace,
    );
    if (matches.length !== 1) {
      errors.push(`${observation.hostId} must contain exactly one signed witness for namespace ${namespace}`);
      continue;
    }
    const witness = matches[0]!;
    const sigrefsName = `refs/namespaces/${namespace}/${SIGREFS_REF}`;
    if (!OID.test(witness.sigrefsOid) || !observation.refs.some((ref) => ref.name === sigrefsName && ref.oid === witness.sigrefsOid)) {
      errors.push(`${observation.hostId} namespace ${namespace} witness must come from its observed sigrefs ref`);
    }
    if (!verifySigrefs(witness.signed, deviceKey)) {
      errors.push(`${observation.hostId} namespace ${namespace} sigrefs signature is invalid`);
      continue;
    }
    const prefix = `refs/namespaces/${namespace}/`;
    const actual = observation.refs
      .filter((ref) => ref.name.startsWith(prefix) && ref.name !== sigrefsName)
      .map((ref) => `${ref.name.slice(prefix.length)}\t${ref.oid}`)
      .sort();
    const signed = witness.signed.refs.map((ref) => `${ref.ref}\t${ref.sha}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(signed)) {
      errors.push(`${observation.hostId} namespace ${namespace} refs must exactly match its device-signed snapshot`);
    }
  }
}

export function validatePhysicalPhaseA(input: PhysicalPhaseAInput): PhysicalPhaseAVerdict {
  const errors: string[] = [];
  if (input.schemaVersion !== PHASE_A_INPUT_SCHEMA) errors.push(`schemaVersion must be ${PHASE_A_INPUT_SCHEMA}`);
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
  const towerBeforeAt = time(input.observations.towerBefore.observedAt, 'towerBefore.observedAt', errors);
  const quarantineAt = time(input.quarantine.observedAt, 'quarantine.observedAt', errors);
  const vmAbsentAt = time(input.observations.vmAbsent.observedAt, 'vmAbsent.observedAt', errors);
  const bootstrapStartedAt = time(input.bootstrap.startedAt, 'bootstrap.startedAt', errors);
  const bootstrapFinishedAt = time(input.bootstrap.finishedAt, 'bootstrap.finishedAt', errors);
  const towerAfterAt = time(input.observations.towerAfter.observedAt, 'towerAfter.observedAt', errors);
  const vmAfterAt = time(input.observations.vmAfter.observedAt, 'vmAfter.observedAt', errors);
  const finishedAt = time(input.window.finishedAt, 'window.finishedAt', errors);
  const ordered = [
    startedAt,
    towerBeforeAt,
    quarantineAt,
    vmAbsentAt,
    bootstrapStartedAt,
    bootstrapFinishedAt,
    towerAfterAt,
    vmAfterAt,
    finishedAt,
  ];
  if (ordered.some((value, index) => index > 0 && value < ordered[index - 1]!)) {
    errors.push('Phase A observations do not preserve absence-before-bootstrap causal order');
  }

  if (
    input.quarantine.method !== 'atomic-rename' ||
    input.quarantine.sourcePath !== input.observations.vmAbsent.repoPath ||
    dirname(input.quarantine.quarantinePath) !== dirname(input.quarantine.sourcePath) ||
    !input.quarantine.quarantinePath.startsWith(`${input.quarantine.sourcePath}.p505-phase-a-`)
  ) {
    errors.push('VM store absence must come from the scenario atomic-quarantine operation');
  }
  if (
    input.bootstrap.tool !== 'git-sync:run' ||
    input.bootstrap.installSlug !== physicalDrillGitSyncSlug('vm') ||
    input.bootstrap.targetHost !== 'vm' ||
    input.bootstrap.fired !== true
  ) {
    errors.push('VM bootstrap must be the fixed canonical git-sync:run invocation');
  }

  validatePresent(input.observations.towerBefore, 'tower', towerNamespace, vmNamespace, errors);
  const absent = input.observations.vmAbsent;
  if (
    absent.schemaVersion !== PHASE_A_REPO_SCHEMA ||
    absent.hostId !== 'vm' ||
    absent.state !== 'absent' ||
    absent.pathExists ||
    absent.repoFingerprint !== null ||
    absent.objectDatabasePath !== null ||
    absent.refs.length !== 0
  ) {
    errors.push('VM store must be physically observed absent after quarantine');
  }
  if (absent.ownNamespace !== vmNamespace || absent.peerNamespace !== towerNamespace) {
    errors.push('VM absence observation must derive namespaces from preflighted identities');
  }
  validatePresent(input.observations.towerAfter, 'tower', towerNamespace, vmNamespace, errors);
  validatePresent(input.observations.vmAfter, 'vm', vmNamespace, towerNamespace, errors);
  validateNamespaceWitnesses(
    input.observations.towerAfter,
    [input.identities.towerDeviceKey, input.identities.vmDeviceKey],
    errors,
  );
  validateNamespaceWitnesses(
    input.observations.vmAfter,
    [input.identities.towerDeviceKey, input.identities.vmDeviceKey],
    errors,
  );
  const vmWitness = input.observations.vmAfter.namespaceWitnesses.find(
    (witness) => witness.deviceKey === input.identities.vmDeviceKey,
  );
  if (!vmWitness || vmWitness.signed.ts < bootstrapStartedAt || vmWitness.signed.ts > vmAfterAt) {
    errors.push('VM own-namespace signature must be created after cold bootstrap starts and before VM observation');
  }

  const towerRefs = refMap(input.observations.towerAfter);
  const vmRefs = refMap(input.observations.vmAfter);
  if (JSON.stringify(towerRefs) !== JSON.stringify(vmRefs)) {
    errors.push('tower and vm namespaced ref OIDs must match exactly after bootstrap');
  }
  if (
    input.observations.towerAfter.repoFingerprint &&
    input.observations.towerAfter.repoFingerprint === input.observations.vmAfter.repoFingerprint
  ) {
    errors.push('tower and vm observations must come from distinct physical repo directories');
  }

  const uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    result:
      uniqueErrors.length > 0
        ? null
        : {
            schemaVersion: PHASE_A_RESULT_SCHEMA,
            phase: 'A',
            planItem: PHASE_A_PLAN_ITEM,
            status: 'complete',
            complete: true,
            missingAssertions: [],
            observedAt: input.window.finishedAt,
            assertions: {
              towerStoreObservedBeforeMutation: true,
              vmStoreQuarantinedByScenario: true,
              vmAbsenceObservedBeforeBootstrap: true,
              canonicalGitSyncBootstrapTriggered: true,
              vmStoreRecreatedAfterBootstrap: true,
              bothPhysicalDeviceNamespacesOnBothHosts: true,
              namespaceRefOidsMatch: true,
              referencedObjectsExistOnBothHosts: true,
              oneObjectDatabasePerRepo: true,
              identityDerivedNamespacesObserved: true,
              eachDeviceWritesOnlyItsOwnNamespace: true,
            },
          },
  };
}
