/**
 * DECLARED-GATE RECOVERY CONTRACT — plan declared-gate-recovery-contract-2026-09-21.
 *
 * An announced gate (`events:emit { announce:true }`) is an emitter-side promise:
 * "this key WILL fire — await it". When a waiter's deadline passes on such a key
 * the platform already knows most of the facts needed to say WHY (catalog
 * membership, the unconditional fire latch, declaration history, declarer and
 * successor liveness, a producer-health certificate). What was missing was the
 * ACTION CONTRACT on top of those facts: one deterministic classification per
 * announcement generation, one exact next verb with its target, and an
 * idempotent escalation that can never turn a timeout into success.
 *
 * This module is that contract. It has two halves and deliberately owns no
 * storage of its own (R-004: "add no parallel gate table"):
 *
 *   1. {@link evaluateDeclaredGateGeneration} — PURE. Consumes one announcement
 *      generation plus already-read evidence and returns a bounded result. It
 *      never reads a clock except the `checkedAtMs` it is handed, and it never
 *      infers liveness from wall-clock age alone: liveness comes from the
 *      liveness oracle's verdict, producer progress from
 *      {@link classifyVerifiedWaitTimeout}. Any probe the caller could not
 *      measure arrives as `{ status: 'unavailable' }` and yields `unknown`
 *      (R-001: unknown/failed probes fail OPEN — never takeover, never success).
 *
 *   2. {@link applyDeclaredGateRecovery} — the action bridge. Side effects are
 *      injected, so the ordering/idempotence rules are testable without a
 *      database. Idempotence is the work-item CONDITION SINGLETON
 *      (condition-upsert, migration 741's partial unique index) keyed by
 *      `(announcement id, declaration generation, classification)`, and the
 *      generation CAS is a re-read of the exact key's current declaration
 *      immediately before acting. A duplicate sweep/timeout for the same
 *      triple adopts the incumbent item and performs NO second wake.
 *
 * WHAT THE BRIDGE NEVER DOES (R-002): emit the key, mark a declaration fired,
 * complete a work item, or ship a plan. `already-complete` is reachable ONLY
 * from the exact generation's own `fired_reason='event'` latch with a matching
 * (or undeclared) expected condition — a producer that merely REPORTS
 * completion is `unknown` until the exact key fires.
 *
 * RE-ARM (R-003/R-004): re-awaiting is the WAITER's returned next verb, not a
 * bridge side effect. `events:await` is already idempotent for one subscriber
 * and key (a newer registration supersedes the prior waiter) and the returned
 * `after_generation` pin makes it a CAS against the declaration generation, so
 * duplicate timeout wakes cannot stack re-arms. See plan decision D-001.
 */
import {
  classifyVerifiedWaitTimeout,
  type ProducerHealthCertificate,
  type ProducerHealthObservation,
  type VerifiedWaitTimeoutClassification,
} from './verified-wait';

/** The seven bounded results an ACTIVE announcement generation can have (R-001). */
export type DeclaredGateClassification =
  | 'never-fireable'
  | 'missed-emitter'
  | 'stalled-producer'
  | 'progressing'
  | 'expected-idle'
  | 'unknown'
  | 'already-complete';

export const DECLARED_GATE_CLASSIFICATIONS: readonly DeclaredGateClassification[] = [
  'never-fireable',
  'missed-emitter',
  'stalled-producer',
  'progressing',
  'expected-idle',
  'unknown',
  'already-complete',
];

/** Classes whose next verb is the waiter's own re-await — the bridge takes no action. */
export const REAWAIT_CLASSIFICATIONS: ReadonlySet<DeclaredGateClassification> = new Set([
  'progressing',
  'expected-idle',
  'unknown',
]);

/** Classes that carry an escalation the bridge performs (once per generation). */
export const ACTIONABLE_CLASSIFICATIONS: ReadonlySet<DeclaredGateClassification> = new Set([
  'never-fireable',
  'missed-emitter',
  'stalled-producer',
]);

export type DeclarationGenerationState = 'declared' | 'fired' | 'cancelled' | 'expired' | 'superseded';

export type ExpectedConditionVerdict = 'not-declared' | 'pending' | 'matched' | 'mismatched' | 'invalid';

/** A read the caller performed — or could not perform. Never a silent default. */
export type RecoveryProbe<T> =
  | { status: 'measured'; value: T }
  | { status: 'unavailable'; reason: string };

