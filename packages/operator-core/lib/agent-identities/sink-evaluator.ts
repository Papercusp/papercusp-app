/**
 * Aggregate bounded synchronous evaluation of identity contributions at a sink
 * (portable-identity-packages-2026-09-26 P-010; D-009).
 *
 * ONE sink invocation owns ONE token budget and ONE wall-clock deadline, and
 * every identity contributing at that sink shares them. Contributions declare a
 * REQUEST (`injection.tokenBudget`, `injection.priority`); the host turns the
 * requests into allowances in deterministic priority order, so:
 *
 *   - adding providers can never multiply the sink allowance — a contribution
 *     ranked after the budget is spent gets nothing and is never started
 *     (PORTABLE-P-010's falsifier);
 *   - the per-turn host ceiling caps the sum across every sink invocation of
 *     one turn, so N sinks cannot multiply it either;
 *   - each session may have at most `perSessionConcurrency` provider calls in
 *     flight, and a slot is released only when the provider's promise SETTLES,
 *     so work that ignores its abort signal stays counted against its session's
 *     admission cap until it actually stops, instead of becoming an unbounded
 *     orphan. There is deliberately no host-wide capacity figure here (D-017):
 *     host in-flight is at most that policy times the live sessions, and
 *     launched sessions are the units the resource Governor already admits;
 *   - nothing queued or nested begins after the deadline;
 *   - a result is fenced to its session, turn, invocation and attachment
 *     revision, so a late or superseded result reaches neither this turn's
 *     injection nor any cache for turn N+1.
 *
 * Failure is visible and bounded: every contribution the host did not deliver
 * yields an omission row with a reason and a short marker, never silence.
 *
 * The declaration vocabulary (`InjectionPoint`) lives in
 * `@papercusp/orchestrator/blueprint` beside the blueprint schema.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { HookContextSink, InjectionPoint, PackageRenderableSink } from '@papercusp/orchestrator/blueprint';

/** What the host allocates from: a declared injection point, or a sync rule's context request (P-011). */
export type SinkInjectionRequest = Pick<InjectionPoint, 'tokenBudget' | 'priority' | 'overBudget'>;

/** Same approximation the rest of operator-core uses for prompt text. */
export function estimateSinkTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export interface SinkBudget {
  readonly tokens: number;
  readonly wallClockMs: number;
}

export interface SinkHostLimits {
  /** One aggregate budget per sink invocation, shared by every identity. */
  readonly sinkBudget: SinkBudget;
  /** Ceiling across every sink invocation of one (session, turn). */
  readonly turnCeiling: SinkBudget;
  /** Hard admission cap for one session's in-flight provider calls, cooperative or not. */
  readonly perSessionConcurrency: number;
}

export const DEFAULT_SINK_HOST_LIMITS: SinkHostLimits = Object.freeze({
  sinkBudget: Object.freeze({ tokens: 400, wallClockMs: 750 }),
  turnCeiling: Object.freeze({ tokens: 800, wallClockMs: 1_500 }),
  perSessionConcurrency: 2,
});

/** What a provider is handed for one call. */
export interface SinkProviderCall {
  /** Aborted at the invocation deadline, on supersession, or when the caller detaches. */
  readonly signal: AbortSignal;
  /** Tokens the host granted THIS contribution; output beyond it is truncated or omitted. */
  readonly tokenAllowance: number;
  readonly deadlineAt: number;
  /**
   * The only sanctioned way to start nested host work. Refuses (rejects with
   * {@link SinkDeadlineError}) once the invocation is aborted, so a provider
   * cannot begin new work after the deadline; nested work shares the parent's
   * signal and allowance, so it cannot multiply either.
   */
  readonly nested: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}

export interface SinkContributionRequest {
  readonly identityId: string;
  readonly contributionId: string;
  readonly injection: SinkInjectionRequest;
  readonly produce: (call: SinkProviderCall) => Promise<string>;
}

export interface SinkInvocationIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly invocationId: string;
  /** A package-renderable sink, or a sync rule's hook context sink (P-011, D-023 §4). */
  readonly sink: PackageRenderableSink | HookContextSink;
  /** The wearer's attachment/activation revision this invocation evaluated against. */
  readonly attachmentRevision: string;
}

export type SinkOmissionReason =
  | 'budget-exhausted'
  | 'queued-past-deadline'
  | 'deadline'
  | 'over-budget'
  | 'superseded'
  | 'provider-error'
  | 'detached';

export interface SinkDelivery {
  readonly identityId: string;
  readonly contributionId: string;
  readonly priority: number;
  readonly allowance: number;
  readonly tokens: number;
  readonly truncated: boolean;
  readonly text: string;
}

