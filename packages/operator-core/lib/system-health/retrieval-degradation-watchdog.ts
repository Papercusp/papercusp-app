/**
 * retrieval-degradation-watchdog (system-notices-on-its-own-2026-08-16 P-002) —
 * make a sustained retrieval degradation visible the way a stalled routine is.
 *
 * WHY. `summariseLegs` decides, for every single search, whether the ranking
 * returned is the ranking the configuration promises. `observeLegs` (P-002) now
 * records that verdict into a bounded trailing window instead of throwing it
 * away. This is the last leg: something has to READ the rate, or instrumenting
 * it just moves the problem from "prose nobody reads" to "a counter nobody
 * queries".
 *
 * The observed failure, three times inside one agent session on 2026-08-16:
 * `semantic leg blocked: query embed failed: query embed exceeded 1200ms budget`
 * — every returned pointer lexical-only — plus a fourth occurrence where the
 * LEXICAL leg contributed 0 candidates instead. Retrieval is how stored
 * knowledge reaches the moment of need, so a half-strength retrieval layer is
 * precisely the mechanism behind "the knowledge existed and it did not reach
 * me". Nothing alarmed, because nothing was counting.
 *
 * SCOPE HONESTY — read this before trusting a quiet watchdog. `readLegHealth()`
 * is an IN-PROCESS ring buffer, so this sweep measures the searches THIS process
 * ran. It is armed in the operator host, which is where the agent-facing search
 * paths execute, so that is the population that matters — but a quiet result
 * means "this process saw no sustained degradation", never "retrieval is healthy
 * everywhere". A cross-process aggregate would need a durable sink and is
 * deliberately not built here: it would be a second definition of the same
 * verdict, and the first thing to establish is whether the rate is even
 * non-trivial.
 */
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { readLegHealth, type LegHealthWindow } from '@papercusp/search';

import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

export const RETRIEVAL_DEGRADATION_SWEEP_INTERVAL_MS = 15 * 60_000;
export const RETRIEVAL_DEGRADATION_WINDOW_MS = 60 * 60_000;

/**
 * Minimum searches in the window before any verdict is issued.
 *
 * Without this, one degraded search in a quiet hour reads as a 100% degradation
 * rate. A rate over a tiny denominator is not a measurement.
 */
export const RETRIEVAL_DEGRADATION_MIN_SAMPLES = 20;

/**
 * The alarm floor, as a fraction of searches in the window.
 *
 * PROVISIONAL AND DELIBERATELY HIGH, and the reason is worth stating: there is
 * no baseline for this rate yet, because until P-002 nothing measured it. Any
 * precise-looking threshold chosen today would be invented rather than derived.
 * So this is set where the verdict is unambiguous REGARDLESS of baseline — half
 * of all retrievals in an hour not running at full strength is wrong under any
 * reading — and it should be re-derived from real percentiles once the metric
 * has produced a few days of data. Producing that baseline is the point of
 * shipping the measurement first.
 */
export const RETRIEVAL_DEGRADATION_FLOOR = 0.5;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'retrieval-degradation-watchdog',
  ownerLabel: 'system · retrieval degradation',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export type RetrievalVerdict =
  | { kind: 'insufficient-samples'; health: LegHealthWindow }
  | { kind: 'healthy'; health: LegHealthWindow }
  | { kind: 'degraded'; health: LegHealthWindow; rate: number; dominant: string };

/**
 * PURE: decide what the window says. Split from the sweep so the thresholds are
 * testable with no timers, no PG and no escalation surface.
 */
