/**
 * Host-independent implementation of the Jev memory gate.
 *
 * Operator settings, credentials, cache wiring, and notifications belong in
 * jev-memory-gate.ts. Keeping this decision path injectable lets isolated
 * workers measure the same gate without bundling operator state or DBOS.
 */
import { createHash } from 'node:crypto';

import type { Cache } from '@papercusp/cache';
import { JEV_PINNED_MODEL, type DecisionClient } from '@papercusp/decision-model';

import { judgeAdmission, type AdmissionDecide, type AdmissionEncoding, type AdmissionVariant } from './jev-admission-request';
import type { JevFunnelEntry } from './recall-stats';

/** The ledger consumer label for push-path calls (the bench uses `memory-bench`). */
export const JEV_MEMORY_CONSUMER = 'memory-injection';

/** The operating point production runs. */
export const JEV_MEMORY_ADMIT_THRESHOLD = 0.35;
export const JEV_MEMORY_ENCODING: AdmissionEncoding = 'instructions';
export const JEV_MEMORY_VARIANT: AdmissionVariant = 'v2-content';

/** Ports where the owner's On does NOT wait for Jev. */
export const JEV_MEMORY_NO_WAIT_PORTS: ReadonlySet<string> = new Set(['mid-turn']);

/** Below this a waiting port runs Log only for that call. */
export const JEV_MEMORY_MIN_WAIT_MS = 150;

/** Time reserved for work after Jev answers and for slack. */
export const JEV_MEMORY_RESPONSE_MARGIN_MS = 250;

/** Maximum duration of one Jev decision call on the memory path. */
export const JEV_MEMORY_TIMEOUT_MS = 800;

/** How long an answered Jev result is cached for an exact repeat. */
export const JEV_MEMORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface JevGateCandidate {
  readonly id: string;
  readonly text: string;
}

/**
 * The cache key for one Jev question set. Candidates are sorted by id, so the
 * same set in a different retrieval order is a hit.
 */
