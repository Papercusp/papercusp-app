/**
 * embed-latency-watchdog (EI-21491088289861649) — detect an embed latency
 * breach AS a breach: per-caller p99 graded against THAT caller's own budget,
 * instead of letting it surface downstream dressed up as a fact about the
 * subject (a wrong consult verdict, a degraded semantic leg, a thin corpus).
 *
 * RELATIONSHIP TO THE SIBLING. retrieval-degradation-watchdog reads leg
 * OUTCOMES — a search either ran at full strength or degraded. It is blind to
 * the most common real shape: an embed that is SLOW but still succeeds.
 * Measured on this box (2026-08-26, healthy sidecar, load ~70%): a cold embed
 * took 1.92s and warm ones ~1ms. 1.92s sails under search's 4000ms budget and
 * blows the mid-turn related-context budget (1200ms) at the same instant —
 * which is exactly why two callers disagreed about whether the sidecar was
 * "available". Only a per-caller p99-vs-budget read can see that; this module
 * is that read. The budgets themselves are deliberate per-caller SLOs (an
 * interactive tool may wait 4s; a per-tool-batch injection may not), each
 * named and env-overridable at its call site — the sampler records whichever
 * budget the caller actually graded against, so a future reconciliation shows
 * up in the data without a code change here.
 *
 * COLD START vs DOWN — opposite remedies, so the judge names which it saw:
 *   · cold-start-spike — p99 over budget while the median sits well under:
 *     the sidecar works; warm it or widen the tight caller's budget.
 *   · sustained-slow  — even the MEDIAN is over budget: every caller is
 *     suffering; look at sidecar load/model/device before touching budgets.
 *   · unavailable     — half or more of the embeds failed outright: not a
 *     latency problem; check the service, do not tune budgets.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { readEmbedLatency, UNATTRIBUTED_CALLER, type EmbedCallerLatency, type EmbedLatencyWindow } from '@papercusp/search';

import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export const EMBED_LATENCY_SWEEP_INTERVAL_MS = 15 * 60_000;
export const EMBED_LATENCY_WINDOW_MS = 60 * 60_000;

/**
 * Minimum embeds for ONE caller before any verdict about it is issued.
 *
 * Same rationale as RETRIEVAL_DEGRADATION_MIN_SAMPLES: one slow embed in a
 * quiet hour on a tiny denominator is not a measurement. 10 embeds/hour is far
 * below any production caller's traffic, so this gates noise, not signal.
 */
export const EMBED_LATENCY_MIN_SAMPLES_PER_CALLER = 10;

/**
 * The unavailable floor: when this fraction of a caller's embeds ended in
 * timeout/error, the condition is "the instrument is down", not "latency" —
 * classified first so the remedy named in the escalation is the right one.
 * Half of all embeds failing over an hour is wrong under any reading.
 */
export const EMBED_LATENCY_UNAVAILABLE_FLOOR = 0.5;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'embed-latency-watchdog',
  ownerLabel: 'system · embed latency',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** How one caller's window was judged. */
export type EmbedCallerVerdict =
  | { kind: 'ungraded'; reason: 'no-budget' | 'insufficient-samples' }
  | { kind: 'healthy' }
  | {
      kind: 'cold-start-spike' | 'sustained-slow' | 'unavailable';
      n: number;
      budgetMs: number;
      p50Ms: number;
      p99Ms: number;
      maxMs: number;
      timeoutCount: number;
      errorCount: number;
    };

export type EmbedCallerBreach = Extract<
  EmbedCallerVerdict,
  { kind: 'cold-start-spike' | 'sustained-slow' | 'unavailable' }
> & { caller: string };

export type EmbedLatencyVerdict =
  | { kind: 'nothing-to-grade' }
  | { kind: 'healthy'; breaches: [] }
  | { kind: 'breach'; breaches: EmbedCallerBreach[] };

/** PURE: grade ONE caller's trailing window against its own budget. Split from
 *  the sweep so the classification ladder is testable with no timers, no PG
 *  and no escalation surface — mirrors judgeRetrievalHealth. */
