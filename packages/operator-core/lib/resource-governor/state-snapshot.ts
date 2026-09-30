/** Canonical, bounded state snapshot for the capless resource governor. */

import type { CaplessControllerDecision } from './controller';
import type { HealthResource, HealthVerdict } from './health-analysis';
import { readSharedSnapshot, writeSharedSnapshot } from '../derived-reads/shared-snapshot';
import type { EmitAwaitedEventOpts } from '../events/await/engine';

export const GOVERNOR_STATE_SNAPSHOT_KEY = 'resource-governor.state';
export const GOVERNOR_STATE_SNAPSHOT_VERSION = 2;
export const GOVERNOR_STATE_MAX_CLASSES = 24;
export const GOVERNOR_STATE_MAX_RESOURCES = 16;
export const GOVERNOR_STATE_MAX_AGE_MS = 120_000;
export const GOVERNOR_BACKLOG_DEFAULT_SERVICE_OBJECTIVE_MS = 60_000;
export const GOVERNOR_TRANSITION_HYSTERESIS_SAMPLES = 2;

export type GovernorTransitionKind =
  | 'admission-constrained'
  | 'backlog-unhealthy'
  | 'constraint-added'
  | 'recovery-probing'
  | 'queue-healthy'
  | 'telemetry-stale';

export interface GovernorTransitionState {
  readonly admissionConstrained: boolean;
  readonly backlogUnhealthy: boolean;
  readonly backlogUnhealthySamples: number;
  readonly healthy: boolean;
  readonly healthySamples: number;
  readonly recoveryProbing: boolean;
  readonly telemetryStale: boolean;
}

export type GovernorTrend = 'falling' | 'stable' | 'rising' | 'unknown';

export interface GovernorQueueClassObservation {
  readonly admissionClass: string;
  readonly depth: number;
  readonly oldestAgeMs?: number;
  readonly arrivals?: number;
  readonly drained?: number;
  readonly observedWindowMs?: number;
}

export interface GovernorRecoveryObservation {
  readonly state: 'stable' | 'recovering' | 'stalled' | 'probing';
  readonly completed: number;
  readonly total: number;
  readonly nextProbeAtMs?: number;
  readonly evidenceRef?: string;
  readonly confidence: number;
}

export interface GovernorStateObservation {
  readonly observedAtMs: number;
  readonly validUntilMs: number;
  readonly evidenceRef?: string;
  readonly health?: HealthVerdict;
  readonly admission?: CaplessControllerDecision;
  /** Complete queue population. Bounded shaping happens only after totals. */
  readonly queueByClass?: readonly GovernorQueueClassObservation[];
  readonly recovery?: GovernorRecoveryObservation;
  /** Age at which queued work has missed this sample's service objective. */
  readonly queueServiceObjectiveMs?: number;
}

export interface GovernorStateSnapshot {
  readonly schemaVersion: typeof GOVERNOR_STATE_SNAPSHOT_VERSION;
  readonly generation: number | null;
  readonly observedAtMs: number;
  readonly validUntilMs: number;
  readonly evidenceRef: string | null;
  readonly confidence: number | null;
  readonly freshness: { readonly stale: false; readonly observedAtMs: number; readonly validUntilMs: number };
  readonly unknown: readonly string[];
  readonly assessments: {
    readonly health: 'healthy' | 'degraded' | 'unknown';
    readonly admission: 'open' | 'constrained' | 'paused' | 'unknown';
    readonly queue: 'empty' | 'draining' | 'growing' | 'unknown';
    readonly resources: 'unconstrained' | 'constrained' | 'unknown';
    readonly recovery: 'stable' | 'recovering' | 'stalled' | 'unknown';
  };
  readonly health: {
    readonly state: string | null;
    readonly severity: string | null;
    readonly actionable: boolean | null;
    readonly confidence: number | null;
    readonly evidenceRef: string | null;
  };
  readonly admission: {
    readonly state: 'open' | 'constrained' | 'paused' | null;
    readonly reason: string | null;
    readonly generation: number | null;
    readonly constrainedClasses: readonly string[];
    readonly nextProbeAtMs: number | null;
    readonly confidence: number | null;
  };
  readonly queue: {
    readonly depth: number | null;
    readonly oldestAgeMs: number | null;
    readonly arrivalRatePerSec: number | null;
    readonly drainRatePerSec: number | null;
    readonly trend: GovernorTrend;
    readonly byClass: readonly {
      admissionClass: string;
      depth: number | null;
      oldestAgeMs: number | null;
      arrivalRatePerSec: number | null;
      drainRatePerSec: number | null;
    }[];
    readonly populationClasses: number | null;
    readonly truncated: boolean;
  };
  readonly resources: {
    readonly constrained: readonly HealthResource[];
    readonly byResource: readonly {
      resource: HealthResource;
      classes: readonly string[];
      confidence: number;
    }[];
    readonly truncated: boolean;
  };
  readonly recovery: {
    readonly state: GovernorRecoveryObservation['state'] | null;
    readonly completed: number | null;
    readonly total: number | null;
    readonly progress: number | null;
    readonly nextProbeAtMs: number | null;
    readonly evidenceRef: string | null;
    readonly confidence: number | null;
  };
  /** Persistent edge/hysteresis memory. It is bounded and contains no request rows. */
  readonly transitions: GovernorTransitionState;
}

