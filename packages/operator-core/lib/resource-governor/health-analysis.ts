/**
 * Rolling healthy baselines and causal degradation analysis for the capless
 * resource governor.
 *
 * P-004 deliberately publishes observations without a verdict. This module is
 * the decision boundary: it evaluates service outcomes against healthy history
 * and only marks a contraction actionable when fresh, confident evidence ties
 * that outcome to a pressure signal. Raw occupancy/utilisation is retained as
 * context, but can never become a capacity ceiling by appearing in a snapshot.
 */

import {
  LIVE_HEALTH_SIGNAL_KEYS,
  LIVE_HEALTH_SIGNAL_SPECS,
  clampLiveHealthConfidence,
  type LiveHealthReading,
  type LiveHealthSignalKey,
  type LiveHealthSnapshot,
  type LiveHealthWriterKind,
} from './live-health';

export const HEALTH_ANALYSIS_SCHEMA_VERSION = 'resource-governor-health-analysis-v1' as const;

export type HealthResource = 'cpu' | 'memory' | 'database' | 'service' | 'provider' | 'queue' | 'governor';
export type HealthVerdictState = 'warming' | 'healthy' | 'degraded' | 'unknown';
export type HealthSeverity = 'none' | 'warning' | 'critical';
export type EvidenceQuality = 'actionable' | 'low-confidence' | 'warming' | 'stale' | 'unknown';

/** Signals that are useful context but are never a service objective or cause. */
export const NON_CAUSAL_CAPACITY_SIGNALS = Object.freeze([
  'cpu.hostUtilizationPct',
  'cpu.processUtilizationPct',
  'scheduler.runnableCount',
  'memory.hostUsedBytes',
  'memory.workingSetBytes',
  'memory.swapUsedBytes',
  'database.activeConnections',
  'descriptor.openCount',
  'socket.closeWaitCount',
  'disk.freeBytes',
  'disk.readBytesPerSec',
  'disk.writeBytesPerSec',
  'network.rxBytesPerSec',
  'network.txBytesPerSec',
  'queue.oldestAgeMs',
  'queue.arrivalRate',
] as const satisfies readonly LiveHealthSignalKey[]);

export interface HealthAnalysisFrame {
  readonly scopeId: string;
  readonly atMs: number;
  readonly signals: Readonly<Partial<Record<LiveHealthSignalKey, LiveHealthReading>>>;
}

export interface LiveHealthFrameSelector {
  readonly scopeId: string;
  readonly writerIds?: ReadonlySet<string>;
  readonly writerKinds?: ReadonlySet<LiveHealthWriterKind>;
  /** Use the compact newest-per-key view when no scoped observation matches. */
  readonly fallbackToCompactSignals?: boolean;
}

/**
 * Select one newest observation per signal without discarding the writer-scoped
 * source snapshot. Callers should pass writer ids/kinds when analyzing a lane.
 */
export function liveHealthFrameFromSnapshot(
  snapshot: LiveHealthSnapshot,
  selector: LiveHealthFrameSelector,
): HealthAnalysisFrame {
  const signals: Partial<Record<LiveHealthSignalKey, LiveHealthReading>> = {};
  for (const key of LIVE_HEALTH_SIGNAL_KEYS) {
    const candidates = Object.values(snapshot.observations[key])
      .filter((reading) => {
        if (selector.writerIds && !selector.writerIds.has(reading.writerId)) return false;
        const writer = snapshot.writers[reading.writerId];
        return !selector.writerKinds || (writer !== undefined && selector.writerKinds.has(writer.kind));
      })
      .sort((a, b) => b.observedAtMs - a.observedAtMs || b.confidence - a.confidence);
    const selected = candidates[0];
    if (selected) signals[key] = selected;
    else if (selector.fallbackToCompactSignals === true) signals[key] = snapshot.signals[key];
  }
  return Object.freeze({ scopeId: selector.scopeId, atMs: snapshot.sampledAtMs, signals: Object.freeze(signals) });
}

