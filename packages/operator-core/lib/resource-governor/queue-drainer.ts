/**
 * Event-driven, feedback-paced draining for the durable resource-governor queue.
 *
 * The drainer owns no resident copy of queued work and has no timer. Every pass
 * is triggered by a durable-queue or health transition, asks the canonical store
 * for one lease at a time, and spends only the transient credit produced by the
 * capless controller. Concurrent triggers collapse into one latest-state wake.
 */

import type { AdmissionClass } from './admission';
import type { CaplessControllerDecision, ClassAdmissionDecision } from './controller';
import type { HealthResource } from './health-analysis';
import type { AdmissionQueueLeaseClaim, QueueLeaseSelection } from './queue';

export type QueueDrainTriggerKind =
  | 'enqueued'
  | 'completed'
  | 'cancelled'
  | 'released'
  | 'health-transition';

export interface QueueDrainTrigger {
  readonly kind: QueueDrainTriggerKind;
  readonly atMs: number;
  /** Resources made newly available by a completion/release, used as affinity. */
  readonly releasedResources?: readonly HealthResource[];
}

export interface QueueServiceEvidence {
  readonly admissionClass: AdmissionClass;
  readonly completedCount: number;
  readonly observedWindowMs: number;
  readonly observedAtMs: number;
  readonly validUntilMs: number;
  readonly confidence: number;
}

export interface QueueWaitEstimate {
  readonly admissionClass: AdmissionClass;
  readonly expectedWaitMs: number;
  readonly confidence: number;
  readonly asOfMs: number;
  readonly validUntilMs: number;
  readonly stale: false;
  readonly evidence: {
    readonly completedCount: number;
    readonly observedWindowMs: number;
    readonly queueDepth: number;
  };
}

export function estimateQueueWait(input: {
  readonly queueDepth: number;
  readonly evidence: QueueServiceEvidence;
  readonly nowMs: number;
}): QueueWaitEstimate | null {
  const completedCount = Math.floor(input.evidence.completedCount);
  const queueDepth = Math.floor(input.queueDepth);
  if (
    !Number.isFinite(input.queueDepth) ||
    input.queueDepth < 0 ||
    !Number.isFinite(input.evidence.completedCount) ||
    completedCount <= 0 ||
    !Number.isFinite(input.evidence.observedWindowMs) ||
    input.evidence.observedWindowMs <= 0 ||
    !Number.isFinite(input.evidence.observedAtMs) ||
    !Number.isFinite(input.evidence.validUntilMs) ||
    !Number.isFinite(input.nowMs) ||
    !Number.isFinite(input.evidence.confidence) ||
    input.evidence.confidence <= 0 ||
    input.evidence.observedAtMs > input.nowMs ||
    input.evidence.validUntilMs < input.nowMs
  ) {
    return null;
  }
  return Object.freeze({
    admissionClass: input.evidence.admissionClass,
    expectedWaitMs: Math.ceil((queueDepth * input.evidence.observedWindowMs) / completedCount),
    confidence: Math.min(1, input.evidence.confidence),
    asOfMs: input.evidence.observedAtMs,
    validUntilMs: input.evidence.validUntilMs,
    stale: false,
    evidence: Object.freeze({
      completedCount,
      observedWindowMs: input.evidence.observedWindowMs,
      queueDepth,
    }),
  });
}

export interface QueueDrainWake {
  readonly trigger: QueueDrainTrigger;
  readonly decision: CaplessControllerDecision;
  /** Relative service shares. They are ordering weights, never quotas. */
  readonly classWeights?: Readonly<Record<string, number>>;
  /** Durable counts observed by the caller; the drainer never retains queue rows. */
  readonly queueDepthByClass?: Readonly<Record<string, number>>;
  readonly serviceEvidence?: readonly QueueServiceEvidence[];
}

export interface QueueDrainLeaseSource {
  leaseNext(input: {
    readonly owner: string;
    readonly ttlMs: number;
    readonly selection: QueueLeaseSelection;
  }): Promise<AdmissionQueueLeaseClaim | null>;
  releaseLease(receiptId: string, leaseId: string): Promise<unknown>;
}

export interface QueueDrainDispatch {
  readonly claim: AdmissionQueueLeaseClaim;
  readonly trigger: QueueDrainTrigger;
  readonly controllerGeneration: number;
}

export interface QueueDrainResult {
  readonly wakeCount: number;
  readonly cycleCount: number;
  readonly started: number;
  readonly borrowed: number;
  readonly startedByClass: Readonly<Record<string, number>>;
  readonly queueExhausted: boolean;
  readonly controllerGeneration: number;
  readonly waitEstimates: readonly QueueWaitEstimate[];
}

