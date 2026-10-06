/**
 * Governed replay (P-020 / FB-06) — the flag + learning-governor glue around
 * {@link runReplayBattery}:
 *
 *   - `replayPreflight` — THE gate before any unattended replay. Double-dark
 *     per D-001: the `papercusp-replay-harness` flag OFF refuses with
 *     'replay-dark' BEFORE the governor is even consulted; with it ON, the
 *     governor's verdict applies (governor-dark / unregistered / unbudgeted /
 *     exhausted ⇒ refuse, D-004). Fail-CLOSED, like the governor's own
 *     preflight.
 *   - `registerReplayLoop` — the arming act (P-001): registers
 *     `frontier:replay-harness` with an owner-set budget.
 *   - `runGovernedReplay` — preflight → reserve an evaluation attempt → clamp
 *     the battery to its grant → run → settle the actual charge once
 *     (signal_origin='replay', accumulate) → return result + spend provenance.
 *
 * Deps are injectable and the PG pool is resolved LAZILY after the flag check
 * (the default-on-flag-glue-vs-hermetic-unit-tests insight): a flag-off call
 * never touches a pool, and unit tests run the full surface with fakes.
 */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { GovernorVerdict, LearningLoopRegistration } from '../learning-governor/core';
import { learningGovernorPreflight, type GovernorGlueDeps } from '../learning-governor/registrants';
import {
  registerLearningLoop, reserveLearningSpend, settleLearningSpend,
  type LearningSpendReservation, type ReserveLearningSpendResult,
} from '../learning-governor/store';
import { runReplayBattery, type ReplayBatteryConfig, type ReplayBatteryDeps, type ReplayBatteryResult } from './battery';
import { PgReplayStore } from './store';
import { REPLAY_LOOP_ID, REPLAY_ORIGIN } from './types';

export interface ReplayPreflightVerdict {
  allow: boolean;
  reason?: GovernorVerdict['reason'] | 'replay-dark' | 'reservation-refused' | 'reservation-error' | 'reservation-unmeasured';
  remainingUsd: number | null;
}

export interface ReplayGlueDeps {
  /** The replay flag check (default: papercusp-replay-harness). */
  enabled?: () => Promise<boolean>;
  /** Lazy pool resolve — only after the flag check passes. */
  getSql?: () => Promise<Sql>;
  /** The governor preflight (default: the real learningGovernorPreflight). */
  preflight?: (
    q: { workspaceId: string; loopId: string },
    deps?: GovernorGlueDeps,
  ) => Promise<GovernorVerdict>;
  reserve?: typeof reserveLearningSpend;
  settle?: typeof settleLearningSpend;
  log?: (msg: string) => void;
}

const defaultDeps: Required<ReplayGlueDeps> = {
  enabled: () => getFlag(FLAGS.REPLAY_HARNESS, 'replay-harness'),
  getSql: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  },
  preflight: learningGovernorPreflight,
  reserve: reserveLearningSpend,
  settle: settleLearningSpend,
  log: (m) => console.log(`[replay-harness] ${m}`),
};

function resolve(deps?: ReplayGlueDeps): Required<ReplayGlueDeps> {
  return { ...defaultDeps, ...deps };
}

/**
 * Flag-aware unattended-refusal gate: replay flag OFF ⇒ 'replay-dark';
 * otherwise the governor verdict for `frontier:replay-harness`. Fail-closed.
 */
export async function replayPreflight(
  q: { workspaceId: string },
  deps?: ReplayGlueDeps,
): Promise<ReplayPreflightVerdict> {
  const d = resolve(deps);
  try {
    if (!(await d.enabled())) return { allow: false, reason: 'replay-dark', remainingUsd: null };
    return await d.preflight({ workspaceId: q.workspaceId, loopId: REPLAY_LOOP_ID });
  } catch (e) {
    d.log(`preflight failed — refusing (fail-closed): ${e instanceof Error ? e.message : e}`);
    return { allow: false, reason: 'governor-error', remainingUsd: null };
  }
}

/** The arming act (P-001): register the replay loop with an owner-set budget. */
export async function registerReplayLoop(
  sql: Sql,
  q: { workspaceId: string; budgetUsd: number | null; priority?: number; enabled?: boolean },
): Promise<LearningLoopRegistration> {
  return registerLearningLoop(sql, {
    workspaceId: q.workspaceId,
    loopId: REPLAY_LOOP_ID,
    displayName: 'Replay harness (frontier P-020)',
    budgetKind: 'lifetime',
    budgetUsd: q.budgetUsd,
    priority: q.priority ?? 100,
    enabled: q.enabled ?? true,
    enforcement: 'governor',
  });
}

