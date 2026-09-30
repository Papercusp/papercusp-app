/**
 * stage-stall-log.ts — named-hop pipeline observability, formalized as a
 * shared primitive (fleet-reliability-verification-2026-07-10 P-012).
 *
 * ORIGIN: `outbox-drain.ts`'s WI-3619 fix. WI-2009's `DRAIN_PASS_TIMEOUT_MS`
 * watchdog could name that a drain PASS hung, but not WHICH stage inside it
 * (the journal said "hung await (keychain unwrap / epoch-key resolution /
 * append)" and left the operator guessing). WI-3619 wrapped every await
 * inside the send-side drain pass with a one-shot stall logger: if the await
 * is still pending after `STAGE_STALL_LOG_MS`, a loud grep-able line names
 * the exact stage — turning "a pass hung" into "THIS specific await hung",
 * diagnosable from the journal alone even when the await never settles (a
 * log-after-completion line would never fire on a truly wedged await).
 *
 * This module lifts that pattern out of outbox-drain.ts (its one prior
 * consumer) so every OTHER federation hop can adopt the same instrumentation
 * without re-deriving it. Generalize: any pipeline stage with a serialized,
 * single-flight-per-tick await loop (capture → drain → replicate → merge →
 * member-guard → project) is a candidate — wrap its awaits with
 * `logIfStageStalls(scope, stageName, promise)` so a wedged hop NAMES ITSELF
 * in the journal instead of presenting only as "the whole pipeline went
 * quiet". See also: `hive-git-p2p-ops-runbook-2026-07-09.mdx` § Named-hop
 * pipeline observability.
 *
 * Current adopters:
 *   - `outbox-drain.ts` (send-side / drain stage) — the original WI-3619 site.
 *   - `read-merge.ts` (merge stage / `applyRecordingWinner`) — the projection
 *     `apply()` call is an unbounded PG write with the same hang shape as the
 *     drain's `append()` (a wedged connection / lock never resolves), so it
 *     gets the same treatment (P-012).
 *
 * NOT yet adopted (candidates for a follow-up, scoped deliberately out of
 * P-012's first pass — see the work-item's completion notes):
 *   - capture (Stage 1, a synchronous PG trigger — no long-lived await to name);
 *   - Hypercore replication itself (framework-internal, not this codebase's
 *     await to wrap);
 *   - member-guard / admission checks (github-ingress-admission.ts,
 *     contribution-admission.ts) — worth a pass once a live wedge is observed
 *     there, per this module's "log the failure class you've actually seen"
 *     philosophy rather than pre-emptively wrapping every await in the repo.
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pinModuleState } from '@papercusp/module-singleton';
import {
  pgDiagnosticIdentity,
  PG_DIAGNOSTIC_STAGES,
  type PgResultDiagnosticCorrelation,
} from '@papercusp/db-org/acquire-registry';

const attemptContext = pinModuleState(
  'operator-core.stage-stall-log.context',
  () => new AsyncLocalStorage<StageAttempt>(),
);
const hopContext = pinModuleState('operator-core.stage-stall-log.hop-context', () =>
  new AsyncLocalStorage<{
    attempt: StageAttempt;
    hopId: number;
    stage: StageDiagnosticName;
    boundary: StageBoundary;
  }>(),
);

// These are source-defined operation names, never row values, SQL, or error text.
const diagnosticStages = PG_DIAGNOSTIC_STAGES;
export type StageDiagnosticName = (typeof diagnosticStages)[number];
type StageBoundary = 'await' | 'sync';
type StageOutcome = 'fulfilled' | 'rejected' | 'expired' | 'abandoned';

export interface StageAttemptContext {
  readonly processInstanceId: string;
  readonly buildSha: string | null;
  readonly rowId: string | null;
  readonly attemptId: string;
}

export interface StageDiagnosticEvent extends StageAttemptContext {
  readonly event: 'attempt-start' | 'attempt-end' | 'hop-start' | 'hop-end' | 'hop-stall' | 'hop-unobserved' | 'cache';
  readonly cacheState?: 'hit' | 'miss' | 'shared';
  /** Random local operation identity; never a key, SQL, or payload identifier. */
  readonly sharedWorkId?: string;
  readonly hopId: number | null;
  readonly stage: StageDiagnosticName | null;
  readonly boundary: StageBoundary | null;
  readonly outcome: StageOutcome | null;
  /** Monotonic duration of this observed boundary, never CPU or PG acquisition time. */
  readonly elapsedMs: number;
  readonly thresholdMs: number | null;
  readonly timerDeliveryDelayMs: number | null;
}

interface StageSpan {
  readonly hopId: number | null;
  end(outcome: 'fulfilled' | 'rejected'): void;
  stalled(thresholdMs: number): void;
}