export interface SinkOmission {
  readonly identityId: string;
  readonly contributionId: string;
  readonly priority: number;
  readonly allowance: number;
  readonly reason: SinkOmissionReason;
  /** Bounded visible marker a sink renders in place of the missing output. */
  readonly marker: string;
  readonly detail?: string;
}

export interface SinkInvocationResult {
  readonly invocation: SinkInvocationIdentity;
  /** The effective aggregate budget after the turn ceiling was applied. */
  readonly budget: { readonly tokens: number; readonly wallClockMs: number; readonly deadlineAt: number };
  /** Allocation in priority order; the sum of allowances never exceeds `budget.tokens`. */
  readonly allocation: readonly { readonly identityId: string; readonly contributionId: string; readonly allowance: number }[];
  readonly deliveredTokens: number;
  /** Wall-clock this invocation took; charged to the turn ceiling. */
  readonly elapsedMs: number;
  readonly deliveries: readonly SinkDelivery[];
  readonly omissions: readonly SinkOmission[];
  /** Provider calls actually started by this invocation. */
  readonly started: number;
  /** Peak concurrent provider calls this invocation observed for its session. */
  readonly peakSessionInFlight: number;
  /** Calls still running when the invocation returned (they keep their host slot until they settle). */
  readonly unsettledAtReturn: number;
}

export class SinkDeadlineError extends Error {
  constructor(message = 'sink invocation deadline passed; no new host work may start') {
    super(message);
    this.name = 'SinkDeadlineError';
  }
}

/** FIFO counting semaphore whose waiters give up at the invocation deadline. */
class Semaphore {
  inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(public limit: number) {}

  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.inFlight += 1;
        resolve(true);
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next && this.inFlight < this.limit) next();
  }

  get idle(): boolean {
    return this.inFlight === 0 && this.waiters.length === 0;
  }
}

interface TurnLedgerEntry {
  tokensSpent: number;
  /**
   * Wall-clock the turn's sink invocations have taken, summed. The ceiling
   * meters time the hooks ADD to a turn, not time since the turn began: a stop
   * sink a minute into the turn has spent nothing yet (P-011, D-024).
   */
  msSpent: number;
  touchedAt: number;
}

const TURN_LEDGER_MAX = 2_048;
const TURN_LEDGER_TTL_MS = 30 * 60_000;

const state = pinModuleState('@papercusp/operator-core.agent-identities.sink-evaluator', () => ({
  sessions: new Map<string, Semaphore>(),
  turns: new Map<string, TurnLedgerEntry>(),
}));

function sessionSemaphore(sessionId: string, limit: number): Semaphore {
  let semaphore = state.sessions.get(sessionId);
  if (!semaphore) {
    semaphore = new Semaphore(limit);
    state.sessions.set(sessionId, semaphore);
  }
  semaphore.limit = limit;
  return semaphore;
}

function turnLedger(sessionId: string, turnId: string, now: number): TurnLedgerEntry {
  const key = `${sessionId}\u0000${turnId}`;
  let entry = state.turns.get(key);
  if (!entry) {
    for (const [staleKey, stale] of state.turns) {
      if (state.turns.size < TURN_LEDGER_MAX && now - stale.touchedAt < TURN_LEDGER_TTL_MS) break;
      state.turns.delete(staleKey);
    }
    entry = { tokensSpent: 0, msSpent: 0, touchedAt: now };
    state.turns.set(key, entry);
  }
  entry.touchedAt = now;
  return entry;
}

/** Live admission state — non-cooperative work stays visible here until it settles. */
export function sinkHostStatus(): { hostInFlight: number; sessionsInFlight: Record<string, number> } {
  const sessionsInFlight: Record<string, number> = {};
  let hostInFlight = 0;
  for (const [sessionId, semaphore] of state.sessions) {
    if (!semaphore.inFlight) continue;
    sessionsInFlight[sessionId] = semaphore.inFlight;
    hostInFlight += semaphore.inFlight;
  }
  return { hostInFlight, sessionsInFlight };
}

/** Test seam: drop the turn ledger and idle semaphores (never resets in-flight work). */
export function resetSinkEvaluatorForTests(): void {
  state.turns.clear();
  for (const [sessionId, semaphore] of state.sessions) if (semaphore.idle) state.sessions.delete(sessionId);
}

const MARKER_DETAIL_MAX = 80;
function omissionMarker(identityId: string, contributionId: string, reason: SinkOmissionReason): string {
  return `⟦${identityId}/${contributionId} omitted: ${reason}⟧`.slice(0, 160);
}

/** Deterministic priority order: priority desc, then identity, then contribution id. */
export function orderSinkContributions<T extends Pick<SinkContributionRequest, 'identityId' | 'contributionId' | 'injection'>>(
  contributions: readonly T[],
): T[] {
  return contributions.slice().sort((a, b) =>
    b.injection.priority - a.injection.priority ||
    (a.identityId < b.identityId ? -1 : a.identityId > b.identityId ? 1 : 0) ||
    (a.contributionId < b.contributionId ? -1 : a.contributionId > b.contributionId ? 1 : 0));
}

