/**
 * Jev on the memory push path (plan jev-decision-model-integration-2026-09-29,
 * P-007 Log only; P-008 On). The owner's switch lives in jev-settings.ts (D-008).
 *
 * Decision D-012 measured this filter with the memory text in `state` and did
 * NOT adopt it: about 1 in 10 answers flipped when the candidate order was
 * reversed. D-013 re-measured it with the memory text inside each question
 * (`instructions`) and it met the full D-007 bar: order flip 1.9%, 0 to 1 of 30
 * hard-negative queries admitting anything vs 8 of 30 for the floor alone, no
 * measurable recall loss. The mode stays the owner's choice (default Off). The
 * contract:
 *
 *  - effective `off` (mode off, OR no key stored) makes ZERO decision calls and
 *    returns before building anything, so the injection block is byte-identical
 *    to the pre-Jev system (D-009, pinned in jev-memory-gate.test.ts).
 *  - `shadow` (Log only) fires ONE request per turn and does not wait for it.
 *    Injection is never delayed or changed; the decision client's ledger hook
 *    records the call, including every P(yes), in decision_model_calls
 *    (consumer `memory-injection`). A would-drop is any P(yes) below the threshold.
 *    Each request runs under the bound On would wait for, and where On would have
 *    no time to wait, Log only makes no call either, so the ledger shows the
 *    timeout rate On would see.
 *  - `on` waits for the answer for what the caller has left, up to
 *    JEV_MEMORY_TIMEOUT_MS (see jevMemoryWaitMs / jevMemoryBudgetMs), and returns
 *    which candidates to keep. Any inconclusive outcome (timeout, error, no key,
 *    malformed answer, no time to wait) fails OPEN: the caller keeps every
 *    candidate (D-002).
 *
 * Jev only filters; it never reorders and never authorizes anything (D-001).
 */
import { createHash } from 'node:crypto';

import type { Cache } from '@papercusp/cache';
import { JEV_PINNED_MODEL, type DecisionClient } from '@papercusp/decision-model';

import { getOperatorCache } from '../cache/instance';
import { activeWorkspaceId } from '../workspace-registry';
import { judgeAdmission, type AdmissionDecide, type AdmissionEncoding, type AdmissionVariant } from './jev-admission-request';
import type { JevFunnelEntry } from './recall-stats';
import {
  ensureJevDecisionClient,
  getJevMode,
  JEV_MEMORY_TIMEOUT_MS,
  resolveJevMemoryInjection,
  type JevMemoryInjectionResolution,
} from './jev-settings';

/** The ledger consumer label for push-path calls (the bench uses `memory-bench`). */
export const JEV_MEMORY_CONSUMER = 'memory-injection';

/**
 * The operating point production runs: the production floor, then keep a candidate
 * when Jev's P(yes) >= 0.35, with the memory text inside each yes-no question.
 * D-013 (plan jev-decision-model-integration-2026-09-29) adopted v1 at 0.3; D-004
 * (plan jev-performance-improvements-2026-09-30) replaced it with v2-content at
 * 0.35, the threshold v2-content's own admission run selected. Changing any of
 * threshold, encoding or variant invalidates those measurements; re-run
 * bench/jev-admission-cli and bench/jev-robustness-cli before keeping a new one.
 */
export const JEV_MEMORY_ADMIT_THRESHOLD = 0.35;
export const JEV_MEMORY_ENCODING: AdmissionEncoding = 'instructions';
/**
 * The question variant production asks: v2-content, which judges the facts in the
 * memory rather than its claims about itself (D-004: self-promoting memories got
 * through 1.8% of the time against v1's 31.4%, with recall and cost unchanged).
 */
export const JEV_MEMORY_VARIANT: AdmissionVariant = 'v2-content';