export function judgeEmbedCaller(c: EmbedCallerLatency): EmbedCallerVerdict {
  if (c.budgetMs === null) return { kind: 'ungraded', reason: 'no-budget' };
  if (c.n < EMBED_LATENCY_MIN_SAMPLES_PER_CALLER) {
    return { kind: 'ungraded', reason: 'insufficient-samples' };
  }
  const base = {
    n: c.n,
    budgetMs: c.budgetMs,
    p50Ms: c.p50Ms ?? 0,
    p99Ms: c.p99Ms ?? 0,
    maxMs: c.maxMs ?? 0,
    timeoutCount: c.timeout,
    errorCount: c.error,
  };
  if ((c.timeout + c.error) / c.n >= EMBED_LATENCY_UNAVAILABLE_FLOOR) {
    return { kind: 'unavailable', ...base };
  }
  // A null percentile cannot happen past the min-samples guard, but never let
  // a defensive 0 impersonate a breach verdict either — hence the explicit
  // null check rather than comparing the coalesced value.
  if (c.p50Ms !== null && c.p50Ms > c.budgetMs) return { kind: 'sustained-slow', ...base };
  if (c.p99Ms !== null && c.p99Ms > c.budgetMs) return { kind: 'cold-start-spike', ...base };
  return { kind: 'healthy' };
}

/** PURE: grade the whole window. Callers with no recorded budget are reported
 *  as ungraded-noise only implicitly (they simply never breach) — but a window
 *  where NOTHING carried a budget grades as nothing-to-grade, which must be
 *  distinguishable from healthy: a detector that measured nothing is not a
 *  detector that passed. */
export function judgeEmbedLatency(window: EmbedLatencyWindow): EmbedLatencyVerdict {
  const graded = window.callers.filter((c) => c.budgetMs !== null);
  if (graded.length === 0) return { kind: 'nothing-to-grade' };
  const breaches = graded
    .map((c) => ({ ...judgeEmbedCaller(c), caller: c.caller }))
    .filter((v): v is EmbedCallerBreach => v.kind !== 'healthy' && v.kind !== 'ungraded');
  if (breaches.length === 0) return { kind: 'healthy', breaches: [] };
  return { kind: 'breach', breaches };
}

export interface EmbedLatencySweepDeps {
  readWindow: () => EmbedLatencyWindow;
  escalate: (v: Extract<EmbedLatencyVerdict, { kind: 'breach' }>) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.EMBED_LATENCY_WATCHDOG, 'system');
  } catch {
    return false;
  }
}

function describeBreach(v: EmbedCallerBreach): string {
  const ratio = v.kind === 'unavailable' ? null : Math.round((v.p99Ms / v.budgetMs) * 10) / 10;
  switch (v.kind) {
    case 'unavailable':
      return (
        `${v.caller}: UNAVAILABLE — ${(v.timeoutCount + v.errorCount)}/${v.n} embeds failed outright ` +
        `(timeout ${v.timeoutCount} · error ${v.errorCount}) within a ${v.budgetMs}ms budget. This is not a ` +
        `latency tuning problem: check the embed sidecar service before touching budgets.`
      );
    case 'sustained-slow':
      return (
        `${v.caller}: SUSTAINED-SLOW — median ${Math.round(v.p50Ms)}ms exceeds its ${v.budgetMs}ms budget ` +
        `(p99 ${Math.round(v.p99Ms)}ms = ${ratio}x budget, max ${Math.round(v.maxMs)}ms over ${v.n} embeds). ` +
        `Every other embed is over budget: look at sidecar load/model/device before widening anything.`
      );
    case 'cold-start-spike':
      return (
        `${v.caller}: COLD-START-SPIKE — p99 ${Math.round(v.p99Ms)}ms breaches its ${v.budgetMs}ms budget ` +
        `(${ratio}x) while the median (${Math.round(v.p50Ms)}ms) sits under it. Measured healthy-sidecar shape: ` +
        `a single cold request (~1.9s) against ~1ms warm ones. The sidecar WORKS — the spike lands on whoever ` +
        `holds the tight budget. Remedy: warm the model eagerly or revisit THIS caller's budget, not the service.`
      );
  }
}