export function jevMemoryCacheKey(message: string, candidates: readonly JevGateCandidate[]): string {
  const pairs = candidates.map((c) => [c.id, c.text] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash('sha256')
    .update(JSON.stringify([JEV_PINNED_MODEL, JEV_MEMORY_VARIANT, JEV_MEMORY_ENCODING, message, pairs]))
    .digest('hex');
  return `jev-memory:${digest}`;
}

export interface JevMemoryInjectionResolution {
  readonly effective: 'off' | 'shadow' | 'on';
}

export interface JevMemoryGateInput {
  readonly workspaceId?: string;
  readonly message: string;
  readonly candidates: readonly JevGateCandidate[];
  readonly consumer?: string;
  readonly port?: string;
  readonly surface?: string;
  readonly budgetMs?: number;
}

export type JevMemoryGateResult =
  | { readonly effective: 'off' }
  | { readonly effective: 'shadow'; readonly fired: boolean; readonly cached?: true; readonly skipped?: 'no-time' }
  | {
      readonly effective: 'on';
      readonly outcome: 'answered';
      readonly keep: readonly boolean[];
      readonly scores: readonly number[];
      readonly model: string;
      readonly cached?: true;
    }
  | { readonly effective: 'on'; readonly outcome: 'inconclusive'; readonly reason: string };

export interface JevMemoryGateDeps {
  readonly resolve: (workspaceId: string) => Promise<JevMemoryInjectionResolution>;
  readonly client: () => DecisionClient;
  readonly cache?: () => Cache;
}

/** Where the result is resolved to: production uses `on` only after its parent gate. */
export type JevGateFn = (input: JevMemoryGateInput) => Promise<JevMemoryGateResult>;

/**
 * The pure gate implementation. `workspaceId` is required here so callers must
 * resolve it at their host boundary rather than silently choosing a partition.
 */
export async function runJevMemoryGateWithDeps(
  input: JevMemoryGateInput & { readonly workspaceId: string },
  deps: JevMemoryGateDeps,
): Promise<JevMemoryGateResult> {
  let effective: JevMemoryInjectionResolution['effective'];
  try {
    effective = (await deps.resolve(input.workspaceId)).effective;
  } catch {
    // An unreadable setting is not consent to call out: behave as Off.
    return { effective: 'off' };
  }
  if (effective === 'off') return { effective: 'off' };
  const noWaitPort = input.port !== undefined && JEV_MEMORY_NO_WAIT_PORTS.has(input.port);
  const waitMs = noWaitPort ? null : jevMemoryWaitMs(input.budgetMs);
  if (effective === 'on' && noWaitPort) effective = 'shadow';
  // Log only uses the bound On would wait for, so its ledger measures the timeout
  // rate On would see. A no-wait port uses the full cap because no latency is added.
  const timeoutMs = waitMs ?? JEV_MEMORY_TIMEOUT_MS;

  const candidates = input.candidates.filter((c) => c.text.trim().length > 0);
  if (candidates.length === 0 || !input.message.trim()) {
    return effective === 'shadow' ? { effective, fired: false } : { effective, outcome: 'inconclusive', reason: 'no-candidates' };
  }
  // Where On has too little time, neither mode makes a call: a shadow call here
  // would measure work On could not wait for.
  if (!noWaitPort && waitMs === null) {
    return effective === 'shadow'
      ? { effective, fired: false, skipped: 'no-time' }
      : { effective, outcome: 'inconclusive', reason: 'no-time' };
  }

  const consumer = input.consumer ?? JEV_MEMORY_CONSUMER;
  const decide: AdmissionDecide = (request, call) =>
    deps.client().decide(request, {
      consumer,
      timeoutMs,
      ...(input.surface ? { surface: input.surface } : {}),
      subjectIds: call.candidates.map((ci) => candidates[ci].id),
    });
  const ask = async (): Promise<{ scores: readonly (readonly [string, number])[]; model: string }> => {
    const judgement = await judgeAdmission(input.message, candidates, JEV_MEMORY_ENCODING, JEV_MEMORY_VARIANT, decide);
    const result = judgement.result;
    if ('failure' in result) throw new JevInconclusive(result.failure);
    return { scores: candidates.map((c, i) => [c.id, result.scores[i]] as const), model: judgement.model ?? 'unknown' };
  };

  let cached = false;
  const cache = deps.cache?.();
  const judge = async (): Promise<{ scores: readonly (readonly [string, number])[]; model: string }> =>
    cache
      ? cache.getOrSet(input.workspaceId, jevMemoryCacheKey(input.message, candidates), ask, {
          softTtlMs: JEV_MEMORY_CACHE_TTL_MS,
          hardTtlMs: JEV_MEMORY_CACHE_TTL_MS,
          onOutcome: (outcome) => {
            cached = outcome === 'hit';
          },
        })
      : ask();

  if (effective === 'shadow') {
    // Fire and forget. An observer fault cannot reach the caller.
    void judge().catch(() => undefined);
    return cached ? { effective, fired: false, cached: true } : { effective, fired: true };
  }

  try {
    const answer = await judge();
    const byId = new Map(answer.scores);
    const scores = input.candidates.map((c) => byId.get(c.id) ?? 1);
    const keep = scores.map((score) => score >= JEV_MEMORY_ADMIT_THRESHOLD);
    return { effective, outcome: 'answered', scores, keep, model: answer.model, ...(cached ? { cached: true as const } : {}) };
  } catch (error) {
    if (error instanceof JevInconclusive) return { effective, outcome: 'inconclusive', reason: error.reason };
    return { effective, outcome: 'inconclusive', reason: `error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

class JevInconclusive extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The bounded wait for a port, or null when On should not wait. */
export function jevMemoryWaitMs(budgetMs: number | undefined): number | null {
  if (budgetMs === undefined || Number.isNaN(budgetMs)) return JEV_MEMORY_TIMEOUT_MS;
  const bound = Math.min(JEV_MEMORY_TIMEOUT_MS, Math.floor(budgetMs));
  return bound >= JEV_MEMORY_MIN_WAIT_MS ? bound : null;
}

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

export interface JevFunnelBounds {
  readonly callerWaiting?: boolean;
  readonly wallLeftMs?: number;
  readonly deadlineLeftMs?: number;
}

export function jevFunnelEntry(
  result: JevMemoryGateResult,
  budgetMs: number | undefined,
  bounds: JevFunnelBounds = {},
): JevFunnelEntry | undefined {
  if (result.effective === 'off') return undefined;
  const finite = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value);
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
