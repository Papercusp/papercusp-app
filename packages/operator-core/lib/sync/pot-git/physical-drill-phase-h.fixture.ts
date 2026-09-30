/**
 * A valid four-step physical Phase H input, shared by the Phase H validator
 * test and the outer physical-evidence guard. Every value is synthetic: the
 * sigrefs OIDs are placeholders and only the device keys must be real raw-32
 * Ed25519 pubkeys (the namespace mapping rejects anything else).
 */
import {
  PHASE_H_ATTEMPT_SCHEMA,
  PHASE_H_INPUT_SCHEMA,
  PHASE_H_MIN_OMISSION_MS,
  PHASE_H_OBSERVATION_SCHEMA,
  type PhaseHCapabilitySummary,
  type PhaseHNamespaceSigrefs,
  type PhysicalPhaseHInput,
  type PhysicalPhaseHObservation,
  type PhysicalPhaseHStep,
  type PhysicalPhaseHStepInput,
} from './physical-drill-phase-h';
import { GIT_SERVING_LEASE_MS, type GitServingCapability } from './serving-capability';
import { deviceNamespaceKey } from './storage';

export const PHASE_H_FIXTURE_HIVE_ID = 'hive-pubkey-base64';
export const PHASE_H_FIXTURE_REPO_KEY = 'hello-world-3-pot';
export const PHASE_H_FIXTURE_GEN_1 = `sg2-1-${'a'.repeat(40)}`;
export const PHASE_H_FIXTURE_GEN_2 = `sg2-2-${'b'.repeat(40)}`;
export const PHASE_H_FIXTURE_OWNER_BEFORE = { pid: 69706, build: 'aef4431553c9', launcher: 'rig-sidecar-current/boot-headless-current.sh' };
export const PHASE_H_FIXTURE_OWNER_AFTER = { ...PHASE_H_FIXTURE_OWNER_BEFORE, pid: 71234 };
export const PHASE_H_FIXTURE_PUBLISHER_PID = 80001;

export const phaseHFixtureOid = (seed: number) => seed.toString(16).padStart(40, '0');

export function phaseHFixtureCapability(vmDeviceKey: string, runtimeId: string, storeGeneration: string, issuedAtMs: number): GitServingCapability {
  return {
    v: 1,
    workspaceId: 'papercusp-workspace',
    installSlug: PHASE_H_FIXTURE_REPO_KEY,
    potHomeSlug: PHASE_H_FIXTURE_REPO_KEY,
    scope: { hive_id: PHASE_H_FIXTURE_HIVE_ID, repo_key: PHASE_H_FIXTURE_REPO_KEY },
    runtimeId,
    identity: { devicePubkeyBase64: vmDeviceKey, githubUserId: 42, keychainId: 'papercusp-device' },
    context: { hive_id: PHASE_H_FIXTURE_HIVE_ID, repo_key: PHASE_H_FIXTURE_REPO_KEY, store_generation: storeGeneration },
    issuedAtMs,
    expiresAtMs: issuedAtMs + GIT_SERVING_LEASE_MS,
  };
}

function summary(c: GitServingCapability): PhaseHCapabilitySummary {
  return {
    runtimeId: c.runtimeId,
    storeGeneration: c.context.store_generation,
    devicePubkeyBase64: c.identity.devicePubkeyBase64,
    issuedAtMs: c.issuedAtMs,
    expiresAtMs: c.expiresAtMs,
  };
}

export function phaseHFixtureSigrefs(
  deviceKey: string,
  sigrefsOid: string,
  version: number,
  storeGeneration: string,
  refs: Array<{ ref: string; sha: string }>,
): PhaseHNamespaceSigrefs {
  return { deviceKey, sigrefsOid, version, storeGeneration, signatureValid: true, refs };
}

/**
 * Evidence advances one second per record from `startMs`, so the whole input
 * spans about fifteen seconds and fits inside any enclosing run window that
 * starts before `startMs` and ends at least twenty seconds after it.
 */
