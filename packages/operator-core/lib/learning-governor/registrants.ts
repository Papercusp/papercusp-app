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
  type LearningReservationResources,
  type LearningSpendReservation,
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
  /** Reported cost, or the known subtotal when usage evidence is incomplete. */
  costUsd: number;
  value: T;
  /** The subtotal cannot establish total spend; retain the reservation for reconciliation. */
  costUsdMeasurementMissing?: boolean;
  /** The attempt stopped deliberately (a gate closed, nothing left to do) rather than completing. */
  cancelled?: boolean;
}

/** The immutable reservation snapshot available BEFORE spending starts.
 * The ID links a dispatch to its durable row; it is not an authentication
 * token or proof that a provider enforces the reserved monetary amount.
 */
export interface SpendAttemptGrant {
  readonly reservationId: string;
  readonly reservedUsd: number;
  readonly clamped: boolean;
  /** Actual store-admitted bounds, frozen independently of the adapter's row. */
  readonly resources?: Readonly<LearningReservationResources>;
}

export interface GovernedSpendAttemptInput<T> {
  workspaceId: string;
  loopId: string;
  potSlug?: string | null;
  attemptKind: SpendAttemptKind;
  /** What this attempt asks the governor to set aside up front. */
  requestedUsd: number;
  /** Forward the existing store contract for single-use manifest/resource admission. */
  exact?: ReserveLearningSpendInput['exact'];
  /** Same floor as reserveLearningSpend; omission preserves its default. */
  floorUsd?: number;
  signalOrigin?: 'organic' | 'drill' | 'replay' | 'shadow';
  runRef?: string | null;
  note?: string | null;
  /** false ⇒ ledger the charge without bumping the registration's spent_usd (mirror-mode loops). */
  accumulate?: boolean;
  /**
   * The work. `grant.reservedUsd` is what the governor set aside — bound the
   * work to it. `grant.clamped` says the grant was smaller than the request.
   *
   * If this throws, attach a finite nonnegative `costUsd` (including an
   * explicit zero) to establish the charge. Missing/invalid cost, or
   * `costUsdMeasurementMissing:true`, leaves the reservation OPEN. A known
   * subtotal is retained without settling it as the full charge.
   */
  run: (grant: SpendAttemptGrant) => Promise<SpendAttemptReport<T>>;
}

export type GovernedSpendAttemptOutcome<T> =
  | { ok: true; value: T; costUsd: number; reservationId: string; clamped: boolean; cancelled: boolean;
      /** Actual store response, including refusals. Null means the outcome could not be confirmed. */
      settlement: SettleLearningSpendResult | null; settlementError?: string; costUsdMeasurementMissing?: true }
  /** The governor refused BEFORE the work ran — nothing was spent. */
  | { ok: false; reason: 'refused'; refusal: Extract<ReserveLearningSpendResult, { ok: false }>['reason']; headroomUsd: number | null }
  /** The governor is dark (kill-switch) — the work did not run. */
  | { ok: false; reason: 'governor-dark' }
  /** The work threw. Complete usage settles 'failed'; incomplete usage remains OPEN. */
  | { ok: false; reason: 'failed'; error: string; costUsd: number; reservationId: string | null;
      settlement: SettleLearningSpendResult | null; settlementError?: string; costUsdMeasurementMissing?: true };

function costEvidenceOf(value: unknown): { costUsd: number; missing: boolean } {
  const report = value as { costUsd?: unknown; costUsdMeasurementMissing?: unknown } | null;
  const c = report?.costUsd;
  const valid = typeof c === 'number' && Number.isFinite(c) && c >= 0;
  return { costUsd: valid ? c : 0, missing: !valid || report?.costUsdMeasurementMissing === true };
}

/** Immutability is not admission: a stale, foreign or malformed successful
 * adapter receipt must not become the authority for a paid dispatch. */