export interface DeclaredGateAnnouncement {
  /** `harness_shared.event_awaits.id` of the policy='announce' row. */
  id: number;
  eventKey: string;
  /** causal_generation of this declaration (null only for pre-P-018 rows). */
  generation: number | null;
  state: DeclarationGenerationState;
  /** The session that declared the gate (announcement subscriber id). */
  declaredBy: string;
  firedAt: string | null;
  firedReason: string | null;
  expectedCondition: unknown | null;
  expectedVerdict: ExpectedConditionVerdict;
  /** Durable owner selector (fleet-leadership / role) when the declarer bound one. */
  boundTo?: { kind: string; ref: string } | null;
}

export interface DeclaredGateEvidenceInput {
  announcement: DeclaredGateAnnouncement;
  /**
   * The key's CURRENT authoritative declaration generation as read in the same
   * pass. A mismatch with `announcement.generation` means a newer declaration
   * (or a supersession) raced this evaluation.
   */
  currentGeneration: number | null;
  /** Static + installed catalog membership of the exact key. */
  catalog: RecoveryProbe<{ member: boolean; nearMiss: readonly string[] }>;
  /**
   * Fire evidence: the exact key's unconditional latch, its two-segment family
   * siblings, and whether an EARLIER declaration generation of this key fired.
   */
  fireHistory: RecoveryProbe<{
    /** The exact key's unconditional fire latch exists (any earlier fire, declared or not). */
    exactFired: boolean;
    /** Total fires across the key's two-segment family (includes the exact key). */
    familyFires: number;
    priorGenerationFired: boolean;
    lastFiredAt: string | null;
  }>;
  /** Liveness-oracle verdict for the declarer + live successors from durable bindings. */
  ownership: RecoveryProbe<{ declaredByLiveness: string | null; liveSuccessorIds: readonly string[] }>;
  /**
   * Producer-bound waits only: the waiter's producer-health certificate plus the
   * producer family's authoritative observation. `null` = not producer-bound.
   */
  producer: null | RecoveryProbe<{ certificate: ProducerHealthCertificate; observation: ProducerHealthObservation }>;
  checkedAtMs: number;
}

export type RecoveryTargetKind =
  | 'waiter'
  | 'declarer'
  | 'live-declarer'
  | 'live-successor'
  | 'steward-work-item'
  | 'producer-work-item';

export interface RecoveryTarget {
  kind: RecoveryTargetKind;
  /** ownerId / work-item id / condition key; null = the caller itself (the waiter). */
  ref: string | null;
}

export interface RecoveryVerb {
  verb:
    | 'events:await'
    | 'events:cancel'
    | 'events:emit'
    | 'events:status'
    | 'coord:send'
    | 'work_items:claim'
    | 'scheduler:get_next';
  args: Record<string, unknown>;
  target: RecoveryTarget;
}

/** The exact next verb plus any ordered follow-up (R-003). */
export interface RecoveryNextVerb extends RecoveryVerb {
  then?: RecoveryVerb[];
}

export interface DeclaredGateRecoveryEvidence {
  eventKey: string;
  announcementId: number;
  generation: number | null;
  currentGeneration: number | null;
  generationState: DeclarationGenerationState;
  declaredBy: string;
  catalogMembership: DeclaredGateEvidenceInput['catalog'];
  fireHistory: DeclaredGateEvidenceInput['fireHistory'];
  ownerLiveness: DeclaredGateEvidenceInput['ownership'];
  producerHealth:
    | null
    | { status: 'unavailable'; reason: string }
    | {
        status: 'measured';
        producer: ProducerHealthCertificate['producer'];
        owner: ProducerHealthCertificate['owner'];
        verifiedClassification: VerifiedWaitTimeoutClassification | 'before-verification-deadline' | 'verifier-error';
        lastProgressAtMs: number | null;
        lastFireAtMs: number | null;
        state: ProducerHealthObservation['state'] | null;
      };
  expectedCondition: unknown | null;
  expectedVerdict: ExpectedConditionVerdict;
  /** Human-readable reasons, in evaluation order. */
  reasons: string[];
  checkedAtMs: number;
}

