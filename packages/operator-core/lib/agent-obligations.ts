/**
 * Shared, side-effect-free contract for an agent's current obligations.
 *
 * This is deliberately a projection layer, not a new store or queue. Providers
 * read the existing state/effect/plan/report authorities, build typed results
 * here, and hand the SAME evaluated agenda to turn-start and fleet-leader
 * consumers. Operation and admission checks consume the same clearing policy.
 *
 * Plan: shared-agent-obligations-and-briefs-2026-09-05 (P-002, D-010/D-011).
 */
import { createHash } from 'node:crypto';

export const AGENT_OBLIGATION_SCHEMA_VERSION = 'agent-obligations-v1' as const;
export const AGENT_OBLIGATION_DEFAULT_MAX_ENTRIES = 3;
export const AGENT_OBLIGATION_DEFAULT_MAX_ESTIMATED_TOKENS = 400;

/** Awaitable material-change keys shared by policy providers and their existing
 * routine/write-side producers. Keeping builders here prevents a reminder from
 * registering a plausible-looking key no writer actually fires. */
export function goalPlanPlacementChangedKey(goalId: string): string {
  return `goal:plan-placement:${goalId}`;
}

export function planAcceptanceChangedKey(planSlug: string): string {
  return `plan:acceptance:${planSlug}`;
}

export type AgentObligationFamily =
  | 'plan-placement'
  | 'planning-needed'
  | 'owner-report'
  | 'independent-verification'
  /** An open owner turn awaiting disposition (done, or declined with a reason). */
  | 'owner-directive'
  /**
   * An event this session is parked on, or a lock it is queued behind (P-011).
   *
   * "Waiting is itself work": the base contract makes the WAITER responsible for
   * verifying that the thing it waits on is actually progressing. A wait is the
   * one obligation with no local artifact — no held item, no checkpoint, no diff
   * — so it is exactly the one a compaction drops without trace, leaving a
   * session parked on a key nobody will ever fire.
   */
  | 'waiting-on'
  /**
   * A consult opened under `latency_contract:'proceed'` whose ASSUMPTION the
   * originator has not reconciled. 'proceed' lets the agent keep working before
   * the answer arrives, which incurs a debt: if the answer (or its absence)
   * contradicts what was assumed, work built on the assumption must be redone.
   * Until now that debt was an honour-system instruction — no row, no terminal
   * state, so a compaction or a lapsed consult silently dropped it.
   */
  | 'consult-reconciliation'
  /**
   * P-005 / D-030 step 6: a fleet this session leads is under-staffed and nothing
   * will restore it (the headcount governor does not hold it). Rendered on every
   * wake so a leader loop cannot keep recording quiet wakes over an empty fleet;
   * clears when the governor holds the fleet, it reaches target, or it winds down.
   */
  | 'fleet-staffing';
export type AgentObligationStatus = 'due' | 'in-progress' | 'blocked' | 'satisfied' | 'not-applicable' | 'unknown';
export type AgentObligationPriority = 'critical' | 'high' | 'normal' | 'low';
export type AgentObligationFreshness = 'current' | 'stale' | 'unknown';

export interface AgentObligationScope {
  workspaceId: string;
  ownerId: string;
  goalId?: string;
  fleetSlug?: string;
  planSlug?: string;
  workItemId?: string;
}

export type SessionTurnOrigin =
  | 'owner-typed'
  | 'owner-dialog'
  | 'unenrolled-origin'
  | 'agent-injected'
  | 'machine-surface'
  | 'synthetic'
  | 'not-user-turn'
  | 'unknown';

export type AgentObligationAuthority =
  | {
      kind: 'owner';
      sourceRef: string;
      turnOrigin: 'owner-typed' | 'owner-dialog';
    }
  | {
      /** A file-backed CLI turn that could be owner speech, but is not proof. */
      kind: 'owner-candidate';
      sourceRef: string;
      turnOrigin: 'unenrolled-origin' | 'unknown';
    }
  | {
      kind: 'agent';
      sourceRef: string;
      turnOrigin: 'agent-injected' | 'machine-surface' | 'synthetic' | 'not-user-turn';
    }
  | {
      kind: 'policy';
      sourceRef: string;
      revision: string;
    };

export interface AgentObligationEvidence {
  /** Addressable writer output: cell, plan, work-item, event, scorecard, or effect. */
  ref: string;
  observedAt: string;
  freshness: AgentObligationFreshness;
  sourceRevision?: string;
  /** The observed effect that can satisfy a rule; prose acknowledgement is not an effect. */
  effect?: string;
  note?: string;
}