/**
 * Ports where the owner's On does NOT wait for Jev: the gate runs Log only there
 * (WI-10004485). The mid-turn hook gives the whole recall 1,500 ms
 * (apps/operator/scripts/hooks/inject/ports.mjs) and live mid-turn recalls already
 * ran past that wall about a quarter of the time before any Jev wait; an awaited
 * call adds ~200 ms in series. Turn-start (2,500 ms) and initialize keep On.
 * Measured 2026-10-01 on live Log-only traffic: Jev's mid-turn drops were ~99%
 * correct, so this is a latency call, not a quality one; revisit once the
 * in-process timeouts (EI-24748208098755918) are fixed.
 */
export const JEV_MEMORY_NO_WAIT_PORTS: ReadonlySet<string> = new Set(['mid-turn']);

/**
 * Below this a port that would wait for Jev does not (it runs Log only for that
 * call). Jev's answered median from a quiet process was 178-258 ms on 2026-10-01,
 * so a shorter wait would mostly time out and only add latency (WI-10004485).
 */
export const JEV_MEMORY_MIN_WAIT_MS = 150;

/**
 * What a caller keeps back from its client's wall for the work after Jev answers
 * (filter, render, last-surfaced stamp, response) and for slack. The slow-recall
 * log measured that tail (`postMs`) at tens of ms; the rest is margin for worker
 * stalls, which ran to 1-2 s on 2026-10-01 (EI-24748208098755918). [inferred]
 */
export const JEV_MEMORY_RESPONSE_MARGIN_MS = 250;

/**
 * How long a port that waits for Jev may wait, given the time its caller can still
 * use (`budgetMs`, already net of {@link JEV_MEMORY_RESPONSE_MARGIN_MS}): the full
 * {@link JEV_MEMORY_TIMEOUT_MS} when there is no wall, otherwise whatever is left of
 * it up to that cap. `null` when less than {@link JEV_MEMORY_MIN_WAIT_MS} is left:
 * a wait that long would push the whole memory block past the client's wall,
 * which loses more than the filter gains. A fixed longer bound was rejected for
 * that reason: a fifth of recalls already took over 1.5 s before any Jev wait.
 */
export function jevMemoryWaitMs(budgetMs: number | undefined): number | null {
  if (budgetMs === undefined || Number.isNaN(budgetMs)) return JEV_MEMORY_TIMEOUT_MS;
  const bound = Math.min(JEV_MEMORY_TIMEOUT_MS, Math.floor(budgetMs));
  return bound >= JEV_MEMORY_MIN_WAIT_MS ? bound : null;
}

/**
 * The `budgetMs` a waiting port can give Jev, net of
 * {@link JEV_MEMORY_RESPONSE_MARGIN_MS}: the smaller of what is left of the client's
 * wall (`respondByMs`, epoch ms) and what is left of the memory build's own deadline
 * (`deadlineRemainingMs`). Undefined when neither is finite (no bound: the full cap).
 *
 * The build deadline binds as often as the wall does. Turn-start's build runs under
 * a 2,000 ms deadline (injection-block-cache MEMORY_BLOCK_COLD_DEADLINE_MS) inside a
 * 2,500 ms hook wall, so the deadline always ends first. Sized from the wall alone,
 * a Jev wait was cut off by that deadline in On, while Log only, which waits for
 * nothing, let the same call run on and recorded it as answered. The ledger then
 * overstated what On delivers (WI-10004485). The same margin applies to both bounds:
 * a cold build's caller stops waiting when the deadline ends, and the work after
 * Jev (filter, render, stats, response) has to fit before then.
 */
export function jevMemoryBudgetMs(
  now: number,
  bounds: { readonly respondByMs?: number; readonly deadlineRemainingMs?: number },
): number | undefined {
  const wallLeft = bounds.respondByMs !== undefined && Number.isFinite(bounds.respondByMs)
    ? bounds.respondByMs - now
    : Number.POSITIVE_INFINITY;
  const deadlineLeft = bounds.deadlineRemainingMs !== undefined && !Number.isNaN(bounds.deadlineRemainingMs)
    ? bounds.deadlineRemainingMs
    : Number.POSITIVE_INFINITY;
  const left = Math.min(wallLeft, deadlineLeft);
  return Number.isFinite(left) ? left - JEV_MEMORY_RESPONSE_MARGIN_MS : undefined;
}