export interface ServiceObjective {
  readonly id: string;
  readonly signal: LiveHealthSignalKey;
  readonly resource: HealthResource;
  /** Numeric warning boundary = max(baseline * ratio, baseline + delta). */
  readonly warningRatio: number;
  readonly criticalRatio: number;
  readonly minimumAbsoluteIncrease: number;
  /** Boolean objectives breach when true; numeric objectives ignore this. */
  readonly failureWhenTrue?: boolean;
  readonly description: string;
}

export const DEFAULT_SERVICE_OBJECTIVES = Object.freeze([
  {
    id: 'operator-heartbeat-progress',
    signal: 'progress.heartbeatLagMs',
    resource: 'service',
    warningRatio: 3,
    criticalRatio: 8,
    minimumAbsoluteIncrease: 100,
    description: 'Operator progress must not fall materially behind its rolling healthy cadence.',
  },
  {
    id: 'operator-event-loop-latency',
    signal: 'latency.eventLoopP95Ms',
    resource: 'service',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 15,
    description: 'Event-loop p95 must remain close to its rolling healthy latency.',
  },
  {
    id: 'memory-full-stall',
    signal: 'memory.psiFullPct',
    resource: 'memory',
    warningRatio: 3,
    criticalRatio: 8,
    minimumAbsoluteIncrease: 0.5,
    description: 'Whole-system memory reclaim stalls must not inflate above healthy history.',
  },
  {
    id: 'memory-gc-pause',
    signal: 'memory.gcPauseP95Ms',
    resource: 'memory',
    warningRatio: 3,
    criticalRatio: 8,
    minimumAbsoluteIncrease: 10,
    description: 'GC pause p95 must remain close to its rolling healthy behavior.',
  },
  {
    id: 'memory-major-fault-thrash',
    signal: 'memory.majorFaultsPerSec',
    resource: 'memory',
    warningRatio: 4,
    criticalRatio: 12,
    minimumAbsoluteIncrease: 5,
    description: 'Major page faults must not accelerate materially above healthy history.',
  },
  {
    id: 'memory-swap-in-thrash',
    signal: 'memory.swapInBytesPerSec',
    resource: 'memory',
    warningRatio: 4,
    criticalRatio: 12,
    minimumAbsoluteIncrease: 512 * 1024,
    description: 'Swap-in traffic is degradation only when it accelerates and is corroborated by memory pressure.',
  },
  {
    id: 'memory-swap-out-thrash',
    signal: 'memory.swapOutBytesPerSec',
    resource: 'memory',
    warningRatio: 4,
    criticalRatio: 12,
    minimumAbsoluteIncrease: 512 * 1024,
    description: 'Swap-out traffic is degradation only when it accelerates and is corroborated by memory pressure.',
  },
  {
    id: 'database-wait-latency',
    signal: 'database.waitP95Ms',
    resource: 'database',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 25,
    description: 'Database wait p95 must remain close to the healthy service baseline.',
  },
  {
    id: 'service-wait-latency',
    signal: 'service.waitP95Ms',
    resource: 'service',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 25,
    description: 'Internal service wait p95 must remain close to the healthy baseline.',
  },
  {
    id: 'provider-wait-latency',
    signal: 'provider.waitP95Ms',
    resource: 'provider',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 100,
    description: 'Provider/account wait p95 must remain close to the healthy routed baseline.',
  },
  {
    id: 'provider-rate-limit',
    signal: 'provider.rateLimited',
    resource: 'provider',
    warningRatio: 1,
    criticalRatio: 1,
    minimumAbsoluteIncrease: 0,
    failureWhenTrue: true,
    description: 'An explicit provider rate-limit result is a direct provider-lane failure signal.',
  },
  {
    id: 'queue-writer-latency',
    signal: 'queue.writerLatencyP95Ms',
    resource: 'queue',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 25,
    description: 'Durable receipt persistence latency must remain close to healthy history.',
  },
  {
    id: 'queue-writer-failures',
    signal: 'queue.writerFailureRate',
    resource: 'queue',
    warningRatio: 3,
    criticalRatio: 8,
    minimumAbsoluteIncrease: 0.5,
    description: 'Durable queue write failures must not rise above healthy history.',
  },
  {
    id: 'governor-admission-latency',
    signal: 'governor.admissionLatencyP95Ms',
    resource: 'governor',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 25,
    description: 'Governor admission latency must remain close to healthy history.',
  },
  {
    id: 'governor-decision-latency',
    signal: 'governor.decisionLatencyP95Ms',
    resource: 'governor',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 25,
    description: 'Governor decision latency must remain close to healthy history.',
  },
  {
    id: 'governor-persist-latency',
    signal: 'governor.persistLatencyP95Ms',
    resource: 'governor',
    warningRatio: 2,
    criticalRatio: 5,
    minimumAbsoluteIncrease: 25,
    description: 'Governor persistence latency must remain close to healthy history.',
  },
] as const satisfies readonly ServiceObjective[]);