export interface PacedDurableQueueDrainerOptions {
  readonly source: QueueDrainLeaseSource;
  readonly owner: string;
  readonly leaseTtlMs: number;
  readonly dispatch: (input: QueueDrainDispatch) => void | Promise<void>;
  readonly agingIntervalMs?: number;
  readonly deadlineHorizonMs?: number;
  readonly resourceAffinityBonus?: number;
  readonly constrainedResourcePenalty?: number;
}

interface MutableClassCredit {
  readonly admissionClass: AdmissionClass;
  readonly weight: number;
  readonly constrainedResources: readonly HealthResource[];
  readonly borrowEligible: boolean;
  baseRemaining: number;
}

function positiveWeight(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 1;
}

function finiteCredit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function liveConstrainedResources(decision: ClassAdmissionDecision, atMs: number): HealthResource[] {
  return [...new Set(decision.feedback.filter((item) => item.expiresAtMs > atMs).map((item) => item.resource))].sort();
}

function mergeWake(current: QueueDrainWake | null, incoming: QueueDrainWake): QueueDrainWake {
  if (!current) return incoming;
  const newer =
    incoming.decision.generation > current.decision.generation ||
    (incoming.decision.generation === current.decision.generation && incoming.trigger.atMs >= current.trigger.atMs)
      ? incoming
      : current;
  const resources = [...new Set([
    ...(current.trigger.releasedResources ?? []),
    ...(incoming.trigger.releasedResources ?? []),
  ])].sort();
  return {
    ...newer,
    trigger: {
      ...newer.trigger,
      atMs: Math.max(current.trigger.atMs, incoming.trigger.atMs),
      ...(resources.length > 0 ? { releasedResources: resources } : {}),
    },
  };
}

/**
 * One drainer instance represents one logical queue authority. It keeps only a
 * bounded virtual-time value per class present in the latest controller state.
 */
export class PacedDurableQueueDrainer {
  readonly #source: QueueDrainLeaseSource;
  readonly #owner: string;
  readonly #leaseTtlMs: number;
  readonly #dispatch: PacedDurableQueueDrainerOptions['dispatch'];
  readonly #agingIntervalMs: number;
  readonly #deadlineHorizonMs: number;
  readonly #resourceAffinityBonus: number;
  readonly #constrainedResourcePenalty: number;
  readonly #virtualTime = new Map<AdmissionClass, number>();
  #pending: QueueDrainWake | null = null;
  #pendingWakeCount = 0;
  #active: Promise<QueueDrainResult> | null = null;