function validDispatchReservation<T>(
  reservation: LearningSpendReservation | null,
  input: GovernedSpendAttemptInput<T>,
  clamped: boolean,
  headroomUsd: number | null,
): reservation is LearningSpendReservation {
  const amount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!reservation || typeof reservation.id !== 'string' || !reservation.id.trim() ||
    reservation.workspaceId !== input.workspaceId || reservation.loopId !== input.loopId ||
    reservation.attemptKind !== input.attemptKind || reservation.status !== 'open' ||
    reservation.usedUsd !== 0 || reservation.settledAt !== null ||
    !amount(input.requestedUsd) || reservation.requestedUsd !== input.requestedUsd ||
    !amount(reservation.reservedUsd) || reservation.reservedUsd > input.requestedUsd ||
    !amount(headroomUsd) || reservation.reservedUsd > headroomUsd ||
    typeof clamped !== 'boolean' || clamped !== (reservation.reservedUsd < input.requestedUsd) ||
    reservation.signalOrigin !== (input.signalOrigin ?? 'organic') ||
    (input.potSlug !== undefined && reservation.potSlug !== input.potSlug)) return false;
  const resources = reservation.resources;
  if (resources !== undefined && (!resources || typeof resources !== 'object' ||
    typeof resources.armId !== 'string' || !resources.armId.trim() ||
    !Number.isSafeInteger(resources.inputTokens) || resources.inputTokens < 0 ||
    !Number.isSafeInteger(resources.outputTokens) || resources.outputTokens <= 0)) return false;
  if (!input.exact) return reservation.runRef === (input.runRef ?? null);
  const exact = input.exact;
  const expectedResources = exact.resources;
  return reservation.id.toLowerCase() === exact.reservationId.toLowerCase() &&
    reservation.runRef === `manifest:${exact.binding}/attempt:${exact.reservationId.toLowerCase()}` &&
    reservation.reservedUsd === input.requestedUsd && !clamped &&
    (expectedResources === undefined ? resources === undefined :
      resources !== undefined && resources.armId === expectedResources.armId &&
      resources.inputTokens === expectedResources.inputTokens && resources.outputTokens === expectedResources.outputTokens);
}

/**
 * Run one spending call inside a governor reservation. Complete usage settles
 * exactly once — success, partial, cancellation, or throw. Incomplete usage
 * leaves the reservation OPEN rather than declaring a subtotal to be the total.
 *
 * This is the answer to the shape the mirrors below still have: they ledger
 * only `if (costUsd > 0)`, so a proposer call that burned tokens and then threw
 * and an evaluation that completed 3 of 10 tasks are both invisible. Wrapping
 * the call means the ATTEMPT is the ledgered unit, not the happy path's price
 * tag, and the four amounts (requested / reserved / used / unsettled) are
 * whole.
 *
 * A settlement failure never masks the work: the value is returned and the
 * failure is logged. The actual store response is retained separately from
 * the work's reported cost. If the call throws, settlement stays unknown: a
 * transport error may occur before or after commit, so it cannot prove that
 * the reservation is either open or closed.
 */