/**
 * How long a Jev answer is reused for an exact repeat (WI-10004485). Measured on
 * live Log-only traffic 2026-10-01 01:49-04:07Z: 13.7% of answered calls asked
 * about a (message, candidate set) Jev had already answered, and most repeats came
 * long after the first answer (118 of 1,097 within 10 minutes, 628 within an hour),
 * so a short TTL would catch almost none. The answer to a fixed message, memory
 * text, question wording and model does not change, so the bound is memory, not
 * staleness. The cache is the operator's per-process L1 (../cache/instance); with
 * the six :3070 workers serving requests at random it recovers an estimated 10% of
 * calls, against 13.7% for a shared cache. Only answered results are cached: a
 * timeout or error is asked again next time.
 */
export const JEV_MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface JevGateCandidate {
  readonly id: string;
  readonly text: string;
}

/**
 * The cache key for one Jev question set: everything that determines the answer
 * (model pin, question variant, encoding, message, and each memory's id AND text)
 * and nothing else. Candidates are sorted by id, so the same set in a different
 * retrieval order is a hit; the reused scores are per memory, and D-013 measured
 * the instructions encoding's order sensitivity at 1.9%.
 */
export function jevMemoryCacheKey(message: string, candidates: readonly JevGateCandidate[]): string {
  const pairs = candidates.map((c) => [c.id, c.text] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash('sha256')
    .update(JSON.stringify([JEV_PINNED_MODEL, JEV_MEMORY_VARIANT, JEV_MEMORY_ENCODING, message, pairs]))
    .digest('hex');
  return `jev-memory:${digest}`;
}

/** A cached answer: P(yes) per memory id, and the model that gave it. */
interface JevCachedAnswer {
  readonly scores: readonly (readonly [string, number])[];
  readonly model: string;
}

/** Thrown inside the cache factory so an inconclusive answer is never cached. */
class JevInconclusive extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export type JevMemoryGateResult =
  /** No call was made. */
  | { readonly effective: 'off' }
  /**
   * Log only: nothing waits. `fired` is whether a request went out; a repeat the
   * cache already answered (`cached`) sends none, and neither does a call On would
   * have had no time to wait for (`skipped: 'no-time'`).
   */
  | { readonly effective: 'shadow'; readonly fired: boolean; readonly cached?: true; readonly skipped?: 'no-time' }
  /**
   * On, answered: `keep` is index-aligned with the candidates. `model` is the id
   * the provider says answered (not the pin we asked for), so a served-model
   * change is visible wherever the verdict is recorded (P-008). `cached` marks an
   * answer reused from an earlier identical call (no request, no wait).
   */
  | {
      readonly effective: 'on';
      readonly outcome: 'answered';
      readonly keep: readonly boolean[];
      readonly scores: readonly number[];
      readonly model: string;
      readonly cached?: true;
    }
  /** On, no verdict: the caller keeps every candidate (fail open). */
  | { readonly effective: 'on'; readonly outcome: 'inconclusive'; readonly reason: string };

export interface JevMemoryGateDeps {
  readonly resolve: (workspaceId: string) => Promise<Pick<JevMemoryInjectionResolution, 'effective'>>;
  readonly client: () => DecisionClient;
  /** Where repeat answers are reused ({@link JEV_MEMORY_CACHE_TTL_MS}). Absent: every call asks Jev. */
  readonly cache?: () => Cache;
}

const defaultDeps: JevMemoryGateDeps = {
  // Hot path: every injection passes here, so Off (the default) costs one cached
  // mode read and never touches the key store.
  resolve: async (workspaceId) => ((await getJevMode(workspaceId)) === 'off' ? { effective: 'off' } : resolveJevMemoryInjection(workspaceId)),
  client: ensureJevDecisionClient,
  cache: getOperatorCache,
};

export interface JevMemoryGateInput {
  readonly workspaceId?: string;
  /** The recall query the candidates were retrieved for (the recent user turn text). */
  readonly message: string;
  /** Floor-admitted candidates in retrieval order. */
  readonly candidates: readonly JevGateCandidate[];
  /**
   * Ledger consumer label. Defaults to {@link JEV_MEMORY_CONSUMER}; the weekly
   * precision monitor passes `memory-bench` so its replay calls are never
   * counted as live injection traffic in decision_model_calls.
   */
  readonly consumer?: string;
  /**
   * The injection port asking (`initialize` | `turn-start` | `mid-turn`, or absent
   * for a tool-call surface). On a {@link JEV_MEMORY_NO_WAIT_PORTS} port the
   * owner's On runs as Log only.
   */
  readonly port?: string;
  /**
   * Recorded with every call as decision_model_calls.surface, so one consumer's
   * calls split by where they came from. Callers pass the same label they record
   * as memory_recall_stats.surface. Absent: recorded as NULL (unattributed).
   */
  readonly surface?: string;
  /**
   * Milliseconds the caller can still use for the answer, already net of
   * {@link JEV_MEMORY_RESPONSE_MARGIN_MS}. Absent: no wall, the full
   * {@link JEV_MEMORY_TIMEOUT_MS}. See {@link jevMemoryWaitMs}.
   */
  readonly budgetMs?: number;
}

export async function runJevMemoryGate(input: JevMemoryGateInput, deps: JevMemoryGateDeps = defaultDeps): Promise<JevMemoryGateResult> {
  let workspaceId: string;
  let effective: JevMemoryInjectionResolution['effective'];
  try {
    workspaceId = input.workspaceId ?? activeWorkspaceId();
    effective = (await deps.resolve(workspaceId)).effective;
  } catch {
    // An unreadable setting is not consent to call out: behave as Off.
    return { effective: 'off' };
  }
  if (effective === 'off') return { effective: 'off' };
  const noWaitPort = input.port !== undefined && JEV_MEMORY_NO_WAIT_PORTS.has(input.port);
  const waitMs = noWaitPort ? null : jevMemoryWaitMs(input.budgetMs);
  if (effective === 'on' && noWaitPort) effective = 'shadow';
  // The bound each request runs under. Where the turn would wait, the wait On would
  // use, so Log only measures the timeout rate On would see. On a no-wait port,
  // the full cap: a longer bound costs no latency there, and the ledger then
  // records Jev's real answer instead of a timeout.
  const timeoutMs = waitMs ?? JEV_MEMORY_TIMEOUT_MS;

  const candidates = input.candidates.filter((c) => c.text.trim().length > 0);
  if (candidates.length === 0 || !input.message.trim()) {
    return effective === 'shadow' ? { effective, fired: false } : { effective, outcome: 'inconclusive', reason: 'no-candidates' };
  }
  // A waiting port with too little time left to wait. On keeps every candidate
  // without asking, so neither mode makes a call: one made here would reach the
  // ledger as a call On waited on, under a bound On never gave it, and would hide
  // the skip inside an answered row. The caller records the skip with the recall
  // (memory_recall_stats.admission.jev), where it can be counted per port.
  if (!noWaitPort && waitMs === null) {
    return effective === 'shadow'
      ? { effective, fired: false, skipped: 'no-time' }
      : { effective, outcome: 'inconclusive', reason: 'no-time' };
  }

  const consumer = input.consumer ?? JEV_MEMORY_CONSUMER;
  // Each request is ledgered against the memories it judges (all of them, or one under `pair`).
  const decide: AdmissionDecide = (request, call) =>
    deps.client().decide(request, {
      consumer,
      timeoutMs,
      ...(input.surface ? { surface: input.surface } : {}),
      subjectIds: call.candidates.map((ci) => candidates[ci].id),
    });
  const ask = async (): Promise<JevCachedAnswer> => {
    const judgement = await judgeAdmission(input.message, candidates, JEV_MEMORY_ENCODING, JEV_MEMORY_VARIANT, decide);
    const p = judgement.result;
    if ('failure' in p) throw new JevInconclusive(p.failure);
    // Scores exist only when every request answered, so a model is always named; the fallback is for the type.
    return { scores: candidates.map((c, i) => [c.id, p.scores[i]] as const), model: judgement.model ?? 'unknown' };
  };
  // `cached` is set synchronously by the cache's outcome hook, before getOrSet's
  // first await, so the shadow path below can read it right after starting judge().
  // A caller that joins an in-flight identical call reports 'miss', not a hit.
  let cached = false;
  const cache = deps.cache?.();
  const judge = async (): Promise<JevCachedAnswer> =>
    cache
      ? cache.getOrSet(workspaceId, jevMemoryCacheKey(input.message, candidates), ask, {
          softTtlMs: JEV_MEMORY_CACHE_TTL_MS,
          hardTtlMs: JEV_MEMORY_CACHE_TTL_MS,
          onOutcome: (outcome) => {
            cached = outcome === 'hit';
          },
        })
      : ask();

  if (effective === 'shadow') {
    // Fire and forget. decide() never throws for expected failures; the catch is
    // for the unexpected (and for JevInconclusive), so a shadow fault can never
    // reach the turn. judge() is async, so even a synchronous fault inside it
    // arrives as a rejection here.
    void judge().catch(() => undefined);
    return cached ? { effective, fired: false, cached: true } : { effective, fired: true };
  }

  try {
    const answer = await judge();
    // `candidates` may be shorter than `input.candidates` (empty texts were never
    // asked about); map back so `keep` stays aligned with the caller's list.
    const byId = new Map(answer.scores);
    const scores = input.candidates.map((c) => byId.get(c.id) ?? 1);
    const keep = scores.map((s) => s >= JEV_MEMORY_ADMIT_THRESHOLD);
    return { effective, outcome: 'answered', scores, keep, model: answer.model, ...(cached ? { cached: true as const } : {}) };
  } catch (e) {
    if (e instanceof JevInconclusive) return { effective, outcome: 'inconclusive', reason: e.reason };
    return { effective, outcome: 'inconclusive', reason: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * What bounded the time {@link jevMemoryBudgetMs} gave Jev, recorded beside it so a
 * no-time skip names the bound that caused it instead of leaving it to inference.
 */
export interface JevFunnelBounds {
  /** Whether a caller still waited on the build (the wall applied only if so). */
  readonly callerWaiting?: boolean;
  /** What was left of the client wall, ms (negative: already past). */
  readonly wallLeftMs?: number;
  /** What was left of the build's own deadline, ms. */
  readonly deadlineLeftMs?: number;
}

/**
 * The admission-funnel record of one gate result (memory_recall_stats.admission.jev),
 * or undefined when the filter was Off. `budgetMs` is what the caller offered
 * ({@link jevMemoryBudgetMs}). A no-time skip is marked `skipped` in both modes, so
 * one predicate counts it whether the filter was On or Log only.
 */
export function jevFunnelEntry(
  result: JevMemoryGateResult,
  budgetMs: number | undefined,
  bounds: JevFunnelBounds = {},
): JevFunnelEntry | undefined {
  if (result.effective === 'off') return undefined;
  const finite = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
  const budget = {
    ...(finite(budgetMs) ? { budgetMs: Math.round(budgetMs) } : {}),
    ...(bounds.callerWaiting !== undefined ? { callerWaiting: bounds.callerWaiting } : {}),
    ...(finite(bounds.wallLeftMs) ? { wallLeftMs: Math.round(bounds.wallLeftMs) } : {}),
    ...(finite(bounds.deadlineLeftMs) ? { deadlineLeftMs: Math.round(bounds.deadlineLeftMs) } : {}),
  };
  if (result.effective === 'shadow') {
    return {
      effective: 'shadow',
      ...budget,
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.cached ? { cached: true as const } : {}),
    };
  }
  if (result.outcome === 'answered') {
    return { effective: 'on', ...budget, outcome: 'answered', ...(result.cached ? { cached: true as const } : {}) };
  }
  return {
    effective: 'on',
    ...budget,
    outcome: 'inconclusive',
    reason: result.reason,
    ...(result.reason === 'no-time' ? { skipped: 'no-time' as const } : {}),
  };
}
