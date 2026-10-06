/**
 * The bulk-run watchdog — the clock the run lifecycle does not otherwise have
 * (autonomous-inbox-resolution-2026-08-31 P-002).
 *
 * ## What was missing
 *
 * `bulk-run-store.ts` already knows how to tell a dead run from a live one
 * (`classifyRunLiveness`) and how to hand a stranded one to a fresh resolver
 * (`restartRun`). Nothing CALLED either on a schedule. Every recovery path was
 * pull-triggered — an owner opening the pane and pressing a button — so a run
 * whose resolver died between two items simply stopped, in `running`, with its
 * remaining items on `outcome = 'pending'`, indefinitely. The items table makes
 * that visible (Requirement 2) but nothing acted on it.
 *
 * Two distinct defects follow, and this module addresses both because they have
 * the same cause and the same fix cadence:
 *
 *  1. **Stranded items.** An undecided item in a run nobody is executing is not
 *     "pending" in any useful sense — it is abandoned. Left as `pending` it is
 *     indistinguishable from an item the resolver simply has not reached yet,
 *     which is exactly the ambiguity that makes a stalled run look busy.
 *
 *  2. **Counters that disagree with their own rows.** The run row carries
 *     `auto_resolved / recommended / skipped / failed` as stored columns, and the
 *     store recomputes them FROM the item rows on every write. So a run whose
 *     counters disagree with its rows has a stored value no write produced —
 *     measured live on `bulk-7d35ee41`, which claims 5 auto-resolved + 19
 *     recommended against ZERO finding rows. The counters are the lie there, not
 *     the rows: the derived value is the truth by construction, which is what
 *     makes reconciliation safe rather than a judgement call.
 *
 * ## Why it FAILS a stranded run rather than re-driving it
 *
 * P-002 allows either. Failing is chosen because re-driving means LAUNCHING a
 * resolver agent, which is P-009's scheduled-resolver work and carries its own
 * single-flight and authority questions; a watchdog that silently spawns agents
 * is a much larger commitment than one that reports the truth. And failing here
 * is not destructive: `restartRun` explicitly accepts `phase = 'failed'`, so a
 * failed run stays one click (or one P-009 tick) from resuming, with every
 * already-decided outcome preserved — `restartRun` never writes the items table.
 *
 * The cost of a WRONG strand is the thing to keep in view: it would abandon a
 * resolver that was merely slow. That is why the staleness predicate lives inside
 * the store's UPDATE ... WHERE rather than in a read here (a resolver that beats
 * between the decision and the write wins the race and the strand cleanly does
 * nothing), and why the threshold is the store's own deliberately-generous
 * `RUN_HEARTBEAT_STALE_MS` rather than a second number this module invents.
 *
 * Pure decision core here; DB effects are injected. Same split as
 * `acceptance-grading-sweep.ts` / `-run.ts`.
 */

import type { BulkRunPhase, RunLiveness } from './bulk-run-store';

/**
 * Mirrors of the store's thresholds. Kept as literals rather than imported
 * because `bulk-run-store` opens Postgres at module scope and this core must stay
 * importable from PG-free unit tests; `bulk-run-watchdog.test.ts` pins both
 * values against the store's exports so the two cannot drift.
 */
export const WATCHDOG_STALE_AFTER_MS = 5 * 60_000;
export const WATCHDOG_RESOLVER_MAX_SILENCE_MS = 30 * 60_000;

/**
 * What the shared activity clock says about the run's resolver
 * (WI-10004887). `heartbeat_at` is written only by the run tools, so a
 * resolver that spends six minutes classifying with other tools, or polls its
 * inbox for a peer's reply, reads as dead to a heartbeat-only watchdog. Measured
 * 2026-10-01: two scheduled runs were failed while their resolvers were making
 * tool calls every few seconds (bulk-8df81e9e, bulk-948a3af3).
 */
export interface ResolverEvidence {
  ownerId: string;
  /**
   * Epoch-ms of the resolver's most recent `agent_activity` row or attributed
   * `tool_invocations` row — the same activity clock coord:presence derives from
   * (`fetchWakeability().lastActivityMs`). `null` when none was found.
   */
  lastActivityMs: number | null;
}

export interface BulkRunCounters {
  autoResolved: number;
  recommended: number;
  skipped: number;
  failed: number;
}

/** Everything the verdict depends on, read once per run. */
export interface WatchdogRunFacts {
  runId: string;
  phase: BulkRunPhase;
  liveness: RunLiveness;
  /** Items (or cleanup findings) still carrying `pending`. */
  undecided: number;
  /** The counters currently STORED on the run row. */
  stored: BulkRunCounters;
  /** The counters DERIVED from the run's own item/finding rows — the truth. */
  derived: BulkRunCounters;
  /**
   * The resolver's own activity, when the run names a resolver owner. Absent or
   * `null` means no evidence beyond the heartbeat — the pre-WI-10004887 rule.
   */
  resolver?: ResolverEvidence | null;
}

