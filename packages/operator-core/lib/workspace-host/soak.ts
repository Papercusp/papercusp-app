/**
 * Workspace-host soak: the pure core of D-391 (byoc-cloud-workspaces-gcp-aws-azure-2026-08-22).
 *
 * A soak watches ONE host, undisturbed, for a fixed window and answers a single question: did it
 * stay the same healthy machine the whole time? Everything here is deliberately side-effect free —
 * the probe takes its readings through injected seams and the verdict is a pure function of the
 * persisted samples — so the rule that decides an acceptance stage can be tested exhaustively
 * without a cloud, and re-derived by any reader from the rows alone.
 *
 * Three properties are load-bearing:
 *
 * 1. THE SUBJECT IS PINNED AT START. The GCE incarnation (instance id) and boot image are read once
 *    and every later sample is compared against them. A host recreated or re-imaged mid-soak is a
 *    FAILED sample — never a new baseline — because "a healthy VM existed under this name for 24h"
 *    is not the claim; "this machine stayed healthy for 24h" is.
 *
 * 2. UNMEASURED IS NOT FAILED. A provider read that errors records its checks as `ok: null`. One
 *    Compute API blip is not evidence the host went down, and treating it as a strict failure would
 *    let a transient control-plane error sink a day of evidence. Unmeasured samples still count
 *    against coverage, so a soak that could not see its host for hours does not pass either.
 *
 * 3. THE VERDICT IS RECOMPUTED FROM WHAT WAS PERSISTED. `evaluateWorkspaceHostSoak` takes samples
 *    read back from `workspace_host_logs`, never a tally the workflow kept in memory, so a reader
 *    auditing the stage later reaches the same answer from the same rows.
 */
import {
  resolveWorkspaceHostHealthStatus,
  type WorkspaceHostHealthAttestation,
  type WorkspaceHostHealthCheck,
} from '@papercusp/deployment-driver';

export const WORKSPACE_HOST_SOAK_SCHEMA_VERSION = 1 as const;

/** `workspace_host_logs.unit` for soak samples; the stream is `controller` (the observer). */
export const WORKSPACE_HOST_SOAK_LOG_UNIT = 'workspace-host-soak';

/**
 * The release stage a qualifying soak settles. Shorter soaks run, but never write it. The name carries
 * no duration: the policy (duration included) is part of the stage identity, so the window can change
 * without renaming the stage. Journals from before 2026-09-30 record the retired `acceptance.soak-24h`.
 */
export const WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE = 'acceptance.soak';
/** One hour (owner owner, 2026-09-30, replacing the D-391 24h window for BYOC P-318). */
export const WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS = 60 * 60_000;

export const WORKSPACE_HOST_SOAK_MIN_INTERVAL_MS = 60_000;
export const WORKSPACE_HOST_SOAK_MAX_DURATION_MS = 7 * 24 * 60 * 60_000;

export const WORKSPACE_HOST_SOAK_CHECKS = [
  'compute-running',
  'incarnation-stable',
  'image-stable',
  'controller-reach',
] as const;
export type WorkspaceHostSoakCheckName = (typeof WORKSPACE_HOST_SOAK_CHECKS)[number];

/**
 * Checks with ZERO tolerance. A VM that stopped, was recreated, or booted another image even once
 * did not soak. `controller-reach` is deliberately absent: an IAP tunnel can drop one attempt with
 * nothing wrong on the host, so reach is judged by rate and run length instead.
 */
export const WORKSPACE_HOST_SOAK_STRICT_CHECKS: readonly WorkspaceHostSoakCheckName[] = [
  'compute-running',
  'incarnation-stable',
  'image-stable',
];

export interface WorkspaceHostSoakPolicy {
  durationMs: number;
  intervalMs: number;
  /** A gap longer than this many intervals between consecutive samples fails the soak. */
  maxGapIntervals: number;
  /** Largest tolerated fraction of reach-measured samples whose controller-reach failed. */
  maxReachFailureRate: number;
  /** Reach failing on this many CONSECUTIVE samples is an outage, not a flake. */
  maxConsecutiveReachFailures: number;
  /** Minimum fraction of the expected sample count whose strict checks were all measured. */
  minSampleCoverage: number;
}