/**
 * PURE: turn declared requests into allowances. Greedy in priority order over
 * ONE shared pool — the sum of allowances is at most `tokens`, whatever the
 * number of contributions or the size of their requests.
 */
export function allocateSinkBudget<T extends Pick<SinkContributionRequest, 'identityId' | 'contributionId' | 'injection'>>(
  contributions: readonly T[],
  tokens: number,
): Array<{ contribution: T; allowance: number }> {
  let remaining = Math.max(0, Math.floor(tokens));
  return orderSinkContributions(contributions).map((contribution) => {
    const allowance = Math.min(contribution.injection.tokenBudget, remaining);
    remaining -= allowance;
    return { contribution, allowance };
  });
}

function truncateToTokens(text: string, allowance: number): string {
  const suffix = ' …⟦truncated⟧';
  const maxChars = allowance * 4;
  if (maxChars <= suffix.length) return '';
  return text.slice(0, maxChars - suffix.length).trimEnd() + suffix;
}

export interface EvaluateSinkInvocationInput {
  readonly invocation: SinkInvocationIdentity;
  readonly contributions: readonly SinkContributionRequest[];
  readonly limits?: SinkHostLimits;
  /**
   * The wearer's CURRENT attachment revision. Read once per settled result; a
   * mismatch with `invocation.attachmentRevision` fences that result out.
   */
  readonly currentAttachmentRevision: () => string;
  /** The caller detached (e.g. the hook's response wall); cancels host calls. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /**
   * What this turn already spent on OTHER hosts (P-011, D-024): the process
   * ledger charges at least these tokens and this much sink wall-clock.
   */
  readonly turnSpent?: { readonly tokensSpent: number; readonly msSpent: number };
}

/**
 * Evaluate every contribution due at one sink invocation under ONE aggregate
 * budget. Never throws for provider failure: failure is an omission row.
 */