export function buildPhysicalPhaseHInput(options: {
  runId: string;
  towerDeviceKey: string;
  vmDeviceKey: string;
  startMs: number;
}): PhysicalPhaseHInput {
  const { runId, towerDeviceKey, vmDeviceKey, startMs } = options;
  let clock = startMs;
  const tick = () => new Date((clock += 1_000)).toISOString();
  const ns = deviceNamespaceKey(vmDeviceKey);
  const oid = phaseHFixtureOid;
  const c1 = phaseHFixtureCapability(vmDeviceKey, 'runtime-1', PHASE_H_FIXTURE_GEN_1, startMs);
  const c2 = phaseHFixtureCapability(vmDeviceKey, 'runtime-2', PHASE_H_FIXTURE_GEN_1, startMs + 120_000);
  // Store replacement need not reboot the owner, so the runtime may survive it.
  const c3 = phaseHFixtureCapability(vmDeviceKey, 'runtime-2', PHASE_H_FIXTURE_GEN_2, startMs + 240_000);
  const commit = (step: PhysicalPhaseHStep, seed: number) => ({
    ref: `refs/namespaces/${ns}/refs/heads/p521-phase-h-${step}-${runId}`,
    oid: oid(seed),
    signed: { ref: `refs/heads/p521-phase-h-${step}-${runId}`, sha: oid(seed) },
  });
  const commits = { pre: commit('pre', 1), omitted: commit('omitted', 2), restarted: commit('restarted', 3), replaced: commit('replaced', 4) };
  const sigrefs = (seed: number, version: number, generation: string, refs: Array<{ ref: string; sha: string }>) =>
    phaseHFixtureSigrefs(vmDeviceKey, oid(seed), version, generation, refs);
  const s0 = sigrefs(100, 10, PHASE_H_FIXTURE_GEN_1, []);
  const s1 = sigrefs(101, 11, PHASE_H_FIXTURE_GEN_1, [commits.pre.signed]);
  const s2 = sigrefs(102, 12, PHASE_H_FIXTURE_GEN_1, [commits.pre.signed, commits.omitted.signed, commits.restarted.signed]);
  const s3 = sigrefs(103, 13, PHASE_H_FIXTURE_GEN_2, [commits.replaced.signed]);

  const observation = (hostId: 'vm' | 'tower', step: PhysicalPhaseHStep, parts: {
    capability?: GitServingCapability | null;
    publisherId?: string;
    ageMs?: number;
    incarnation?: string;
    namespace: PhaseHNamespaceSigrefs;
  }): PhysicalPhaseHObservation => {
    const observedAt = tick();
    const ready = parts.capability ?? null;
    return {
      schemaVersion: PHASE_H_OBSERVATION_SCHEMA,
      hostId,
      step,
      observedAt,
      observerPid: hostId === 'vm' ? 80100 : 80200,
      advertisement: {
        present: hostId === 'vm',
        publisherId: parts.publisherId ?? null,
        sentAtMs: hostId === 'vm' ? Date.parse(observedAt) - (parts.ageMs ?? 1_000) : null,
        ageMs: hostId === 'vm' ? (parts.ageMs ?? 1_000) : null,
      },
      serving: ready
        ? { status: 'ready', retryable: false, reason: null, capability: ready }
        : { status: 'unknown', retryable: true, reason: 'owner advertisement is stale', capability: null },
      storeIncarnation: parts.incarnation ?? null,
      namespaces: [parts.namespace],
    };
  };
  const refused = (c: GitServingCapability) => ({
    outcome: 'refused' as const,
    capability: summary(c),
    code: 'GIT_SERVING_UNAVAILABLE',
    retryable: true,
    message: 'pot-git serving unavailable: unknown (owner advertisement is stale); retry next tick',
  });
  const step = (name: PhysicalPhaseHStep, parts: {
    owner: GitServingCapability | null;
    publisherId: string;
    ageMs?: number;
    incarnation: string;
    guard: PhysicalPhaseHStepInput['attempt']['capturedGuard'];
    before: PhaseHNamespaceSigrefs;
    after: PhaseHNamespaceSigrefs;
    published: boolean;
  }): PhysicalPhaseHStepInput => {
    const vm = observation('vm', name, {
      capability: parts.owner, publisherId: parts.publisherId, ageMs: parts.ageMs, incarnation: parts.incarnation, namespace: parts.before,
    });
    const startedAt = tick();
    const finishedAt = tick();
    return {
      vm,
      attempt: {
        schemaVersion: PHASE_H_ATTEMPT_SCHEMA,
        hostId: 'vm',
        step: name,
        runId,
        startedAt,
        finishedAt,
        publisherPid: PHASE_H_FIXTURE_PUBLISHER_PID,
        resolution: parts.owner
          ? { status: 'ready', retryable: false, reason: null, capability: summary(parts.owner) }
          : { status: 'unknown', retryable: true, reason: 'owner advertisement is stale', capability: null },
        capturedGuard: parts.guard,
        bootAttempts: 0,
        commit: { ref: commits[name].ref, oid: commits[name].oid },
        published: parts.published ? { version: parts.after.version!, sigrefsOid: parts.after.sigrefsOid! } : null,
        sigrefsBefore: parts.before,
        sigrefsAfter: parts.after,
      },
      tower: observation('tower', name, { namespace: { ...parts.after } }),
    };
  };

  const steps = {
    pre: step('pre', {
      owner: c1, publisherId: 'publisher-1', incarnation: oid(200),
      guard: { outcome: 'signed', capability: summary(c1), signatureValid: true },
      before: s0, after: s1, published: true,
    }),
    omitted: step('omitted', {
      owner: null, publisherId: 'publisher-1', ageMs: PHASE_H_MIN_OMISSION_MS + 1_000, incarnation: oid(200),
      guard: refused(c1), before: s1, after: s1, published: false,
    }),
    restarted: step('restarted', {
      owner: c2, publisherId: 'publisher-2', incarnation: oid(200),
      guard: refused(c1), before: s1, after: s2, published: true,
    }),
    replaced: step('replaced', {
      owner: c3, publisherId: 'publisher-2', incarnation: oid(201),
      guard: refused(c2), before: s2, after: s3, published: true,
    }),
  };
  // structuredClone detaches every shared sigrefs object, so a test that
  // mutates one step's view cannot silently rewrite another step's evidence.
  return structuredClone({
    schemaVersion: PHASE_H_INPUT_SCHEMA,
    runId,
    window: { startedAt: new Date(startMs).toISOString(), finishedAt: new Date(clock + 1_000).toISOString() },
    identities: { towerDeviceKey, vmDeviceKey },
    vmOwner: { before: PHASE_H_FIXTURE_OWNER_BEFORE, after: PHASE_H_FIXTURE_OWNER_AFTER, frozenMs: PHASE_H_MIN_OMISSION_MS + 5_000 },
    steps,
  });
}