export interface GovernorOrientSummary {
  readonly generation: number | null;
  readonly observedAtMs: number;
  readonly validUntilMs: number;
  readonly stale: boolean;
  readonly evidenceRef: string | null;
  readonly confidence: number | null;
  readonly assessments: GovernorStateSnapshot['assessments'];
  readonly queue: Pick<GovernorStateSnapshot['queue'], 'depth' | 'oldestAgeMs' | 'trend'>;
  readonly constrainedClasses: readonly string[];
  readonly constrainedResources: readonly HealthResource[];
  readonly nextProbeAtMs: number | null;
  readonly action: string;
  readonly unknown: readonly string[];
}

function finiteNonNegative(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function rate(count: number | undefined, windowMs: number | undefined): number | null {
  const c = finiteNonNegative(count);
  const w = finiteNonNegative(windowMs);
  return c === null || w === null || w <= 0 ? null : c / (w / 1_000);
}

function completeSum(values: readonly (number | undefined)[]): number | null {
  const measured = values.map((value) => finiteNonNegative(value));
  return measured.some((value) => value === null)
    ? null
    : (measured as number[]).reduce((sum, value) => sum + value, 0);
}

function minConfidence(values: readonly (number | undefined)[]): number | null {
  const measured = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return measured.length === 0 ? null : Math.max(0, Math.min(1, Math.min(...measured)));
}

export function buildGovernorStateSnapshot(
  input: GovernorStateObservation,
  transitions?: GovernorTransitionState,
): GovernorStateSnapshot {
  if (!Number.isFinite(input.observedAtMs) || !Number.isFinite(input.validUntilMs)) {
    throw new Error('governor state timestamps must be finite');
  }
  if (input.validUntilMs < input.observedAtMs) throw new Error('governor state validity cannot precede observation');
  const unknown: string[] = [];
  if (!input.health) unknown.push('health');
  if (!input.admission) unknown.push('admission');
  if (!input.queueByClass) unknown.push('queue');
  if (!input.recovery) unknown.push('recovery');

  const population = input.queueByClass ?? [];
  const queueDepth = input.queueByClass ? completeSum(population.map((item) => item.depth)) : null;
  const oldestAgeMs = input.queueByClass
    ? population.reduce<number | null>((max, item) => {
        const value = finiteNonNegative(item.oldestAgeMs);
        return value === null ? max : max === null ? value : Math.max(max, value);
      }, null)
    : null;
  const arrivals = input.queueByClass ? completeSum(population.map((item) => item.arrivals)) : null;
  const drained = input.queueByClass ? completeSum(population.map((item) => item.drained)) : null;
  const windowValues = population.map((item) => finiteNonNegative(item.observedWindowMs));
  const windowMs =
    input.queueByClass && !windowValues.some((value) => value === null)
      ? Math.max(0, ...(windowValues as number[]))
      : null;
  const arrivalRatePerSec = arrivals === null || !windowMs ? null : arrivals / (windowMs / 1_000);
  const drainRatePerSec = drained === null || !windowMs ? null : drained / (windowMs / 1_000);
  const trend: GovernorTrend =
    arrivalRatePerSec === null || drainRatePerSec === null
      ? 'unknown'
      : arrivalRatePerSec > drainRatePerSec
        ? 'rising'
        : arrivalRatePerSec < drainRatePerSec
          ? 'falling'
          : 'stable';
  const byClass = [...population]
    .sort((a, b) => b.depth - a.depth || a.admissionClass.localeCompare(b.admissionClass))
    .slice(0, GOVERNOR_STATE_MAX_CLASSES)
    .map((item) => ({
      admissionClass: item.admissionClass,
      depth: finiteNonNegative(item.depth),
      oldestAgeMs: finiteNonNegative(item.oldestAgeMs),
      arrivalRatePerSec: rate(item.arrivals, item.observedWindowMs),
      drainRatePerSec: rate(item.drained, item.observedWindowMs),
    }));

  const classDecisions = input.admission?.classes ?? [];
  const pausedClasses = classDecisions
    .filter((item) => item.paused)
    .map((item) => item.admissionClass)
    .sort();
  const constrainedClasses = classDecisions
    .filter((item) => item.feedback.length > 0)
    .map((item) => item.admissionClass)
    .sort();
  const admissionState = !input.admission
    ? null
    : pausedClasses.length > 0
      ? ('paused' as const)
      : constrainedClasses.length > 0
        ? ('constrained' as const)
        : ('open' as const);
  const resourceMap = new Map<HealthResource, { classes: Set<string>; confidence: number }>();
  for (const item of classDecisions) {
    for (const feedback of item.feedback) {
      if (feedback.expiresAtMs <= input.observedAtMs) continue;
      const current = resourceMap.get(feedback.resource) ?? { classes: new Set(), confidence: 1 };
      current.classes.add(item.admissionClass);
      current.confidence = Math.min(current.confidence, feedback.confidence);
      resourceMap.set(feedback.resource, current);
    }
  }
  const allResources = [...resourceMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resource, value]) => ({
      resource,
      classes: [...value.classes].sort(),
      confidence: Math.max(0, Math.min(1, value.confidence)),
    }));

  const healthConfidence = input.health
    ? (minConfidence(input.health.evidence.filter((item) => item.breached).map((item) => item.confidence)) ?? 1)
    : null;
  const recoveryProgress = input.recovery
    ? input.recovery.total > 0
      ? Math.max(0, Math.min(1, input.recovery.completed / input.recovery.total))
      : input.recovery.completed === 0
        ? 1
        : null
    : null;
  const confidence = minConfidence([healthConfidence ?? undefined, input.recovery?.confidence]);
  if (input.queueByClass && queueDepth === null) unknown.push('queue.depth');
  if (input.queueByClass && arrivalRatePerSec === null) unknown.push('queue.arrivalRatePerSec');
  if (input.queueByClass && drainRatePerSec === null) unknown.push('queue.drainRatePerSec');

  return Object.freeze({
    schemaVersion: GOVERNOR_STATE_SNAPSHOT_VERSION,
    generation: input.admission?.generation ?? null,
    observedAtMs: input.observedAtMs,
    validUntilMs: input.validUntilMs,
    evidenceRef: input.evidenceRef ?? null,
    confidence,
    freshness: Object.freeze({ stale: false, observedAtMs: input.observedAtMs, validUntilMs: input.validUntilMs }),
    unknown: Object.freeze([...new Set(unknown)].sort()),
    assessments: Object.freeze({
      health: !input.health ? 'unknown' : input.health.state === 'healthy' ? 'healthy' : 'degraded',
      admission: admissionState ?? 'unknown',
      queue: queueDepth === null ? 'unknown' : queueDepth === 0 ? 'empty' : trend === 'rising' ? 'growing' : 'draining',
      resources: !input.admission ? 'unknown' : allResources.length > 0 ? 'constrained' : 'unconstrained',
      recovery: !input.recovery
        ? 'unknown'
        : input.recovery.state === 'stalled'
          ? 'stalled'
          : input.recovery.state === 'stable'
            ? 'stable'
            : 'recovering',
    }),
    health: Object.freeze({
      state: input.health?.state ?? null,
      severity: input.health?.severity ?? null,
      actionable: input.health?.actionable ?? null,
      confidence: healthConfidence,
      evidenceRef: input.evidenceRef ?? null,
    }),
    admission: Object.freeze({
      state: admissionState,
      reason: input.admission?.reasons.join('; ') ?? null,
      generation: input.admission?.generation ?? null,
      constrainedClasses: Object.freeze([...new Set([...pausedClasses, ...constrainedClasses])].sort()),
      nextProbeAtMs: classDecisions.reduce<number | null>((next, item) => {
        const candidate = item.pauseUntilMs;
        return candidate === null ? next : next === null ? candidate : Math.min(next, candidate);
      }, null),
      confidence,
    }),
    queue: Object.freeze({
      depth: queueDepth,
      oldestAgeMs,
      arrivalRatePerSec,
      drainRatePerSec,
      trend,
      byClass: Object.freeze(byClass),
      populationClasses: input.queueByClass ? population.length : null,
      truncated: population.length > GOVERNOR_STATE_MAX_CLASSES,
    }),
    resources: Object.freeze({
      constrained: Object.freeze(allResources.map((item) => item.resource).slice(0, GOVERNOR_STATE_MAX_RESOURCES)),
      byResource: Object.freeze(allResources.slice(0, GOVERNOR_STATE_MAX_RESOURCES)),
      truncated: allResources.length > GOVERNOR_STATE_MAX_RESOURCES,
    }),
    recovery: Object.freeze({
      state: input.recovery?.state ?? null,
      completed: input.recovery ? finiteNonNegative(input.recovery.completed) : null,
      total: input.recovery ? finiteNonNegative(input.recovery.total) : null,
      progress: recoveryProgress,
      nextProbeAtMs: input.recovery ? finiteNonNegative(input.recovery.nextProbeAtMs) : null,
      evidenceRef: input.recovery?.evidenceRef ?? input.evidenceRef ?? null,
      confidence: input.recovery ? Math.max(0, Math.min(1, input.recovery.confidence)) : null,
    }),
    transitions: Object.freeze(
      transitions ?? {
        admissionConstrained: false,
        backlogUnhealthy: false,
        backlogUnhealthySamples: 0,
        healthy: false,
        healthySamples: 0,
        recoveryProbing: false,
        telemetryStale: false,
      },
    ),
  });
}