export interface DeclaredGateClassifiedResult {
  status: 'classified';
  classification: DeclaredGateClassification;
  nextVerb: RecoveryNextVerb;
  /** Who is escalated to (R-005). Null for waiter-owned verbs. */
  escalationTarget: RecoveryTarget | null;
  /** `declared-gate-recovery:<announcementId>:<generation>:<classification>` — the condition key (R-004). */
  idempotenceKey: string;
  evidence: DeclaredGateRecoveryEvidence;
}

export type DeclaredGateInactiveReason =
  | 'stale-generation'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'fired-expected-mismatch';

/** A generation outside R-001's domain: terminal or already replaced. Never actionable. */
export interface DeclaredGateInactiveResult {
  status: 'inactive';
  reason: DeclaredGateInactiveReason;
  nextVerb: RecoveryNextVerb;
  evidence: DeclaredGateRecoveryEvidence;
}

export type DeclaredGateRecoveryResult = DeclaredGateClassifiedResult | DeclaredGateInactiveResult;

export const DECLARED_GATE_RECOVERY_KEY_PREFIX = 'declared-gate-recovery';

/** The condition-singleton identity for one (announcement, generation, classification). */
export function declaredGateRecoveryKey(
  announcementId: number,
  generation: number | null,
  classification: DeclaredGateClassification,
): string {
  return `${DECLARED_GATE_RECOVERY_KEY_PREFIX}:${announcementId}:${generation ?? 'none'}:${classification}`;
}

function isLiveVerdict(verdict: string | null): boolean {
  return verdict != null && verdict !== 'ended';
}

function statusVerb(eventKey: string, generation: number | null): RecoveryVerb {
  return {
    verb: 'events:status',
    args: generation == null ? { event: eventKey } : { event: eventKey, after_generation: generation },
    target: { kind: 'waiter', ref: null },
  };
}

function reawaitVerb(eventKey: string, generation: number | null): RecoveryVerb {
  return {
    verb: 'events:await',
    args: {
      event: eventKey,
      ...(generation == null ? {} : { after_generation: generation }),
      on_timeout: 'wake',
    },
    target: { kind: 'waiter', ref: null },
  };
}

function producerEvidence(
  producer: DeclaredGateEvidenceInput['producer'],
  verifiedClassification?: VerifiedWaitTimeoutClassification | 'before-verification-deadline' | 'verifier-error',
): DeclaredGateRecoveryEvidence['producerHealth'] {
  if (producer == null) return null;
  if (producer.status === 'unavailable') return { status: 'unavailable', reason: producer.reason };
  const { certificate, observation } = producer.value;
  return {
    status: 'measured',
    producer: certificate.producer,
    owner: certificate.owner,
    verifiedClassification: verifiedClassification ?? 'verifier-error',
    lastProgressAtMs: observation.lastProgressAtMs,
    lastFireAtMs: observation.lastFireAtMs,
    state: observation.state ?? null,
  };
}

/**
 * Classify ONE announcement generation. Pure and total: every input shape
 * returns a result, and no branch reports success without exact fire evidence.
 *
 * Evaluation order (the Design section of the plan):
 *   1. reject a generation that is no longer the key's current one (race);
 *   2. reject terminal generations (cancelled / expired / superseded);
 *   3. exact fire latch of THIS generation + expected condition → already-complete
 *      (a mismatched expected condition is inactive, never success);
 *   4. live ownership (declarer, then durable successors) — a live owner is never
 *      "missed"; producer-bound waits delegate to classifyVerifiedWaitTimeout;
 *   5. no live owner: catalog membership / fire history split missed-emitter
 *      (the key IS fireable, nobody will fire it) from never-fireable (no known
 *      emitter anywhere).
 */
