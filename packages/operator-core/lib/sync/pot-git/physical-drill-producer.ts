/** Canonical assembly CLI for the two-machine hive-git physical probe. */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  issuePhysicalDrillHostReceipt,
  resolvePhysicalDrillHostIdentity,
  validatePhysicalDrillHostReceipt,
  type PhysicalDrillHostIdentity,
  type PhysicalDrillHostReceipt,
} from './physical-drill-host-receipt';
import { validatePhysicalDrillEvidence } from './physical-drill-evidence';
import { physicalDrillPreflightMode } from './physical-drill-preflight';
import {
  capturePhysicalPhaseARepo,
  physicalDrillTarget,
  quarantineAndObservePhysicalPhaseAAbsence,
  quarantinePhysicalPhaseARepo,
  validatePhysicalPhaseA,
  type PhysicalPhaseAInput,
} from './physical-drill-phase-a';

/** A same-box rehearsal is diagnostic (D-003 (4)): it never signs or finalizes evidence. */
export function refuseDiagnosticEvidence(mode: 'sign' | 'finalize'): void {
  const target = physicalDrillTarget();
  if (target.diagnostic) {
    throw new Error(
      `physical-drill-producer: ${mode} refused — the same-box target ${target.potHome}/${target.repoKey} is diagnostic and can never be release evidence`,
    );
  }
}
import {
  capturePhysicalPhaseBRepo,
  createPhysicalPhaseBCommit,
  phaseBObservationLag,
  validatePhysicalPhaseB,
  type PhysicalPhaseBDirection,
  type PhysicalPhaseBHost,
  type PhysicalPhaseBInput,
} from './physical-drill-phase-b';
import {
  executePhysicalPhaseCHost,
  validatePhysicalPhaseC,
  type PhysicalPhaseCHost,
  type PhysicalPhaseCInput,
} from './physical-drill-phase-c';
import {
  PHASE_D_EVENT_WAIT_MAX_MS,
  capturePhysicalPhaseDEvent,
  capturePhysicalPhaseDObservation,
  phaseDObservationLag,
  capturePhysicalPhaseDRequest,
  createPhysicalPhaseDMutation,
  dirtyPhysicalPhaseDWorktree,
  holdPhysicalPhaseDBelowSteer,
  ratifyPhysicalPhaseDRequest,
  resetPhysicalPhaseDDirt,
  restorePhysicalPhaseDTier,
  validatePhysicalPhaseD,
  type PhysicalPhaseDHost,
  type PhysicalPhaseDInput,
  type PhysicalPhaseDMutationKind,
  type PhysicalPhaseDObservationStage,
  PHASE_D_WORKSPACE,
} from './physical-drill-phase-d';
import { getPotGitMode, setPotGitMode } from '../../harness/git-sync/hive-git-mode';
import {
  capturePhysicalPhaseEObservation,
  createPhysicalPhaseEDivergence,
  createPhysicalPhaseEIngress,
  ensurePhysicalPhaseEMode,
  PHASE_E_MODE_WAIT_MAX_MS,
  preflightPhysicalPhaseERemotes,
  readPhysicalPhaseEMode,
  requirePhysicalPhaseEStageMode,
  restorePhysicalPhaseEDivergence,
  runPhysicalPhaseEWatchdogSweep,
  setPhysicalPhaseEMode,
  validatePhysicalPhaseE,
  type PhysicalPhaseEHost,
  type PhysicalPhaseEInput,
  type PhysicalPhaseEObservationStage,
  type PhysicalPhaseERemoteMutation,
} from './physical-drill-phase-e';
import {
  executePhysicalPhaseFHost,
  validatePhysicalPhaseF,
  type PhysicalPhaseFHost,
  type PhysicalPhaseFInput,
} from './physical-drill-phase-f';
import {
  executePhysicalPhaseG,
  validatePhysicalPhaseG,
  type PhysicalPhaseGInput,
} from './physical-drill-phase-g';
import {
  attemptPhysicalPhaseH,
  observePhysicalPhaseH,
  validatePhysicalPhaseH,
  type PhysicalPhaseHInput,
  type PhysicalPhaseHObservation,
} from './physical-drill-phase-h';
import {
  attemptPhysicalPhaseI,
  startPhaseIOwner,
  validatePhysicalPhaseI,
  type PhysicalPhaseIAttempt,
  type PhysicalPhaseIInput,
  type PhysicalPhaseIStep,
} from './physical-drill-phase-i';
import {
  installPhysicalPhaseJFault,
  observePhysicalPhaseJ,
  phaseJLag,
  phaseJWriteSummary,
  phaseJWriteTitle,
  removePhysicalPhaseJFault,
  sweepPhysicalPhaseJFaults,
  validatePhysicalPhaseJ,
  type PhysicalPhaseJInput,
} from './physical-drill-phase-j';
import {
  validatePostGoReleaseCanary,
  type PostGoReleaseCanaryInput,
} from './post-go-release-canary';
import {
  appendCanaryObservation,
  capturePostGoCanaryObservation,
  type PostGoCanaryObservation,
} from './post-go-canary-observations';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/**
 * Match the CLI entrypoint by physical path, not merely its spelling. macOS
 * exposes `/tmp` through `/private/tmp`; comparing `resolve(argv[1])` with the
 * module URL therefore made a successfully loaded CLI exit 0 without running.
 */
export function samePhysicalDrillPath(
  left: string,
  right: string,
  canonicalize: (path: string) => string = realpathSync,
): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return resolve(left) === resolve(right);
  }
}