function transitionEventKey(kind: GovernorTransitionKind): string {
  return `governor:transition:${kind}`;
}

function actionFor(snapshot: GovernorStateSnapshot, stale: boolean): string {
  if (stale) return 'refresh governor telemetry before changing admission';
  if (snapshot.assessments.admission === 'paused') return 'wait for the next probe or a recovery signal';
  if (snapshot.assessments.admission === 'constrained') return 'queue work durably; do not reject accepted work';
  if (snapshot.transitions.backlogUnhealthy)
    return 'increase healthy drain capacity and inspect the oldest service-objective breach';
  if (snapshot.assessments.recovery === 'recovering') return 'continue bounded recovery probes';
  return 'continue normal admission';
}

export function buildGovernorOrientSummary(snapshot: GovernorStateSnapshot, nowMs = Date.now()): GovernorOrientSummary {
  const stale = nowMs > snapshot.validUntilMs;
  return Object.freeze({
    generation: snapshot.generation,
    observedAtMs: snapshot.observedAtMs,
    validUntilMs: snapshot.validUntilMs,
    stale,
    evidenceRef: snapshot.evidenceRef,
    confidence: snapshot.confidence,
    assessments: snapshot.assessments,
    queue: Object.freeze({
      depth: snapshot.queue.depth,
      oldestAgeMs: snapshot.queue.oldestAgeMs,
      trend: snapshot.queue.trend,
    }),
    constrainedClasses: snapshot.admission.constrainedClasses,
    constrainedResources: snapshot.resources.constrained,
    nextProbeAtMs: snapshot.admission.nextProbeAtMs ?? snapshot.recovery.nextProbeAtMs,
    action: actionFor(snapshot, stale),
    unknown: snapshot.unknown,
  });
}