export function evaluateDeclaredGateGeneration(input: DeclaredGateEvidenceInput): DeclaredGateRecoveryResult {
  const a = input.announcement;
  const reasons: string[] = [];
  const baseEvidence = (producerHealth: DeclaredGateRecoveryEvidence['producerHealth']): DeclaredGateRecoveryEvidence => ({
    eventKey: a.eventKey,
    announcementId: a.id,
    generation: a.generation,
    currentGeneration: input.currentGeneration,
    generationState: a.state,
    declaredBy: a.declaredBy,
    catalogMembership: input.catalog,
    fireHistory: input.fireHistory,
    ownerLiveness: input.ownership,
    producerHealth,
    expectedCondition: a.expectedCondition ?? null,
    expectedVerdict: a.expectedVerdict,
    reasons,
    checkedAtMs: input.checkedAtMs,
  });
  const inactive = (reason: DeclaredGateInactiveReason, why: string): DeclaredGateInactiveResult => {
    reasons.push(why);
    return {
      status: 'inactive',
      reason,
      nextVerb: statusVerb(a.eventKey, input.currentGeneration),
      evidence: baseEvidence(producerEvidence(input.producer)),
    };
  };
  const classified = (
    classification: DeclaredGateClassification,
    nextVerb: RecoveryNextVerb,
    escalationTarget: RecoveryTarget | null,
    producerHealth: DeclaredGateRecoveryEvidence['producerHealth'] = producerEvidence(input.producer),
  ): DeclaredGateClassifiedResult => ({
    status: 'classified',
    classification,
    nextVerb,
    escalationTarget,
    idempotenceKey: declaredGateRecoveryKey(a.id, a.generation, classification),
    evidence: baseEvidence(producerHealth),
  });
  const reawait = (
    classification: 'progressing' | 'expected-idle' | 'unknown',
    why: string,
    producerHealth?: DeclaredGateRecoveryEvidence['producerHealth'],
  ) => {
    reasons.push(why);
    return classified(classification, reawaitVerb(a.eventKey, a.generation), null, producerHealth);
  };

  // 1. Generation race: a newer declaration (or a supersession) replaced this one.
  if (a.generation != null && input.currentGeneration != null && a.generation !== input.currentGeneration) {
    return inactive(
      'stale-generation',
      `generation ${a.generation} is not the current declaration generation ${input.currentGeneration}; resync before acting`,
    );
  }
  // 2. Terminal generations are outside the active domain.
  if (a.state === 'superseded') return inactive('superseded', `generation ${a.generation ?? 'none'} was superseded`);
  if (a.state === 'cancelled') return inactive('cancelled', `generation ${a.generation ?? 'none'} was cancelled by its declarer`);
  if (a.state === 'expired') return inactive('expired', `generation ${a.generation ?? 'none'} expired without firing`);

  // 3. Exact fire latch of THIS generation. Only a real emit counts (R-002).
  if (a.state === 'fired') {
    if (a.firedReason !== 'event') {
      return inactive('expired', `generation ${a.generation ?? 'none'} closed with fired_reason='${a.firedReason ?? 'null'}', not an exact event fire`);
    }
    if (a.expectedVerdict === 'mismatched' || a.expectedVerdict === 'invalid') {
      return inactive(
        'fired-expected-mismatch',
        `the exact key fired but its declared expected condition is ${a.expectedVerdict}; a mismatched fire is not success — wait for a fresh generation`,
      );
    }
    reasons.push(`exact generation ${a.generation ?? 'none'} fired at ${a.firedAt ?? 'unknown'} with expected condition ${a.expectedVerdict}`);
    return classified('already-complete', statusVerb(a.eventKey, a.generation), null);
  }

  // 4. Ownership. A failed probe is unknown, never takeover.
  if (input.ownership.status === 'unavailable') {
    return reawait('unknown', `owner liveness unavailable (${input.ownership.reason}); fail open`);
  }
  const { declaredByLiveness, liveSuccessorIds } = input.ownership.value;
  const declarerLive = isLiveVerdict(declaredByLiveness);
  const successorId = liveSuccessorIds.find((id) => id && id !== a.declaredBy) ?? null;
  if (!declarerLive && declaredByLiveness == null && successorId == null) {
    return reawait('unknown', 'the liveness oracle returned no verdict for the declarer and no live successor exists; fail open');
  }

  if (declarerLive || successorId != null) {
    const owner: RecoveryTarget = declarerLive
      ? { kind: 'live-declarer', ref: a.declaredBy }
      : { kind: 'live-successor', ref: successorId };
    reasons.push(
      declarerLive
        ? `declarer ${a.declaredBy} is ${declaredByLiveness}`
        : `declarer ${a.declaredBy} is ${declaredByLiveness ?? 'unverified'}; live successor ${successorId} owns the emitter duty`,
    );
    if (input.producer == null) {
      return reawait('unknown', 'live owner but no producer-health certificate: progress cannot be proven or disproven from age alone');
    }
    if (input.producer.status === 'unavailable') {
      return reawait('unknown', `producer health unavailable (${input.producer.reason}); fail open`);
    }
    const { certificate, observation } = input.producer.value;
    if (observation.checkedAtMs < certificate.verificationDeadlineMs) {
      return reawait(
        'unknown',
        'producer health checked before its verification deadline; the certificate forbids classifying yet',
        producerEvidence(input.producer, 'before-verification-deadline'),
      );
    }
    let verified;
    try {
      verified = classifyVerifiedWaitTimeout(certificate, observation);
    } catch (e) {
      return reawait(
        'unknown',
        `producer verifier rejected the certificate (${e instanceof Error ? e.message : String(e)}); fail open`,
        producerEvidence(input.producer, 'verifier-error'),
      );
    }
    const health = producerEvidence(input.producer, verified.classification);
    switch (verified.classification) {
      case 'progressing':
        return reawait('progressing', 'producer shows authoritative progress within its cadence', health);
      case 'expected-idle':
        return reawait('expected-idle', 'producer is deliberately idle/paused', health);
      case 'unknown':
        return reawait('unknown', 'producer state is inconclusive', health);
      case 'already-complete':
        // R-002: producer completion is NOT exact fire evidence.
        return reawait(
          'unknown',
          'producer reports completion but the exact announced key has not fired this generation — not success; re-await the exact key',
          health,
        );
      case 'stalled':
      case 'absent': {
        reasons.push(`producer ${certificate.producer.kind}:${certificate.producer.id} is ${verified.classification}`);
        const takeoverItem = certificate.owner.workItemId;
        return classified(
          'stalled-producer',
          {
            verb: 'coord:send',
            args: {
              to: [owner.ref],
              wake: 'required',
              expects: 'action',
              summary: `Announced gate ${a.eventKey} (generation ${a.generation ?? 'none'}): producer ${certificate.producer.kind}:${certificate.producer.id} is ${verified.classification}`,
            },
            target: owner,
            then: [
              takeoverItem
                ? { verb: 'work_items:claim', args: { id: takeoverItem }, target: { kind: 'producer-work-item', ref: takeoverItem } }
                : { verb: 'scheduler:get_next', args: {}, target: { kind: 'waiter', ref: null } },
            ],
          },
          owner,
          health,
        );
      }
    }
  }

  // 5. No live owner. Separate "fireable but orphaned" from "nothing can fire it".
  reasons.push(`declarer ${a.declaredBy} is ${declaredByLiveness ?? 'unverified'} and no live successor exists`);
  if (input.catalog.status === 'unavailable') {
    return reawait('unknown', `catalog membership unavailable (${input.catalog.reason}); fail open`);
  }
  if (input.fireHistory.status === 'unavailable') {
    return reawait('unknown', `fire history unavailable (${input.fireHistory.reason}); fail open`);
  }
  const catalog = input.catalog.value;
  const history = input.fireHistory.value;
  const fireable = catalog.member || history.exactFired || history.familyFires > 0 || history.priorGenerationFired;
  const conditionKey = declaredGateRecoveryKey(a.id, a.generation, fireable ? 'missed-emitter' : 'never-fireable');
  if (fireable) {
    reasons.push(
      catalog.member
        ? 'the key is a catalogued family, so an emitter exists but its declared owner is gone'
        : `the key (or its family) has fired before (exact ${history.exactFired}, family fires ${history.familyFires}, prior generation ${history.priorGenerationFired})`,
    );
    const producerItem = input.producer?.status === 'measured' ? input.producer.value.certificate.owner.workItemId : null;
    if (producerItem) {
      // An existing repair item owns the producer: tell its audience, then claim it.
      const steward: RecoveryTarget = { kind: 'producer-work-item', ref: producerItem };
      return classified(
        'missed-emitter',
        {
          verb: 'coord:send',
          args: {
            to: [`@object:work-item:${producerItem}`],
            expects: 'action',
            summary: `Announced gate ${a.eventKey} (generation ${a.generation ?? 'none'}) has no live declarer or successor to fire it`,
          },
          target: steward,
          then: [{ verb: 'work_items:claim', args: { id: producerItem }, target: steward }],
        },
        steward,
      );
    }
    // No live owner and no repair item: the bridge files the steward condition
    // item (keyed by `conditionKey`), which is the claimable escalation. There is
    // nobody live to message, so the waiter's next verb is to pull it.
    const steward: RecoveryTarget = { kind: 'steward-work-item', ref: conditionKey };
    return classified(
      'missed-emitter',
      { verb: 'scheduler:get_next', args: {}, target: steward },
      steward,
    );
  }
  reasons.push('no catalog family, no exact or sibling fire history, and no live emitter duty — nothing is heading toward this key');
  const corrected = catalog.nearMiss[0] ?? null;
  // R-005: with no live owner, the escalation target is the durable condition
  // item the bridge records for this generation (keyed by `conditionKey`) —
  // explicit, never null, exactly like the no-owner missed-emitter path.
  const advisory: RecoveryTarget = { kind: 'steward-work-item', ref: conditionKey };
  return classified(
    'never-fireable',
    {
      verb: 'events:cancel',
      args: a.generation == null ? { announcement_id: a.id } : { announcement_id: a.id, expected_generation: a.generation },
      target: { kind: 'declarer', ref: a.declaredBy },
      then: [
        corrected
          ? { verb: 'events:await', args: { event: corrected, on_timeout: 'wake' }, target: { kind: 'waiter', ref: null } }
          : { verb: 'events:emit', args: { event: a.eventKey, announce: true }, target: { kind: 'declarer', ref: a.declaredBy } },
      ],
    },
    advisory,
  );
}