export interface StageAttempt {
  readonly context: StageAttemptContext;
  begin(stage: StageDiagnosticName, boundary: StageBoundary): StageSpan;
  cache(stage: StageDiagnosticName, state: 'hit' | 'miss' | 'shared', sharedWorkId?: string): void;
  finish(outcome?: StageOutcome): void;
  snapshot(): Readonly<{
    context: StageAttemptContext;
    status: 'disabled' | 'active' | StageOutcome;
    unobservedHops: number;
    activeHops: readonly Readonly<{ hopId: number; stage: StageDiagnosticName; boundary: StageBoundary }>[];
  }>;
}

const NO_STAGE_SPAN: StageSpan = Object.freeze({ hopId: null, end() {}, stalled() {} });
const MAX_ACTIVE_HOPS = 64;

/** Local, opt-in observation only. No operation/envelope is retained or modified.
 * The owner finishes the attempt on retry/timeout; expiry bounds forgotten attempts.
 * Closing an attempt drops its active spans but never cancels their business promises.
 * There is no global history: public retention belongs to the existing diagnostic channel.
 */
export function createStageAttempt(options: {
  rowId: string | number;
  onEvent?: (event: StageDiagnosticEvent) => void | Promise<void>;
  enabled?: boolean;
  maxAgeMs?: number;
}): StageAttempt {
  const rowId = String(options.rowId);
  const context: StageAttemptContext = Object.freeze({
    ...pgDiagnosticIdentity(),
    rowId: /^\d{1,30}$/.test(rowId) ? rowId : null,
    attemptId: randomUUID(),
  });
  let sink = options.enabled === false ? undefined : options.onEvent;
  let status: 'disabled' | 'active' | StageOutcome = sink ? 'active' : 'disabled';
  let nextHop = 0;
  let unobservedHops = 0;
  const startedAt = performance.now();
  const active = new Map<number, { stage: StageDiagnosticName; boundary: StageBoundary; startedAt: number }>();
  let expiry: ReturnType<typeof setTimeout> | undefined;

  function emit(
    event: StageDiagnosticEvent['event'],
    hopId: number | null = null,
    stage: StageDiagnosticName | null = null,
    boundary: StageBoundary | null = null,
    outcome: StageOutcome | null = null,
    since = startedAt,
    thresholdMs: number | null = null,
    cache?: { cacheState: 'hit' | 'miss' | 'shared'; sharedWorkId?: string },
  ) {
    if (!sink) return;
    const elapsedMs = Math.max(0, performance.now() - since);
    const record = Object.freeze({
      ...context,
      ...cache,
      event,
      hopId,
      stage,
      boundary,
      outcome,
      elapsedMs,
      thresholdMs,
      timerDeliveryDelayMs: thresholdMs === null ? null : Math.max(0, elapsedMs - thresholdMs),
    });
    try {
      // Async observers are also detached: neither their latency nor rejection is business work.
      const result = sink(record);
      if (result) void Promise.resolve(result).catch(() => {});
    } catch {
      /* A broken diagnostic consumer cannot replace the operation's result. */
    }
  }

  function finish(outcome: StageOutcome = 'fulfilled') {
    if (status !== 'active') return;
    status = outcome;
    clearTimeout(expiry);
    active.clear();
    emit('attempt-end', null, null, null, outcome);
    sink = undefined;
  }

  if (status === 'active') {
    const requestedAge = options.maxAgeMs ?? 300_000;
    const age = Number.isFinite(requestedAge) ? Math.max(1, Math.min(requestedAge, 600_000)) : 300_000;
    expiry = setTimeout(() => finish('expired'), age);
    expiry.unref?.();
    emit('attempt-start');
  }

  return Object.freeze({
    context,
    cache(stage: StageDiagnosticName, state: 'hit' | 'miss' | 'shared', sharedWorkId?: string) {
      if (status !== 'active' || !diagnosticStages.includes(stage) || !['hit', 'miss', 'shared'].includes(state))
        return;
      const safeId = sharedWorkId && /^[a-f0-9-]{36}$/i.test(sharedWorkId) ? sharedWorkId : undefined;
      emit('cache', null, stage, null, null, startedAt, null, {
        cacheState: state,
        ...(safeId ? { sharedWorkId: safeId } : {}),
      });
    },
    begin(stage: StageDiagnosticName, boundary: StageBoundary): StageSpan {
      if (status !== 'active') return NO_STAGE_SPAN;
      if (!diagnosticStages.includes(stage) || (boundary !== 'await' && boundary !== 'sync')) {
        unobservedHops++;
        emit('hop-unobserved');
        return NO_STAGE_SPAN;
      }
      const hopId = ++nextHop;
      if (active.size >= MAX_ACTIVE_HOPS) {
        unobservedHops++;
        emit('hop-unobserved', hopId, stage, boundary);
        return NO_STAGE_SPAN;
      }
      const hop = { stage, boundary, startedAt: performance.now() };
      active.set(hopId, hop);
      emit('hop-start', hopId, stage, boundary, null, hop.startedAt);
      return {
        hopId,
        end(outcome) {
          if (status !== 'active' || !active.delete(hopId)) return;
          emit('hop-end', hopId, stage, boundary, outcome, hop.startedAt);
        },
        stalled(thresholdMs) {
          if (status !== 'active' || !active.has(hopId) || boundary !== 'await') return;
          emit('hop-stall', hopId, stage, boundary, null, hop.startedAt, thresholdMs);
        },
      };
    },
    finish,
    snapshot() {
      return Object.freeze({
        context,
        status,
        unobservedHops,
        activeHops: Object.freeze(
          Array.from(active, ([hopId, hop]) =>
            Object.freeze({
              hopId,
              stage: hop.stage,
              boundary: hop.boundary,
            }),
          ),
        ),
      });
    },
  });
}