export function evaluateGovernorTransitions(
  next: GovernorStateSnapshot,
  previous: GovernorStateSnapshot | null,
  serviceObjectiveMs = GOVERNOR_BACKLOG_DEFAULT_SERVICE_OBJECTIVE_MS,
): {
  state: GovernorTransitionState;
  fired: GovernorTransitionKind[];
  addedClasses: string[];
  addedResources: HealthResource[];
} {
  const prior = previous?.transitions;
  const admissionConstrained = next.assessments.admission === 'constrained' || next.assessments.admission === 'paused';
  const backlogCandidate =
    next.queue.oldestAgeMs !== null &&
    next.queue.oldestAgeMs >= serviceObjectiveMs &&
    next.queue.trend === 'rising' &&
    next.queue.arrivalRatePerSec !== null &&
    next.queue.drainRatePerSec !== null &&
    next.queue.arrivalRatePerSec > next.queue.drainRatePerSec;
  const backlogUnhealthySamples = backlogCandidate ? (prior?.backlogUnhealthySamples ?? 0) + 1 : 0;
  const backlogUnhealthy = backlogUnhealthySamples >= GOVERNOR_TRANSITION_HYSTERESIS_SAMPLES;
  const healthyCandidate =
    next.assessments.health === 'healthy' &&
    next.assessments.admission === 'open' &&
    next.assessments.queue === 'empty' &&
    next.assessments.resources === 'unconstrained';
  const healthySamples = healthyCandidate ? (prior?.healthySamples ?? 0) + 1 : 0;
  const healthy = healthySamples >= GOVERNOR_TRANSITION_HYSTERESIS_SAMPLES;
  const recoveryProbing = next.recovery.state === 'probing';
  const priorClasses = new Set(previous?.admission.constrainedClasses ?? []);
  const priorResources = new Set(previous?.resources.constrained ?? []);
  const addedClasses = next.admission.constrainedClasses.filter((value) => !priorClasses.has(value));
  const addedResources = next.resources.constrained.filter((value) => !priorResources.has(value));
  const state: GovernorTransitionState = {
    admissionConstrained,
    backlogUnhealthy,
    backlogUnhealthySamples,
    healthy,
    healthySamples,
    recoveryProbing,
    telemetryStale: false,
  };
  const fired: GovernorTransitionKind[] = [];
  if (admissionConstrained && !prior?.admissionConstrained) fired.push('admission-constrained');
  if (backlogUnhealthy && !prior?.backlogUnhealthy) fired.push('backlog-unhealthy');
  if (addedClasses.length > 0 || addedResources.length > 0) fired.push('constraint-added');
  if (recoveryProbing && !prior?.recoveryProbing) fired.push('recovery-probing');
  if (healthy && !prior?.healthy) fired.push('queue-healthy');
  return { state, fired, addedClasses, addedResources };
}