export interface HealthyBaseline {
  readonly signal: LiveHealthSignalKey;
  readonly sampleCount: number;
  readonly ready: boolean;
  readonly median: number;
  readonly medianAbsoluteDeviation: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export interface RollingHealthyBaselineOptions {
  readonly maxSamples?: number;
  readonly maxAgeMs?: number;
  readonly minimumSamples?: number;
  readonly minimumConfidence?: number;
}

interface BaselineSample {
  readonly atMs: number;
  readonly value: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/** Sample-count and age bounded; only explicitly healthy, trustworthy frames enter. */
export class RollingHealthyBaselineStore {
  readonly maxSamples: number;
  readonly maxAgeMs: number;
  readonly minimumSamples: number;
  readonly minimumConfidence: number;
  readonly #samples = new Map<string, BaselineSample[]>();

  constructor(options: RollingHealthyBaselineOptions = {}) {
    this.maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 60));
    this.maxAgeMs = Math.max(1, options.maxAgeMs ?? 15 * 60_000);
    this.minimumSamples = Math.max(1, Math.floor(options.minimumSamples ?? 4));
    this.minimumConfidence = clampLiveHealthConfidence(options.minimumConfidence ?? 0.7);
  }

  #key(scopeId: string, signal: LiveHealthSignalKey): string {
    return `${scopeId}\u0000${signal}`;
  }

  recordHealthy(frame: HealthAnalysisFrame): void {
    for (const [rawSignal, reading] of Object.entries(frame.signals)) {
      const signal = rawSignal as LiveHealthSignalKey;
      if (
        !reading ||
        reading.state !== 'measured' ||
        typeof reading.value !== 'number' ||
        !Number.isFinite(reading.value) ||
        reading.confidence < this.minimumConfidence
      ) {
        continue;
      }
      const key = this.#key(frame.scopeId, signal);
      const cutoff = frame.atMs - this.maxAgeMs;
      const next = [...(this.#samples.get(key) ?? []), { atMs: frame.atMs, value: reading.value }]
        .filter((sample) => sample.atMs >= cutoff && sample.atMs <= frame.atMs)
        .slice(-this.maxSamples);
      this.#samples.set(key, next);
    }
  }

  get(scopeId: string, signal: LiveHealthSignalKey, atMs: number): HealthyBaseline | null {
    const key = this.#key(scopeId, signal);
    const cutoff = atMs - this.maxAgeMs;
    const samples = (this.#samples.get(key) ?? []).filter((sample) => sample.atMs >= cutoff && sample.atMs <= atMs);
    if (samples.length === 0) return null;
    if (samples.length !== this.#samples.get(key)?.length) this.#samples.set(key, samples);
    const center = median(samples.map((sample) => sample.value));
    const deviation = median(samples.map((sample) => Math.abs(sample.value - center)));
    return Object.freeze({
      signal,
      sampleCount: samples.length,
      ready: samples.length >= this.minimumSamples,
      median: center,
      medianAbsoluteDeviation: deviation,
      startedAtMs: samples[0]!.atMs,
      endedAtMs: samples.at(-1)!.atMs,
    });
  }

  clear(scopeId?: string): void {
    if (!scopeId) {
      this.#samples.clear();
      return;
    }
    const prefix = `${scopeId}\u0000`;
    for (const key of this.#samples.keys()) if (key.startsWith(prefix)) this.#samples.delete(key);
  }
}

export interface ObjectiveEvidence {
  readonly objectiveId: string;
  readonly signal: LiveHealthSignalKey;
  readonly resource: HealthResource;
  readonly readingState: LiveHealthReading['state'] | 'absent';
  readonly value: LiveHealthReading['value'] | null;
  readonly confidence: number;
  readonly baseline: HealthyBaseline | null;
  readonly warningBoundary: number | null;
  readonly criticalBoundary: number | null;
  readonly inflationRatio: number | null;
  readonly breached: boolean;
  readonly severity: HealthSeverity;
  readonly quality: EvidenceQuality;
  readonly reason: string;
}

export interface CausalAttribution {
  readonly objectiveId: string;
  readonly outcomeSignal: LiveHealthSignalKey;
  readonly causeSignal: LiveHealthSignalKey;
  readonly resource: HealthResource;
  readonly confidence: number;
  readonly correlation: number;
  readonly temporallyAligned: boolean;
  readonly actionable: boolean;
  readonly reason: string;
}

export interface HealthVerdict {
  readonly schemaVersion: typeof HEALTH_ANALYSIS_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly evaluatedAtMs: number;
  readonly state: HealthVerdictState;
  readonly severity: HealthSeverity;
  readonly actionable: boolean;
  readonly evidence: readonly ObjectiveEvidence[];
  readonly attributions: readonly CausalAttribution[];
  readonly actionableResources: readonly HealthResource[];
  readonly ignoredCapacitySignals: readonly LiveHealthSignalKey[];
  readonly reasons: readonly string[];
}

interface CausalRule {
  readonly resource: HealthResource;
  readonly causeSignal: LiveHealthSignalKey;
  readonly outcomes: readonly LiveHealthSignalKey[];
  readonly warningRatio: number;
  readonly minimumAbsoluteIncrease: number;
  readonly direct?: boolean;
  readonly corroboratingSignals?: readonly LiveHealthSignalKey[];
}

const PROGRESS_OUTCOMES = Object.freeze([
  'progress.heartbeatLagMs',
  'latency.eventLoopP95Ms',
  'governor.admissionLatencyP95Ms',
  'governor.decisionLatencyP95Ms',
] as const satisfies readonly LiveHealthSignalKey[]);

const CAUSAL_RULES: readonly CausalRule[] = Object.freeze([
  {
    resource: 'cpu',
    causeSignal: 'cpu.psiSomePct',
    outcomes: PROGRESS_OUTCOMES,
    warningRatio: 3,
    minimumAbsoluteIncrease: 1,
  },
  {
    resource: 'memory',
    causeSignal: 'memory.psiSomePct',
    outcomes: PROGRESS_OUTCOMES,
    warningRatio: 3,
    minimumAbsoluteIncrease: 1,
  },
  {
    resource: 'memory',
    causeSignal: 'memory.psiFullPct',
    outcomes: [...PROGRESS_OUTCOMES, 'memory.psiFullPct'],
    warningRatio: 3,
    minimumAbsoluteIncrease: 0.5,
    direct: true,
  },
  {
    resource: 'memory',
    causeSignal: 'memory.workingSetGrowthBytesPerSec',
    outcomes: [...PROGRESS_OUTCOMES, 'memory.gcPauseP95Ms', 'memory.majorFaultsPerSec'],
    warningRatio: 3,
    minimumAbsoluteIncrease: 1024 * 1024,
  },
  {
    resource: 'memory',
    causeSignal: 'memory.gcPauseP95Ms',
    outcomes: [...PROGRESS_OUTCOMES, 'memory.gcPauseP95Ms'],
    warningRatio: 3,
    minimumAbsoluteIncrease: 10,
    direct: true,
  },
  {
    resource: 'memory',
    causeSignal: 'memory.majorFaultsPerSec',
    outcomes: [...PROGRESS_OUTCOMES, 'memory.majorFaultsPerSec'],
    warningRatio: 4,
    minimumAbsoluteIncrease: 5,
    direct: true,
  },
  {
    resource: 'memory',
    causeSignal: 'memory.swapInBytesPerSec',
    outcomes: [...PROGRESS_OUTCOMES, 'memory.swapInBytesPerSec'],
    warningRatio: 4,
    minimumAbsoluteIncrease: 512 * 1024,
    direct: true,
    corroboratingSignals: ['memory.psiFullPct', 'memory.majorFaultsPerSec'],
  },
  {
    resource: 'memory',
    causeSignal: 'memory.swapOutBytesPerSec',
    outcomes: [...PROGRESS_OUTCOMES, 'memory.swapOutBytesPerSec'],
    warningRatio: 4,
    minimumAbsoluteIncrease: 512 * 1024,
    direct: true,
    corroboratingSignals: ['memory.psiFullPct', 'memory.majorFaultsPerSec'],
  },
  ...(
    [
      ['database', 'database.waitP95Ms'],
      ['service', 'service.waitP95Ms'],
      ['provider', 'provider.waitP95Ms'],
      ['provider', 'provider.rateLimited'],
      ['queue', 'queue.writerLatencyP95Ms'],
      ['queue', 'queue.writerFailureRate'],
      ['governor', 'governor.admissionLatencyP95Ms'],
      ['governor', 'governor.decisionLatencyP95Ms'],
      ['governor', 'governor.persistLatencyP95Ms'],
    ] as const
  ).map(([resource, signal]) => ({
    resource,
    causeSignal: signal,
    outcomes: [signal],
    warningRatio: 2,
    minimumAbsoluteIncrease: 0,
    direct: true,
  })),
] as const satisfies readonly CausalRule[]);

/** Corroborators keep their own units; a swap byte-rate delta cannot be reused for PSI. */
const PRESSURE_THRESHOLDS = Object.freeze({
  'cpu.psiSomePct': { warningRatio: 3, minimumAbsoluteIncrease: 1 },
  'memory.psiSomePct': { warningRatio: 3, minimumAbsoluteIncrease: 1 },
  'memory.psiFullPct': { warningRatio: 3, minimumAbsoluteIncrease: 0.5 },
  'memory.workingSetGrowthBytesPerSec': { warningRatio: 3, minimumAbsoluteIncrease: 1024 * 1024 },
  'memory.gcPauseP95Ms': { warningRatio: 3, minimumAbsoluteIncrease: 10 },
  'memory.majorFaultsPerSec': { warningRatio: 4, minimumAbsoluteIncrease: 5 },
  'memory.swapInBytesPerSec': { warningRatio: 4, minimumAbsoluteIncrease: 512 * 1024 },
  'memory.swapOutBytesPerSec': { warningRatio: 4, minimumAbsoluteIncrease: 512 * 1024 },
} as const satisfies Partial<
  Record<LiveHealthSignalKey, { readonly warningRatio: number; readonly minimumAbsoluteIncrease: number }>
>);

export interface RollingHealthAnalyzerOptions {
  readonly objectives?: readonly ServiceObjective[];
  readonly baseline?: RollingHealthyBaselineStore;
  readonly minimumEvidenceConfidence?: number;
  readonly minimumAttributionConfidence?: number;
  readonly causalWindowMs?: number;
  readonly historySamples?: number;
  /** Automatically add non-degraded trustworthy frames to healthy history. */
  readonly commitHealthyFrames?: boolean;
}

function boundary(center: number, ratio: number, minimumAbsoluteIncrease: number): number {
  const ratioBoundary = center > 0 ? center * ratio : center;
  return Math.max(ratioBoundary, center + minimumAbsoluteIncrease);
}

function pearson(pairs: readonly (readonly [number, number])[]): number {
  if (pairs.length < 3) return 0.5;
  const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let numerator = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    numerator += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }
  if (varianceX === 0 || varianceY === 0) return 0;
  return Math.max(0, Math.min(1, numerator / Math.sqrt(varianceX * varianceY)));
}

function highestSeverity(evidence: readonly ObjectiveEvidence[]): HealthSeverity {
  if (evidence.some((item) => item.severity === 'critical')) return 'critical';
  if (evidence.some((item) => item.severity === 'warning')) return 'warning';
  return 'none';
}

export class RollingHealthAnalyzer {
  readonly objectives: readonly ServiceObjective[];
  readonly baseline: RollingHealthyBaselineStore;
  readonly minimumEvidenceConfidence: number;
  readonly minimumAttributionConfidence: number;
  readonly causalWindowMs: number;
  readonly historySamples: number;
  readonly commitHealthyFrames: boolean;
  readonly #history = new Map<string, HealthAnalysisFrame[]>();

  constructor(options: RollingHealthAnalyzerOptions = {}) {
    this.objectives = Object.freeze([...(options.objectives ?? DEFAULT_SERVICE_OBJECTIVES)]);
    this.baseline = options.baseline ?? new RollingHealthyBaselineStore();
    this.minimumEvidenceConfidence = clampLiveHealthConfidence(options.minimumEvidenceConfidence ?? 0.7);
    this.minimumAttributionConfidence = clampLiveHealthConfidence(options.minimumAttributionConfidence ?? 0.65);
    this.causalWindowMs = Math.max(1, options.causalWindowMs ?? 30_000);
    this.historySamples = Math.max(3, Math.floor(options.historySamples ?? 20));
    this.commitHealthyFrames = options.commitHealthyFrames ?? true;
  }

  /** Seed only a frame the caller knows was healthy; useful after restart/cold start. */
  primeHealthy(frame: HealthAnalysisFrame): void {
    this.baseline.recordHealthy(frame);
    this.#appendHistory(frame);
  }

  #appendHistory(frame: HealthAnalysisFrame): void {
    const history = [...(this.#history.get(frame.scopeId) ?? []), frame].slice(-this.historySamples);
    this.#history.set(frame.scopeId, history);
  }

  #assessObjective(frame: HealthAnalysisFrame, objective: ServiceObjective): ObjectiveEvidence {
    const reading = frame.signals[objective.signal];
    const baseline = this.baseline.get(frame.scopeId, objective.signal, frame.atMs);
    if (!reading) {
      return Object.freeze({
        objectiveId: objective.id,
        signal: objective.signal,
        resource: objective.resource,
        readingState: 'absent',
        value: null,
        confidence: 0,
        baseline,
        warningBoundary: null,
        criticalBoundary: null,
        inflationRatio: null,
        breached: false,
        severity: 'none',
        quality: 'unknown',
        reason: 'signal-absent',
      });
    }
    if (reading.state !== 'measured' || reading.value === null) {
      return Object.freeze({
        objectiveId: objective.id,
        signal: objective.signal,
        resource: objective.resource,
        readingState: reading.state,
        value: null,
        confidence: reading.confidence,
        baseline,
        warningBoundary: null,
        criticalBoundary: null,
        inflationRatio: null,
        breached: false,
        severity: 'none',
        quality: reading.state === 'stale' ? 'stale' : 'unknown',
        reason: reading.reason ?? `signal-${reading.state}`,
      });
    }
    if (typeof reading.value === 'boolean') {
      const breached = objective.failureWhenTrue === true && reading.value;
      return Object.freeze({
        objectiveId: objective.id,
        signal: objective.signal,
        resource: objective.resource,
        readingState: reading.state,
        value: reading.value,
        confidence: reading.confidence,
        baseline,
        warningBoundary: null,
        criticalBoundary: null,
        inflationRatio: null,
        breached,
        severity: breached ? 'critical' : 'none',
        quality: reading.confidence >= this.minimumEvidenceConfidence ? 'actionable' : 'low-confidence',
        reason: breached ? 'explicit-failure-signal' : 'objective-satisfied',
      });
    }
    if (!baseline?.ready) {
      return Object.freeze({
        objectiveId: objective.id,
        signal: objective.signal,
        resource: objective.resource,
        readingState: reading.state,
        value: reading.value,
        confidence: reading.confidence,
        baseline,
        warningBoundary: null,
        criticalBoundary: null,
        inflationRatio: null,
        breached: false,
        severity: 'none',
        quality: 'warming',
        reason: `healthy-baseline-warming:${baseline?.sampleCount ?? 0}/${this.baseline.minimumSamples}`,
      });
    }
    const warningBoundary = boundary(baseline.median, objective.warningRatio, objective.minimumAbsoluteIncrease);
    const criticalBoundary = boundary(baseline.median, objective.criticalRatio, objective.minimumAbsoluteIncrease * 2);
    const severity: HealthSeverity =
      reading.value >= criticalBoundary ? 'critical' : reading.value >= warningBoundary ? 'warning' : 'none';
    return Object.freeze({
      objectiveId: objective.id,
      signal: objective.signal,
      resource: objective.resource,
      readingState: reading.state,
      value: reading.value,
      confidence: reading.confidence,
      baseline,
      warningBoundary,
      criticalBoundary,
      inflationRatio: baseline.median > 0 ? reading.value / baseline.median : null,
      breached: severity !== 'none',
      severity,
      quality: reading.confidence >= this.minimumEvidenceConfidence ? 'actionable' : 'low-confidence',
      reason: severity === 'none' ? 'objective-satisfied' : 'rolling-objective-breached',
    });
  }

  #signalUnderPressure(frame: HealthAnalysisFrame, rule: CausalRule, signal = rule.causeSignal): boolean {
    const reading = frame.signals[signal];
    if (!reading || reading.state !== 'measured' || reading.value === null) return false;
    if (typeof reading.value === 'boolean') return reading.value;
    const baseline = this.baseline.get(frame.scopeId, signal, frame.atMs);
    if (!baseline?.ready) return false;
    const threshold = PRESSURE_THRESHOLDS[signal as keyof typeof PRESSURE_THRESHOLDS] ?? rule;
    return reading.value >= boundary(baseline.median, threshold.warningRatio, threshold.minimumAbsoluteIncrease);
  }

  #correlation(
    frames: readonly HealthAnalysisFrame[],
    causeSignal: LiveHealthSignalKey,
    outcomeSignal: LiveHealthSignalKey,
  ): number {
    if (causeSignal === outcomeSignal) return 1;
    const pairs: Array<readonly [number, number]> = [];
    for (const frame of frames) {
      const cause = frame.signals[causeSignal];
      const outcome = frame.signals[outcomeSignal];
      if (
        cause?.state === 'measured' &&
        outcome?.state === 'measured' &&
        typeof cause.value === 'number' &&
        typeof outcome.value === 'number'
      ) {
        pairs.push([cause.value, outcome.value]);
      }
    }
    return pearson(pairs);
  }

  #attribute(
    frame: HealthAnalysisFrame,
    evidence: ObjectiveEvidence,
    frames: readonly HealthAnalysisFrame[],
  ): CausalAttribution[] {
    const outcome = frame.signals[evidence.signal];
    if (!outcome || !evidence.breached) return [];
    const out: CausalAttribution[] = [];
    for (const rule of CAUSAL_RULES) {
      if (!rule.outcomes.includes(evidence.signal)) continue;
      const cause = frame.signals[rule.causeSignal];
      if (!cause || cause.state !== 'measured' || cause.value === null) continue;
      const pressure =
        rule.direct && rule.causeSignal === evidence.signal ? true : this.#signalUnderPressure(frame, rule);
      if (!pressure) continue;
      if (
        rule.corroboratingSignals &&
        !rule.corroboratingSignals.some((signal) => this.#signalUnderPressure(frame, rule, signal))
      ) {
        continue;
      }
      const alignmentWindow = Math.max(this.causalWindowMs, cause.window.durationMs, outcome.window.durationMs);
      const temporallyAligned = Math.abs(cause.observedAtMs - outcome.observedAtMs) <= alignmentWindow;
      const correlation = this.#correlation(frames, rule.causeSignal, evidence.signal);
      const confidence = clampLiveHealthConfidence(
        Math.min(cause.confidence, outcome.confidence) * (0.55 + 0.45 * correlation) * (temporallyAligned ? 1 : 0.25),
      );
      const actionable =
        temporallyAligned &&
        evidence.quality === 'actionable' &&
        cause.confidence >= this.minimumEvidenceConfidence &&
        confidence >= this.minimumAttributionConfidence;
      out.push(
        Object.freeze({
          objectiveId: evidence.objectiveId,
          outcomeSignal: evidence.signal,
          causeSignal: rule.causeSignal,
          resource: rule.resource,
          confidence,
          correlation,
          temporallyAligned,
          actionable,
          reason: actionable
            ? rule.causeSignal === evidence.signal
              ? 'direct-degradation-signal'
              : 'pressure-correlates-with-objective'
            : 'attribution-below-actionable-confidence',
        }),
      );
    }
    return out;
  }

  evaluate(frame: HealthAnalysisFrame): HealthVerdict {
    const evidence = this.objectives.map((objective) => this.#assessObjective(frame, objective));
    const breached = evidence.filter((item) => item.breached);
    const frames = [...(this.#history.get(frame.scopeId) ?? []), frame].slice(-this.historySamples);
    const attributions = breached
      .flatMap((item) => this.#attribute(frame, item, frames))
      .sort((a, b) => b.confidence - a.confidence || a.causeSignal.localeCompare(b.causeSignal));
    const actionableAttributions = attributions.filter((item) => item.actionable);
    const hasReadyObjective = evidence.some(
      (item) => item.quality === 'actionable' || item.quality === 'low-confidence',
    );
    const hasWarmingObjective = evidence.some((item) => item.quality === 'warming');
    const state: HealthVerdictState =
      breached.length > 0 ? 'degraded' : hasReadyObjective ? 'healthy' : hasWarmingObjective ? 'warming' : 'unknown';
    const ignoredCapacitySignals = NON_CAUSAL_CAPACITY_SIGNALS.filter(
      (signal) => frame.signals[signal]?.state === 'measured',
    );
    const actionableResources = [...new Set(actionableAttributions.map((item) => item.resource))].sort();
    const reasons =
      breached.length === 0
        ? [state === 'healthy' ? 'service-objectives-satisfied' : `service-objectives-${state}`]
        : actionableAttributions.length > 0
          ? ['attributable-service-degradation']
          : ['service-degradation-not-actionably-attributed'];

    if (this.commitHealthyFrames && breached.length === 0) this.baseline.recordHealthy(frame);
    this.#appendHistory(frame);

    return Object.freeze({
      schemaVersion: HEALTH_ANALYSIS_SCHEMA_VERSION,
      scopeId: frame.scopeId,
      evaluatedAtMs: frame.atMs,
      state,
      severity: highestSeverity(breached),
      actionable: actionableAttributions.length > 0,
      evidence: Object.freeze(evidence),
      attributions: Object.freeze(attributions),
      actionableResources: Object.freeze(actionableResources),
      ignoredCapacitySignals: Object.freeze(ignoredCapacitySignals),
      reasons: Object.freeze(reasons),
    });
  }
}