export interface CounterDrift {
  stored: BulkRunCounters;
  derived: BulkRunCounters;
  /** Which counters disagree — named so a report says WHAT drifted, not just that it did. */
  fields: (keyof BulkRunCounters)[];
}

export interface WatchdogVerdict {
  runId: string;
  /**
   * Explicitly fail this run and mark its undecided items, or `null` to leave it
   * alone. Independent of `counterDrift`: a run can need both, one, or neither.
   */
  strand: {
    reason: 'stale-executing';
    undecided: number;
    ageMs: number;
    /** `start` means the resolver died before its FIRST heartbeat — a materially
     *  different failure from one that beat and then stopped, and the one an
     *  owner-facing report most needs spelled out. */
    measuredFrom: 'heartbeat' | 'start';
  } | null;
  /**
   * The heartbeat is stale but the resolver is demonstrably working, so the run
   * is left alone this tick. Reported so a sweep can say WHY it did not strand.
   */
  deferred: {
    reason: 'resolver-active';
    ownerId: string;
    /** How long ago the resolver last did anything. */
    activityAgeMs: number;
    /** How long since the run's own last heartbeat (or start). */
    heartbeatAgeMs: number;
  } | null;
  counterDrift: CounterDrift | null;
}

/**
 * PURE: does the resolver's own activity keep a heartbeat-stale run alive?
 *
 * Two bounds, and each blocks a distinct failure:
 *  - the activity must be as recent as the heartbeat threshold itself, so a
 *    resolver that went quiet is noticed on the same clock as before;
 *  - the run's own heartbeat (or start) must be younger than
 *    `maxSilenceMs`. Without this ceiling a resolver stuck looping on unrelated
 *    tools would hold a run open forever; the run tools beat on every manifest
 *    and report, so 30 minutes without one means the run is not advancing.
 */
export function resolverKeepsRunAlive(input: {
  liveness: RunLiveness;
  resolver: ResolverEvidence | null | undefined;
  nowMs: number;
  staleAfterMs?: number;
  maxSilenceMs?: number;
}): { ownerId: string; activityAgeMs: number; heartbeatAgeMs: number } | null {
  const staleAfterMs = input.staleAfterMs ?? WATCHDOG_STALE_AFTER_MS;
  const maxSilenceMs = input.maxSilenceMs ?? WATCHDOG_RESOLVER_MAX_SILENCE_MS;
  if (input.liveness.state !== 'stale') return null;
  const resolver = input.resolver;
  if (!resolver || resolver.lastActivityMs == null || !Number.isFinite(resolver.lastActivityMs)) return null;
  const heartbeatAgeMs = input.liveness.ageMs;
  if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > maxSilenceMs) return null;
  const activityAgeMs = input.nowMs - resolver.lastActivityMs;
  // A future timestamp is clock skew, not proof of life beyond the threshold;
  // treat it as "just now" rather than rejecting it, since it is still recent.
  if (activityAgeMs > staleAfterMs) return null;
  return { ownerId: resolver.ownerId, activityAgeMs: Math.max(0, activityAgeMs), heartbeatAgeMs };
}

const COUNTER_FIELDS: (keyof BulkRunCounters)[] = [
  'autoResolved',
  'recommended',
  'skipped',
  'failed',
];

export function diffCounters(
  stored: BulkRunCounters,
  derived: BulkRunCounters,
): CounterDrift | null {
  const fields = COUNTER_FIELDS.filter((f) => stored[f] !== derived[f]);
  return fields.length === 0 ? null : { stored, derived, fields };
}

/**
 * The whole rule, pure.
 *
 * Note what is deliberately NOT conditioned on phase: counter drift is checked on
 * every run the sweep reads, terminal ones included. The measured case that
 * motivated this item (`bulk-7d35ee41`) is a run that already reached a terminal
 * phase carrying counters no write could have produced — checking only active
 * runs would miss precisely the population where the drift is permanent.
 */
export function decideWatchdogVerdict(
  facts: WatchdogRunFacts,
  nowMs: number = Date.now(),
): WatchdogVerdict {
  const counterDrift = diffCounters(facts.stored, facts.derived);

  // Only an EXECUTING run can be stranded. `review` is waiting on the owner by
  // design and `complete`/`failed` are done — calling either stale would turn a
  // correct state into a failure. `classifyRunLiveness` already encodes that as
  // `not-executing`, so this reads its verdict rather than re-deriving it.
  if (facts.liveness.state !== 'stale') {
    return { runId: facts.runId, strand: null, deferred: null, counterDrift };
  }
  // A stale run with nothing left undecided has no stranded work — settling it is
  // the settle path's job (and `deriveSettleOutcome` has its own never-ran rule).
  // Failing it here would relabel a finished run as a failure.
  if (facts.undecided <= 0) {
    return { runId: facts.runId, strand: null, deferred: null, counterDrift };
  }

  // The heartbeat is one witness, not the only one (WI-10004887). A resolver that
  // is still calling tools is working on the run even when it is not calling a
  // run tool, and failing it there is the costly direction of error this module
  // was written to avoid.
  const alive = resolverKeepsRunAlive({ liveness: facts.liveness, resolver: facts.resolver, nowMs });
  if (alive) {
    return {
      runId: facts.runId,
      strand: null,
      deferred: { reason: 'resolver-active', ...alive },
      counterDrift,
    };
  }

  return {
    runId: facts.runId,
    strand: {
      reason: 'stale-executing',
      undecided: facts.undecided,
      ageMs: facts.liveness.ageMs,
      measuredFrom: facts.liveness.measuredFrom,
    },
    deferred: null,
    counterDrift,
  };
}

