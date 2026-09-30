/**
 * Learning-governor REGISTRANTS (self-learning-frontier-2026-06-12 P-003 /
 * FB-01) — the glue between the governor ledger and its callers:
 *
 *   - `learningGovernorPreflight` — THE gate every frontier loop (FB-04..15)
 *     calls before an unattended run. Flag-aware: with papercusp-learning-
 *     governor OFF (the kill-switch) it refuses with 'governor-dark'; with it
 *     ON, unregistered/unbudgeted/exhausted loops refuse (D-004) — so a
 *     frontier loop cannot run unattended before its P-001 arming act (owner
 *     sets its budget) even if its own flag were flipped early.
 *
 *   - `recordGymTickToGovernor` / `recordScoutTickToGovernor` — the mirrors
 *     the existing gym + scout routine actions call after each tick. ZERO
 *     behavior change by construction: flag-gated, best-effort (never throw —
 *     governor bookkeeping must never fail or replay a host tick), and purely
 *     additive (gym_autoloop_config / scout's per-cycle budget stay the
 *     authoritative gates; their budgets surface here as sub-budgets).
 *
 * Deps are injectable (the codebase's seam pattern) so registrants.test.ts
 * covers flag-off no-ops, mirror mapping, and error swallowing with no PG.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  gymLoopId,
  gymRegistrationInput,
  scoutLoopId,
  scoutRegistrationInput,
  type GovernorVerdict,
  type GymAutoloopLike,
} from './core';
import {
  governorCheck,
  recordLearningSpend,
  registerLearningLoop,
  reserveLearningSpend,
  settleLearningSpend,
  type RecordLearningSpendInput,
  type RegisterLearningLoopInput,
  type ReserveLearningSpendInput,
  type ReserveLearningSpendResult,
  type SettleLearningSpendInput,
  type SettleLearningSpendResult,
} from './store';
import type { SpendAttemptKind } from './spend';

/** Injectable IO seam (tests). Defaults = the real flag + store + pool. */
export interface GovernorGlueDeps {
  enabled?: () => Promise<boolean>;
  getSql?: () => Promise<Sql>;
  register?: (sql: Sql, input: RegisterLearningLoopInput) => Promise<unknown>;
  recordSpend?: (sql: Sql, input: RecordLearningSpendInput) => Promise<unknown>;
  /** P-005: open one spend attempt (default: reserveLearningSpend). */
  reserve?: (sql: Sql, input: ReserveLearningSpendInput) => Promise<ReserveLearningSpendResult>;
  /** P-005: close one spend attempt (default: settleLearningSpend). */
  settle?: (sql: Sql, input: SettleLearningSpendInput) => Promise<SettleLearningSpendResult>;
  check?: (sql: Sql, q: { workspaceId: string; loopId: string; floorUsd?: number }) => Promise<GovernorVerdict>;
  /** P-004: resolve the pot a scout install learns for (default: resolveLearningPotSlug). */
  resolvePot?: (q: { workspaceId: string; harnessSlug: string }) => Promise<string | null>;
  log?: (msg: string) => void;
}

const defaultDeps: Required<GovernorGlueDeps> = {
  enabled: () => getFlag(FLAGS.LEARNING_GOVERNOR, 'learning-governor'),
  // Lazy import: unit tests of the host actions run the flag-off path with no
  // PG env; the pool module must not load (or throw) before the flag check.
  getSql: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  },
  register: registerLearningLoop,
  recordSpend: recordLearningSpend,
  reserve: reserveLearningSpend,
  settle: settleLearningSpend,
  check: governorCheck,
  // Lazy import for the same reason as getSql: the flag-off unit path must not
  // load (or pay for) the registry resolver.
  resolvePot: async (q) => {
    const { resolveLearningPotSlug } = await import('../learning/pot-scope');
    return resolveLearningPotSlug({ workspaceId: q.workspaceId, harnessSlug: q.harnessSlug });
  },
  log: (m) => console.log(`[learning-governor] ${m}`),
};

function resolve(deps?: GovernorGlueDeps): Required<GovernorGlueDeps> {
  return { ...defaultDeps, ...deps };
}

