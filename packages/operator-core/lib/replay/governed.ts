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
 *   - `runGovernedReplay` — preflight → clamp the battery's spend cap to the
 *     governor's remaining budget → run → ledger the spend
 *     (signal_origin='replay', accumulate) → return result + verdict.
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
import { recordLearningSpend, registerLearningLoop } from '../learning-governor/store';
import { runReplayBattery, type ReplayBatteryConfig, type ReplayBatteryDeps, type ReplayBatteryResult } from './battery';
import { PgReplayStore } from './store';
import { REPLAY_LOOP_ID, REPLAY_ORIGIN } from './types';

export interface ReplayPreflightVerdict {
  allow: boolean;
  reason?: GovernorVerdict['reason'] | 'replay-dark';
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
  recordSpend?: typeof recordLearningSpend;
  log?: (msg: string) => void;
}

const defaultDeps: Required<ReplayGlueDeps> = {
  enabled: () => getFlag(FLAGS.REPLAY_HARNESS, 'replay-harness'),
  getSql: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  },
  preflight: learningGovernorPreflight,
  recordSpend: recordLearningSpend,
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
}

/**
 * The unattended entrypoint FB-07/08/09's loops call: preflight → run the
 * battery (spend cap clamped to the governor's remaining budget) → ledger the
 * spend with origin='replay'. Attended/supervised callers may use
 * runReplayBattery directly — this wrapper is what makes a loop refusable.
 */
export async function runGovernedReplay(
  q: { workspaceId: string; config: ReplayBatteryConfig },
  deps: Omit<ReplayBatteryDeps, 'store'> & { store?: ReplayBatteryDeps['store'] },
  glue?: ReplayGlueDeps,
): Promise<GovernedReplayResult> {
  const d = resolve(glue);
  const verdict = await replayPreflight({ workspaceId: q.workspaceId }, glue);
  if (!verdict.allow) return { verdict, result: null };

  const sql = await d.getSql();
  const store = deps.store ?? new PgReplayStore(sql, q.workspaceId);

  // The battery's high-water cap never exceeds the governor's remaining budget.
  const caps = [q.config.maxSpendUsd, verdict.remainingUsd ?? undefined].filter(
    (c): c is number => c !== undefined,
  );
  const config: ReplayBatteryConfig = {
    ...q.config,
    ...(caps.length > 0 ? { maxSpendUsd: Math.min(...caps) } : {}),
  };

  const result = await runReplayBattery(config, { ...deps, store });

  if (result.totalCostUsd > 0) {
    try {
      await d.recordSpend(sql, {
        workspaceId: q.workspaceId,
        loopId: REPLAY_LOOP_ID,
        costUsd: result.totalCostUsd,
        signalOrigin: REPLAY_ORIGIN,
        runRef: result.batteryId,
        note: 'replay battery',
        accumulate: true,
      });
    } catch (e) {
      // Spend ledgering must never lose a finished battery's result.
      d.log(`spend ledgering failed for ${result.batteryId}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { verdict, result };
}