export type AgentObligationActionKind =
  | 'continue'
  | 'claim'
  | 'delegate'
  | 'repair'
  | 'await'
  | 'report'
  | 'verify'
  | 'inspect';

export interface AgentObligationAction {
  kind: AgentObligationActionKind;
  /** Imperative, load-bearing text; renderers place this before optional context. */
  summary: string;
  tool?: string;
  args?: Record<string, unknown>;
  targetRef?: string;
  /**
   * An AGENT-CALLABLE pointer that recovers the content this row had to budget
   * away — rendered verbatim into even the narrowest sink, so it must be a call
   * the reader can make (`orders:get #27`), never an internal symbol.
   *
   * Deliberately NOT `targetRef`: that field is diagnostic provenance and
   * carries internal reader names (`readGoalPlanFleetCohort`,
   * `evaluatePlanAcceptanceGate`) on measurement-failure rows. Rendering it
   * would spend the turn-start sink's scarcest chars on a symbol the agent
   * cannot call.
   */
  recoveryRef?: string;
  resumeWhen?: string;
  /** True when advancing the already-owned item is preferable to taking fresh work. */
  continuesCurrentWork?: boolean;
}

export interface AgentObligationClearingPredicate {
  id: string;
  summary: string;
  evidenceKind: 'effect' | 'delivery' | 'verdict' | 'state';
  sourceRef: string;
}

export interface AgentObligationChangeSignal {
  /** Existing event/watch key, or a stable description when the provider has only a deadline. */
  event?: string;
  nextDeadlineAt?: string;
  cancellationRef?: string;
}

export interface AgentObligationMeasurementFailure {
  code: string;
  detail: string;
  retry: string;
}

export interface AgentObligationBoundaryPolicy {
  /** Stable operation family, for example fleet:launch-on-plan or plans:ship. */
  boundary: string;
  refusalCode: string;
  /** Required means admission and mutation both consult this exact policy. */
  enforcement: 'required' | 'advisory';
  /** Unknown evidence may fail closed only when the existing operation already requires proof. */
  unknown: 'allow-with-warning' | 'refuse';
}

export interface AgentObligationInput {
  ruleId: string;
  ruleRevision: string;
  family: AgentObligationFamily;
  title: string;
  scope: AgentObligationScope;
  responsibleOwnerId: string;
  /** Stable provider-owned episode (deadline cycle, plan revision, or launch attempt). */
  episode: string;
  status: AgentObligationStatus;
  authority: AgentObligationAuthority;
  reason: string;
  priority: AgentObligationPriority;
  /** Lower values are upstream prerequisites and sort before downstream symptoms. */
  causalRank: number;
  /** Count of concrete applicable opportunities, not a mode-time proxy. */
  applicableDemand: number;
  sourceGeneration: string;
  evidence: AgentObligationEvidence[];
  action?: AgentObligationAction;
  clearsWhen: AgentObligationClearingPredicate;
  changeSignal?: AgentObligationChangeSignal;
  boundary?: AgentObligationBoundaryPolicy;
  lastSatisfiedAt?: string;
  dueAt?: string;
  blockedBy?: string[];
  ageMs?: number;
  measurementFailure?: AgentObligationMeasurementFailure;
}

export interface AgentObligation extends AgentObligationInput {
  id: string;
}

export interface AgentObligationAgenda {
  schemaVersion: typeof AGENT_OBLIGATION_SCHEMA_VERSION;
  evaluatedAt: string;
  sourceGeneration: string;
  /** Complete evaluated set, including satisfied/not-applicable controls. */
  evaluations: AgentObligation[];
  /** Ranked actionable set. Renderers may apply a tighter sink-specific cap. */
  primary: AgentObligation[];
  nextDeadlineAt?: string;
  conflicts: string[];
}

export interface AgentObligationDeliveryReceipt {
  sink: string;
  mode: 'truncate' | 'refuse';
  entriesAvailable: number;
  entriesDelivered: number;
  entriesOmitted: number;
  bodyDeliveredChars: number;
  estimatedTokens: number;
  bodyTruncated: boolean;
  refused: boolean;
  reason?: 'entry-cap' | 'character-cap' | 'token-cap';
}

export interface AgentObligationProjection {
  text: string;
  entries: AgentObligation[];
  receipt: AgentObligationDeliveryReceipt;
}

