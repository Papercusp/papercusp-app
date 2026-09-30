/**
 * P-013 (capless-inference-gateway-2026-08-28): ONE canonical gateway admission
 * state/read model.
 *
 * ## Why this file exists
 *
 * Before this, every capacity-shaped surface built its own answer. `/admin/config`
 * forwarded `admission.maxConcurrent` beside `aimd.effective` from separate reads;
 * `fleet:capacity` recomputed its own view; health panels and alerts each derived a
 * number with no record of which term produced it. The failure that follows is not
 * "a surface is wrong" — it is that two surfaces disagree and NEITHER carries the
 * provenance needed to settle which one binds. An agent read `maxConcurrent: 4`
 * beside `effective: 24`, diagnosed an AIMD defect, and carried the wrong cause for
 * a day; the real term (a serviceable-account clamp) was one line away in a
 * different read.
 *
 * The fix is structural, not editorial: there is exactly ONE snapshot builder here,
 * and every surface is a PROJECTION of its output. Two projections cannot disagree
 * about the binding writer, the generation, or the freshness of a number, because
 * they are reading the same field of the same object. That property is what the
 * spec's falsifier probes, so it is asserted directly in the test file rather than
 * left as an architectural intention.
 *
 * ## The units/writer rule
 *
 * Every number in this model is a {@link GatewayMeasure}: a value PLUS the exact
 * writer that produced it, its unit, and its disposition. A bare number is not
 * representable. This is the derived-truth ladder applied to capacity state — the
 * value and its provenance are written together or not at all, so provenance cannot
 * drift away from the number the way a hand-maintained comment does.
 */

import type { AdmissionClass, QueueReceipt } from '../resource-governor/admission';
import type { CaplessControllerDecision, ClassAdmissionDecision } from '../resource-governor/controller';
import type { GatewayAdmissionProvider } from './admission-context';
import type {
  GatewayCausalAttribution,
  PhysicalConstraintObservation,
  PhysicalConstraintVerdict,
} from './physical-constraints';
// VALUE import, deliberately not `import type`: the binding decision below has to RE-EVALUATE
// an observation's age, not merely describe its stored shape. Until 2026-08-30 this module
// imported `./physical-constraints` for types only, which is exactly why the freshness gate
// below was missing — there was no way to call the re-classifier from here.
import { refreshPhysicalConstraint } from './physical-constraints';

export const GATEWAY_ADMISSION_STATE_SCHEMA_VERSION = 'inference-gateway-admission-state-v1' as const;

/**
 * WHY a number is allowed to bound productive capacity.
 *
 * The source lint (`npm run lint:no-capacity-maxima`) rejects a hard-coded or
 * derived maximum whose writer does not declare one of the first three. `observed`
 * and `derived` are explicitly NOT licences to cap: they describe a measurement or
 * a computed view, and a lane may never be bound by one.
 */
export type GatewayCapacityDisposition =
  /** A meaning-bearing limit: a tier floor, a protected class. Not a throughput cap. */
  | 'semantic'
  /** Imposed by a wire protocol or API contract we do not control. */
  | 'protocol'
  /** An external physical contract: a provider quota, a 429 budget, a device limit. */
  | 'physical-contract'
  /** A measurement of what IS, never a bound on what MAY be. */
  | 'observed'
  /** Computed from other terms for presentation. Never binding. */
  | 'derived';

/** Dispositions that may legitimately BIND a lane's effective window. */
export const BINDING_DISPOSITIONS: ReadonlySet<GatewayCapacityDisposition> = new Set([
  'semantic',
  'protocol',
  'physical-contract',
]);

export type GatewayStateUnit =
  | 'concurrent-requests'
  | 'requests'
  | 'epoch-ms'
  | 'milliseconds'
  | 'count'
  | 'fraction';

/**
 * The exact producer of a value. `writer` is a grep-able `module#symbol` identity,
 * not a prose description — a reader who distrusts a number must be able to open
 * the code that wrote it without asking anyone.
 */
export interface GatewayStateWriter {
  readonly writer: string;
  readonly unit: GatewayStateUnit;
  readonly disposition: GatewayCapacityDisposition;
}