/**
 * Two hosts must be distinct owners (hostId, deviceKey) AND, for release evidence, distinct
 * machines (machineFingerprint). A same-box rehearsal runs both owners on ONE machine by
 * construction, so it can only ever meet the owner half. That relaxation is safe solely
 * because a diagnostic target can never sign or finalize (refuseDiagnosticEvidence): the
 * finalize path always calls this with distinct machines required.
 */
function assertDistinctHosts(
  identities: PhysicalDrillHostIdentity[],
  opts: { requireDistinctMachines: boolean } = { requireDistinctMachines: true },
): void {
  if (identities.length !== 2) throw new Error('physical-drill-producer: exactly two host identities required');
  const fields = opts.requireDistinctMachines
    ? (['hostId', 'deviceKey', 'machineFingerprint'] as const)
    : (['hostId', 'deviceKey'] as const);
  for (const field of fields) {
    if (new Set(identities.map((identity) => identity[field])).size !== 2) {
      throw new Error(`physical-drill-producer: two physical hosts must have distinct ${field} values`);
    }
  }
}

export function preflightPhysicalDrillHosts(
  rawIdentities: unknown[],
  opts: { diagnostic?: boolean } = {},
): PhysicalDrillHostIdentity[] {
  const identities = rawIdentities.map((raw, index) => {
    const identity = record(raw);
    if (!identity || identity.schemaVersion !== 'hive-git-physical-host-identity/v1') {
      throw new Error(`physical-drill-producer: host identity ${index} has an invalid schema`);
    }
    return identity as unknown as PhysicalDrillHostIdentity;
  });
  assertDistinctHosts(identities, { requireDistinctMachines: opts.diagnostic !== true });
  return identities;
}