  constructor(options: PacedDurableQueueDrainerOptions) {
    const owner = options.owner.trim();
    if (!owner) throw new Error('queue drainer owner must be non-empty');
    if (!Number.isFinite(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
      throw new Error('queue drainer leaseTtlMs must be positive');
    }
    this.#source = options.source;
    this.#owner = owner;
    this.#leaseTtlMs = Math.floor(options.leaseTtlMs);
    this.#dispatch = options.dispatch;
    this.#agingIntervalMs = Math.max(1, Math.floor(options.agingIntervalMs ?? 5_000));
    this.#deadlineHorizonMs = Math.max(1, Math.floor(options.deadlineHorizonMs ?? 60_000));
    this.#resourceAffinityBonus = Math.max(0, options.resourceAffinityBonus ?? 2);
    this.#constrainedResourcePenalty = Math.max(0, options.constrainedResourcePenalty ?? 4);
  }

  wake(input: QueueDrainWake): Promise<QueueDrainResult> {
    this.#pending = mergeWake(this.#pending, input);
    this.#pendingWakeCount += 1;
    if (!this.#active) {
      this.#active = this.#run().finally(() => {
        this.#active = null;
      });
    }
    return this.#active;
  }

  async #run(): Promise<QueueDrainResult> {
    const startedByClass: Record<string, number> = {};
    let wakeCount = 0;
    let cycleCount = 0;
    let started = 0;
    let borrowed = 0;
    let queueExhausted = false;
    let controllerGeneration = 0;
    let waitEstimates: readonly QueueWaitEstimate[] = [];

    while (this.#pending) {
      const wake = this.#pending;
      wakeCount += this.#pendingWakeCount;
      this.#pending = null;
      this.#pendingWakeCount = 0;
      const result = await this.#drainCycle(wake);
      cycleCount += 1;
      started += result.started;
      borrowed += result.borrowed;
      queueExhausted = result.queueExhausted;
      controllerGeneration = wake.decision.generation;
      waitEstimates = result.waitEstimates;
      for (const [admissionClass, count] of Object.entries(result.startedByClass)) {
        startedByClass[admissionClass] = (startedByClass[admissionClass] ?? 0) + count;
      }
    }

    return Object.freeze({
      wakeCount,
      cycleCount,
      started,
      borrowed,
      startedByClass: Object.freeze({ ...startedByClass }),
      queueExhausted,
      controllerGeneration,
      waitEstimates,
    });
  }

  async #drainCycle(wake: QueueDrainWake): Promise<Omit<QueueDrainResult, 'wakeCount' | 'cycleCount' | 'controllerGeneration'>> {
    const activeClasses = new Set(wake.decision.classes.map((item) => item.admissionClass));
    for (const admissionClass of this.#virtualTime.keys()) {
      if (!activeClasses.has(admissionClass)) this.#virtualTime.delete(admissionClass);
    }

    const credits = new Map<AdmissionClass, MutableClassCredit>();
    let globalRemaining = 0;
    for (const item of wake.decision.classes) {
      if (item.paused) continue;
      const baseRemaining = finiteCredit(item.availableStarts);
      globalRemaining = Math.min(Number.MAX_SAFE_INTEGER, globalRemaining + baseRemaining);
      const constrainedResources = liveConstrainedResources(item, wake.trigger.atMs);
      credits.set(item.admissionClass, {
        admissionClass: item.admissionClass,
        weight: positiveWeight(wake.classWeights?.[item.admissionClass]),
        constrainedResources,
        borrowEligible: constrainedResources.length === 0,
        baseRemaining,
      });
      if (!this.#virtualTime.has(item.admissionClass)) this.#virtualTime.set(item.admissionClass, 0);
    }

    let started = 0;
    let borrowed = 0;
    let queueExhausted = false;
    let borrowing = false;
    const startedByClass: Record<string, number> = {};
    while (globalRemaining > 0) {
      const classes = [...credits.values()]
        .filter((item) => (borrowing ? item.borrowEligible : item.baseRemaining > 0))
        .map((item) => ({
          admissionClass: item.admissionClass,
          weight: item.weight,
          virtualTime: this.#virtualTime.get(item.admissionClass) ?? 0,
          constrainedResources: item.constrainedResources,
        }));
      if (classes.length === 0) break;
      const claim = await this.#source.leaseNext({
        owner: this.#owner,
        ttlMs: this.#leaseTtlMs,
        selection: {
          classes,
          releasedResources: wake.trigger.releasedResources ?? [],
          agingIntervalMs: this.#agingIntervalMs,
          deadlineHorizonMs: this.#deadlineHorizonMs,
          resourceAffinityBonus: this.#resourceAffinityBonus,
          constrainedResourcePenalty: this.#constrainedResourcePenalty,
        },
      });
      if (!claim) {
        if (!borrowing) {
          // A null selection proves there is no queued row in any funded class.
          // Only then may their unused transient credit become a healthy-class pool.
          borrowing = true;
          for (const credit of credits.values()) credit.baseRemaining = 0;
          continue;
        }
        queueExhausted = true;
        break;
      }
      const credit = credits.get(claim.record.admissionClass);
      if (!credit || (borrowing ? !credit.borrowEligible : credit.baseRemaining <= 0)) {
        await this.#source.releaseLease(claim.receiptId, claim.lease.leaseId);
        throw new Error(`queue store leased class '${claim.record.admissionClass}' outside the drain policy`);
      }
      const isBorrowed = borrowing;
      if (!borrowing) credit.baseRemaining -= 1;
      globalRemaining -= 1;
      this.#virtualTime.set(
        credit.admissionClass,
        (this.#virtualTime.get(credit.admissionClass) ?? 0) + 1 / credit.weight,
      );
      try {
        await this.#dispatch({
          claim,
          trigger: wake.trigger,
          controllerGeneration: wake.decision.generation,
        });
      } catch (error) {
        await this.#source.releaseLease(claim.receiptId, claim.lease.leaseId);
        throw error;
      }
      started += 1;
      if (isBorrowed) borrowed += 1;
      startedByClass[credit.admissionClass] = (startedByClass[credit.admissionClass] ?? 0) + 1;
    }

    const minimumVirtualTime = Math.min(...this.#virtualTime.values());
    if (Number.isFinite(minimumVirtualTime) && minimumVirtualTime > 0) {
      for (const [admissionClass, value] of this.#virtualTime) {
        this.#virtualTime.set(admissionClass, value - minimumVirtualTime);
      }
    }

    const evidenceByClass = new Map((wake.serviceEvidence ?? []).map((item) => [item.admissionClass, item]));
    const waitEstimates = Object.entries(wake.queueDepthByClass ?? {})
      .map(([admissionClass, queueDepth]) => {
        const evidence = evidenceByClass.get(admissionClass);
        return evidence ? estimateQueueWait({ queueDepth, evidence, nowMs: wake.trigger.atMs }) : null;
      })
      .filter((item): item is QueueWaitEstimate => item !== null)
      .sort((a, b) => a.admissionClass.localeCompare(b.admissionClass));

    return Object.freeze({
      started,
      borrowed,
      startedByClass: Object.freeze({ ...startedByClass }),
      queueExhausted,
      waitEstimates: Object.freeze(waitEstimates),
    });
  }
}