/** A number that cannot be read without its provenance. */
export interface GatewayMeasure {
  readonly value: number | null;
  readonly writer: GatewayStateWriter;
}

export interface GatewayLaneKey {
  readonly admissionClass: AdmissionClass;
  readonly provider: GatewayAdmissionProvider | null;
  readonly accountId: string | null;
}

/** Stable, human-readable lane identity used as the join key across projections. */
export function gatewayLaneId(lane: GatewayLaneKey): string {
  return [lane.admissionClass, lane.provider ?? 'any', lane.accountId ?? 'any'].join('/');
}

export interface GatewayLaneObservation {
  readonly observedAtMs: number;
  readonly collectedAtMs: number;
  /** null ⇒ this observation does not expire on its own. */
  readonly expiresAtMs: number | null;
  readonly freshness: 'fresh' | 'aging' | 'stale' | 'unknown';
}

export interface GatewayLaneQueue {
  readonly depth: GatewayMeasure;
  readonly oldestEnqueuedAtMs: number | null;
  /** Durable receipts, so a queued request is traceable across a restart. */
  readonly receipts: readonly QueueReceipt[];
}

/**
 * Which term actually binds this lane, and the writer that produced it.
 *
 * `binding: null` means nothing bounds the lane — the capless steady state. That is
 * a POSITIVE answer, not a missing one, which is why it is modelled explicitly
 * instead of being represented by an absent field.
 */
export interface GatewayLaneBinding {
  readonly bindingTerm: 'effective-window' | 'pause' | 'physical-contract' | null;
  readonly writer: GatewayStateWriter | null;
  readonly reason: string;
  /** Physical observations that are actually binding, not merely present. */
  readonly bindingObservations: readonly PhysicalConstraintObservation[];
}

export interface GatewayAdmissionLaneState {
  readonly lane: GatewayLaneKey;
  readonly laneId: string;
  readonly desiredWindow: GatewayMeasure;
  readonly effectiveWindow: GatewayMeasure;
  readonly inFlight: GatewayMeasure;
  readonly availableStarts: GatewayMeasure;
  readonly queue: GatewayLaneQueue;
  readonly paused: boolean;
  readonly pauseUntilMs: number | null;
  readonly protectedClass: boolean;
  /** Bypass keys that skip admission for this lane, named so they are auditable. */
  readonly controlBypass: readonly string[];
  readonly physical: readonly PhysicalConstraintObservation[];
  readonly attributions: readonly GatewayCausalAttribution[];
  readonly binding: GatewayLaneBinding;
  readonly observation: GatewayLaneObservation;
  readonly generation: number;
}

export interface GatewayAdmissionStateSnapshot {
  readonly schemaVersion: typeof GATEWAY_ADMISSION_STATE_SCHEMA_VERSION;
  readonly generation: number;
  readonly evaluatedAtMs: number;
  readonly healthState: CaplessControllerDecision['healthState'] | 'unknown';
  readonly lanes: readonly GatewayAdmissionLaneState[];
  readonly reasons: readonly string[];
  /** Weakest freshness across lanes — the honest freshness of the whole snapshot. */
  readonly freshness: GatewayLaneObservation['freshness'];
}

export interface DescribeGatewayAdmissionStateInput {
  readonly decision: CaplessControllerDecision;
  readonly physical?: PhysicalConstraintVerdict | null;
  /** Durable queued receipts, keyed by admission class. */
  readonly queued?: Readonly<Record<string, readonly QueueReceipt[]>>;
  readonly provider?: GatewayAdmissionProvider | null;
  readonly accountId?: string | null;
  readonly bypassKeys?: readonly string[];
  readonly nowMs?: number;
  /** Beyond this age an observation is `aging`; twice it, `stale`. */
  readonly freshnessBudgetMs?: number;
}

const DEFAULT_FRESHNESS_BUDGET_MS = 30_000;

const WRITER_CONTROLLER = 'resource-governor/controller.ts#CaplessAdaptiveController';
const WRITER_QUEUE = 'resource-governor/admission.ts#QueueReceipt';
const WRITER_MODEL = 'inference-gateway/admission-state-model.ts#describeGatewayAdmissionState';