/** Carry local diagnostics across existing dependency interfaces without touching wire data. */
export function withStageAttempt<T>(attempt: StageAttempt | undefined, run: () => T): T {
  return attempt ? attemptContext.run(attempt, run) : run();
}

export function currentStageAttempt(): StageAttempt | undefined {
  return attemptContext.getStore();
}

/** Never guess a hop from a shared active-hop list: parallel branches overlap. */
export function currentStageDiagnosticContext(): PgResultDiagnosticCorrelation | null {
  const attempt = currentStageAttempt();
  if (!attempt) return null;
  const snapshot = attempt.snapshot();
  if (snapshot.status !== 'active') return null;
  const hop = hopContext.getStore();
  const observed = hop?.attempt === attempt &&
    snapshot.activeHops.some((active) => active.hopId === hop.hopId);
  return {
    ...attempt.context,
    hopId: observed ? hop.hopId : null,
    stage: observed ? hop.stage : null,
    boundary: observed ? hop.boundary : null,
  };
}

/** Invoke the actual dependency only after recording its await boundary. */
export async function traceStageAwait<T>(stage: StageDiagnosticName, run: () => PromiseLike<T>): Promise<T> {
  const attempt = currentStageAttempt();
  const span = attempt?.begin(stage, 'await');
  try {
    const value = await (attempt && span?.hopId
      ? hopContext.run({ attempt, hopId: span.hopId, stage, boundary: 'await' }, async () => await run())
      : run());
    span?.end('fulfilled');
    return value;
  } catch (error) {
    span?.end('rejected');
    throw error;
  }
}

/** Synchronous boundaries cannot be diagnosed by a timer on the blocked event loop. */
export function traceStageSync<T>(attempt: StageAttempt | undefined, stage: StageDiagnosticName, run: () => T): T {
  const span = attempt?.begin(stage, 'sync');
  try {
    const value = attempt && span?.hopId
      ? withStageAttempt(attempt, () => hopContext.run({ attempt, hopId: span.hopId!, stage, boundary: 'sync' }, run))
      : run();
    span?.end('fulfilled');
    return value;
  } catch (error) {
    span?.end('rejected');
    throw error;
  }
}

/** Default stall-log threshold: an await pending this long gets a named,
 *  grep-able journal line. Shared across every adopter unless a specific
 *  stage has a reason to override it (pass a different `thresholdMs`). */
export const STAGE_STALL_LOG_MS = 15_000;

/**
 * Race `p` against a one-shot logging timer: if `p` has not settled after
 * `thresholdMs`, emit a loud `console.error` naming `scope` + `stage` (so a
 * hung pipeline names the exact await that's wedged), then keep waiting for
 * `p` itself — this NEVER times out or rejects `p`; it only adds an
 * observability side-channel. Silent on the healthy path (the timer is
 * cleared as soon as `p` settles, one way or the other).
 *
 * `scope` should identify the pipeline instance (e.g.
 * `${workspaceId}::${harnessSlug}`); `stage` should name the specific await
 * (e.g. `hypercore-append (row id=… table=…)`, `merge-apply (table=… key=…)`)
 * so the resulting line is directly actionable: "THIS stage, on THIS scope,
 * has been hung for THIS long."
 */
export async function logIfStageStalls<T>(
  scope: string,
  stage: string,
  p: PromiseLike<T>,
  thresholdMs: number = STAGE_STALL_LOG_MS,
  diagnostic?: { attempt: StageAttempt; stage: StageDiagnosticName },
): Promise<T> {
  const span = diagnostic?.attempt.begin(diagnostic.stage, 'await');
  const timer = setTimeout(() => {
    span?.stalled(thresholdMs);
    console.error(
      `[stage-stall] STAGE STALL for ${scope}: '${stage}' still pending after ` +
        `${thresholdMs}ms — this is the hung await (named-hop pipeline observability, P-012)`,
    );
  }, thresholdMs);
  timer.unref?.();
  try {
    const value = await p;
    span?.end('fulfilled');
    return value;
  } catch (error) {
    span?.end('rejected');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