export class GovernorStateSnapshotWriter {
  constructor(
    private readonly workspaceId: string,
    private readonly write: typeof writeSharedSnapshot = writeSharedSnapshot,
    private readonly read: typeof readGovernorStateSnapshot = readGovernorStateSnapshot,
    private readonly emit: (opts: EmitAwaitedEventOpts) => Promise<unknown> = async (opts) =>
      (await import('../events/await/engine')).emitAwaitedEvent(opts),
  ) {}

  async publish(input: GovernorStateObservation): Promise<GovernorStateSnapshot> {
    const previous = (await this.read(this.workspaceId, Number.POSITIVE_INFINITY))?.payload ?? null;
    const candidate = buildGovernorStateSnapshot(input);
    const evaluated = evaluateGovernorTransitions(candidate, previous, input.queueServiceObjectiveMs);
    const snapshot = buildGovernorStateSnapshot(input, evaluated.state);
    await this.write(GOVERNOR_STATE_SNAPSHOT_KEY, this.workspaceId, snapshot, GOVERNOR_STATE_SNAPSHOT_VERSION);
    const summary = buildGovernorOrientSummary(snapshot, input.observedAtMs);
    for (const kind of evaluated.fired) {
      await this.emit({
        key: transitionEventKey(kind),
        workspaceId: this.workspaceId,
        source: 'resource-governor',
        summary: `resource governor transitioned: ${kind}`,
        payload: {
          kind,
          generation: snapshot.generation,
          evidenceRef: snapshot.evidenceRef,
          trend: snapshot.queue.trend,
          constrainedClasses: snapshot.admission.constrainedClasses,
          constrainedResources: snapshot.resources.constrained,
          addedClasses: evaluated.addedClasses,
          addedResources: evaluated.addedResources,
          action: summary.action,
        },
      });
    }
    return snapshot;
  }

  /** Periodic stale-telemetry edge check. The latch fires once until a fresh publish resets it. */
  async checkStaleness(nowMs = Date.now()): Promise<boolean> {
    const current = (await this.read(this.workspaceId, Number.POSITIVE_INFINITY))?.payload ?? null;
    if (!current || nowMs <= current.validUntilMs || current.transitions.telemetryStale) return false;
    const snapshot: GovernorStateSnapshot = Object.freeze({
      ...current,
      transitions: Object.freeze({ ...current.transitions, telemetryStale: true }),
    });
    await this.write(GOVERNOR_STATE_SNAPSHOT_KEY, this.workspaceId, snapshot, GOVERNOR_STATE_SNAPSHOT_VERSION);
    const summary = buildGovernorOrientSummary(snapshot, nowMs);
    await this.emit({
      key: transitionEventKey('telemetry-stale'),
      workspaceId: this.workspaceId,
      source: 'resource-governor',
      summary: 'resource governor telemetry became stale',
      payload: {
        kind: 'telemetry-stale',
        generation: snapshot.generation,
        evidenceRef: snapshot.evidenceRef,
        observedAtMs: snapshot.observedAtMs,
        validUntilMs: snapshot.validUntilMs,
        action: summary.action,
      },
    });
    return true;
  }
}

export async function readGovernorStateSnapshot(workspaceId: string, maxAgeMs = GOVERNOR_STATE_MAX_AGE_MS) {
  return readSharedSnapshot<GovernorStateSnapshot>(
    GOVERNOR_STATE_SNAPSHOT_KEY,
    workspaceId,
    GOVERNOR_STATE_SNAPSHOT_VERSION,
    maxAgeMs,
  );
}