function measure(
  value: number | null,
  writer: string,
  unit: GatewayStateUnit,
  disposition: GatewayCapacityDisposition,
): GatewayMeasure {
  return { value, writer: { writer, unit, disposition } };
}

function freshnessFor(observedAtMs: number, nowMs: number, budgetMs: number): GatewayLaneObservation['freshness'] {
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0) return 'unknown';
  const age = nowMs - observedAtMs;
  // A clock skew that puts the observation in the future is not freshness — it is a
  // broken instrument, and reporting it as `fresh` would launder the fault.
  if (age < -budgetMs) return 'unknown';
  if (age <= budgetMs) return 'fresh';
  if (age <= budgetMs * 2) return 'aging';
  return 'stale';
}

const FRESHNESS_RANK: Readonly<Record<GatewayLaneObservation['freshness'], number>> = {
  fresh: 0,
  aging: 1,
  stale: 2,
  unknown: 3,
};

/**
 * Decide which term binds a lane.
 *
 * Order matters and is deliberate: a live pause outranks the window, and an external
 * physical contract outranks a local window, because reporting the local window as
 * the binding term while a provider quota is actually in force is precisely the
 * misdiagnosis this model exists to prevent.
 */
export function explainGatewayLaneBinding(
  klass: ClassAdmissionDecision,
  physical: readonly PhysicalConstraintObservation[],
  nowMs: number,
): GatewayLaneBinding {
  // FRESHNESS IS CONSULTED HERE, not merely stored (D-009). `refreshPhysicalConstraint`
  // re-classifies a row whose `expiresAtMs` has passed to state:'stale' — a row that was
  // `measured` when collected keeps `constraint: true` and `state: 'measured'` in the stored
  // object forever, so filtering the RAW row reports an expired provider quota as the live
  // binding term. That is the misdiagnosis this whole model exists to prevent, arriving
  // through the back door. Found by rubric vetting, 2026-08-30 (D-020).
  //
  // `actionable` is deliberately NOT part of this predicate, which is why this is not simply
  // `canContractFromPhysicalConstraint`. That predicate answers "may this row DRIVE CONTROL";
  // this one answers "what is IN FORCE on this lane right now", and a non-actionable external
  // contract still binds what an operator is looking at. Two questions, two predicates — but
  // both must consult freshness, and only one of them did.
  const bindingObservations = physical
    .map((o) => refreshPhysicalConstraint(o, nowMs))
    .filter((o) => o.state === 'measured' && o.constraint && o.binding === 'external-physical-contract');
  if (klass.paused) {
    return {
      bindingTerm: 'pause',
      writer: { writer: WRITER_CONTROLLER, unit: 'epoch-ms', disposition: 'physical-contract' },
      reason:
        'An attributable severe-progress pause is live, so no start is admitted regardless of the window.',
      bindingObservations,
    };
  }
  if (bindingObservations.length > 0) {
    const first = bindingObservations[0]!;
    return {
      bindingTerm: 'physical-contract',
      writer: {
        writer: `inference-gateway/physical-constraints.ts#${first.source}`,
        unit: 'concurrent-requests',
        disposition: 'physical-contract',
      },
      reason: `An external physical contract binds this lane: ${first.reason ?? first.source}.`,
      bindingObservations,
    };
  }
  if (klass.inFlight >= klass.effectiveWindow) {
    return {
      bindingTerm: 'effective-window',
      writer: { writer: WRITER_CONTROLLER, unit: 'concurrent-requests', disposition: 'observed' },
      reason:
        'In-flight work has reached the controller\'s current effective window; the window is adaptive and has no maximum.',
      bindingObservations,
    };
  }
  return {
    bindingTerm: null,
    writer: null,
    reason: 'Nothing binds this lane: starts are available now.',
    bindingObservations,
  };
}

/**
 * THE one builder. Every gateway capacity surface projects from its output.
 */