export interface GovernorGlueOutcome {
  applied: boolean;
  reason?: 'flag-off' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// The frontier preflight (FB-04..FB-15 call this before any unattended run)
// ---------------------------------------------------------------------------

/**
 * Flag-aware unattended-refusal gate: governor flag OFF ⇒ 'governor-dark';
 * otherwise the registration verdict (unregistered / disabled / unbudgeted /
 * exhausted ⇒ refuse). Fail-CLOSED: an IO error refuses rather than allows —
 * an unattended learning loop must never spend on a broken ledger.
 */
export async function learningGovernorPreflight(
  q: { workspaceId: string; loopId: string; floorUsd?: number },
  deps?: GovernorGlueDeps,
): Promise<GovernorVerdict> {
  const d = resolve(deps);
  try {
    if (!(await d.enabled())) return { allow: false, reason: 'governor-dark', remainingUsd: null };
    const sql = await d.getSql();
    return await d.check(sql, q);
  } catch (e) {
    d.log(`preflight failed for ${q.loopId} — refusing (fail-closed): ${e instanceof Error ? e.message : e}`);
    return { allow: false, reason: 'governor-error', remainingUsd: null };
  }
}

// ---------------------------------------------------------------------------
// Governed spend ATTEMPT (P-005) — the seam every spending call wraps
// ---------------------------------------------------------------------------

/** What the wrapped work reports back. `cancelled` closes the attempt without charging it as work done. */
export interface SpendAttemptReport<T> {
  /** What the attempt actually cost. Partial work reports its partial cost. */
  costUsd: number;
  value: T;
  /** The attempt stopped deliberately (a gate closed, nothing left to do) rather than completing. */
  cancelled?: boolean;
}

export interface GovernedSpendAttemptInput<T> {
  workspaceId: string;
  loopId: string;
  potSlug?: string | null;
  attemptKind: SpendAttemptKind;
  /** What this attempt asks the governor to set aside up front. */
  requestedUsd: number;
  signalOrigin?: 'organic' | 'drill' | 'replay' | 'shadow';
  runRef?: string | null;
  note?: string | null;
  /** false ⇒ ledger the charge without bumping the registration's spent_usd (mirror-mode loops). */
  accumulate?: boolean;
  /**
   * The work. `grant.reservedUsd` is what the governor set aside — bound the
   * work to it. `grant.clamped` says the grant was smaller than the request.
   *
   * If this throws, the attempt settles as `failed`. Attach a `costUsd`
   * property to the thrown error to declare money that was burned before the
   * failure — that is the proposer-call case P-005 names, where tokens are
   * spent and then the parse blows up.
   */
  run: (grant: { reservedUsd: number; clamped: boolean }) => Promise<SpendAttemptReport<T>>;
}

export type GovernedSpendAttemptOutcome<T> =
  | { ok: true; value: T; costUsd: number; reservationId: string; clamped: boolean; cancelled: boolean }
  /** The governor refused BEFORE the work ran — nothing was spent. */
  | { ok: false; reason: 'refused'; refusal: Extract<ReserveLearningSpendResult, { ok: false }>['reason']; headroomUsd: number | null }
  /** The governor is dark (kill-switch) — the work did not run. */
  | { ok: false; reason: 'governor-dark' }
  /** The work threw. The attempt is settled 'failed' with whatever it burned. */
  | { ok: false; reason: 'failed'; error: string; costUsd: number; reservationId: string | null };

function burnedCostOf(e: unknown): number {
  const c = (e as { costUsd?: unknown } | null)?.costUsd;
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : 0;
}

/**
 * Run one spending call inside a governor reservation, and settle it EXACTLY
 * once on every path — success, partial, cancellation, or throw.
 *
 * This is the answer to the shape the mirrors below still have: they ledger
 * only `if (costUsd > 0)`, so a proposer call that burned tokens and then threw
 * and an evaluation that completed 3 of 10 tasks are both invisible. Wrapping
 * the call means the ATTEMPT is the ledgered unit, not the happy path's price
 * tag, and the four amounts (requested / reserved / used / unsettled) are
 * whole.
 *
 * A settlement failure never masks the work: the value is returned and the
 * failure is logged. That leaves the reservation OPEN, which is the honest
 * state — it shows up in `unsettledUsd` as work whose cost is unknown, rather
 * than silently reading as free.
 */
export async function runGovernedSpendAttempt<T>(
  input: GovernedSpendAttemptInput<T>,
  deps?: GovernorGlueDeps,
): Promise<GovernedSpendAttemptOutcome<T>> {
  const d = resolve(deps);
  if (!(await d.enabled())) return { ok: false, reason: 'governor-dark' };
  const sql = await d.getSql();
  const reserved = await d.reserve(sql, {
    workspaceId: input.workspaceId,
    loopId: input.loopId,
    ...(input.potSlug === undefined ? {} : { potSlug: input.potSlug }),
    attemptKind: input.attemptKind,
    requestedUsd: input.requestedUsd,
    ...(input.signalOrigin ? { signalOrigin: input.signalOrigin } : {}),
    runRef: input.runRef ?? null,
    note: input.note ?? null,
  });
  if (!reserved.ok) {
    return { ok: false, reason: 'refused', refusal: reserved.reason, headroomUsd: reserved.headroomUsd };
  }
  const reservationId = reserved.reservation.id;
  const settle = async (
    disposition: 'used' | 'cancelled' | 'failed',
    usedUsd: number,
    note?: string,
  ): Promise<void> => {
    try {
      await d.settle(sql, {
        workspaceId: input.workspaceId,
        reservationId,
        disposition,
        usedUsd,
        ...(note ? { note } : {}),
        ...(input.accumulate === undefined ? {} : { accumulate: input.accumulate }),
      });
    } catch (e) {
      d.log(
        `settlement failed for reservation ${reservationId} (${disposition}, $${usedUsd}) — ` +
          `it stays OPEN and visible as unsettled spend: ${e instanceof Error ? e.message : e}`,
      );
    }
  };
  let report: SpendAttemptReport<T>;
  try {
    report = await input.run({ reservedUsd: reserved.reservation.reservedUsd, clamped: reserved.clamped });
  } catch (e) {
    const burned = burnedCostOf(e);
    const error = e instanceof Error ? e.message : String(e);
    await settle('failed', burned, `attempt failed: ${error}`);
    return { ok: false, reason: 'failed', error, costUsd: burned, reservationId };
  }
  const cancelled = report.cancelled === true;
  await settle(cancelled ? 'cancelled' : 'used', report.costUsd);
  return {
    ok: true,
    value: report.value,
    costUsd: report.costUsd,
    reservationId,
    clamped: reserved.clamped,
    cancelled,
  };
}

// ---------------------------------------------------------------------------
// Gym mirror (system:gym-cycle calls this after every tick)
// ---------------------------------------------------------------------------

export interface GymTickGovernorInput {
  workspaceId: string;
  /** The tick's already-open admin pool (gym-actions holds one) — avoids a second pool resolve. */
  sql: Sql;
  /** Lazy mirror source (listAutoloopsForWorkspace) — only read once the flag check passes. */
  listAutoloops: () => Promise<readonly GymAutoloopLike[]>;
  /** The tick outcome's spend, when a cycle ran. */
  ran?: { harnessSlug: string; spentUsd: number; runRef?: string } | null;
}

/**
 * Mirror every gym autoloop row onto the governor registry (budget AND spent
 * overwritten — gym_autoloop_config stays authoritative) and, when a cycle
 * ran, ledger one spend EVENT (accumulate:false — the row's spent comes from
 * the mirror; accumulating would double-count). Never throws.
 */
export async function recordGymTickToGovernor(
  input: GymTickGovernorInput,
  deps?: GovernorGlueDeps,
): Promise<GovernorGlueOutcome> {
  const d = resolve(deps);
  try {
    if (!(await d.enabled())) return { applied: false, reason: 'flag-off' };
    for (const cfg of await input.listAutoloops()) {
      await d.register(input.sql, gymRegistrationInput({ ...cfg, workspaceId: input.workspaceId }));
    }
    if (input.ran && input.ran.spentUsd > 0) {
      await d.recordSpend(input.sql, {
        workspaceId: input.workspaceId,
        loopId: gymLoopId(input.ran.harnessSlug),
        // per-hive by construction — the harness slug IS the pot (P-004).
        potSlug: input.ran.harnessSlug,
        costUsd: input.ran.spentUsd,
        runRef: input.ran.runRef ?? null,
        note: 'gym autoloop cycle',
        accumulate: false,
      });
    }
    return { applied: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    d.log(`gym mirror failed (tick unaffected): ${error}`);
    return { applied: false, reason: 'error', error };
  }
}

// ---------------------------------------------------------------------------
// Scout mirror (system:scout-cycle calls this after every tick)
// ---------------------------------------------------------------------------

export interface ScoutTickGovernorInput {
  workspaceId: string;
  harnessSlug: string;
  /** The tick's resolved per-cycle cap (budget.ts maxCostUsd) — mirrored as the sub-budget. */
  perCycleBudgetUsd: number;
  /** Spend when the tick fired a cycle that reported cost. */
  fired?: { costUsd: number; cycleId?: string } | null;
}

/**
 * Mirror the scout registration (per-cycle sub-budget; spent preserved) and,
 * when a cycle fired with reported cost, ACCUMULATE it (the governor is
 * scout's only loop-level spend store). Never throws.
 */
export async function recordScoutTickToGovernor(
  input: ScoutTickGovernorInput,
  deps?: GovernorGlueDeps,
): Promise<GovernorGlueOutcome> {
  const d = resolve(deps);
  try {
    if (!(await d.enabled())) return { applied: false, reason: 'flag-off' };
    const sql = await d.getSql();
    // P-004 (pot-scope-all-learnings): the loop keys by the POT the scout learns
    // for, not the raw install slug — the workspace-brain scout previously minted
    // `blender:papercusp-workspace` / `blender:@singleton` registrants. An
    // unresolvable pot degrades to the install slug so a degraded process still
    // budgets/ledgers consistently.
    const potSlug = await d
      .resolvePot({ workspaceId: input.workspaceId, harnessSlug: input.harnessSlug })
      .catch(() => null);
    await d.register(
      sql,
      scoutRegistrationInput({
        workspaceId: input.workspaceId,
        harnessSlug: input.harnessSlug,
        potSlug,
        perCycleBudgetUsd: input.perCycleBudgetUsd,
      }),
    );
    if (input.fired && input.fired.costUsd > 0) {
      await d.recordSpend(sql, {
        workspaceId: input.workspaceId,
        loopId: scoutLoopId(potSlug ?? input.harnessSlug),
        potSlug,
        costUsd: input.fired.costUsd,
        runRef: input.fired.cycleId ?? null,
        note: 'scout ideation cycle',
        accumulate: true,
      });
    }
    return { applied: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    d.log(`scout mirror failed (tick unaffected): ${error}`);
    return { applied: false, reason: 'error', error };
  }
}