// ── Action bridge ──────────────────────────────────────────────────────────

export interface DeclaredGateCurrentDeclaration {
  generation: number | null;
  state: DeclarationGenerationState;
}

export interface DeclaredGateRecoveryDeps {
  /** CAS re-read: the key's current (non-superseded) declaration right now. */
  readCurrentDeclaration(eventKey: string): Promise<DeclaredGateCurrentDeclaration | null>;
  /** File-or-adopt the condition singleton (`upsertConditionWorkItem`). */
  upsertCondition(
    conditionKey: string,
    input: { title: string; summary: string; payload: Record<string, unknown> },
  ): Promise<{ id: string | null; created: boolean }>;
  /** One required wake to a live owner (stalled-producer only). */
  wakeOwner(ownerId: string, input: { summary: string; payload: Record<string, unknown> }): Promise<{ queued: number }>;
}

export type DeclaredGateRecoveryActionKind =
  | 'none'
  | 'generation-moved'
  | 'deduplicated'
  | 'advisory-recorded'
  | 'steward-item-filed'
  | 'owner-woken';

export interface DeclaredGateRecoveryAction {
  action: DeclaredGateRecoveryActionKind;
  /** The condition key the action was (or would have been) keyed on. */
  conditionKey: string | null;
  workItemId: string | null;
  /** For a deduplicated stalled-producer: the existing takeover surface, never executed here. */
  surfacedTakeover?: RecoveryVerb[];
  detail: string;
}