export const DEFAULT_WORKSPACE_HOST_SOAK_POLICY: WorkspaceHostSoakPolicy = Object.freeze({
  durationMs: WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS,
  // One-minute samples keep a one-hour window at 61 expected samples, so the coverage and reach-rate
  // tolerances below still admit a few unmeasured reads and one isolated IAP drop.
  intervalMs: 60_000,
  maxGapIntervals: 3,
  maxReachFailureRate: 0.02,
  maxConsecutiveReachFailures: 1,
  minSampleCoverage: 0.95,
});

export class WorkspaceHostSoakPolicyError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid workspace-host soak policy: ${problems.join('; ')}`);
    this.name = 'WorkspaceHostSoakPolicyError';
  }
}

/** Merge caller overrides onto the default and refuse anything that could not produce a verdict. */
export function resolveWorkspaceHostSoakPolicy(
  overrides: Partial<Pick<WorkspaceHostSoakPolicy, 'durationMs' | 'intervalMs'>> = {},
): WorkspaceHostSoakPolicy {
  const policy = { ...DEFAULT_WORKSPACE_HOST_SOAK_POLICY, ...overrides };
  const problems: string[] = [];
  if (!Number.isSafeInteger(policy.intervalMs) || policy.intervalMs < WORKSPACE_HOST_SOAK_MIN_INTERVAL_MS) {
    problems.push(`intervalMs must be an integer >= ${WORKSPACE_HOST_SOAK_MIN_INTERVAL_MS}`);
  }
  if (
    !Number.isSafeInteger(policy.durationMs) ||
    policy.durationMs < policy.intervalMs ||
    policy.durationMs > WORKSPACE_HOST_SOAK_MAX_DURATION_MS
  ) {
    problems.push(`durationMs must be an integer in [intervalMs, ${WORKSPACE_HOST_SOAK_MAX_DURATION_MS}]`);
  }
  if (problems.length > 0) throw new WorkspaceHostSoakPolicyError(problems);
  return policy;
}

export function workspaceHostSoakQualifiesForAcceptance(policy: WorkspaceHostSoakPolicy): boolean {
  return policy.durationMs >= WORKSPACE_HOST_SOAK_ACCEPTANCE_DURATION_MS;
}

/** The machine a soak watches, fixed at start. */
export interface WorkspaceHostSoakSubject {
  workspaceId: string;
  hostId: string;
  soakId: string;
  instanceId: string;
  image: string;
}

export interface WorkspaceHostSoakSample {
  schemaVersion: typeof WORKSPACE_HOST_SOAK_SCHEMA_VERSION;
  soakId: string;
  sequence: number;
  observedAt: string;
  pinned: { instanceId: string; image: string };
  checks: WorkspaceHostHealthCheck[];
}

/** One provider read of the instance. `unreadable` = we could not ask, not that it is gone. */
export type WorkspaceHostSoakInstanceReading =
  | { kind: 'observed'; status: string; instanceId?: string; sourceImage?: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string };

/**
 * One controller-reach attempt over the pinned transport. `conduit-missing` means the host
 * ANSWERED and the fixed initializer binary is gone; `transport-failure` means we never reached
 * the question at all (ssh exits 255 alike for IAP, OS Login and host-key refusals).
 */
export type WorkspaceHostSoakReachOutcome =
  | { kind: 'reached' }
  | { kind: 'conduit-missing'; detail: string }
  | { kind: 'transport-failure'; detail: string };

export interface WorkspaceHostSoakProbe {
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  probeReach(): Promise<WorkspaceHostSoakReachOutcome>;
  now(): Date;
}

export class WorkspaceHostSoakSubjectError extends Error {
  constructor(readonly hostId: string, detail: string) {
    super(`Workspace host '${hostId}' cannot be soaked: ${detail}`);
    this.name = 'WorkspaceHostSoakSubjectError';
  }
}

/** Pin the subject from a reading taken at start; a host that is not up cannot begin a soak. */
export function pinWorkspaceHostSoakSubject(
  identity: Pick<WorkspaceHostSoakSubject, 'workspaceId' | 'hostId' | 'soakId'>,
  reading: WorkspaceHostSoakInstanceReading,
): WorkspaceHostSoakSubject {
  if (reading.kind === 'absent') {
    throw new WorkspaceHostSoakSubjectError(identity.hostId, 'the provider reports no instance');
  }
  if (reading.kind === 'unreadable') {
    throw new WorkspaceHostSoakSubjectError(identity.hostId, `the provider could not be read (${reading.detail})`);
  }
  if (reading.status !== 'RUNNING') {
    throw new WorkspaceHostSoakSubjectError(identity.hostId, `the instance is ${reading.status}, not RUNNING`);
  }
  if (!reading.instanceId) {
    throw new WorkspaceHostSoakSubjectError(identity.hostId, 'the provider returned no instance id to pin');
  }
  if (!reading.sourceImage) {
    throw new WorkspaceHostSoakSubjectError(identity.hostId, 'the provider returned no boot image to pin');
  }
  return { ...identity, instanceId: reading.instanceId, image: reading.sourceImage };
}

function instanceChecks(
  subject: WorkspaceHostSoakSubject,
  reading: WorkspaceHostSoakInstanceReading,
): WorkspaceHostHealthCheck[] {
  if (reading.kind === 'unreadable') {
    const detail = `provider read failed: ${reading.detail}`;
    return [
      { name: 'compute-running', ok: null, detail },
      { name: 'incarnation-stable', ok: null, detail },
      { name: 'image-stable', ok: null, detail },
    ];
  }
  if (reading.kind === 'absent') {
    return [
      { name: 'compute-running', ok: false, detail: 'instance absent' },
      { name: 'incarnation-stable', ok: false, detail: `instance absent (pinned ${subject.instanceId})` },
      { name: 'image-stable', ok: false, detail: 'instance absent' },
    ];
  }
  return [
    { name: 'compute-running', ok: reading.status === 'RUNNING', detail: reading.status },
    reading.instanceId === undefined
      ? { name: 'incarnation-stable', ok: null, detail: 'provider returned no instance id' }
      : {
          name: 'incarnation-stable',
          ok: reading.instanceId === subject.instanceId,
          detail: reading.instanceId === subject.instanceId
            ? reading.instanceId
            : `instance ${reading.instanceId} != pinned ${subject.instanceId}`,
        },
    reading.sourceImage === undefined
      ? { name: 'image-stable', ok: null, detail: 'provider returned no boot image' }
      : {
          name: 'image-stable',
          ok: reading.sourceImage === subject.image,
          detail: reading.sourceImage === subject.image
            ? reading.sourceImage
            : `image ${reading.sourceImage} != pinned ${subject.image}`,
        },
  ];
}

function reachCheck(outcome: WorkspaceHostSoakReachOutcome): WorkspaceHostHealthCheck {
  if (outcome.kind === 'reached') return { name: 'controller-reach', ok: true, detail: 'conduit executable' };
  return { name: 'controller-reach', ok: false, detail: `${outcome.kind}: ${outcome.detail}` };
}

function errorDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Take one sample. Never throws for a probe failure: a failed or unreadable reading IS the
 * observation, and a probe that threw would leave a hole the evaluator must then treat as a gap.
 */
export async function probeWorkspaceHostSoakSample(
  subject: WorkspaceHostSoakSubject,
  sequence: number,
  probe: WorkspaceHostSoakProbe,
): Promise<WorkspaceHostSoakSample> {
  const observedAt = probe.now().toISOString();
  const reading = await probe
    .readInstance()
    .catch((error: unknown): WorkspaceHostSoakInstanceReading => ({ kind: 'unreadable', detail: errorDetail(error) }));
  const reach = await probe
    .probeReach()
    .catch((error: unknown): WorkspaceHostSoakReachOutcome => ({ kind: 'transport-failure', detail: errorDetail(error) }));
  return {
    schemaVersion: WORKSPACE_HOST_SOAK_SCHEMA_VERSION,
    soakId: subject.soakId,
    sequence,
    observedAt,
    pinned: { instanceId: subject.instanceId, image: subject.image },
    checks: [...instanceChecks(subject, reading), reachCheck(reach)],
  };
}

function checkOf(sample: WorkspaceHostSoakSample, name: WorkspaceHostSoakCheckName): WorkspaceHostHealthCheck | undefined {
  return sample.checks.find((check) => check.name === name);
}

/** A sample whose measured checks all pass (unmeasured checks do not fail it). */
export function workspaceHostSoakSampleOk(sample: WorkspaceHostSoakSample): boolean {
  return sample.checks.every((check) => check.ok !== false);
}

/** The host-row health attestation for one sample — the first production producer of host health. */
export function workspaceHostSoakAttestation(
  hostId: string,
  sample: WorkspaceHostSoakSample,
): WorkspaceHostHealthAttestation {
  return {
    hostId,
    observedAt: sample.observedAt,
    status: resolveWorkspaceHostHealthStatus({
      reachable: checkOf(sample, 'compute-running')?.ok !== false,
      checks: sample.checks,
    }),
    checks: sample.checks,
  };
}

function isCheck(value: unknown): value is WorkspaceHostHealthCheck {
  if (!value || typeof value !== 'object') return false;
  const check = value as Record<string, unknown>;
  return (
    typeof check.name === 'string' &&
    (check.ok === true || check.ok === false || check.ok === null) &&
    (check.detail === undefined || typeof check.detail === 'string')
  );
}

/** Validate a persisted sample. A row that does not parse is excluded, and so costs coverage. */
export function parseWorkspaceHostSoakSample(value: unknown): WorkspaceHostSoakSample | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const pinned = row.pinned as Record<string, unknown> | undefined;
  if (
    row.schemaVersion !== WORKSPACE_HOST_SOAK_SCHEMA_VERSION ||
    typeof row.soakId !== 'string' ||
    !Number.isSafeInteger(row.sequence) ||
    (row.sequence as number) < 0 ||
    typeof row.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(row.observedAt)) ||
    !pinned ||
    typeof pinned.instanceId !== 'string' ||
    typeof pinned.image !== 'string' ||
    !Array.isArray(row.checks) ||
    !row.checks.every(isCheck)
  ) {
    return null;
  }
  return {
    schemaVersion: WORKSPACE_HOST_SOAK_SCHEMA_VERSION,
    soakId: row.soakId,
    sequence: row.sequence as number,
    observedAt: row.observedAt,
    pinned: { instanceId: pinned.instanceId, image: pinned.image },
    checks: row.checks.map((check) => ({ ...check })),
  };
}

export type WorkspaceHostSoakVerdict = 'pass' | 'fail' | 'running';

export interface WorkspaceHostSoakEvaluation {
  verdict: WorkspaceHostSoakVerdict;
  soakId: string | null;
  samples: number;
  measuredSamples: number;
  expectedSamples: number;
  window: { first: string | null; last: string | null; spanMs: number };
  maxGapMs: number;
  failures: Record<WorkspaceHostSoakCheckName, number>;
  maxConsecutiveReachFailures: number;
  reachFailureRate: number;
  /** Why the verdict is `fail`, or why a `running` soak cannot conclude yet. */
  reasons: string[];
}

export interface EvaluateWorkspaceHostSoakInput {
  samples: readonly WorkspaceHostSoakSample[];
  policy: WorkspaceHostSoakPolicy;
  /**
   * The sampler has stopped (finished, failed early, or was cancelled). A soak that has ended
   * without its window covering the duration is a failure, never a soak still `running`.
   */
  ended?: boolean;
}

/**
 * The single rule that decides a soak. Pure: same samples + policy, same verdict, for the workflow
 * settling the stage and for any later reader auditing it.
 */
export function evaluateWorkspaceHostSoak(input: EvaluateWorkspaceHostSoakInput): WorkspaceHostSoakEvaluation {
  const { policy } = input;
  const bySequence = new Map<number, WorkspaceHostSoakSample>();
  for (const sample of input.samples) {
    if (!bySequence.has(sample.sequence)) bySequence.set(sample.sequence, sample);
  }
  const samples = [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  const soakIds = new Set(samples.map((sample) => sample.soakId));
  const failures = Object.fromEntries(WORKSPACE_HOST_SOAK_CHECKS.map((name) => [name, 0])) as Record<
    WorkspaceHostSoakCheckName,
    number
  >;
  const reasons: string[] = [];
  const firstFailure = new Map<WorkspaceHostSoakCheckName, string>();

  let measuredSamples = 0;
  let reachMeasured = 0;
  let consecutiveReach = 0;
  let maxConsecutiveReach = 0;
  let maxGapMs = 0;
  let previousAt: number | null = null;

  for (const sample of samples) {
    for (const name of WORKSPACE_HOST_SOAK_CHECKS) {
      const check = checkOf(sample, name);
      if (check?.ok === false) {
        failures[name] += 1;
        if (!firstFailure.has(name)) {
          firstFailure.set(name, `sample ${sample.sequence} at ${sample.observedAt}: ${check.detail ?? 'failed'}`);
        }
      }
    }
    if (WORKSPACE_HOST_SOAK_STRICT_CHECKS.every((name) => typeof checkOf(sample, name)?.ok === 'boolean')) {
      measuredSamples += 1;
    }
    const reach = checkOf(sample, 'controller-reach');
    if (typeof reach?.ok === 'boolean') {
      reachMeasured += 1;
      consecutiveReach = reach.ok ? 0 : consecutiveReach + 1;
      maxConsecutiveReach = Math.max(maxConsecutiveReach, consecutiveReach);
    }
    const at = Date.parse(sample.observedAt);
    if (previousAt !== null) maxGapMs = Math.max(maxGapMs, at - previousAt);
    previousAt = at;
  }

  const first = samples[0]?.observedAt ?? null;
  const last = samples.at(-1)?.observedAt ?? null;
  const spanMs = first && last ? Date.parse(last) - Date.parse(first) : 0;
  const expectedSamples = Math.floor(policy.durationMs / policy.intervalMs) + 1;
  const reachFailureRate = reachMeasured === 0 ? 0 : failures['controller-reach'] / reachMeasured;

  if (soakIds.size > 1) reasons.push(`samples from ${soakIds.size} different soaks were mixed`);
  for (const name of WORKSPACE_HOST_SOAK_STRICT_CHECKS) {
    if (failures[name] > 0) reasons.push(`${name} failed ${failures[name]}x, first ${firstFailure.get(name)}`);
  }
  if (maxConsecutiveReach > policy.maxConsecutiveReachFailures) {
    reasons.push(
      `controller-reach failed on ${maxConsecutiveReach} consecutive samples ` +
        `(max ${policy.maxConsecutiveReachFailures}), first ${firstFailure.get('controller-reach')}`,
    );
  }
  const maxGapAllowedMs = policy.maxGapIntervals * policy.intervalMs;
  if (maxGapMs > maxGapAllowedMs) {
    reasons.push(`largest gap between samples was ${maxGapMs}ms (max ${maxGapAllowedMs}ms)`);
  }

  const windowCovered = samples.length > 0 && spanMs >= policy.durationMs;
  if (windowCovered || input.ended) {
    if (!windowCovered) {
      reasons.push(`sampling ended after ${spanMs}ms, before the ${policy.durationMs}ms window was covered`);
    }
    const requiredMeasured = Math.ceil(expectedSamples * policy.minSampleCoverage);
    if (measuredSamples < requiredMeasured) {
      reasons.push(`only ${measuredSamples} fully-measured samples (need ${requiredMeasured} of ${expectedSamples})`);
    }
    if (reachFailureRate > policy.maxReachFailureRate) {
      reasons.push(
        `controller-reach failed on ${(reachFailureRate * 100).toFixed(2)}% of samples ` +
          `(max ${(policy.maxReachFailureRate * 100).toFixed(2)}%)`,
      );
    }
  }

  const verdict: WorkspaceHostSoakVerdict =
    reasons.length > 0 ? 'fail' : windowCovered ? 'pass' : 'running';
  if (verdict === 'running') {
    reasons.push(`window covers ${spanMs}ms of ${policy.durationMs}ms`);
  }
  return {
    verdict,
    soakId: soakIds.size === 1 ? [...soakIds][0]! : null,
    samples: samples.length,
    measuredSamples,
    expectedSamples,
    window: { first, last, spanMs },
    maxGapMs,
    failures,
    maxConsecutiveReachFailures: maxConsecutiveReach,
    reachFailureRate,
    reasons,
  };
}

/**
 * Whether sampling can stop early: a strict failure or an over-long reach outage already decides
 * the verdict, and waiting out the rest of the window would only delay reporting it.
 */
export function workspaceHostSoakDecidedEarly(
  samples: readonly WorkspaceHostSoakSample[],
  policy: WorkspaceHostSoakPolicy,
): boolean {
  return evaluateWorkspaceHostSoak({ samples, policy }).verdict === 'fail';
}