export async function evaluateSinkInvocation(input: EvaluateSinkInvocationInput): Promise<SinkInvocationResult> {
  const limits = input.limits ?? DEFAULT_SINK_HOST_LIMITS;
  const now = input.now ?? Date.now;
  const start = now();
  const { sessionId, turnId, attachmentRevision } = input.invocation;
  const ledger = turnLedger(sessionId, turnId, start);
  if (input.turnSpent) {
    ledger.tokensSpent = Math.max(ledger.tokensSpent, input.turnSpent.tokensSpent);
    ledger.msSpent = Math.max(ledger.msSpent, input.turnSpent.msSpent);
  }
  const turnTokensLeft = Math.max(0, limits.turnCeiling.tokens - ledger.tokensSpent);
  const turnMsLeft = Math.max(0, limits.turnCeiling.wallClockMs - ledger.msSpent);
  const budgetMs = Math.min(limits.sinkBudget.wallClockMs, turnMsLeft);
  // A turn with no time left has no budget at all: nothing starts, rather than
  // racing a zero-length timer that a fast provider could beat.
  const budgetTokens = budgetMs > 0 ? Math.min(limits.sinkBudget.tokens, turnTokensLeft) : 0;
  const deadlineAt = start + budgetMs;

  const session = sessionSemaphore(sessionId, limits.perSessionConcurrency);
  const controller = new AbortController();
  const abort = (reason: SinkOmissionReason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const timer = setTimeout(() => abort('deadline'), budgetMs);
  timer.unref?.();
  const onDetach = () => abort('detached');
  input.signal?.addEventListener('abort', onDetach, { once: true });
  if (input.signal?.aborted) abort('detached');

  const allocation = allocateSinkBudget(input.contributions, budgetTokens);
  const deliveries: SinkDelivery[] = [];
  const omissions: SinkOmission[] = [];
  const omit = (c: SinkContributionRequest, allowance: number, reason: SinkOmissionReason, detail?: string) =>
    omissions.push({
      identityId: c.identityId, contributionId: c.contributionId, priority: c.injection.priority, allowance, reason,
      marker: omissionMarker(c.identityId, c.contributionId, reason),
      ...(detail ? { detail: detail.slice(0, MARKER_DETAIL_MAX) } : {}),
    });
  let started = 0;
  let unsettled = 0;
  let peakSessionInFlight = 0;
  const abortReason = (): SinkOmissionReason =>
    (controller.signal.reason as SinkOmissionReason | undefined) ?? 'deadline';

  const tasks = allocation.map(async ({ contribution, allowance }) => {
    if (allowance <= 0) {
      omit(contribution, 0, 'budget-exhausted');
      return;
    }
    // Admission: a waiter still queued at the deadline gives up — nothing
    // queued begins after it.
    if (!(await session.acquire(controller.signal))) {
      omit(contribution, allowance, controller.signal.reason === 'detached' ? 'detached' : 'queued-past-deadline');
      return;
    }
    started += 1;
    unsettled += 1;
    peakSessionInFlight = Math.max(peakSessionInFlight, session.inFlight);
    const call: SinkProviderCall = {
      signal: controller.signal,
      tokenAllowance: allowance,
      deadlineAt,
      nested: async (work) => {
        if (controller.signal.aborted) throw new SinkDeadlineError();
        return work(controller.signal);
      },
    };
    let text: string;
    try {
      text = await Promise.resolve().then(() => contribution.produce(call));
    } catch (error) {
      if (controller.signal.aborted) omit(contribution, allowance, abortReason());
      else omit(contribution, allowance, 'provider-error', error instanceof Error ? error.message : String(error));
      return;
    } finally {
      // Released only when the provider's own promise settles: work that ignored
      // its signal keeps occupying the admission cap until it actually stops.
      unsettled -= 1;
      session.release();
    }
    // Late-result fence: a result that settles after the deadline, or against
    // a superseded attachment, is dropped — not injected, not cached.
    if (controller.signal.aborted) return omit(contribution, allowance, abortReason());
    if (input.currentAttachmentRevision() !== attachmentRevision) return omit(contribution, allowance, 'superseded');
    const tokens = estimateSinkTokens(text);
    if (tokens <= allowance) {
      deliveries.push({ identityId: contribution.identityId, contributionId: contribution.contributionId,
        priority: contribution.injection.priority, allowance, tokens, truncated: false, text });
      return;
    }
    if (contribution.injection.overBudget === 'omit') return omit(contribution, allowance, 'over-budget');
    const clipped = truncateToTokens(text, allowance);
    if (!clipped) return omit(contribution, allowance, 'over-budget');
    deliveries.push({ identityId: contribution.identityId, contributionId: contribution.contributionId,
      priority: contribution.injection.priority, allowance, tokens: estimateSinkTokens(clipped), truncated: true,
      text: clipped });
  });

  // Tasks that ignore their signal must not hold the sink past its deadline.
  const deadline = new Promise<void>((resolve) => {
    if (controller.signal.aborted) resolve();
    else controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await Promise.race([Promise.allSettled(tasks).then(() => undefined), deadline]);
  clearTimeout(timer);
  input.signal?.removeEventListener('abort', onDetach);
  if (!controller.signal.aborted) controller.abort('settled');

  // Anything neither delivered nor omitted by now is still running past the deadline.
  const accounted = new Set([...deliveries, ...omissions].map((row) => `${row.identityId}\u0000${row.contributionId}`));
  for (const { contribution, allowance } of allocation) {
    if (!accounted.has(`${contribution.identityId}\u0000${contribution.contributionId}`)) {
      omit(contribution, allowance, 'deadline');
    }
  }
  const order = new Map(allocation.map(({ contribution }, index) =>
    [`${contribution.identityId}\u0000${contribution.contributionId}`, index]));
  const rank = (row: { identityId: string; contributionId: string }) =>
    order.get(`${row.identityId}\u0000${row.contributionId}`) ?? 0;
  deliveries.sort((a, b) => rank(a) - rank(b));
  omissions.sort((a, b) => rank(a) - rank(b));
  const deliveredTokens = deliveries.reduce((sum, row) => sum + row.tokens, 0);
  const elapsedMs = Math.max(0, now() - start);
  ledger.tokensSpent += deliveredTokens;
  ledger.msSpent += elapsedMs;
  if (session.idle) state.sessions.delete(sessionId);
  return {
    invocation: input.invocation,
    budget: { tokens: budgetTokens, wallClockMs: budgetMs, deadlineAt },
    allocation: allocation.map(({ contribution, allowance }) => ({
      identityId: contribution.identityId, contributionId: contribution.contributionId, allowance })),
    deliveredTokens,
    elapsedMs,
    deliveries: [...deliveries],
    omissions: [...omissions],
    started,
    peakSessionInFlight,
    unsettledAtReturn: unsettled,
  };
}

/**
 * The generation fence for CONSUMERS: a cached or queued result is usable only
 * for the exact session, turn and attachment revision it was evaluated under.
 */
export function isSinkResultCurrent(
  result: Pick<SinkInvocationResult, 'invocation'>,
  current: { sessionId: string; turnId: string; attachmentRevision: string },
): boolean {
  return result.invocation.sessionId === current.sessionId &&
    result.invocation.turnId === current.turnId &&
    result.invocation.attachmentRevision === current.attachmentRevision;
}
