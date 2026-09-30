/**
 * Capless adaptive admission controller.
 *
 * The controller consumes P-005 health verdicts and adjusts per-class desired
 * admission windows. It deliberately has no configured or derived maximum:
 * healthy operation keeps probing upward, while causally attributed
 * degradation applies scoped multiplicative decreases. Contraction evidence
 * and severe-progress pauses are expiring feedback, so neither can become a
 * permanent ratchet.
 */

import type { AdmissionClass, ResourceDemand } from './admission';
import type { HealthResource, HealthSeverity, HealthVerdict } from './health-analysis';

export const CAPLESS_CONTROLLER_SCHEMA_VERSION = 'resource-governor-controller-v1' as const;
/** Version of the durable controller-internal state (distinct from a decision's wire schema). */
export const CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION = 'resource-governor-controller-state-v1' as const;

const PROGRESS_LOSS_SIGNALS = new Set([
  'progress.heartbeatLagMs',
  'latency.eventLoopP95Ms',
  'governor.admissionLatencyP95Ms',
  'governor.decisionLatencyP95Ms',
] as const);

export interface ControllerClassSample {
  readonly admissionClass: AdmissionClass;
  readonly inFlight?: number;
  /** Representative incremental demand for one start in this class. */
  readonly demand?: ResourceDemand;
  /** Per-start attribution weights for resources not represented by ResourceDemand. */
  readonly resourceWeights?: Readonly<Partial<Record<HealthResource, number>>>;
}

export interface CaplessControllerOptions {
  readonly initialWindow?: number;
  readonly minimumWindow?: number;
  readonly healthySamplesPerIncrease?: number;
  readonly increaseStep?: number;
  readonly contractionFraction?: number;
  readonly warningSeverityMultiplier?: number;
  readonly contractionCooldownMs?: number;
  readonly contractionTtlMs?: number;
  readonly severePauseMs?: number;
  readonly severePauseMinimumShare?: number;
  readonly protectedClasses?: ReadonlySet<AdmissionClass>;
  /** Optional durable state restored before the first control step. */
  readonly state?: CaplessControllerState;
}

export interface ResourceClassFeedback {
  readonly admissionClass: AdmissionClass;
  readonly resource: HealthResource;
  readonly severity: Exclude<HealthSeverity, 'none'>;
  readonly confidence: number;
  readonly attributableShare: number;
  readonly reductionFraction: number;
  readonly desiredWindowBefore: number;
  readonly desiredWindowAfter: number;
  readonly observedAtMs: number;
  readonly expiresAtMs: number;
  readonly reason: string;
}

/**
 * Durable representation of one class' feedback memory. This is a snapshot,
 * not a limit configuration: it deliberately has no `cap` or upper-bound
 * field, so a restored window remains transient feedback rather than a new
 * productive-capacity ceiling.
 */
export interface CaplessControllerClassState {
  readonly admissionClass: AdmissionClass;
  readonly desiredWindow: number;
  /** Effective window at `evaluatedAtMs`; derived from the expiring pause state. */
  readonly effectiveWindow?: number;
  readonly healthySamples: number;
  readonly pauseUntilMs: number;
  readonly feedback: readonly ResourceClassFeedback[];
  readonly lastContractionAtMs: readonly {
    readonly resource: HealthResource;
    readonly atMs: number;
  }[];
}

export interface CaplessControllerState {
  readonly schemaVersion: typeof CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION;
  readonly generation: number;
  readonly evaluatedAtMs?: number;
  readonly classes: readonly CaplessControllerClassState[];
}

export interface ClassAdmissionDecision {
  readonly admissionClass: AdmissionClass;
  /** Unbounded AIMD target. It has a floor but intentionally no maximum. */
  readonly desiredWindow: number;
  /** Zero only while an attributable severe-progress pause is live. */
  readonly effectiveWindow: number;
  readonly inFlight: number;
  readonly availableStarts: number;
  readonly paused: boolean;
  readonly pauseUntilMs: number | null;
  readonly protected: boolean;
  readonly healthySamples: number;
  readonly feedback: readonly ResourceClassFeedback[];
}

