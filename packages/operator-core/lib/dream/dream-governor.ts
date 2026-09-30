/**
 * Dream-cycle adapter over the existing learning-governor registry + spend
 * event ledger (REM dreaming P-005).  This is not a parallel budget system:
 * `dream:<pot>` is one more registrant, and every measured model cost lands in
 * `learning_spend_events` through `recordLearningSpend`.
 */
import type { Sql, TransactionSql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type { GovernorRefusal, GovernorVerdict } from '../learning-governor/core';
import {
  governorCheck,
  recordLearningSpend,
  registerLearningLoop,
  type RegisterLearningLoopInput,
} from '../learning-governor/store';
import { resolveDreamCycleConfig, type DreamCycleConfig } from './dream-config';
import { beginDreamRunCall, getDreamRun } from './dream-run-store';
import { dreamCapabilityRun, type DreamRunCall } from './dream-run-provenance';

export const DREAM_LOOP_ID_PREFIX = 'dream:';
export const DREAM_ROLLING_WINDOW_MS = 24 * 60 * 60_000;
export const DREAM_REGISTRANT_PRIORITY = 65;

export function dreamLoopId(potSlug: string): string {
  const slug = potSlug.trim();
  if (!slug) throw new RangeError('potSlug must be a non-empty string');
  return `${DREAM_LOOP_ID_PREFIX}${slug}`;
}

export function dreamRegistrationInput(input: {
  workspaceId: string;
  potSlug: string;
  config?: Partial<DreamCycleConfig>;
}): RegisterLearningLoopInput {
  const config = resolveDreamCycleConfig(input.config);
  return {
    workspaceId: input.workspaceId,
    loopId: dreamLoopId(input.potSlug),
    potSlug: input.potSlug,
    displayName: `Dream cycles (${input.potSlug})`,
    budgetKind: 'per-cycle',
    budgetUsd: config.maxCostUsd,
    priority: DREAM_REGISTRANT_PRIORITY,
    enabled: true,
    enforcement: 'governor',
    meta: {
      maxDreamsPerCycle: config.maxDreamsPerCycle,
      rolling24hCostUsd: config.rolling24hCostUsd,
      rollingWindowMs: DREAM_ROLLING_WINDOW_MS,
    },
  };
}

export interface DreamGovernorDeps {
  enabled: () => Promise<boolean>;
  register: (sql: Sql, input: RegisterLearningLoopInput) => Promise<unknown>;
  check: (sql: Sql, input: { workspaceId: string; loopId: string }) => Promise<GovernorVerdict>;
  sumSince: (
    sql: Sql,
    input: { workspaceId: string; sinceMs: number },
  ) => Promise<{ totalUsd: number; loopCount: number }>;
  now: () => number;
}

const defaultDeps: DreamGovernorDeps = {
  enabled: () => getFlag(FLAGS.LEARNING_GOVERNOR, 'dream-cycle'),
  register: registerLearningLoop,
  check: governorCheck,
  sumSince: sumDreamSpendSince,
  now: Date.now,
};

export type DreamGovernorRefusal = GovernorRefusal | 'rolling-cap-exceeded';

export type DreamGovernorPreflight =
  | {
      allow: true;
      loopId: string;
      cycleRemainingUsd: number;
      rollingSpentUsd: number;
      rollingRemainingUsd: number;
      rollingLoopCount: number;
    }
  | {
      allow: false;
      loopId: string;
      reason: DreamGovernorRefusal;
      cycleRemainingUsd: number | null;
      rollingSpentUsd: number;
      rollingRemainingUsd: number;
      rollingLoopCount: number;
    };

/** Windowed sum across every dream registrant in the workspace. */
export async function sumDreamSpendSince(
  sql: Sql,
  input: { workspaceId: string; sinceMs: number },
): Promise<{ totalUsd: number; loopCount: number }> {
  const rows = await sql<Array<{ total: number; loops: number }>>`
    SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total,
           COUNT(DISTINCT loop_id)::int AS loops FROM (
      SELECT cost_usd, loop_id FROM harness_shared.learning_spend_events
       WHERE workspace_id = ${input.workspaceId}
         AND loop_id LIKE ${DREAM_LOOP_ID_PREFIX + '%'}
         AND created_at >= ${new Date(input.sinceMs)}
      UNION ALL
      SELECT cost_usd, ${DREAM_LOOP_ID_PREFIX} || pot_slug AS loop_id
        FROM harness_shared.dream_runs
       WHERE workspace_id = ${input.workspaceId} AND spend_recorded_at IS NULL
         AND (status = 'running' OR completed_at >= ${new Date(input.sinceMs)})
    ) committed`;
  return { totalUsd: Number(rows[0]?.total ?? 0), loopCount: Number(rows[0]?.loops ?? 0) };
}

/** Register/refresh the bounded default, then apply governor + rolling-window gates. */
export async function preflightDreamCycle(
  sql: Sql,
  input: { workspaceId: string; potSlug: string; config?: Partial<DreamCycleConfig> },
  deps: DreamGovernorDeps = defaultDeps,
): Promise<DreamGovernorPreflight> {
  const config = resolveDreamCycleConfig(input.config);
  const loopId = dreamLoopId(input.potSlug);
  if (!(await deps.enabled())) {
    return {
      allow: false,
      loopId,
      reason: 'governor-dark',
      cycleRemainingUsd: null,
      rollingSpentUsd: 0,
      rollingRemainingUsd: config.rolling24hCostUsd,
      rollingLoopCount: 0,
    };
  }

  await deps.register(sql, dreamRegistrationInput({ ...input, config }));
  const [cycle, rolling] = await Promise.all([
    deps.check(sql, { workspaceId: input.workspaceId, loopId }),
    deps.sumSince(sql, {
      workspaceId: input.workspaceId,
      sinceMs: deps.now() - DREAM_ROLLING_WINDOW_MS,
    }),
  ]);
  const rollingRemainingUsd = config.rolling24hCostUsd - rolling.totalUsd;
  if (!cycle.allow) {
    return {
      allow: false,
      loopId,
      reason: cycle.reason ?? 'governor-error',
      cycleRemainingUsd: cycle.remainingUsd,
      rollingSpentUsd: rolling.totalUsd,
      rollingRemainingUsd,
      rollingLoopCount: rolling.loopCount,
    };
  }
  if (rollingRemainingUsd <= 0) {
    return {
      allow: false,
      loopId,
      reason: 'rolling-cap-exceeded',
      cycleRemainingUsd: cycle.remainingUsd,
      rollingSpentUsd: rolling.totalUsd,
      rollingRemainingUsd,
      rollingLoopCount: rolling.loopCount,
    };
  }
  return {
    allow: true,
    loopId,
    cycleRemainingUsd: cycle.remainingUsd ?? config.maxCostUsd,
    rollingSpentUsd: rolling.totalUsd,
    rollingRemainingUsd,
    rollingLoopCount: rolling.loopCount,
  };
}

export interface RecordDreamSpendResult {
  recorded: boolean;
  costUsd: number;
  reason?: 'already-recorded' | 'zero-cost';
}

export class DreamAdmissionError extends Error {
  constructor(public readonly reason: 'cycle-cost-cap' | 'rolling-cost-cap' | 'governor-refused') {
    super('Dream phase admission refused: ' + reason);
  }
}

/** Serialize admission across pots, then reserve in the EXISTING run ledger.
 * No transaction or connection stays held during source/model work. The actual
 * response can exceed its estimate; that cost is retained and stops later calls. */
export async function admitDreamRunCall(
  sql: Sql,
  input: {
    workspaceId: string;
    potSlug: string;
    runId: string;
    config?: Partial<DreamCycleConfig>;
    call: Pick<DreamRunCall, 'callId' | 'phase' | 'model' | 'reservedUsd'>;
  },
  deps: DreamGovernorDeps = defaultDeps,
): ReturnType<typeof beginDreamRunCall> {
  const config = resolveDreamCycleConfig(input.config);
  if (!Number.isFinite(input.call.reservedUsd) || input.call.reservedUsd < 0)
    throw new RangeError('Invalid Dream call reservation');
  return (await sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'dream-admission:' + input.workspaceId}, 0))`;
    const run = await getDreamRun(tx, input);
    if (!run || run.potSlug !== input.potSlug) throw new Error('Dream admission crosses run scope');
    if (dreamCapabilityRun(run)?.calls.some((c) => c.callId === input.call.callId)) return beginDreamRunCall(tx, input);
    const verdict = await preflightDreamCycle(tx, input, deps);
    if (!verdict.allow)
      throw new DreamAdmissionError(
        verdict.reason === 'rolling-cap-exceeded' ? 'rolling-cost-cap' : 'governor-refused',
      );
    const rows = await tx<Array<{ total: number }>>`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS total FROM harness_shared.dream_runs
       WHERE workspace_id = ${input.workspaceId} AND cycle_id = ${run.cycleId}`;
    const remaining = Math.min(config.maxCostUsd, verdict.cycleRemainingUsd) - Number(rows[0]?.total ?? 0);
    if (remaining <= 0 || input.call.reservedUsd > remaining + 1e-9) throw new DreamAdmissionError('cycle-cost-cap');
    if (input.call.reservedUsd > verdict.rollingRemainingUsd + 1e-9) throw new DreamAdmissionError('rolling-cost-cap');
    return beginDreamRunCall(tx, input);
  })) as Awaited<ReturnType<typeof beginDreamRunCall>>;
}

/**
 * Idempotently account one terminal dream.  The dream row is locked; event
 * insertion, registrant accumulation, and the replay fence commit together.
 */
export async function recordDreamRunSpend(
  sql: Sql,
  input: { workspaceId: string; runId: string; potSlug: string },
): Promise<RecordDreamSpendResult> {
  return sql.begin(async (tx) => {
    const rows = await tx<
      Array<{ pot_slug: string; status: string; cost_usd: number; spend_recorded_at: Date | null }>
    >`
      SELECT pot_slug, status, cost_usd, spend_recorded_at
        FROM harness_shared.dream_runs
       WHERE workspace_id = ${input.workspaceId} AND run_id = ${input.runId}
       FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new Error(`dream governor: run not found ${input.workspaceId}/${input.runId}`);
    if (row.pot_slug !== input.potSlug) throw new Error('Dream spend crosses run scope');
    if (row.status === 'running') throw new Error(`dream governor: run ${input.runId} is not terminal`);
    const costUsd = Number(row.cost_usd ?? 0);
    if (row.spend_recorded_at) return { recorded: false, costUsd, reason: 'already-recorded' };

    if (costUsd > 0) {
      await recordLearningSpend(tx as unknown as Sql, {
        workspaceId: input.workspaceId,
        loopId: dreamLoopId(input.potSlug),
        potSlug: input.potSlug,
        costUsd,
        runRef: input.runId,
        note: 'REM dream attempt',
        accumulate: true,
      });
    }
    await (tx as TransactionSql)`
      UPDATE harness_shared.dream_runs
         SET spend_recorded_at = now(), updated_at = now()
       WHERE workspace_id = ${input.workspaceId} AND run_id = ${input.runId}`;
    return costUsd > 0 ? { recorded: true, costUsd } : { recorded: false, costUsd, reason: 'zero-cost' };
  }) as Promise<RecordDreamSpendResult>;
}