export interface AgentObligationBoundaryVerdict {
  phase: 'admission' | 'operation';
  boundary: string;
  allowed: boolean;
  warning: boolean;
  code?: string;
  reason: string;
  recovery?: AgentObligationAction;
  evidenceRefs: string[];
}

export interface AgentObligationOperation {
  tool: string;
  /** Already normalized by the operation door after resolving defaults/scope. */
  args: Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown, chars = 20): string {
  return createHash('sha256').update(stableJson(value)).digest('hex').slice(0, chars);
}

/**
 * Stable provider generation over canonical writer values. Callers deliberately
 * omit observation clocks before calling this: a per-turn timestamp would make
 * an unchanged agenda look new on every wake and defeat delivery deduplication.
 */
export function agentObligationSourceGeneration(value: unknown): string {
  return digest(value);
}

export function authorityFromTurnOrigin(sourceRef: string, turnOrigin: SessionTurnOrigin): AgentObligationAuthority {
  if (turnOrigin === 'owner-typed' || turnOrigin === 'owner-dialog') {
    return { kind: 'owner', sourceRef, turnOrigin };
  }
  if (turnOrigin === 'unenrolled-origin' || turnOrigin === 'unknown') {
    return { kind: 'owner-candidate', sourceRef, turnOrigin };
  }
  return { kind: 'agent', sourceRef, turnOrigin };
}

export function agentObligationId(
  input: Pick<AgentObligationInput, 'ruleId' | 'ruleRevision' | 'scope' | 'episode'>,
): string {
  return `obl:${input.ruleId}:${digest({
    revision: input.ruleRevision,
    scope: input.scope,
    episode: input.episode,
  })}`;
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`agent obligation ${label} must be non-empty`);
}

/**
 * Validate one provider result at its boundary. Invalid evidence is rejected
 * here rather than repaired by a renderer, so both consumers see the same truth.
 */
export function defineAgentObligation(input: AgentObligationInput): AgentObligation {
  assertNonEmpty(input.ruleId, 'ruleId');
  assertNonEmpty(input.ruleRevision, 'ruleRevision');
  assertNonEmpty(input.title, 'title');
  assertNonEmpty(input.scope.workspaceId, 'scope.workspaceId');
  assertNonEmpty(input.scope.ownerId, 'scope.ownerId');
  assertNonEmpty(input.responsibleOwnerId, 'responsibleOwnerId');
  assertNonEmpty(input.episode, 'episode');
  assertNonEmpty(input.reason, 'reason');
  assertNonEmpty(input.sourceGeneration, 'sourceGeneration');
  assertNonEmpty(input.clearsWhen.id, 'clearsWhen.id');
  assertNonEmpty(input.clearsWhen.summary, 'clearsWhen.summary');
  assertNonEmpty(input.clearsWhen.sourceRef, 'clearsWhen.sourceRef');
  if (!Number.isFinite(input.causalRank) || input.causalRank < 0) {
    throw new Error('agent obligation causalRank must be a non-negative finite number');
  }
  if (!Number.isInteger(input.applicableDemand) || input.applicableDemand < 0) {
    throw new Error('agent obligation applicableDemand must be a non-negative integer');
  }
  if (input.status === 'unknown' && !input.measurementFailure) {
    throw new Error('unknown agent obligation requires a concrete measurementFailure');
  }
  if (input.status !== 'unknown' && input.measurementFailure) {
    throw new Error('measurementFailure is valid only for an unknown agent obligation');
  }
  if (input.status === 'satisfied' && !input.evidence.some((entry) => entry.effect && entry.freshness === 'current')) {
    throw new Error('satisfied agent obligation requires current observed-effect evidence');
  }
  if (
    input.status !== 'satisfied' &&
    input.status !== 'not-applicable' &&
    (!input.action || !input.action.summary.trim())
  ) {
    throw new Error(`${input.status} agent obligation requires a recovery/advance action`);
  }
  if (input.authority.kind === 'owner' && input.authority.turnOrigin === ('unenrolled-origin' as SessionTurnOrigin)) {
    throw new Error('unenrolled-origin cannot be represented as verified owner authority');
  }
  return { ...input, id: agentObligationId(input) };
}

const PRIORITY_RANK: Record<AgentObligationPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const STATUS_RANK: Record<AgentObligationStatus, number> = {
  due: 0,
  'in-progress': 1,
  blocked: 2,
  unknown: 3,
  satisfied: 4,
  'not-applicable': 5,
};

export function agentObligationIsActionable(obligation: AgentObligation): boolean {
  return obligation.status !== 'satisfied' && obligation.status !== 'not-applicable';
}