/** The owner-facing reason written onto the run and its abandoned items. */
export function strandReasonText(strand: NonNullable<WatchdogVerdict['strand']>): string {
  const minutes = Number.isFinite(strand.ageMs) ? Math.round(strand.ageMs / 60_000) : null;
  const age = minutes == null ? 'an unknown time' : `${minutes}m`;
  const since =
    strand.measuredFrom === 'start'
      ? 'never reported a heartbeat after launch'
      : 'stopped reporting';
  return (
    `Resolver ${since} (${age} since the last evidence of life); ` +
    `${strand.undecided} item(s) were never decided. Marked failed by the run watchdog — ` +
    `restart the run to hand the remaining items to a fresh resolver.`
  );
}

export interface WatchdogDependencies {
  /** Runs worth examining. The sweep bounds this itself (recency/phase). */
  listRuns(): Promise<WatchdogRunFacts[]>;
  /**
   * Fail the run and mark its undecided items, re-checking staleness inside the
   * write so a resolver that woke up in the meantime wins. Returns how many items
   * were actually marked; 0 means the write lost that race and nothing changed.
   */
  strandRun(input: { runId: string; reason: string }): Promise<{ marked: number }>;
  /** Recompute the run's stored counters from its own rows. */
  reconcileCounters(input: { runId: string }): Promise<void>;
  /** Structured trace for the routine log; never throws. */
  note?(line: string): void;
  /** Clock seam for tests; defaults to `Date.now()`. */
  nowMs?(): number;
}

export interface WatchdogSweepResult {
  examined: number;
  stranded: string[];
  /** Heartbeat-stale runs left alone because their resolver is still working. */
  deferred: string[];
  itemsMarked: number;
  countersReconciled: string[];
  /** Runs whose effect threw. A failure on one run must not abort the sweep. */
  errors: { runId: string; error: string }[];
}

/**
 * Run one sweep. Every effect is per-run and independently guarded: a watchdog
 * that aborts the whole pass because one run's write failed would leave the
 * REST stranded, which is the condition it exists to clear.
 */
export async function runBulkRunWatchdog(
  deps: WatchdogDependencies,
): Promise<WatchdogSweepResult> {
  const result: WatchdogSweepResult = {
    examined: 0,
    stranded: [],
    deferred: [],
    itemsMarked: 0,
    countersReconciled: [],
    errors: [],
  };

  const runs = await deps.listRuns();
  const nowMs = deps.nowMs?.() ?? Date.now();
  for (const facts of runs) {
    result.examined += 1;
    const verdict = decideWatchdogVerdict(facts, nowMs);
    if (verdict.deferred) {
      result.deferred.push(facts.runId);
      deps.note?.(
        `deferred ${facts.runId}: no run heartbeat for ${Math.round(verdict.deferred.heartbeatAgeMs / 1000)}s, ` +
          `but resolver ${verdict.deferred.ownerId} was active ${Math.round(verdict.deferred.activityAgeMs / 1000)}s ago`,
      );
    }
    try {
      if (verdict.strand) {
        const { marked } = await deps.strandRun({
          runId: facts.runId,
          reason: strandReasonText(verdict.strand),
        });
        // `marked === 0` means the guarded write refused — the resolver was alive
        // after all. Reporting it as stranded would be a false positive in the
        // one direction that matters, so it is recorded only when it took effect.
        if (marked > 0) {
          result.stranded.push(facts.runId);
          result.itemsMarked += marked;
          deps.note?.(
            `stranded ${facts.runId}: ${marked} undecided item(s) marked failed ` +
              `(${verdict.strand.measuredFrom === 'start' ? 'never beat' : 'stopped beating'})`,
          );
        }
      }
      // Reconcile AFTER a strand: the strand writes item outcomes, so the drift
      // measured before it is out of date and the recompute must see the new rows.
      if (verdict.counterDrift || verdict.strand) {
        await deps.reconcileCounters({ runId: facts.runId });
        result.countersReconciled.push(facts.runId);
        if (verdict.counterDrift) {
          deps.note?.(
            `reconciled ${facts.runId}: stored counters disagreed with their own rows ` +
              `on ${verdict.counterDrift.fields.join(', ')}`,
          );
        }
      }
    } catch (e) {
      result.errors.push({ runId: facts.runId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