export interface CaplessControllerDecision {
  readonly schemaVersion: typeof CAPLESS_CONTROLLER_SCHEMA_VERSION;
  readonly generation: number;
  readonly evaluatedAtMs: number;
  readonly healthScopeId: string;
  readonly healthState: HealthVerdict['state'];
  readonly healthSeverity: HealthVerdict['severity'];
  readonly classes: readonly ClassAdmissionDecision[];
  readonly reasons: readonly string[];
}

interface MutableClassState {
  desiredWindow: number;
  healthySamples: number;
  pauseUntilMs: number;
  feedback: Map<HealthResource, ResourceClassFeedback>;
  lastContractionAtMs: Map<HealthResource, number>;
}

interface AggregatedClassSample {
  readonly admissionClass: AdmissionClass;
  readonly inFlight: number;
  readonly resourceWeights: Readonly<Record<HealthResource, number>>;
}

function finiteNonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function floorNearInteger(value: number): number {
  const nearest = Math.round(value);
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(value)) * 4;
  return Math.abs(value - nearest) <= tolerance ? nearest : Math.floor(value);
}

function demandWeight(resource: HealthResource, demand: ResourceDemand | undefined): number {
  const explicit = finiteNonNegative(demand?.custom?.[`resource:${resource}`] ?? demand?.custom?.[resource]);
  if (explicit > 0) return explicit;
  switch (resource) {
    case 'cpu':
      return finiteNonNegative(demand?.cpuWeight);
    case 'memory':
      return finiteNonNegative(demand?.memoryBytes);
    case 'database':
      return finiteNonNegative(demand?.databaseConnections);
    case 'provider':
      return finiteNonNegative(demand?.providerRequests);
    case 'service':
    case 'queue':
    case 'governor':
      return 0;
  }
}

function aggregateSamples(samples: readonly ControllerClassSample[]): AggregatedClassSample[] {
  const byClass = new Map<AdmissionClass, { inFlight: number; weights: Record<HealthResource, number> }>();
  for (const sample of samples) {
    const current = byClass.get(sample.admissionClass) ?? {
      inFlight: 0,
      weights: { cpu: 0, memory: 0, database: 0, service: 0, provider: 0, queue: 0, governor: 0 },
    };
    const inFlight = sample.inFlight === undefined ? 1 : Math.max(0, Math.floor(finiteNonNegative(sample.inFlight)));
    current.inFlight += inFlight;
    for (const resource of Object.keys(current.weights) as HealthResource[]) {
      const perStartWeight =
        finiteNonNegative(sample.resourceWeights?.[resource]) || demandWeight(resource, sample.demand);
      current.weights[resource] += perStartWeight * inFlight;
    }
    byClass.set(sample.admissionClass, current);
  }
  return [...byClass.entries()]
    .map(([admissionClass, value]) => ({
      admissionClass,
      inFlight: value.inFlight,
      resourceWeights: Object.freeze({ ...value.weights }),
    }))
    .sort((a, b) => a.admissionClass.localeCompare(b.admissionClass));
}

function hasSevereProgressLoss(verdict: HealthVerdict): boolean {
  return (
    verdict.severity === 'critical' &&
    verdict.evidence.some(
      (item) => item.breached && item.severity === 'critical' && PROGRESS_LOSS_SIGNALS.has(item.signal as never),
    )
  );
}

function actionableConfidence(verdict: HealthVerdict, resource: HealthResource): number {
  return verdict.attributions
    .filter((item) => item.actionable && item.resource === resource)
    .reduce((highest, item) => Math.max(highest, clampUnit(item.confidence)), 0);
}

/**
 * Purely event-driven: callers supply time with each step, so there is no timer,
 * scheduler, or process-local singleton to manage.
 */