function bucketRatio(v: EmbedCallerBreach): number {
  // Bucketed so a persistent same-shape condition dedups instead of re-alarming
  // every sweep, while a materially worse ratio still opens a fresh escalation —
  // mirrors the sibling watchdog's signature scheme.
  if (v.kind === 'unavailable') return -1;
  return Math.floor((v.p99Ms / v.budgetMs) * 10);
}

async function defaultEscalate(v: Extract<EmbedLatencyVerdict, { kind: 'breach' }>): Promise<void> {
  const lines = v.breaches.map(describeBreach);
  const signatures = [...v.breaches]
    .sort((a, b) => (a.caller < b.caller ? -1 : 1))
    .map((b) => `${b.caller}:${b.kind}:${bucketRatio(b)}`);
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Embed latency breach: ${v.breaches.length} caller(s) over their own embed budget in the last hour`,
    body:
      `The embed-latency watchdog graded each search caller's query-embed p99 against the budget that ` +
      `caller ACTUALLY used (EI-21491088289861649). This is the first-class breach signal: until now a slow ` +
      `but succeeding embed surfaced only indirectly — as a wrong consult verdict ("no one knows more than ` +
      `you do"), a degraded semantic leg ("query embed exceeded NNNNms budget"), or thin corpus coverage — ` +
      `each reporting a fact about the SUBJECT when the truth was a fact about the INSTRUMENT.\n\n` +
      lines.join('\n\n') +
      `\n\nSCOPE: in-process samples from THIS operator host's hybrid-search paths. Quiet means "this process ` +
      `saw no breach", never "every embedder everywhere is fast". Unlabeled embeds land under ` +
      `'${UNATTRIBUTED_CALLER}' and are visible there precisely so unlabeled call sites show up AS unlabeled.`,
    meta: {
      dedupKind: 'embed-latency-breach',
      subjectSignature: signatures.join('|'),
      breaches: v.breaches.map((b) => ({
        caller: b.caller,
        kind: b.kind,
        ...(b.kind === 'unavailable'
          ? {}
          : { p50Ms: b.p50Ms, p99Ms: b.p99Ms, budgetMs: b.budgetMs }),
        n: b.n,
      })),
    },
  });
}

function sweepDeps(overrides: Partial<EmbedLatencySweepDeps>): EmbedLatencySweepDeps {
  return {
    readWindow: () => readEmbedLatency({ windowMs: EMBED_LATENCY_WINDOW_MS }),
    escalate: defaultEscalate,
    flagEnabled: defaultFlagEnabled,
    ...overrides,
  };
}

/** One sweep. Exported for tests. */
export async function runEmbedLatencySweepOnce(
  overrides: Partial<EmbedLatencySweepDeps> = {},
): Promise<{ verdict: 'breach' | 'healthy' | 'nothing-to-grade' | 'skipped'; escalated: number }> {
  const deps = sweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { verdict: 'skipped', escalated: 0 };
  const verdict = judgeEmbedLatency(deps.readWindow());
  if (verdict.kind !== 'breach') return { verdict: verdict.kind, escalated: 0 };
  await deps.escalate(verdict);
  return { verdict: 'breach', escalated: 1 };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the embed-latency watchdog. Idempotent.
 * Runtime gate: FLAGS.EMBED_LATENCY_WATCHDOG (checked per tick).
 */
export function startEmbedLatencyWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? EMBED_LATENCY_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'embed-latency-watchdog',
    intervalMs,
    () => {
      if (sweeping) return;
      sweeping = true;
      void runEmbedLatencySweepOnce()
        .catch((e) => {
          console.warn(
            `[embed-latency-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // D-004: 'must-sample'. The embed-latency ring buffer is plain in-process
    // state written by the search path and emits no change events, so there is
    // nothing to subscribe to for "p99 crossed the budget" — it has to be read.
    { category: 'watchdog', classification: 'must-sample' },
  );
}