export function describeGatewayAdmissionState(
  input: DescribeGatewayAdmissionStateInput,
): GatewayAdmissionStateSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const budgetMs = input.freshnessBudgetMs ?? DEFAULT_FRESHNESS_BUDGET_MS;
  const observations = input.physical?.observations ?? [];
  const attributions = input.physical?.attributions ?? [];
  const bypassKeys = [...(input.bypassKeys ?? [])].sort();

  const lanes = input.decision.classes.map((klass): GatewayAdmissionLaneState => {
    const lane: GatewayLaneKey = {
      admissionClass: klass.admissionClass,
      provider: input.provider ?? null,
      accountId: input.accountId ?? null,
    };
    // Scope an observation to this lane by provider AND account. An observation
    // that names neither is workspace-wide and belongs to every lane; one that
    // names a DIFFERENT provider or account must not be attributed here, or a
    // quota on one account would be reported as binding on another.
    const lanePhysical = observations.filter((o) => {
      const scopeProvider = o.scope?.provider;
      const scopeAccountId = o.scope?.accountId;
      if (input.provider && scopeProvider && scopeProvider !== providerAlias(input.provider)) return false;
      if (input.accountId && scopeAccountId && scopeAccountId !== input.accountId) return false;
      return true;
    });
    const receipts = input.queued?.[klass.admissionClass] ?? [];
    // Only work that is genuinely still waiting counts as queue depth. Counting
    // completed/cancelled receipts would inflate the one number an operator uses to
    // decide whether admission is stuck.
    const waiting = receipts.filter((r) => r.state === 'queued' || r.state === 'eligible');
    const oldestEnqueuedAtMs = waiting.reduce<number | null>(
      (acc, r) => (acc === null || r.enqueuedAtMs < acc ? r.enqueuedAtMs : acc),
      null,
    );
    const observedAtMs = input.decision.evaluatedAtMs;
    const laneExpiry = lanePhysical.reduce<number | null>((acc, o) => {
      if (o.expiresAtMs === null) return acc;
      return acc === null || o.expiresAtMs < acc ? o.expiresAtMs : acc;
    }, null);

    return {
      lane,
      laneId: gatewayLaneId(lane),
      // The desired window is the controller's unbounded AIMD target. It is `observed`,
      // never `semantic`/`protocol`/`physical-contract`, so the lint can never read it
      // as a licence to cap.
      desiredWindow: measure(klass.desiredWindow, WRITER_CONTROLLER, 'concurrent-requests', 'observed'),
      effectiveWindow: measure(klass.effectiveWindow, WRITER_CONTROLLER, 'concurrent-requests', 'observed'),
      inFlight: measure(klass.inFlight, WRITER_CONTROLLER, 'concurrent-requests', 'observed'),
      availableStarts: measure(klass.availableStarts, WRITER_CONTROLLER, 'concurrent-requests', 'derived'),
      queue: {
        depth: measure(waiting.length, WRITER_QUEUE, 'requests', 'observed'),
        oldestEnqueuedAtMs,
        receipts,
      },
      paused: klass.paused,
      pauseUntilMs: klass.pauseUntilMs,
      protectedClass: klass.protected,
      controlBypass: bypassKeys,
      physical: lanePhysical,
      attributions,
      binding: explainGatewayLaneBinding(klass, lanePhysical, nowMs),
      observation: {
        observedAtMs,
        collectedAtMs: nowMs,
        expiresAtMs: laneExpiry,
        freshness: freshnessFor(observedAtMs, nowMs, budgetMs),
      },
      generation: input.decision.generation,
    };
  });

  const freshness = lanes.reduce<GatewayLaneObservation['freshness']>(
    (worst, l) => (FRESHNESS_RANK[l.observation.freshness] > FRESHNESS_RANK[worst] ? l.observation.freshness : worst),
    'fresh',
  );

  return {
    schemaVersion: GATEWAY_ADMISSION_STATE_SCHEMA_VERSION,
    generation: input.decision.generation,
    evaluatedAtMs: input.decision.evaluatedAtMs,
    healthState: input.decision.healthState ?? 'unknown',
    lanes,
    reasons: [...(input.decision.reasons ?? []), ...(input.physical?.reasons ?? [])],
    freshness: lanes.length === 0 ? 'unknown' : freshness,
  };
}