export class CaplessAdaptiveController {
  readonly initialWindow: number;
  readonly minimumWindow: number;
  readonly healthySamplesPerIncrease: number;
  readonly increaseStep: number;
  readonly contractionFraction: number;
  readonly warningSeverityMultiplier: number;
  readonly contractionCooldownMs: number;
  readonly contractionTtlMs: number;
  readonly severePauseMs: number;
  readonly severePauseMinimumShare: number;
  readonly protectedClasses: ReadonlySet<AdmissionClass>;

  readonly #classes = new Map<AdmissionClass, MutableClassState>();
  #generation = 0;

  constructor(options: CaplessControllerOptions = {}) {
    this.minimumWindow = Math.max(1, Math.floor(options.minimumWindow ?? 1));
    this.initialWindow = Math.max(this.minimumWindow, Math.floor(options.initialWindow ?? this.minimumWindow));
    this.healthySamplesPerIncrease = Math.max(1, Math.floor(options.healthySamplesPerIncrease ?? 3));
    this.increaseStep = Math.max(1, Math.floor(options.increaseStep ?? 1));
    this.contractionFraction = clampUnit(options.contractionFraction ?? 0.5);
    this.warningSeverityMultiplier = clampUnit(options.warningSeverityMultiplier ?? 0.5);
    this.contractionCooldownMs = Math.max(0, Math.floor(options.contractionCooldownMs ?? 5_000));
    this.contractionTtlMs = Math.max(1, Math.floor(options.contractionTtlMs ?? 30_000));
    this.severePauseMs = Math.max(1, Math.floor(options.severePauseMs ?? 5_000));
    this.severePauseMinimumShare = clampUnit(options.severePauseMinimumShare ?? 0.5);
    this.protectedClasses = new Set(options.protectedClasses ?? ['control']);
    if (options.state) this.restore(options.state);
  }