function timestamp(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** Stable causal ordering; no clock is read inside this function. */
export function compareAgentObligations(a: AgentObligation, b: AgentObligation): number {
  return (
    a.causalRank - b.causalRank ||
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    Number(Boolean(b.action?.continuesCurrentWork)) - Number(Boolean(a.action?.continuesCurrentWork)) ||
    timestamp(a.dueAt) - timestamp(b.dueAt) ||
    b.applicableDemand - a.applicableDemand ||
    (b.ageMs ?? 0) - (a.ageMs ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

function equivalentObligation(a: AgentObligation, b: AgentObligation): boolean {
  return stableJson(a) === stableJson(b);
}

function conflictingObligation(a: AgentObligation, b: AgentObligation): AgentObligation {
  const refs = [...a.evidence, ...b.evidence].filter(
    (entry, index, all) => all.findIndex((candidate) => candidate.ref === entry.ref) === index,
  );
  return {
    ...a,
    status: 'unknown',
    reason: `providers disagreed for ${a.ruleId}; no action or satisfaction may be inferred`,
    evidence: refs,
    action: {
      kind: 'inspect',
      summary: `re-read ${a.ruleId} from its canonical writer before acting`,
      targetRef: a.clearsWhen.sourceRef,
    },
    measurementFailure: {
      code: 'conflicting-provider-results',
      detail: `${a.status} versus ${b.status} for one stable obligation episode`,
      retry: `read ${a.clearsWhen.sourceRef} once and rebuild the shared agenda`,
    },
    sourceGeneration: digest([a.sourceGeneration, b.sourceGeneration]),
  };
}

export function evaluateAgentObligations(
  obligations: readonly AgentObligation[],
  evaluatedAt: string,
): AgentObligationAgenda {
  if (!Number.isFinite(Date.parse(evaluatedAt))) throw new Error('evaluatedAt must be an ISO timestamp');
  const byId = new Map<string, AgentObligation>();
  const conflicts: string[] = [];
  for (const obligation of obligations) {
    const existing = byId.get(obligation.id);
    if (!existing) {
      byId.set(obligation.id, obligation);
      continue;
    }
    if (equivalentObligation(existing, obligation)) continue;
    byId.set(obligation.id, conflictingObligation(existing, obligation));
    conflicts.push(obligation.id);
  }
  const evaluations = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const primary = evaluations.filter(agentObligationIsActionable).sort(compareAgentObligations);
  const deadlines = evaluations
    .flatMap((entry) => [entry.changeSignal?.nextDeadlineAt, entry.dueAt])
    .filter((entry): entry is string => Boolean(entry) && Number.isFinite(Date.parse(entry as string)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    schemaVersion: AGENT_OBLIGATION_SCHEMA_VERSION,
    evaluatedAt,
    sourceGeneration: digest(evaluations.map((entry) => [entry.id, entry.sourceGeneration, entry.status])),
    evaluations,
    primary,
    ...(deadlines[0] ? { nextDeadlineAt: deadlines[0] } : {}),
    conflicts: [...new Set(conflicts)].sort(),
  };
}

function authorityLabel(authority: AgentObligationAuthority): string {
  switch (authority.kind) {
    case 'owner':
      return 'owner';
    case 'owner-candidate':
      return 'possible-owner-source';
    case 'agent':
      return 'agent-source';
    case 'policy':
      return 'policy';
  }
}

/** Load-bearing action first; optional reason/provenance may be clipped later. */
export function formatAgentObligationLine(obligation: AgentObligation, detail: 'full' | 'action' = 'full'): string {
  const action = obligation.action?.summary ?? obligation.clearsWhen.summary;
  // The recovery pointer rides at BOTH detail levels: a narrow sink is exactly
  // where content was budgeted away, so it is where the pointer earns its chars.
  const recovery = obligation.action?.recoveryRef ? `; full: ${obligation.action.recoveryRef}` : '';
  // Goal grading joins the actually emitted row to its provider snapshot. A
  // source/API receipt alone cannot establish which revision reached a turn.
  const identity = obligation.scope.goalId
    ? `; [${obligation.id}@${obligation.sourceGeneration}; ${obligation.ruleRevision}]`
    : '';
  const actionLine = `- [${obligation.status.toUpperCase()}] ${obligation.title} — ${action}${recovery}${identity}`;
  if (detail === 'action') return actionLine;
  const demand = obligation.applicableDemand > 0 ? `; demand ${obligation.applicableDemand}` : '';
  const age = obligation.ageMs != null ? `; age ${Math.max(0, Math.round(obligation.ageMs / 60_000))}m` : '';
  return `${actionLine}; why: ${obligation.reason}${demand}${age}; authority: ${authorityLabel(obligation.authority)} (${obligation.authority.sourceRef})`;
}

export function conservativeTokenEstimate(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Sink-aware bounded rendering with an explicit receipt. `truncate` drops whole
 * trailing entries; `refuse` writes nothing. Callers must inspect the receipt.
 */
export function projectAgentObligationAgenda(input: {
  agenda: AgentObligationAgenda;
  sink: string;
  mode: 'truncate' | 'refuse';
  /** Narrow sinks retain the complete action; reason and authority stay in the full agenda. */
  detail?: 'full' | 'action';
  maxEntries?: number;
  maxChars?: number;
  maxEstimatedTokens?: number;
}): AgentObligationProjection {
  const maxEntries = Math.max(0, input.maxEntries ?? AGENT_OBLIGATION_DEFAULT_MAX_ENTRIES);
  const maxEstimatedTokens = Math.max(0, input.maxEstimatedTokens ?? AGENT_OBLIGATION_DEFAULT_MAX_ESTIMATED_TOKENS);
  const charBudgetFromTokens = maxEstimatedTokens * 4;
  const maxChars = Math.max(0, Math.min(input.maxChars ?? charBudgetFromTokens, charBudgetFromTokens));
  const capped = input.agenda.primary.slice(0, maxEntries);
  const lines = capped.map((entry) => formatAgentObligationLine(entry, input.detail));
  const joined = lines.join('\n');
  const entryCapHit = input.agenda.primary.length > capped.length;
  const charCapHit = joined.length > maxChars;

  if (input.mode === 'refuse' && (entryCapHit || charCapHit)) {
    return {
      text: '',
      entries: [],
      receipt: {
        sink: input.sink,
        mode: input.mode,
        entriesAvailable: input.agenda.primary.length,
        entriesDelivered: 0,
        entriesOmitted: input.agenda.primary.length,
        bodyDeliveredChars: 0,
        estimatedTokens: 0,
        bodyTruncated: false,
        refused: true,
        reason: entryCapHit ? 'entry-cap' : 'character-cap',
      },
    };
  }

  const delivered: AgentObligation[] = [];
  const deliveredLines: string[] = [];
  let chars = 0;
  for (let index = 0; index < capped.length; index += 1) {
    const line = lines[index]!;
    const next = chars + (deliveredLines.length > 0 ? 1 : 0) + line.length;
    if (next > maxChars) break;
    delivered.push(capped[index]!);
    deliveredLines.push(line);
    chars = next;
  }
  const bodyTruncated = delivered.length < input.agenda.primary.length;
  return {
    text: deliveredLines.join('\n'),
    entries: delivered,
    receipt: {
      sink: input.sink,
      mode: input.mode,
      entriesAvailable: input.agenda.primary.length,
      entriesDelivered: delivered.length,
      entriesOmitted: input.agenda.primary.length - delivered.length,
      bodyDeliveredChars: chars,
      estimatedTokens: conservativeTokenEstimate(chars),
      bodyTruncated,
      refused: false,
      ...(bodyTruncated ? { reason: delivered.length === capped.length ? 'entry-cap' : 'character-cap' } : {}),
    },
  };
}

/**
 * One predicate for assignment/admission and the terminal operation. The phase
 * changes attribution only; it cannot change the allow/refuse answer.
 */
export function evaluateAgentObligationBoundary(input: {
  obligation: AgentObligation;
  boundary: string;
  phase: 'admission' | 'operation';
}): AgentObligationBoundaryVerdict {
  const policy = input.obligation.boundary;
  const evidenceRefs = input.obligation.evidence.map((entry) => entry.ref);
  if (!policy || policy.boundary !== input.boundary || policy.enforcement === 'advisory') {
    return {
      phase: input.phase,
      boundary: input.boundary,
      allowed: true,
      warning: Boolean(policy && policy.boundary === input.boundary && agentObligationIsActionable(input.obligation)),
      reason: policy
        ? 'advisory obligation does not refuse this operation'
        : 'obligation does not govern this boundary',
      evidenceRefs,
    };
  }
  if (input.obligation.status === 'satisfied' || input.obligation.status === 'not-applicable') {
    return {
      phase: input.phase,
      boundary: input.boundary,
      allowed: true,
      warning: false,
      reason:
        input.obligation.status === 'satisfied'
          ? `cleared by ${input.obligation.clearsWhen.summary}`
          : 'prerequisite is not applicable to this scope',
      evidenceRefs,
    };
  }
  if (input.obligation.status === 'unknown' && policy.unknown === 'allow-with-warning') {
    return {
      phase: input.phase,
      boundary: input.boundary,
      allowed: true,
      warning: true,
      reason: input.obligation.measurementFailure?.detail ?? 'required evidence is unknown',
      recovery: input.obligation.action,
      evidenceRefs,
    };
  }
  return {
    phase: input.phase,
    boundary: input.boundary,
    allowed: false,
    warning: false,
    code: policy.refusalCode,
    reason:
      input.obligation.status === 'unknown'
        ? (input.obligation.measurementFailure?.detail ?? 'required evidence is unknown')
        : input.obligation.reason,
    recovery: input.obligation.action,
    evidenceRefs,
  };
}

/**
 * Operation-bound variant for obligations whose action is itself the one safe
 * way to clear the prerequisite (for example a GOAL steward launching the
 * provider-selected independently led plan fleet).
 *
 * A plain required-boundary verdict correctly refuses a due obligation, but it
 * cannot distinguish the exact recovery operation from a competing mutation.
 * This comparator admits only the provider-authored tool + argument subset;
 * extra resource choices such as count/model remain the steward's judgment.
 * Satisfied/not-applicable means there is no placement operation to perform,
 * so it refuses an extra launch instead of treating "nothing due" as authority
 * to create more work. Unknown preserves the policy's existing fail-open/fail-
 * closed stance unchanged.
 */
export function evaluateAgentObligationRecoveryBoundary(input: {
  obligation: AgentObligation;
  boundary: string;
  phase: 'admission' | 'operation';
  operation: AgentObligationOperation;
  /**
   * WI-10004401: the requested operation reaches the boundary AFTER the tool has
   * normalized its arguments (e.g. fleet:launch-on-plan clamps `name` to a 60-char
   * slug), while the provider authored its recovery args from the RAW source. An
   * exact compare of one normalized side against one raw side can never be
   * satisfied for any value the normalization changes. The tool passes the SAME
   * normalization it applies itself; it is applied to BOTH sides of every
   * compared key, so the comparison is between equally-normalized values and a
   * genuinely different value still refuses.
   */
  normalizeArg?: (key: string, value: unknown) => unknown;
}): AgentObligationBoundaryVerdict {
  const base = evaluateAgentObligationBoundary(input);
  const policy = input.obligation.boundary;
  if (!policy || policy.boundary !== input.boundary || policy.enforcement === 'advisory') {
    return base;
  }
  if (input.obligation.status === 'unknown') return base;

  const recovery = input.obligation.action;
  const expectedArgs = recovery?.args ?? {};
  const normalize = input.normalizeArg ?? ((_key: string, value: unknown) => value);
  const exactRecovery =
    (input.obligation.status === 'due' || input.obligation.status === 'in-progress') &&
    recovery?.tool === input.operation.tool &&
    Object.entries(expectedArgs).every(
      ([key, expected]) =>
        Object.prototype.hasOwnProperty.call(input.operation.args, key) &&
        stableJson(normalize(key, input.operation.args[key])) === stableJson(normalize(key, expected)),
    );
  if (exactRecovery) {
    return {
      phase: input.phase,
      boundary: input.boundary,
      allowed: true,
      warning: false,
      reason: `operation matches the provider recovery action: ${recovery.summary}`,
      recovery,
      evidenceRefs: input.obligation.evidence.map((entry) => entry.ref),
    };
  }

  const expected = recovery?.tool
    ? `${recovery.tool} ${stableJson(expectedArgs)}`
    : 'no executable recovery operation';
  const requested = `${input.operation.tool} ${stableJson(input.operation.args)}`;
  const noDemand =
    input.obligation.status === 'satisfied' || input.obligation.status === 'not-applicable';
  return {
    phase: input.phase,
    boundary: input.boundary,
    allowed: false,
    warning: false,
    code: policy.refusalCode,
    reason: noDemand
      ? `no canonical recovery operation is currently eligible: ${input.obligation.reason}`
      : `requested operation does not match the provider recovery action; requested ${requested}; expected ${expected}. ${input.obligation.reason}`,
    ...(recovery ? { recovery } : {}),
    evidenceRefs: input.obligation.evidence.map((entry) => entry.ref),
  };
}