/** `GatewayAdmissionProvider` and `PhysicalConstraintProvider` spell Claude differently. */
function providerAlias(provider: GatewayAdmissionProvider): string {
  return provider === 'claude' ? 'anthropic' : provider;
}

/**
 * One provider lane as the RUNNING gateway knows it.
 *
 * `window` comes from `ProviderAdmissionLifecycle` and `inFlight`/`queued` from the
 * lane's `queue.snapshot()` — the two live writers `/admin/config` already reads.
 * Naming them here is what lets the endpoint stop assembling its own answer.
 */
export interface GatewayLiveLaneInput {
  readonly lane: GatewayAdmissionProvider;
  readonly window: number;
  readonly observedPeak: number;
  readonly minimumWindow: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly accountId?: string | null;
  readonly admissionClass?: AdmissionClass;
}

export interface DescribeGatewayLiveStateInput {
  readonly lanes: readonly GatewayLiveLaneInput[];
  readonly generation: number;
  readonly evaluatedAtMs: number;
  readonly healthState?: GatewayAdmissionStateSnapshot['healthState'];
  readonly physical?: PhysicalConstraintVerdict | null;
  readonly bypassKeys?: readonly string[];
  readonly reasons?: readonly string[];
  readonly nowMs?: number;
  readonly freshnessBudgetMs?: number;
}

const WRITER_LIFECYCLE = 'inference-gateway/provider-admission-lifecycle.ts#ProviderAdmissionLifecycle';
const WRITER_LANE_QUEUE = 'inference-gateway/gateway.ts#queue.snapshot';

/**
 * Build the canonical snapshot from the LIVE gateway's own writers.
 *
 * The provider lifecycle keeps ONE adaptive window per lane, so `desiredWindow` and
 * `effectiveWindow` are deliberately the same number here rather than being split to
 * look richer. Reporting a fabricated gap between them would recreate the exact
 * confusion this model exists to end — a reader seeing two different numbers and
 * inferring a suppression that never happened.
 */
export function describeGatewayLiveAdmissionState(
  input: DescribeGatewayLiveStateInput,
): GatewayAdmissionStateSnapshot {
  const decision = {
    schemaVersion: 'capless-controller-v1',
    generation: input.generation,
    evaluatedAtMs: input.evaluatedAtMs,
    healthScopeId: 'inference-gateway',
    healthState: input.healthState ?? 'unknown',
    healthSeverity: 'none',
    reasons: input.reasons ?? [],
    classes: input.lanes.map((lane) => ({
      admissionClass: lane.admissionClass ?? lane.lane,
      desiredWindow: lane.window,
      effectiveWindow: lane.window,
      inFlight: lane.inFlight,
      availableStarts: Math.max(0, lane.window - lane.inFlight),
      paused: false,
      pauseUntilMs: null,
      protected: false,
      healthySamples: 0,
      feedback: [],
    })),
  } as unknown as CaplessControllerDecision;

  // The per-lane queue depth is a real measurement from a DIFFERENT writer than the
  // controller path, so it is re-stamped with that writer rather than inheriting the
  // controller's — otherwise `gateway:status` would attribute a queue number to the
  // lifecycle, and the first person to distrust it would open the wrong file.
  const base = describeGatewayAdmissionState({
    decision,
    physical: input.physical ?? null,
    bypassKeys: input.bypassKeys,
    nowMs: input.nowMs,
    freshnessBudgetMs: input.freshnessBudgetMs,
  });

  const lanes = base.lanes.map((laneState, i) => {
    const live = input.lanes[i]!;
    const laneKey: GatewayLaneKey = {
      admissionClass: live.admissionClass ?? live.lane,
      provider: live.lane,
      accountId: live.accountId ?? null,
    };
    return {
      ...laneState,
      lane: laneKey,
      laneId: gatewayLaneId(laneKey),
      desiredWindow: measure(live.window, WRITER_LIFECYCLE, 'concurrent-requests', 'observed'),
      effectiveWindow: measure(live.window, WRITER_LIFECYCLE, 'concurrent-requests', 'observed'),
      inFlight: measure(live.inFlight, WRITER_LANE_QUEUE, 'concurrent-requests', 'observed'),
      availableStarts: measure(
        Math.max(0, live.window - live.inFlight),
        WRITER_MODEL,
        'concurrent-requests',
        'derived',
      ),
      queue: {
        ...laneState.queue,
        depth: measure(live.queued, WRITER_LANE_QUEUE, 'requests', 'observed'),
      },
    };
  });

  return { ...base, lanes };
}