export function finalizePhysicalDrillArtifacts(input: { evidence: unknown; receipts: unknown[] }): {
  evidence: JsonRecord;
  trust: JsonRecord;
} {
  const evidence = record(input.evidence);
  if (!evidence) throw new Error('physical-drill-producer: unsigned evidence must be an object');
  if (Array.isArray(evidence.attestations) && evidence.attestations.length > 0) {
    throw new Error('physical-drill-producer: scenario output must not contain pre-banked attestations');
  }
  if (input.receipts.length !== 2) {
    throw new Error('physical-drill-producer: exactly two fresh host receipts required');
  }

  const receipts = input.receipts.map((raw, index) => {
    const verdict = validatePhysicalDrillHostReceipt(raw, evidence);
    if (!verdict.ok || !verdict.receipt) {
      throw new Error(`physical-drill-producer: host receipt ${index} rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict.receipt;
  });
  assertDistinctHosts(
    receipts.map((receipt) => ({
      schemaVersion: 'hive-git-physical-host-identity/v1',
      hostId: receipt.hostId,
      deviceKey: receipt.deviceKey,
      keychainId: receipt.keychainId,
      githubUserId: receipt.githubUserId,
      githubLogin: receipt.githubLogin,
      machineFingerprint: receipt.machineFingerprint,
    })),
  );

  const finalizedEvidence: JsonRecord = {
    ...evidence,
    attestations: receipts.map((receipt) => ({
      deviceKey: receipt.deviceKey,
      signature: receipt.evidenceAttestation,
    })),
  };
  const window = record(evidence.window);
  const trust: JsonRecord = {
    schemaVersion: 'hive-git-physical-trust/v1',
    source: 'papercusp-vm-rig/v1',
    runId: evidence.runId,
    observedAt: window?.finishedAt,
    hosts: receipts.map((receipt) => ({
      id: receipt.hostId,
      deviceKey: receipt.deviceKey,
      machineFingerprint: receipt.machineFingerprint,
    })),
    receipts,
  };
  const verdict = validatePhysicalDrillEvidence(finalizedEvidence, trust);
  if (!verdict.ok) {
    throw new Error(`physical-drill-producer: finalized evidence rejected: ${verdict.errors.join('; ')}`);
  }
  return { evidence: finalizedEvidence, trust };
}

function writeOutputsAtomically(
  evidencePath: string,
  trustPath: string,
  artifacts: { evidence: JsonRecord; trust: JsonRecord },
): void {
  for (const path of [evidencePath, trustPath]) {
    if (!path.startsWith('/') || existsSync(path)) {
      throw new Error(`physical-drill-producer: output must be an absent absolute path: ${path}`);
    }
  }
  if (dirname(evidencePath) !== dirname(trustPath)) {
    throw new Error('physical-drill-producer: evidence and trust outputs must share one directory');
  }
  const suffix = `.tmp-${process.pid}-${Date.now()}`;
  const evidenceTmp = `${evidencePath}${suffix}`;
  const trustTmp = `${trustPath}${suffix}`;
  writeFileSync(evidenceTmp, `${JSON.stringify(artifacts.evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(trustTmp, `${JSON.stringify(artifacts.trust, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(trustTmp, trustPath);
  renameSync(evidenceTmp, evidencePath);
}

async function cli(argv: string[]): Promise<unknown> {
  const [mode, ...args] = argv;
  if (mode === 'identity') {
    const [hostId, cachePath] = args;
    if (!hostId || !cachePath) {
      throw new Error('usage: physical-drill-producer identity <host-id> <absolute-cache-path>');
    }
    return resolvePhysicalDrillHostIdentity({ hostId, cachePath });
  }
  if (mode === 'preflight') {
    const [towerIdentityPath, vmIdentityPath] = args;
    if (!towerIdentityPath || !vmIdentityPath) {
      throw new Error('usage: physical-drill-producer preflight <tower-identity.json> <vm-identity.json>');
    }
    return {
      ok: true,
      hosts: preflightPhysicalDrillHosts([readJson(towerIdentityPath), readJson(vmIdentityPath)], {
        // Same-box (D-005): both owners share one machine; the evidence stays unsignable.
        diagnostic: physicalDrillTarget().diagnostic,
      }),
    };
  }
  if (mode === 'sign') {
    refuseDiagnosticEvidence('sign');
    const [evidencePath, hostId, cachePath] = args;
    if (!evidencePath || !hostId || !cachePath) {
      throw new Error('usage: physical-drill-producer sign <unsigned-evidence.json> <host-id> <absolute-cache-path>');
    }
    return issuePhysicalDrillHostReceipt({ evidencePath, hostId, cachePath });
  }
  if (mode === 'phase-a-observe') {
    const [hostId, state, repoPath, ownDeviceKey, peerDeviceKey, observedAt] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      (state !== 'present' && state !== 'absent') ||
      !repoPath ||
      !ownDeviceKey ||
      !peerDeviceKey
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-a-observe <tower|vm> <present|absent> <repo-path> <own-device-key> <peer-device-key> [observed-at]',
      );
    }
    return capturePhysicalPhaseARepo({
      hostId,
      state,
      repoPath,
      ownDeviceKey,
      peerDeviceKey,
      ...(observedAt ? { observedAt } : {}),
    });
  }
  if (mode === 'phase-a-quarantine') {
    const [repoPath, runId] = args;
    if (!repoPath || !runId) {
      throw new Error('usage: physical-drill-producer phase-a-quarantine <canonical-vm-repo-path> <run-id>');
    }
    return quarantinePhysicalPhaseARepo({ repoPath, runId });
  }
  if (mode === 'phase-a-quarantine-observe') {
    const [repoPath, runId, ownDeviceKey, peerDeviceKey] = args;
    if (!repoPath || !runId || !ownDeviceKey || !peerDeviceKey) {
      throw new Error(
        'usage: physical-drill-producer phase-a-quarantine-observe <canonical-vm-repo-path> <run-id> <own-device-key> <peer-device-key>',
      );
    }
    return quarantineAndObservePhysicalPhaseAAbsence({ repoPath, runId, ownDeviceKey, peerDeviceKey });
  }
  if (mode === 'phase-a-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer phase-a-verify <private-run-input.json>');
    }
    const verdict = validatePhysicalPhaseA(readJson(inputPath) as PhysicalPhaseAInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase A rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-b-observe') {
    const [hostId, direction, state, repoPath, sourceDeviceKey, runId, ...rest] = args;
    // One trailing arg is an observed-at stamp; two are a convergence expectation.
    const observedAt = rest.length === 1 ? rest[0] : undefined;
    const [expectedOid, beforeSigrefsVersion] = rest.length === 2 ? rest : [];
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      (direction !== 'tower-to-vm' && direction !== 'vm-to-tower') ||
      (state !== 'present' && state !== 'absent') ||
      !repoPath ||
      !sourceDeviceKey ||
      !runId ||
      rest.length > 2 ||
      (expectedOid !== undefined &&
        (state !== 'present' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expectedOid) || !/^\d+$/.test(beforeSigrefsVersion ?? '')))
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-b-observe <tower|vm> <tower-to-vm|vm-to-tower> <present|absent> <repo-path> <source-device-key> <run-id> [observed-at | <expected-oid> <before-sigrefs-version>]',
      );
    }
    const observation = capturePhysicalPhaseBRepo({
      hostId: hostId as PhysicalPhaseBHost,
      direction: direction as PhysicalPhaseBDirection,
      state,
      repoPath,
      sourceDeviceKey,
      runId,
      ...(observedAt ? { observedAt } : {}),
    });
    // With an expectation, a store whose signed sigrefs do not yet cover the
    // fresh commit exits 3 and still prints the observation, so the scenario can
    // nudge git-sync and retry without losing the evidence (P-505 run 33b).
    if (expectedOid !== undefined) {
      const lagging = phaseBObservationLag(observation, {
        oid: expectedOid,
        beforeSigrefsVersion: Number(beforeSigrefsVersion),
      });
      if (lagging.length > 0) {
        throw new PhysicalDrillIncompleteEvidenceError(
          `physical-drill-producer: ${hostId} ${direction} has not converged to ${expectedOid}: lagging ${lagging.join(', ')}`,
          observation,
        );
      }
    }
    return observation;
  }
  if (mode === 'phase-b-commit') {
    const [sourceHost, direction, repoPath, sourceDeviceKey, runId, createdAt] = args;
    if (
      (sourceHost !== 'tower' && sourceHost !== 'vm') ||
      (direction !== 'tower-to-vm' && direction !== 'vm-to-tower') ||
      !repoPath ||
      !sourceDeviceKey ||
      !runId
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-b-commit <tower|vm> <tower-to-vm|vm-to-tower> <repo-path> <source-device-key> <run-id> [created-at]',
      );
    }
    return createPhysicalPhaseBCommit({
      sourceHost: sourceHost as PhysicalPhaseBHost,
      direction: direction as PhysicalPhaseBDirection,
      repoPath,
      sourceDeviceKey,
      runId,
      ...(createdAt ? { createdAt } : {}),
    });
  }
  if (mode === 'phase-b-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer phase-b-verify <private-run-input.json>');
    }
    const verdict = validatePhysicalPhaseB(readJson(inputPath) as PhysicalPhaseBInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase B rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-c-run') {
    const [hostId, repoPath, physicalDeviceKey, peerDeviceKey, runId] = args;
    if ((hostId !== 'tower' && hostId !== 'vm') || !repoPath || !physicalDeviceKey || !peerDeviceKey || !runId) {
      throw new Error(
        'usage: physical-drill-producer phase-c-run <tower|vm> <repo-path> <physical-device-key> <peer-device-key> <run-id>',
      );
    }
    return executePhysicalPhaseCHost({
      hostId: hostId as PhysicalPhaseCHost,
      repoPath,
      physicalDeviceKey,
      peerDeviceKey,
      runId,
    });
  }
  if (mode === 'phase-c-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer phase-c-verify <private-run-input.json>');
    }
    const verdict = validatePhysicalPhaseC(readJson(inputPath) as PhysicalPhaseCInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase C rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-d-commit') {
    const [hostId, kind, sourceDeviceKey, runId] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      (kind !== 'below-steer' && kind !== 'dirty-overlap') ||
      !sourceDeviceKey ||
      !runId
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-d-commit <tower|vm> <below-steer|dirty-overlap> <source-device-key> <run-id>',
      );
    }
    return createPhysicalPhaseDMutation({
      sourceHost: hostId as PhysicalPhaseDHost,
      kind: kind as PhysicalPhaseDMutationKind,
      sourceDeviceKey,
      runId,
    });
  }
  if (mode === 'phase-d-dirty') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-d-dirty <run-id>');
    return dirtyPhysicalPhaseDWorktree({ runId });
  }
  if (mode === 'phase-d-reset') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-d-reset <run-id>');
    return resetPhysicalPhaseDDirt({ runId });
  }
  if (mode === 'phase-d-tier-hold') {
    const [vmDevicePubkey, runId, holdPath] = args;
    if (!vmDevicePubkey || !runId || !holdPath) {
      throw new Error('usage: physical-drill-producer phase-d-tier-hold <vm-device-pubkey> <run-id> <hold-path>');
    }
    return holdPhysicalPhaseDBelowSteer({ vmDevicePubkey, runId, holdPath });
  }
  if (mode === 'phase-d-tier-restore') {
    const [holdPath] = args;
    if (!holdPath) throw new Error('usage: physical-drill-producer phase-d-tier-restore <hold-path>');
    return restorePhysicalPhaseDTier({ holdPath });
  }
  if (mode === 'phase-d-request') {
    const [state, devicePubkey, headSha] = args;
    if ((state !== 'pending' && state !== 'ratified') || !devicePubkey || !headSha) {
      throw new Error(
        'usage: physical-drill-producer phase-d-request <pending|ratified> <device-pubkey> <head-sha>',
      );
    }
    return capturePhysicalPhaseDRequest({ state, devicePubkey, headSha });
  }
  if (mode === 'phase-d-ratify') {
    const [devicePubkey, headSha] = args;
    if (!devicePubkey || !headSha) {
      throw new Error('usage: physical-drill-producer phase-d-ratify <device-pubkey> <head-sha>');
    }
    return ratifyPhysicalPhaseDRequest({ devicePubkey, headSha });
  }
  if (mode === 'phase-d-event') {
    const [hostId, afterRowIdRaw, integratorDeviceKey, stagingSha, waitSecondsRaw] = args;
    const afterRowId = Number(afterRowIdRaw);
    // Optional bounded wait (WI-10003787): the tower's event can land after git-sync:run returns in_progress.
    const waitSeconds = waitSecondsRaw === undefined ? 0 : Number(waitSecondsRaw);
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      !Number.isSafeInteger(afterRowId) ||
      afterRowId < 0 ||
      !integratorDeviceKey ||
      !stagingSha ||
      !Number.isSafeInteger(waitSeconds) ||
      waitSeconds < 0 ||
      waitSeconds * 1000 > PHASE_D_EVENT_WAIT_MAX_MS
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-d-event <tower|vm> <after-row-id> <integrator-device-key> <staging-sha> [wait-seconds<=1200]',
      );
    }
    return capturePhysicalPhaseDEvent({
      hostId: hostId as PhysicalPhaseDHost,
      afterRowId,
      integratorDeviceKey,
      stagingSha,
      waitMs: waitSeconds * 1000,
    });
  }
  if (mode === 'phase-d-observe') {
    const [hostId, stage, integratorDeviceKey, runId, expectedSha] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      !['first-source', 'first-destination', 'dirty-before', 'dirty-after'].includes(stage ?? '') ||
      !integratorDeviceKey ||
      !runId ||
      (expectedSha !== undefined && !/^[0-9a-f]{40}$/.test(expectedSha))
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-d-observe <tower|vm> <first-source|first-destination|dirty-before|dirty-after> <integrator-device-key> <run-id> [expected-staging-sha]',
      );
    }
    const observation = await capturePhysicalPhaseDObservation({
      hostId: hostId as PhysicalPhaseDHost,
      stage: stage as PhysicalPhaseDObservationStage,
      integratorDeviceKey,
      runId,
    });
    // With an expected head, a host that has not converged yet exits 3 and still
    // prints the observation, so the scenario can nudge git-sync and retry
    // without losing the evidence (WI-10003811).
    if (expectedSha !== undefined) {
      const lagging = phaseDObservationLag(observation, stage as PhysicalPhaseDObservationStage, expectedSha);
      if (lagging.length > 0) {
        throw new PhysicalDrillIncompleteEvidenceError(
          `physical-drill-producer: ${hostId} ${stage} has not converged to ${expectedSha}: lagging ${lagging.join(', ')}`,
          observation,
        );
      }
    }
    return observation;
  }
  if (mode === 'phase-d-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-d-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseD(readJson(inputPath) as PhysicalPhaseDInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase D rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-e-mode') {
    const [nextMode, runId] = args;
    if ((nextMode !== 'legacy' && nextMode !== 'bridged') || !runId) {
      throw new Error('usage: physical-drill-producer phase-e-mode <legacy|bridged> <run-id>');
    }
    return setPhysicalPhaseEMode({ runId, mode: nextMode });
  }
  if (mode === 'rig-preflight') {
    // P-003 (R-5): P-505 guard-rail facts as read-only checks, run before the first rig ssh.
    return physicalDrillPreflightMode(args);
  }
  if (mode === 'phase-e-preflight') {
    if (args.length !== 0) {
      throw new Error('usage: physical-drill-producer phase-e-preflight');
    }
    return preflightPhysicalPhaseERemotes();
  }
  if (mode === 'phase-e-mode-read') {
    if (args.length !== 0) throw new Error('usage: physical-drill-producer phase-e-mode-read');
    return readPhysicalPhaseEMode();
  }
  if (mode === 'same-box-pot-mode') {
    // Rig setup for the same-box rehearsal only: put the throwaway pot in the canary's steady
    // mode (bridged) so git-sync creates the pot-git stores the phases observe. Refused on the
    // physical rig, whose canary mode belongs to its hive (phase E restores it).
    const [nextMode] = args;
    if ((nextMode !== 'legacy' && nextMode !== 'bridged' && nextMode !== 'p2p-only') || args.length !== 1) {
      throw new Error('usage: physical-drill-producer same-box-pot-mode <legacy|bridged|p2p-only>');
    }
    const target = physicalDrillTarget();
    if (!target.diagnostic) throw new Error('physical-drill-producer: same-box-pot-mode is refused on the physical rig');
    await setPotGitMode(PHASE_D_WORKSPACE, target.potHome, nextMode);
    return { ok: true, potHome: target.potHome, mode: await getPotGitMode(PHASE_D_WORKSPACE, target.potHome) };
  }
  if (mode === 'phase-e-mode-ensure') {
    const [nextMode, runId] = args;
    if ((nextMode !== 'legacy' && nextMode !== 'bridged') || !runId || args.length !== 2) {
      throw new Error('usage: physical-drill-producer phase-e-mode-ensure <legacy|bridged> <run-id>');
    }
    return ensurePhysicalPhaseEMode({ runId, mode: nextMode });
  }
  if (mode === 'phase-e-await-mode') {
    const [stage, waitSecRaw] = args;
    const waitSec = Number(waitSecRaw);
    if (
      !['legacy-before', 'bridged-member', 'healthy-egress', 'divergence-before', 'divergence-after', 'legacy-after'].includes(stage ?? '') ||
      args.length !== 2 || !Number.isInteger(waitSec) || waitSec < 0 || waitSec * 1000 > PHASE_E_MODE_WAIT_MAX_MS
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-e-await-mode <legacy-before|bridged-member|healthy-egress|divergence-before|divergence-after|legacy-after> <wait-sec<=1200>',
      );
    }
    return requirePhysicalPhaseEStageMode({ stage: stage as PhysicalPhaseEObservationStage, waitMs: waitSec * 1000 });
  }
  if (mode === 'phase-e-observe') {
    // after-fire-started-at: the ISO start of the git-sync:run this stage judges.
    // The capture then waits (inside the same budget) for a finished fire started
    // at/after it, instead of racing the in-flight one (WI-10004055).
    const [hostId, stage, deviceKey, runId, waitSecRaw, afterFireStartedAt] = args;
    const waitSec = waitSecRaw === undefined ? 0 : Number(waitSecRaw);
    if (
      (hostId !== 'tower' && hostId !== 'vm') ||
      !['legacy-before', 'bridged-member', 'healthy-egress', 'divergence-before', 'divergence-after', 'legacy-after'].includes(stage ?? '') ||
      !deviceKey || !runId || args.length > 6 || afterFireStartedAt === '' ||
      !Number.isInteger(waitSec) || waitSec < 0 || waitSec * 1000 > PHASE_E_MODE_WAIT_MAX_MS
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-e-observe <tower|vm> <legacy-before|bridged-member|healthy-egress|divergence-before|divergence-after|legacy-after> <device-key> <run-id> [wait-sec<=1200] [after-fire-started-at-iso]',
      );
    }
    return capturePhysicalPhaseEObservation({
      hostId: hostId as PhysicalPhaseEHost,
      stage: stage as PhysicalPhaseEObservationStage,
      deviceKey,
      runId,
      waitMs: waitSec * 1000,
      ...(afterFireStartedAt === undefined ? {} : { afterFireStartedAt }),
    });
  }
  if (mode === 'phase-e-ingress') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-e-ingress <run-id>');
    return createPhysicalPhaseEIngress({ runId });
  }
  if (mode === 'phase-e-diverge') {
    const [runId] = args;
    if (!runId) throw new Error('usage: physical-drill-producer phase-e-diverge <run-id>');
    return createPhysicalPhaseEDivergence({ runId });
  }
  if (mode === 'phase-e-recover') {
    const [mutationPath] = args;
    if (!mutationPath) throw new Error('usage: physical-drill-producer phase-e-recover <fork-ahead-mutation.json>');
    return restorePhysicalPhaseEDivergence(readJson(mutationPath) as PhysicalPhaseERemoteMutation);
  }
  if (mode === 'phase-e-watchdog') {
    const [ordinalRaw, runId] = args;
    const ordinal = Number(ordinalRaw);
    if ((ordinal !== 1 && ordinal !== 2) || !runId) {
      throw new Error('usage: physical-drill-producer phase-e-watchdog <1|2> <run-id>');
    }
    return runPhysicalPhaseEWatchdogSweep({ runId, ordinal: ordinal as 1 | 2 });
  }
  if (mode === 'phase-e-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-e-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseE(readJson(inputPath) as PhysicalPhaseEInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase E rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-f-run') {
    const [hostId, deviceKey, peerDeviceKey, runId] = args;
    if ((hostId !== 'tower' && hostId !== 'vm') || !deviceKey || !peerDeviceKey || !runId) {
      throw new Error(
        'usage: physical-drill-producer phase-f-run <tower|vm> <device-key> <peer-device-key> <run-id>',
      );
    }
    return executePhysicalPhaseFHost({
      hostId: hostId as PhysicalPhaseFHost,
      deviceKey,
      peerDeviceKey,
      runId,
    });
  }
  if (mode === 'phase-f-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-f-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseF(readJson(inputPath) as PhysicalPhaseFInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase F rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-g-run') {
    const [towerDeviceKey, vmDeviceKey, runId] = args;
    if (!towerDeviceKey || !vmDeviceKey || !runId) {
      throw new Error(
        'usage: physical-drill-producer phase-g-run <tower-device-key> <vm-device-key> <run-id>',
      );
    }
    return executePhysicalPhaseG({ runId, towerDeviceKey, vmDeviceKey });
  }
  if (mode === 'phase-g-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-g-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseG(readJson(inputPath) as PhysicalPhaseGInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase G rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-h-observe') {
    const [hostId, step, repoPath, ...deviceKeys] = args;
    if ((hostId !== 'tower' && hostId !== 'vm') || !step || !repoPath || deviceKeys.length === 0) {
      throw new Error(
        'usage: physical-drill-producer phase-h-observe <tower|vm> <pre|omitted|restarted|replaced> <canonical-repo-path> <device-key...>',
      );
    }
    return observePhysicalPhaseH({ hostId, step, repoPath, deviceKeys });
  }
  if (mode === 'phase-h-attempt') {
    // The captured capability comes only from a recorded VM observation, so the
    // capability a step tests is the one the owner actually advertised earlier.
    const [step, repoPath, deviceKey, runId, capturedObservationPath] = args;
    if (!step || !repoPath || !deviceKey || !runId || !capturedObservationPath) {
      throw new Error(
        'usage: physical-drill-producer phase-h-attempt <pre|omitted|restarted|replaced> <canonical-vm-repo-path> <vm-device-key> <run-id> <captured-vm-observation.json>',
      );
    }
    const observation = readJson(capturedObservationPath) as PhysicalPhaseHObservation;
    const captured = observation?.hostId === 'vm' ? observation.serving?.capability : null;
    if (!captured) {
      throw new Error(`physical-drill-producer: ${capturedObservationPath} holds no ready VM serving capability`);
    }
    return attemptPhysicalPhaseH({ step, repoPath, deviceKey, runId, captured });
  }
  if (mode === 'phase-h-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-h-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseH(readJson(inputPath) as PhysicalPhaseHInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase H rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (mode === 'phase-i-owner') {
    // The single owning hive process (P-521 F6, D-022). It is the ONE producer
    // mode that does not exit on its own: it serves owner signatures until the
    // scenario SIGKILLs it (the physical owner loss) or its EXIT trap does. The
    // scenario always starts it detached, so no caller waits on its exit.
    const [dir, runId] = args;
    if (!dir || !runId || args.length !== 2) {
      throw new Error('usage: physical-drill-producer phase-i-owner <absolute-phase-dir> <run-id>');
    }
    const owner = await startPhaseIOwner({ dir, runId });
    await writeFlushed(process.stdout, `${JSON.stringify(owner.record)}\n`);
    return new Promise<never>(() => undefined);
  }
  if (mode === 'phase-i-attempt') {
    // The device signer is this host's REAL physical device key, addressed by
    // the keychain id its host identity names. The VM record files carry the
    // captured owner proof (live) and the VM's signed device head (outage).
    const [hostId, step, dir, runId, deviceKey, keychainId, hiveId, vmLivePath, vmOutagePath] = args;
    if (
      (hostId !== 'tower' && hostId !== 'vm') || !step || !dir || !runId || !deviceKey || !keychainId || !hiveId ||
      args.length > 9
    ) {
      throw new Error(
        'usage: physical-drill-producer phase-i-attempt <tower|vm> <live|lost|outage|restored> <absolute-phase-dir> <run-id> <device-key> <keychain-id> <hive-id> [vm-live.json [vm-outage.json]]',
      );
    }
    const { signWithDeviceKey } = await import('../../identity/sign-with-device-key');
    return attemptPhysicalPhaseI({
      host: hostId,
      step: step as PhysicalPhaseIStep,
      dir,
      runId,
      deviceKey,
      hiveId,
      ownerSocket: hostId === 'vm' ? resolve(dir, 'owner', 'owner.sock') : null,
      vmLive: vmLivePath ? (readJson(vmLivePath) as PhysicalPhaseIAttempt) : null,
      vmOutage: vmOutagePath ? (readJson(vmOutagePath) as PhysicalPhaseIAttempt) : null,
    }, { signDevice: (bytes) => signWithDeviceKey(keychainId, bytes) });
  }
  if (mode === 'phase-i-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-i-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseI(readJson(inputPath) as PhysicalPhaseIInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase I rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  if (PHASE_J_MODES.has(mode)) return physicalPhaseJMode(mode, args);
  if (mode === 'post-go-canary-verify') {
    const [inputPath] = args;
    if (!inputPath) {
      throw new Error('usage: physical-drill-producer post-go-canary-verify <post-go-canary-input.json>');
    }
    const verdict = validatePostGoReleaseCanary(
      readJson(inputPath) as PostGoReleaseCanaryInput,
    );
    if (!verdict.ok) {
      throw new Error(
        `physical-drill-producer: post-GO release canary rejected: ${verdict.errors.join('; ')}`,
      );
    }
    return verdict;
  }
  if (mode === 'post-go-canary-observe') {
    // One hourly P-501 sample (WI-10002545). The first sample of a soak is its
    // START, refused unless the hive's bridge egress is real (endgame D-044).
    const [hive, samplesPath] = args;
    if (!hive || !samplesPath) {
      throw new Error('usage: physical-drill-producer post-go-canary-observe <canary-hive> <samples.json>');
    }
    const existing = existsSync(samplesPath) ? readJson(samplesPath) : [];
    if (!Array.isArray(existing)) {
      throw new Error(`physical-drill-producer: ${samplesPath} must hold a JSON array of P-501 observations`);
    }
    const sample = await capturePostGoCanaryObservation(hive);
    const samples = appendCanaryObservation(existing as PostGoCanaryObservation[], sample);
    const tmpPath = `${samplesPath}.tmp-${process.pid}`;
    writeFileSync(tmpPath, `${JSON.stringify(samples, null, 2)}\n`);
    renameSync(tmpPath, samplesPath);
    return { ok: true, hive, samplesPath, count: samples.length, sample };
  }
  if (mode === 'finalize') {
    refuseDiagnosticEvidence('finalize');
    const [unsignedEvidencePath, towerReceiptPath, vmReceiptPath, evidencePath, trustPath] = args;
    if (!unsignedEvidencePath || !towerReceiptPath || !vmReceiptPath || !evidencePath || !trustPath) {
      throw new Error(
        'usage: physical-drill-producer finalize <unsigned-evidence.json> <tower-receipt.json> <vm-receipt.json> <evidence-out.json> <trust-out.json>',
      );
    }
    const artifacts = finalizePhysicalDrillArtifacts({
      evidence: readJson(unsignedEvidencePath),
      receipts: [readJson(towerReceiptPath), readJson(vmReceiptPath)],
    });
    writeOutputsAtomically(evidencePath, trustPath, artifacts);
    return { ok: true, runId: artifacts.evidence.runId, evidencePath, trustPath };
  }
  throw new Error(
    'physical-drill-producer: mode must be identity, preflight, phase-a-observe, phase-a-quarantine, phase-a-quarantine-observe, phase-a-verify, phase-b-observe, phase-b-commit, phase-b-verify, phase-c-run, phase-c-verify, phase-d-commit, phase-d-dirty, phase-d-reset, phase-d-tier-hold, phase-d-tier-restore, phase-d-request, phase-d-ratify, phase-d-event, phase-d-observe, phase-d-verify, phase-e-preflight, phase-e-mode, phase-e-mode-read, phase-e-mode-ensure, phase-e-await-mode, phase-e-observe, phase-e-ingress, phase-e-diverge, phase-e-recover, phase-e-watchdog, phase-e-verify, phase-f-run, phase-f-verify, phase-g-run, phase-g-verify, phase-h-observe, phase-h-attempt, phase-h-verify, phase-i-owner, phase-i-attempt, phase-i-verify, phase-j-fault, phase-j-write, phase-j-observe, phase-j-verify, post-go-canary-observe, post-go-canary-verify, same-box-pot-mode, sign, or finalize',
  );
}

// Phase J (P-521 F4): the scoped VM outage fault, run-bound writes, the observer
// and the verifier. The database-touching steps are injectable so the argument
// handling and the lag -> exit 3 mapping are testable without a database.
const PHASE_J_MODES = new Set(['phase-j-fault', 'phase-j-write', 'phase-j-observe', 'phase-j-verify']);

export type PhysicalPhaseJModeDeps = {
  observe: typeof observePhysicalPhaseJ;
  install: typeof installPhysicalPhaseJFault;
  remove: typeof removePhysicalPhaseJFault;
  sweep: typeof sweepPhysicalPhaseJFaults;
  readInput: (path: string) => unknown;
};

export async function physicalPhaseJMode(
  mode: string,
  args: string[],
  overrides: Partial<PhysicalPhaseJModeDeps> = {},
): Promise<unknown> {
  const deps: PhysicalPhaseJModeDeps = {
    observe: observePhysicalPhaseJ,
    install: installPhysicalPhaseJFault,
    remove: removePhysicalPhaseJFault,
    sweep: sweepPhysicalPhaseJFaults,
    readInput: readJson,
    ...overrides,
  };
  if (mode === 'phase-j-fault') {
    const [hostId, action, runId, ...rest] = args;
    const usage = 'usage: physical-drill-producer phase-j-fault vm <install|remove> <run-id> | phase-j-fault vm sweep';
    // The fault is VM-only by construction: the tower is the fleet's live bg-host.
    if (hostId !== 'vm' || rest.length > 0) throw new Error(usage);
    if (action === 'sweep' && !runId) return deps.sweep();
    if (!runId) throw new Error(usage);
    if (action === 'install') return deps.install({ runId });
    if (action === 'remove') return deps.remove({ runId });
    throw new Error(usage);
  }
  if (mode === 'phase-j-write') {
    // The exact work_items:create args for one run-bound write; the scenario pipes
    // them to the tower's production MCP verb, so the tower authors it itself.
    const [write, runId] = args;
    if ((write !== 'A' && write !== 'B') || !runId) {
      throw new Error('usage: physical-drill-producer phase-j-write <A|B> <run-id>');
    }
    return { kind: 'task', title: phaseJWriteTitle(runId, write), summary: phaseJWriteSummary(runId, write), force: true };
  }
  if (mode === 'phase-j-observe') {
    const [hostId, step, runId, featureIdA, logKeyHex, heldPositionRaw] = args;
    if ((hostId !== 'tower' && hostId !== 'vm') || !step || !runId) {
      throw new Error(
        'usage: physical-drill-producer phase-j-observe <tower|vm> <baseline|authored|held|held-after-restart|replayed> <run-id> [feature-id-a [log-key-hex held-position]]',
      );
    }
    const heldPosition = heldPositionRaw === undefined ? undefined : Number(heldPositionRaw);
    if (heldPosition !== undefined && !Number.isSafeInteger(heldPosition)) {
      throw new Error(`physical-drill-producer: phase-j-observe held-position must be an integer: ${heldPositionRaw}`);
    }
    const observation = await deps.observe({ hostId, step, runId, featureIds: featureIdA ? [featureIdA] : [] });
    const lag = phaseJLag(observation, { featureIdA, logKeyHex, heldPosition });
    if (lag.length > 0) {
      throw new PhysicalDrillIncompleteEvidenceError(
        `physical Phase J ${hostId} has not reached ${step}: ${lag.join('; ')}`,
        observation,
      );
    }
    return observation;
  }
  if (mode === 'phase-j-verify') {
    const [inputPath] = args;
    if (!inputPath) throw new Error('usage: physical-drill-producer phase-j-verify <private-run-input.json>');
    const verdict = validatePhysicalPhaseJ(deps.readInput(inputPath) as PhysicalPhaseJInput);
    if (!verdict.ok) {
      throw new Error(`physical-drill-producer: Phase J rejected: ${verdict.errors.join('; ')}`);
    }
    return verdict;
  }
  throw new Error(`physical-drill-producer: ${mode} is not a Phase J mode`);
}

type PhysicalDrillCliStream = { write(chunk: string, callback: (error?: Error | null) => void): boolean };

function writeFlushed(stream: PhysicalDrillCliStream, text: string): Promise<void> {
  return new Promise((resolveWrite) => {
    stream.write(text, () => resolveWrite());
  });
}

/**
 * Run one producer mode, write its result, then END THE PROCESS (WI-10003741).
 *
 * The scenario calls every mode over ssh and waits for the remote process to
 * exit. Modes that take or release a file lock open the @papercusp/locks pg
 * pool, whose idle clients keep the event loop alive, so a CLI that only sets
 * `process.exitCode` never exits. Measured in P-505 run 23: `phase-d-dirty`
 * wrote its receipt at 21:50:03Z and was still running 26 minutes later, which
 * stalled Phase D until the dirt lock's TTL nearly lapsed. The exit waits for
 * the write callback so a piped stdout is flushed before the process ends.
 */
export async function runPhysicalDrillCliToExit(
  argv: string[],
  deps: {
    run: (argv: string[]) => Promise<unknown>;
    stdout: PhysicalDrillCliStream;
    stderr: PhysicalDrillCliStream;
    exit: (code: number) => void;
  },
): Promise<void> {
  let code = 0;
  try {
    const result = await deps.run(argv);
    await writeFlushed(deps.stdout, `${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error instanceof PhysicalDrillIncompleteEvidenceError) {
      code = PHYSICAL_DRILL_INCOMPLETE_EXIT;
      await writeFlushed(deps.stdout, `${JSON.stringify(error.evidence)}\n`);
    } else {
      code = 1;
    }
    await writeFlushed(deps.stderr, `${error instanceof Error ? error.message : String(error)}\n`);
  }
  deps.exit(code);
}

/** Exit code for "the evidence is valid but the host has not converged yet; retry". */
export const PHYSICAL_DRILL_INCOMPLETE_EXIT = 3;

/**
 * A mode that measured something real but not yet the state it waits for. The
 * CLI prints `evidence` to stdout and exits {@link PHYSICAL_DRILL_INCOMPLETE_EXIT},
 * so a retry loop keeps the last observation for diagnostics (WI-10003811).
 */
export class PhysicalDrillIncompleteEvidenceError extends Error {
  constructor(
    message: string,
    readonly evidence: unknown,
  ) {
    super(message);
    this.name = 'PhysicalDrillIncompleteEvidenceError';
  }
}

const invokedPath = process.argv[1];
if (invokedPath && samePhysicalDrillPath(invokedPath, fileURLToPath(import.meta.url))) {
  void runPhysicalDrillCliToExit(process.argv.slice(2), {
    run: cli,
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code) => process.exit(code),
  });
}