export function judgeRetrievalHealth(
  health: LegHealthWindow,
  opts: { minSamples?: number; floor?: number } = {},
): RetrievalVerdict {
  const minSamples = opts.minSamples ?? RETRIEVAL_DEGRADATION_MIN_SAMPLES;
  const floor = opts.floor ?? RETRIEVAL_DEGRADATION_FLOOR;
  // degradedRate is null (never 0) when nothing was recorded — a no-data window
  // must not be able to impersonate a clean bill of health.
  if (health.degradedRate === null || health.searches < minSamples) {
    return { kind: 'insufficient-samples', health };
  }
  if (health.degradedRate < floor) return { kind: 'healthy', health };
  // Name the leg actually responsible, so the alarm points at a cause rather
  // than restating that something is wrong.
  const counts: [string, number][] = [
    ['semantic leg blocked', health.semanticBlocked],
    ['lexical leg blocked', health.lexicalBlocked],
    ['semantic leg returned nothing', health.semanticEmpty],
    ['lexical leg returned nothing', health.lexicalEmpty],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const dominant = counts[0][1] > 0 ? counts[0][0] : 'mixed / partial source failures';
  return { kind: 'degraded', health, rate: health.degradedRate, dominant };
}

export interface RetrievalDegradationSweepDeps {
  readHealth: () => LegHealthWindow;
  escalate: (v: Extract<RetrievalVerdict, { kind: 'degraded' }>) => Promise<void>;
  flagEnabled: () => Promise<boolean>;
  minSamples: number;
  floor: number;
}

async function defaultFlagEnabled(): Promise<boolean> {
  try {
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    return await getFlag(FLAGS.RETRIEVAL_DEGRADATION_WATCHDOG, 'system');
  } catch {
    return false;
  }
}

async function defaultEscalate(
  v: Extract<RetrievalVerdict, { kind: 'degraded' }>,
): Promise<void> {
  const pct = (v.rate * 100).toFixed(0);
  const h = v.health;
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary: `Retrieval degraded: ${pct}% of ${h.searches} searches in the last hour did not run at full strength (${v.dominant})`,
    body:
      `${h.degraded} of ${h.searches} searches in the trailing ` +
      `${Math.round(h.windowMs / 60_000)}min ran DEGRADED — the ranking returned was not the ` +
      `ranking the configuration promises. Dominant cause: ${v.dominant}.\n\n` +
      `Breakdown: semantic blocked ${h.semanticBlocked} · lexical blocked ${h.lexicalBlocked} · ` +
      `semantic returned nothing ${h.semanticEmpty} · lexical returned nothing ${h.lexicalEmpty}` +
      (h.truncatedByCapacity
        ? `\n\n⚠ The retained sample was capacity-bound, so these counts are FLOORS, not totals.`
        : '') +
      `\n\nWhy this matters more than it looks: retrieval is how stored knowledge reaches an ` +
      `agent at the moment it is needed. A half-strength retrieval layer does not fail loudly — ` +
      `it silently returns a worse ranking, and the caller reads it as the answer. The observed ` +
      `signature is a per-call prose warning ("semantic leg blocked: query embed exceeded 1200ms ` +
      `budget") that readers skim past.\n\n` +
      `Triage: if 'semantic leg blocked' dominates, the query embedder is timing out — check the ` +
      `embedding provider's latency against the query-embed budget. If a leg 'returned nothing', ` +
      `check the score floors before suspecting the sources.\n\n` +
      `SCOPE: this measures searches run in THIS operator process. Quiet means "this process saw ` +
      `no sustained degradation", never "retrieval is healthy everywhere".`,
    meta: {
      dedupKind: 'retrieval-degradation',
      // Bucketed so a persistent condition dedups instead of re-alarming every
      // sweep, while a materially worse rate still opens a fresh escalation.
      subjectSignature: `${v.dominant}:${Math.floor(v.rate * 10)}`,
      degradedRate: v.rate,
      searches: h.searches,
      degraded: h.degraded,
      dominant: v.dominant,
      truncatedByCapacity: h.truncatedByCapacity,
    },
  });
}

function sweepDeps(
  overrides: Partial<RetrievalDegradationSweepDeps>,
): RetrievalDegradationSweepDeps {
  return {
    readHealth: () => readLegHealth({ windowMs: RETRIEVAL_DEGRADATION_WINDOW_MS }),
    escalate: defaultEscalate,
    flagEnabled: defaultFlagEnabled,
    minSamples: RETRIEVAL_DEGRADATION_MIN_SAMPLES,
    floor: RETRIEVAL_DEGRADATION_FLOOR,
    ...overrides,
  };
}

/** One sweep. Exported for tests. */
export async function runRetrievalDegradationSweepOnce(
  overrides: Partial<RetrievalDegradationSweepDeps> = {},
): Promise<{ verdict: RetrievalVerdict['kind'] | 'skipped'; escalated: number }> {
  const deps = sweepDeps(overrides);
  if (!(await deps.flagEnabled())) return { verdict: 'skipped', escalated: 0 };
  const verdict = judgeRetrievalHealth(deps.readHealth(), {
    minSamples: deps.minSamples,
    floor: deps.floor,
  });
  if (verdict.kind !== 'degraded') return { verdict: verdict.kind, escalated: 0 };
  await deps.escalate(verdict);
  return { verdict: 'degraded', escalated: 1 };
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the retrieval-degradation watchdog. Idempotent.
 * Runtime gate: FLAGS.RETRIEVAL_DEGRADATION_WATCHDOG (checked per tick).
 */
export function startRetrievalDegradationWatchdog(opts: { intervalMs?: number } = {}): void {
  const intervalMs = opts.intervalMs ?? RETRIEVAL_DEGRADATION_SWEEP_INTERVAL_MS;
  if (watchdogTimer) watchdogTimer.stop();
  let sweeping = false;
  watchdogTimer = managedSetInterval(
    'retrieval-degradation-watchdog',
    intervalMs,
    () => {
      if (sweeping) return;
      sweeping = true;
      void runRetrievalDegradationSweepOnce()
        .catch((e) => {
          console.warn(
            `[retrieval-degradation-watchdog] sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
          );
        })
        .finally(() => {
          sweeping = false;
        });
    },
    // D-004: 'must-sample'. The leg-health ring buffer is plain in-process state written
    // by the search path and emits no change events, so there is nothing to subscribe to
    // for "the degradation rate crossed" — it has to be read.
    { category: 'watchdog', classification: 'must-sample' },
  );
}