// ── Projections ──────────────────────────────────────────────────────────────
// Each surface below is a VIEW of the snapshot above, never an independent read.
// They may show different FIELDS; they may never disagree about a shared one.

export interface GatewayLaneProjectionRow {
  readonly laneId: string;
  readonly generation: number;
  readonly freshness: GatewayLaneObservation['freshness'];
  readonly bindingTerm: GatewayLaneBinding['bindingTerm'];
  readonly bindingWriter: string | null;
}

/** Fields every projection must carry, so surfaces are comparable by construction. */
export function projectLaneIdentity(lane: GatewayAdmissionLaneState): GatewayLaneProjectionRow {
  return {
    laneId: lane.laneId,
    generation: lane.generation,
    freshness: lane.observation.freshness,
    bindingTerm: lane.binding.bindingTerm,
    bindingWriter: lane.binding.writer?.writer ?? null,
  };
}

export function projectGatewayStatus(snapshot: GatewayAdmissionStateSnapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    generation: snapshot.generation,
    freshness: snapshot.freshness,
    healthState: snapshot.healthState,
    lanes: snapshot.lanes.map((lane) => ({
      ...projectLaneIdentity(lane),
      desiredWindow: lane.desiredWindow,
      effectiveWindow: lane.effectiveWindow,
      inFlight: lane.inFlight,
      queued: lane.queue.depth,
      paused: lane.paused,
      bindingReason: lane.binding.reason,
    })),
  };
}

export function projectFleetCapacity(snapshot: GatewayAdmissionStateSnapshot) {
  return {
    generation: snapshot.generation,
    freshness: snapshot.freshness,
    lanes: snapshot.lanes.map((lane) => ({
      ...projectLaneIdentity(lane),
      availableStarts: lane.availableStarts,
      inFlight: lane.inFlight,
      queued: lane.queue.depth,
    })),
  };
}

export function projectHealthPanel(snapshot: GatewayAdmissionStateSnapshot) {
  return {
    generation: snapshot.generation,
    freshness: snapshot.freshness,
    healthState: snapshot.healthState,
    lanes: snapshot.lanes.map((lane) => ({
      ...projectLaneIdentity(lane),
      attributions: lane.attributions,
      physical: lane.physical,
      expiresAtMs: lane.observation.expiresAtMs,
    })),
  };
}

/**
 * Alerts fire on lanes that are actually stuck.
 *
 * The condition is deliberately "waiting while starts are available" — work queued
 * with idle capacity is an ADMISSION defect, not a shortage, and no amount of pool
 * headroom fixes it. A lane at its window with a queue is working as designed.
 */
export function projectAlerts(snapshot: GatewayAdmissionStateSnapshot) {
  const stuck = snapshot.lanes.filter(
    (lane) => (lane.queue.depth.value ?? 0) > 0 && (lane.availableStarts.value ?? 0) > 0 && !lane.paused,
  );
  return {
    generation: snapshot.generation,
    freshness: snapshot.freshness,
    alerts: stuck.map((lane) => ({
      ...projectLaneIdentity(lane),
      kind: 'admission-stalled' as const,
      detail: `${lane.queue.depth.value} request(s) queued on ${lane.laneId} while ${lane.availableStarts.value} start(s) are available — an admission defect, not a capacity shortage.`,
    })),
  };
}

export const GATEWAY_STATE_PROJECTIONS = Object.freeze({
  'gateway:status': projectGatewayStatus,
  'fleet:capacity': projectFleetCapacity,
  'health-panel': projectHealthPanel,
  alerts: projectAlerts,
});