  /**
   * Restore controller feedback after a process restart.
   *
   * Invalid rows are ignored class-by-class. The next `step` evaluates fresh
   * health and expires stale feedback before exposing a decision, so a damaged
   * or old snapshot can never become an admission ceiling.
   */
  restore(state: CaplessControllerState): void {
    if (!state || state.schemaVersion !== CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION) return;
    if (!Number.isFinite(state.generation) || state.generation < 0) return;
    this.#classes.clear();
    this.#generation = Math.max(0, Math.floor(state.generation));
    for (const row of state.classes ?? []) {
      const admissionClass = typeof row?.admissionClass === 'string' ? row.admissionClass.trim() : '';
      if (!admissionClass) continue;
      const desiredWindow = Number(row.desiredWindow);
      if (!Number.isFinite(desiredWindow) || desiredWindow < this.minimumWindow) continue;
      const healthySamples = Number(row.healthySamples);
      const pauseUntilMs = Number(row.pauseUntilMs);
      const feedback = new Map<HealthResource, ResourceClassFeedback>();
      for (const item of row.feedback ?? []) {
        if (!item || typeof item.resource !== 'string' || !Number.isFinite(item.expiresAtMs)) continue;
        feedback.set(item.resource as HealthResource, Object.freeze({ ...item }));
      }
      const lastContractionAtMs = new Map<HealthResource, number>();
      for (const item of row.lastContractionAtMs ?? []) {
        if (!item || typeof item.resource !== 'string' || !Number.isFinite(item.atMs)) continue;
        lastContractionAtMs.set(item.resource as HealthResource, Math.max(0, Math.floor(item.atMs)));
      }
      this.#classes.set(admissionClass, {
        desiredWindow: Math.min(Number.MAX_SAFE_INTEGER, Math.floor(desiredWindow)),
        healthySamples: Number.isFinite(healthySamples) ? Math.max(0, Math.floor(healthySamples)) : 0,
        pauseUntilMs: Number.isFinite(pauseUntilMs) ? Math.max(0, Math.floor(pauseUntilMs)) : 0,
        feedback,
        lastContractionAtMs,
      });
    }
  }

  /** Return a stable, JSON-safe snapshot for a durable state writer. */
  snapshot(evaluatedAtMs = Date.now()): CaplessControllerState {
    const atMs = Number.isFinite(evaluatedAtMs) ? Math.max(0, Math.floor(evaluatedAtMs)) : Date.now();
    this.#expire(atMs);
    const classes = [...this.#classes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([admissionClass, state]) => Object.freeze({
        admissionClass,
        desiredWindow: state.desiredWindow,
        effectiveWindow: this.protectedClasses.has(admissionClass) || state.pauseUntilMs <= atMs
          ? state.desiredWindow
          : 0,
        healthySamples: state.healthySamples,
        pauseUntilMs: state.pauseUntilMs,
        feedback: Object.freeze(
          [...state.feedback.values()].sort((a, b) => a.resource.localeCompare(b.resource)),
        ),
        lastContractionAtMs: Object.freeze(
          [...state.lastContractionAtMs.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([resource, atMs]) => Object.freeze({ resource, atMs })),
        ),
      }));
    return Object.freeze({
      schemaVersion: CAPLESS_CONTROLLER_STATE_SCHEMA_VERSION,
      generation: this.#generation,
      evaluatedAtMs: atMs,
      classes: Object.freeze(classes),
    });
  }

  #state(admissionClass: AdmissionClass): MutableClassState {
    let state = this.#classes.get(admissionClass);
    if (!state) {
      state = {
        desiredWindow: this.initialWindow,
        healthySamples: 0,
        pauseUntilMs: 0,
        feedback: new Map(),
        lastContractionAtMs: new Map(),
      };
      this.#classes.set(admissionClass, state);
    }
    return state;
  }

  #expire(atMs: number): void {
    for (const state of this.#classes.values()) {
      if (state.pauseUntilMs <= atMs) state.pauseUntilMs = 0;
      for (const [resource, feedback] of state.feedback) {
        if (feedback.expiresAtMs <= atMs) state.feedback.delete(resource);
      }
    }
  }

  #expandHealthy(samples: readonly AggregatedClassSample[]): void {
    for (const sample of samples) {
      const state = this.#state(sample.admissionClass);
      state.healthySamples += 1;
      if (state.healthySamples < this.healthySamplesPerIncrease) continue;
      state.healthySamples = 0;
      state.desiredWindow = Math.min(Number.MAX_SAFE_INTEGER, state.desiredWindow + this.increaseStep);
    }
  }

  #contract(
    verdict: HealthVerdict,
    samples: readonly AggregatedClassSample[],
    atMs: number,
  ): ResourceClassFeedback[] {
    const emitted: ResourceClassFeedback[] = [];
    const severeProgressLoss = hasSevereProgressLoss(verdict);
    const severityMultiplier = verdict.severity === 'critical' ? 1 : this.warningSeverityMultiplier;

    for (const resource of verdict.actionableResources) {
      const confidence = actionableConfidence(verdict, resource);
      if (confidence <= 0) continue;
      const attributable = samples.filter(
        (sample) => !this.protectedClasses.has(sample.admissionClass) && sample.resourceWeights[resource] > 0,
      );
      const totalWeight = attributable.reduce((sum, sample) => sum + sample.resourceWeights[resource], 0);
      if (totalWeight <= 0) continue;

      for (const sample of attributable) {
        const state = this.#state(sample.admissionClass);
        state.healthySamples = 0;
        const share = sample.resourceWeights[resource] / totalWeight;
        const previousAt = state.lastContractionAtMs.get(resource);
        const insideCooldown = previousAt !== undefined && atMs - previousAt < this.contractionCooldownMs;
        const desiredWindowBefore = state.desiredWindow;
        const reductionFraction = clampUnit(this.contractionFraction * severityMultiplier * confidence * share);
        if (!insideCooldown && reductionFraction > 0) {
          state.desiredWindow = Math.max(
            this.minimumWindow,
            floorNearInteger(state.desiredWindow * (1 - reductionFraction)),
          );
          state.lastContractionAtMs.set(resource, atMs);
        }
        if (severeProgressLoss && share >= this.severePauseMinimumShare) {
          state.pauseUntilMs = Math.max(state.pauseUntilMs, atMs + this.severePauseMs);
        }
        const feedback: ResourceClassFeedback = Object.freeze({
          admissionClass: sample.admissionClass,
          resource,
          severity: verdict.severity === 'critical' ? 'critical' : 'warning',
          confidence,
          attributableShare: share,
          reductionFraction: insideCooldown ? 0 : reductionFraction,
          desiredWindowBefore,
          desiredWindowAfter: state.desiredWindow,
          observedAtMs: atMs,
          expiresAtMs: atMs + this.contractionTtlMs,
          reason: insideCooldown ? 'attributable-degradation-cooldown-renewed' : 'attributable-degradation',
        });
        state.feedback.set(resource, feedback);
        emitted.push(feedback);
      }
    }
    return emitted;
  }

  step(input: {
    readonly verdict: HealthVerdict;
    readonly classes: readonly ControllerClassSample[];
    readonly atMs?: number;
  }): CaplessControllerDecision {
    const atMs = Math.max(0, Math.floor(input.atMs ?? input.verdict.evaluatedAtMs));
    const samples = aggregateSamples(input.classes);
    for (const sample of samples) this.#state(sample.admissionClass);
    this.#expire(atMs);

    let reasons: string[];
    if (input.verdict.state === 'healthy' && !input.verdict.actionable) {
      this.#expandHealthy(samples);
      reasons = ['stable-health-upward-probe'];
    } else if (input.verdict.state === 'degraded' && input.verdict.actionable) {
      const contractions = this.#contract(input.verdict, samples, atMs);
      reasons = contractions.length > 0
        ? ['causal-class-contraction']
        : ['degradation-had-no-declared-attributable-class'];
    } else {
      for (const sample of samples) this.#state(sample.admissionClass).healthySamples = 0;
      reasons = [`health-${input.verdict.state}-holds-window`];
    }

    this.#generation += 1;
    return this.#decision(samples, input.verdict, atMs, reasons);
  }

  #decision(
    samples: readonly AggregatedClassSample[],
    verdict: HealthVerdict,
    atMs: number,
    reasons: readonly string[],
  ): CaplessControllerDecision {
    const sampleByClass = new Map(samples.map((sample) => [sample.admissionClass, sample]));
    const classes = [...this.#classes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([admissionClass, state]): ClassAdmissionDecision => {
        const inFlight = sampleByClass.get(admissionClass)?.inFlight ?? 0;
        const isProtected = this.protectedClasses.has(admissionClass);
        const paused = !isProtected && state.pauseUntilMs > atMs;
        const effectiveWindow = paused ? 0 : state.desiredWindow;
        return Object.freeze({
          admissionClass,
          desiredWindow: state.desiredWindow,
          effectiveWindow,
          inFlight,
          availableStarts: Math.max(0, effectiveWindow - inFlight),
          paused,
          pauseUntilMs: paused ? state.pauseUntilMs : null,
          protected: isProtected,
          healthySamples: state.healthySamples,
          feedback: Object.freeze([...state.feedback.values()].sort((a, b) => a.resource.localeCompare(b.resource))),
        });
      });
    return Object.freeze({
      schemaVersion: CAPLESS_CONTROLLER_SCHEMA_VERSION,
      generation: this.#generation,
      evaluatedAtMs: atMs,
      healthScopeId: verdict.scopeId,
      healthState: verdict.state,
      healthSeverity: verdict.severity,
      classes: Object.freeze(classes),
      reasons: Object.freeze([...reasons]),
    });
  }
}