export async function runGovernedSpendAttempt<T>(
  input: GovernedSpendAttemptInput<T>,
  deps?: GovernorGlueDeps,
): Promise<GovernedSpendAttemptOutcome<T>> {
  // An async flag/pool preflight must not let the caller replace the manifest,
  // resource policy, dispatch callback or settlement identity after admission
  // begins. The store validates this snapshot against the registered policy.
  input = { ...input, ...(input.exact ? { exact: { ...input.exact,
    ...(input.exact.resources ? { resources: { ...input.exact.resources } } : {}),
    ...(input.exact.expectedResourceBudget ? { expectedResourceBudget: { ...input.exact.expectedResourceBudget,
      armIds: Array.isArray(input.exact.expectedResourceBudget.armIds) ? [...input.exact.expectedResourceBudget.armIds] : [],
    } } : {}),
  } } : {}) };
  const d = resolve(deps);
  if (!(await d.enabled())) return { ok: false, reason: 'governor-dark' };
  const sql = await d.getSql();
  const reserved = await d.reserve(sql, {
    workspaceId: input.workspaceId,
    loopId: input.loopId,
    ...(input.potSlug === undefined ? {} : { potSlug: input.potSlug }),
    attemptKind: input.attemptKind,
    requestedUsd: input.requestedUsd,
    ...(input.exact === undefined ? {} : { exact: input.exact }),
    ...(input.floorUsd === undefined ? {} : { floorUsd: input.floorUsd }),
    ...(input.signalOrigin ? { signalOrigin: input.signalOrigin } : {}),
    runRef: input.runRef ?? null,
    note: input.note ?? null,
  });
  if (!reserved.ok) {
    return { ok: false, reason: 'refused', refusal: reserved.reason, headroomUsd: reserved.headroomUsd };
  }
  // Copy once before validating, then dispatch only that snapshot. Never try
  // to settle an invalid receipt: its id may belong to another live attempt.
  const row = reserved.reservation;
  const reservation = row && typeof row === 'object' ? { ...row,
    ...(row.resources ? { resources: { ...row.resources } } : {}),
  } : null;
  const clamped = reserved.clamped;
  if (!validDispatchReservation(reservation, input, clamped, reserved.headroomUsd)) {
    const error = 'governor reservation receipt does not match request';
    d.log(error);
    return { ok: false, reason: 'failed', error, costUsd: 0, reservationId: null,
      settlement: null, settlementError: 'invalid reservation receipt; dispatch and settlement not attempted' };
  }
  const reservationId = reservation.id;
  const grant: SpendAttemptGrant = Object.freeze({
    reservationId, reservedUsd: reservation.reservedUsd, clamped,
    ...(reservation.resources ? { resources: Object.freeze({ ...reservation.resources }) } : {}),
  });
  let settlement: SettleLearningSpendResult | null = null;
  let settlementError: string | undefined;
  const settle = async (
    disposition: 'used' | 'cancelled' | 'failed',
    usedUsd: number,
    note?: string,
  ): Promise<void> => {
    try {
      settlement = await d.settle(sql, {
        workspaceId: input.workspaceId,
        reservationId,
        disposition,
        usedUsd,
        ...(note ? { note } : {}),
        ...(input.accumulate === undefined ? {} : { accumulate: input.accumulate }),
      });
      if (!settlement.ok) {
        d.log(`settlement refused for reservation ${reservationId}: ${settlement.reason} ` +
          `(stored status: ${settlement.reservation?.status ?? 'unknown'})`);
      }
    } catch (e) {
      settlementError = e instanceof Error ? e.message : String(e);
      d.log(
        `settlement outcome unconfirmed for reservation ${reservationId} (${disposition}, $${usedUsd}): ` +
          settlementError,
      );
    }
  };
  let report: SpendAttemptReport<T>;
  const incompleteUsage = () => {
    settlementError = 'usage measurement incomplete; reservation remains open';
    d.log(`reservation ${reservationId}: ${settlementError}`);
  };
  try {
    report = await input.run(grant);
  } catch (e) {
    const { costUsd: burned, missing } = costEvidenceOf(e);
    const error = e instanceof Error ? e.message : String(e);
    if (missing) incompleteUsage();
    else await settle('failed', burned, `attempt failed: ${error}`);
    return { ok: false, reason: 'failed', error, costUsd: burned, reservationId,
      settlement, ...(settlementError === undefined ? {} : { settlementError }),
      ...(missing ? { costUsdMeasurementMissing: true } : {}) };
  }
  const { costUsd, missing } = costEvidenceOf(report);
  const cancelled = report.cancelled === true;
  if (missing) incompleteUsage();
  else await settle(cancelled ? 'cancelled' : 'used', costUsd);
  return {
    ok: true,
    value: report.value,
    costUsd,
    reservationId,
    clamped: grant.clamped,
    cancelled,
    settlement,
    ...(settlementError === undefined ? {} : { settlementError }),
    ...(missing ? { costUsdMeasurementMissing: true } : {}),
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