function recoveryTitle(result: DeclaredGateClassifiedResult): string {
  const e = result.evidence;
  const gen = e.generation ?? 'none';
  switch (result.classification) {
    case 'never-fireable':
      return `Announced gate ${e.eventKey} (gen ${gen}) can never fire — no catalog family, no fire history, no live emitter`;
    case 'missed-emitter':
      return `Announced gate ${e.eventKey} (gen ${gen}) lost its emitter — declarer ${e.declaredBy} ended with no live successor`;
    case 'stalled-producer':
      return `Announced gate ${e.eventKey} (gen ${gen}) producer is stalled — owner woken, takeover next if still stale`;
    default:
      return `Announced gate ${e.eventKey} (gen ${gen}) — ${result.classification}`;
  }
}

/** Evidence body recorded on the condition item (R-005). */
export function declaredGateRecoverySummary(result: DeclaredGateClassifiedResult): string {
  const e = result.evidence;
  const fmt = (v: unknown) => JSON.stringify(v);
  const next = [result.nextVerb, ...(result.nextVerb.then ?? [])]
    .map((v) => `${v.verb} ${fmt(v.args)} → ${v.target.kind}${v.target.ref ? `:${v.target.ref}` : ''}`)
    .join(' ; then ');
  return [
    `Declared-gate recovery classified announcement #${e.announcementId} for \`${e.eventKey}\` as **${result.classification}**.`,
    '',
    `- generation: ${e.generation ?? 'none'} (current ${e.currentGeneration ?? 'none'}, state ${e.generationState})`,
    `- declared by: ${e.declaredBy}`,
    `- catalog membership: ${fmt(e.catalogMembership)}`,
    `- fire latch/history: ${fmt(e.fireHistory)}`,
    `- owner liveness: ${fmt(e.ownerLiveness)}`,
    `- producer health: ${fmt(e.producerHealth)}`,
    `- expected condition: ${fmt(e.expectedCondition)} (${e.expectedVerdict})`,
    `- escalation target: ${result.escalationTarget ? `${result.escalationTarget.kind}:${result.escalationTarget.ref}` : 'none (waiter-owned)'}`,
    `- next verb: ${next}`,
    `- reasons: ${e.reasons.join(' | ')}`,
    '',
    'This record never marks the gate fired, completes work, or ships a plan: a timeout stays a timeout until the exact key fires.',
  ].join('\n');
}