export interface GovernedReplayResult {
  verdict: ReplayPreflightVerdict;
  /** Null when the preflight refused. */
  result: ReplayBatteryResult | null;
  /** Actual governor row; an OPEN row is never evidence of settled spend. */
  reservation?: LearningSpendReservation;
  reservationRefusal?: Extract<ReserveLearningSpendResult, { ok: false }>['reason'];
}

/**
 * The unattended entrypoint FB-07/08/09's loops call: preflight → reserve →
 * run the battery within its grant → settle, including zero-cost attempts.
 * Attended/supervised callers may use
 * runReplayBattery directly — this wrapper is what makes a loop refusable.
 */
export async function runGovernedReplay(
  q: { workspaceId: string; config: ReplayBatteryConfig; potSlug?: string | null },
  deps: Omit<ReplayBatteryDeps, 'store'> & { store?: ReplayBatteryDeps['store'] },
  glue?: ReplayGlueDeps,
): Promise<GovernedReplayResult> {
  const d = resolve(glue);
  const verdict = await replayPreflight({ workspaceId: q.workspaceId }, glue);
  if (!verdict.allow) return { verdict, result: null };

  const sql = await d.getSql();
  const caps = [q.config.maxSpendUsd, verdict.remainingUsd ?? undefined].filter(
    (c): c is number => c !== undefined,
  );
  const requestedUsd = caps.length ? Math.min(...caps) : NaN;
  if (!Number.isFinite(requestedUsd) || requestedUsd < 0) {
    return { verdict: { ...verdict, allow: false, reason: 'reservation-unmeasured' }, result: null };
  }
  let reserved: Awaited<ReturnType<typeof reserveLearningSpend>>;
  try {
    reserved = await d.reserve(sql, {
      workspaceId: q.workspaceId, loopId: REPLAY_LOOP_ID,
      ...(q.potSlug === undefined ? {} : { potSlug: q.potSlug }),
      attemptKind: 'evaluation', requestedUsd, signalOrigin: REPLAY_ORIGIN,
      runRef: q.config.batteryId, note: 'replay battery',
    });
  } catch (e) {
    d.log(`reservation failed — refusing replay: ${e instanceof Error ? e.message : e}`);
    return { verdict: { ...verdict, allow: false, reason: 'reservation-error' }, result: null };
  }
  if (!reserved.ok) {
    return { verdict: { ...verdict, allow: false, reason: 'reservation-refused' },
      result: null, reservationRefusal: reserved.reason };
  }
  const reservation = reserved.reservation;
  // The transactional grant includes other in-flight batteries; preflight's
  // earlier remainingUsd alone cannot bound concurrent spending.
  const config: ReplayBatteryConfig = {
    ...q.config,
    maxSpendUsd: reservation.reservedUsd,
  };
  const settle = async (disposition: 'used' | 'failed', usedUsd: unknown): Promise<LearningSpendReservation> => {
    if (typeof usedUsd !== 'number' || !Number.isFinite(usedUsd) || usedUsd < 0) {
      d.log(`charge unknown for reservation ${reservation.id}; it stays OPEN and visible as unsettled spend`);
      return reservation;
    }
    try {
      const settled = await d.settle(sql, {
        workspaceId: q.workspaceId, reservationId: reservation.id,
        disposition, usedUsd, accumulate: true,
      });
      if (settled.ok) return settled.reservation;
      d.log(`settlement refused for reservation ${reservation.id}: ${settled.reason}`);
      return settled.reservation ?? reservation;
    } catch (e) {
      // The reservation remains durable and blocks headroom even if settlement
      // fails. Preserve the result, without relabelling the OPEN row as paid.
      d.log(`settlement failed for reservation ${reservation.id}; it stays OPEN: ${e instanceof Error ? e.message : e}`);
      return reservation;
    }
  };
  let result: ReplayBatteryResult;
  try {
    const store = deps.store ?? new PgReplayStore(sql, q.workspaceId);
    result = await runReplayBattery(config, { ...deps, store });
  } catch (e) {
    await settle('failed', (e as { costUsd?: unknown } | null)?.costUsd);
    throw e;
  }
  // An errored provider call may have charged an unknown amount. Keep the
  // durable reservation open rather than certifying the known lower bound.
  return { verdict, result, reservation: result.costMeasured === false
    ? reservation : await settle('used', result.totalCostUsd) };
}