/**
 * Perform the classification's escalation exactly once per
 * (announcement, generation, classification). Waiter-owned and inactive
 * results are returned untouched (`action: 'none'`).
 */
export async function applyDeclaredGateRecovery(
  result: DeclaredGateRecoveryResult,
  deps: DeclaredGateRecoveryDeps,
): Promise<DeclaredGateRecoveryAction> {
  if (result.status === 'inactive') {
    return { action: 'none', conditionKey: null, workItemId: null, detail: `inactive generation (${result.reason})` };
  }
  if (!ACTIONABLE_CLASSIFICATIONS.has(result.classification)) {
    return {
      action: 'none',
      conditionKey: null,
      workItemId: null,
      detail: `${result.classification} is waiter-owned: ${result.nextVerb.verb}`,
    };
  }
  const e = result.evidence;
  // Generation CAS: act only while THIS generation is still the declared one.
  const current = await deps.readCurrentDeclaration(e.eventKey);
  if (!current || current.state !== 'declared' || current.generation !== e.generation) {
    return {
      action: 'generation-moved',
      conditionKey: result.idempotenceKey,
      workItemId: null,
      detail: `declaration moved to generation ${current?.generation ?? 'none'} (${current?.state ?? 'absent'}) before acting`,
    };
  }
  const upsert = await deps.upsertCondition(result.idempotenceKey, {
    title: recoveryTitle(result),
    summary: declaredGateRecoverySummary(result),
    payload: {
      declaredGateRecovery: {
        classification: result.classification,
        idempotenceKey: result.idempotenceKey,
        escalationTarget: result.escalationTarget,
        nextVerb: result.nextVerb,
        evidence: result.evidence,
      },
    },
  });
  if (!upsert.created) {
    return {
      action: 'deduplicated',
      conditionKey: result.idempotenceKey,
      workItemId: upsert.id,
      ...(result.classification === 'stalled-producer' && result.nextVerb.then
        ? { surfacedTakeover: result.nextVerb.then }
        : {}),
      detail: 'this generation+classification was already handled; no second wake or filing',
    };
  }
  if (result.classification === 'stalled-producer') {
    const ownerId = result.escalationTarget?.ref ?? null;
    if (!ownerId) {
      return {
        action: 'steward-item-filed',
        conditionKey: result.idempotenceKey,
        workItemId: upsert.id,
        detail: 'stalled producer had no resolvable live owner id; the condition item is the escalation',
      };
    }
    const wake = await deps.wakeOwner(ownerId, {
      summary: String(result.nextVerb.args.summary ?? recoveryTitle(result)),
      payload: { declaredGateRecovery: result.idempotenceKey, workItemId: upsert.id, evidence: e },
    });
    return {
      action: 'owner-woken',
      conditionKey: result.idempotenceKey,
      workItemId: upsert.id,
      detail: `woke ${result.escalationTarget?.kind} ${ownerId} (queued ${wake.queued}); takeover is surfaced on the next sweep if still stale`,
    };
  }
  return {
    action: result.classification === 'missed-emitter' ? 'steward-item-filed' : 'advisory-recorded',
    conditionKey: result.idempotenceKey,
    workItemId: upsert.id,
    detail:
      result.classification === 'missed-emitter'
        ? 'filed the steward work item that owns re-emitting or retiring this gate'
        : 'recorded the never-fireable advisory; no wake and no takeover',
  };
}
