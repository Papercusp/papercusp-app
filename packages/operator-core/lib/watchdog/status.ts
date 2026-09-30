/**
 * Effective status for scheduled watchdogs.
 *
 * A watchdog's truth spans configuration, its scheduler, eligible source rows,
 * and its fire ledger. This module joins those layers once and classifies them
 * into an action-oriented state so callers do not have to reverse-engineer the
 * implementation from source + environment + DBOS + product tables.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { ungradedFilingsConfig, type UngradedFilingsConfig } from '../scout/ungraded-filings-watchdog';
import {
  DEFAULT_UNGRADED_EPOCH_POLICY,
  readUngradedEligibility,
  type UngradedEpochPolicy,
} from '../scout/ungraded-scope';

export const SCHEDULED_WATCHDOG_IDS = ['su-ideate-ungraded'] as const;
export type ScheduledWatchdogId = (typeof SCHEDULED_WATCHDOG_IDS)[number];

export interface WatchdogSchedulerStatus {
  kind: 'dbos-operation';
  parentWorkflow: 'routinesTick';
  operation: 'su-ideate-ungraded-sweep';
  lastExecutionAt: string | null;
  lastWorkflowStatus: string | null;
  lastError: string | null;
  internalErrorCount: number;
  /** Persisted DBOS return value: scopes with at least one stale filing. */
  lastResultCount: number | null;
  /** Persisted DBOS return value: scopes that delivered a grading nudge. */
  lastNudgedCount: number | null;
}

export interface WatchdogEligibilityStatus {
  byOrigin: Record<string, { pendingCount: number; eligibleCount: number; oldestRoutedAt: string | null }>;
  total: { pendingCount: number; eligibleCount: number; oldestRoutedAt: string | null; firstEligibleAt: string | null };
}

export interface WatchdogFireStatus {
  source: 'su-ideate-ungraded';
  count: number;
  lastFireAt: string | null;
  lastReason: string | null;
}

export type WatchdogEffectiveState =
  | 'disabled'
  | 'scheduler-unobserved'
  | 'scheduler-error'
  | 'eligible-awaiting-sweep'
  | 'eligible-sweep-empty'
  | 'eligible-no-fire'
  | 'healthy-fired'
  | 'healthy-idle';

export interface ScheduledWatchdogStatus {
  ok: boolean;
  id: ScheduledWatchdogId;
  scope: { workspaceId: string; harnessSlug: string };
  config: UngradedFilingsConfig;
  scheduler: WatchdogSchedulerStatus;
  eligibility: WatchdogEligibilityStatus;
  fire: WatchdogFireStatus;
  effectiveState: WatchdogEffectiveState;
  summary: string;
  nextVerb: { name: string; args?: Record<string, unknown>; reason: string } | null;
}

function timeMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Pure classifier: precedence is disable → scheduler integrity → eligibility → healthy. */
export function classifyScheduledWatchdogStatus(
  status: Omit<ScheduledWatchdogStatus, 'ok' | 'effectiveState' | 'summary' | 'nextVerb'>,
): Pick<ScheduledWatchdogStatus, 'ok' | 'effectiveState' | 'summary' | 'nextVerb'> {
  const { config, scheduler, eligibility, fire } = status;
  if (!config.enabled) {
    return {
      ok: true,
      effectiveState: 'disabled',
      summary: `${status.id} is deliberately disabled by its effective threshold (${config.effectiveThresholdSec}s).`,
      nextVerb: null,
    };
  }
  if (scheduler.lastError || scheduler.internalErrorCount > 0 || scheduler.lastWorkflowStatus === 'ERROR') {
    return {
      ok: false,
      effectiveState: 'scheduler-error',
      summary: `${status.id} last execution failed (${scheduler.lastError ?? `${scheduler.internalErrorCount} internal error(s)`}).`,
      nextVerb: {
        name: 'notifications:recent',
        reason: 'Inspect the concrete scheduler/sweep error before retrying or changing the threshold.',
      },
    };
  }
  if (!scheduler.lastExecutionAt) {
    return {
      ok: false,
      effectiveState: 'scheduler-unobserved',
      summary: `${status.id} has no recorded ${scheduler.operation} execution.`,
      nextVerb: {
        name: 'dev:service_health',
        reason: 'Verify the DBOS routines host is live and PAPERCUSP_DBOS_ROUTINES is enabled.',
      },
    };
  }
  if (eligibility.total.eligibleCount > 0) {
    const executionMs = timeMs(scheduler.lastExecutionAt);
    const firstEligibleMs = timeMs(eligibility.total.firstEligibleAt);
    const fireMs = timeMs(fire.lastFireAt);
    const origins = Object.entries(eligibility.byOrigin)
      .filter(([, value]) => value.eligibleCount > 0)
      .map(([origin, value]) => `${origin}: ${value.eligibleCount}`)
      .join(', ');
    const sweptAfterEligibility = executionMs != null && firstEligibleMs != null && executionMs >= firstEligibleMs;
    const firedAfterEligibility = fireMs != null && firstEligibleMs != null && fireMs >= firstEligibleMs;
    if (sweptAfterEligibility && scheduler.lastResultCount === 0) {
      return {
        ok: false,
        effectiveState: 'eligible-sweep-empty',
        summary:
          `${eligibility.total.eligibleCount} eligible filing(s) (${origins}) remained after a successful sweep that evaluated ` +
          'zero scopes; the grading backstop made no progress.',
        nextVerb: {
          name: 'mode:set',
          args: {
            mode: 'grade',
            enabled: true,
            reason: 'watchdog:status found eligible ungraded filings after a zero-evaluation sweep; grade them through the SU GRADE path.',
          },
          reason:
            'The Mug grading path is retired. Enter SU GRADE mode and process the eligible filings with blender:grade-idea.',
        },
      };
    }
    if (sweptAfterEligibility && !firedAfterEligibility) {
      return {
        ok: false,
        effectiveState: 'eligible-no-fire',
        summary: `${eligibility.total.eligibleCount} eligible filing(s) (${origins}) were present before a successful sweep, but no matching fire was recorded.`,
        nextVerb: {
          name: 'mode:set',
          args: {
            mode: 'grade',
            enabled: true,
            reason: 'watchdog:status found eligible ungraded filings with no matching nudge; grade them through the SU GRADE path.',
          },
          reason:
            'The Mug grading path is retired. Enter SU GRADE mode and process the eligible filings with blender:grade-idea.',
        },
      };
    }
    return {
      ok: true,
      effectiveState: 'eligible-awaiting-sweep',
      summary: `${eligibility.total.eligibleCount} filing(s) (${origins}) are eligible; the latest sweep predates their eligibility.`,
      nextVerb: null,
    };
  }
  if (fire.lastFireAt) {
    return {
      ok: true,
      effectiveState: 'healthy-fired',
      summary: `No filing is currently eligible; ${fire.count} matching fire(s) are recorded.`,
      nextVerb: null,
    };
  }
  return {
    ok: true,
    effectiveState: 'healthy-idle',
    summary: `No filing is currently eligible; zero fires is correct until ${eligibility.total.firstEligibleAt ?? 'a scoped filing reaches the threshold'}.`,
    nextVerb: null,
  };
}

interface SchedulerRow {
  output: string | null;
  operation_error: string | null;
  completed_at_epoch_ms: number | string | null;
  workflow_status: string | null;
  workflow_error: string | null;
}

interface FireRow {
  fire_count: number | string;
  last_fire_at: Date | string | null;
  last_reason: string | null;
}

function parsePersistedConfig(value: unknown): UngradedFilingsConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<UngradedFilingsConfig>;
  const threshold = Number(candidate.effectiveThresholdSec);
  const policy = parsePersistedPolicy(candidate.policy);
  const batchCap = Number(candidate.batchCap);
  const validOverrideSources: UngradedFilingsConfig['overrideSource'][] = [
    'default',
    'environment',
    'invalid-environment-fallback',
  ];
  if (
    typeof candidate.enabled !== 'boolean' ||
    !Number.isFinite(threshold) ||
    candidate.enabled !== threshold > 0 ||
    !validOverrideSources.includes(candidate.overrideSource as UngradedFilingsConfig['overrideSource']) ||
    candidate.overrideEnv !== 'PAPERCUSP_SU_IDEATE_UNGRADED_STALE_SEC' ||
    (candidate.rawOverride !== null && typeof candidate.rawOverride !== 'string') ||
    policy === undefined ||
    !Number.isFinite(batchCap)
  ) {
    return undefined;
  }
  return {
    enabled: candidate.enabled,
    effectiveThresholdSec: threshold,
    overrideSource: candidate.overrideSource as UngradedFilingsConfig['overrideSource'],
    overrideEnv: candidate.overrideEnv,
    rawOverride: candidate.rawOverride,
    policy,
    batchCap,
  };
}

/**
 * P-001: the persisted config carries the whole PER-ORIGIN floor policy, not one
 * origin's `epochMs`. A readback that accepted a bare number would silently describe
 * the rail with a line drawn for a single producer — the exact failure `ungraded-scope.ts`
 * exists to prevent, arriving through the diagnostic surface instead of the census.
 * An unparseable policy returns undefined so the caller falls back to the live config,
 * rather than inventing a floor.
 */
function parsePersistedPolicy(value: unknown): UngradedEpochPolicy | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<UngradedEpochPolicy>;
  const fallbackMs = Number(candidate.fallbackMs);
  if (!Number.isFinite(fallbackMs)) return undefined;
  const rawByOrigin = candidate.byOrigin;
  if (!rawByOrigin || typeof rawByOrigin !== 'object' || Array.isArray(rawByOrigin)) return undefined;
  const byOrigin: Record<string, number> = {};
  for (const [origin, floor] of Object.entries(rawByOrigin as Record<string, unknown>)) {
    const ms = Number(floor);
    if (!Number.isFinite(ms)) return undefined;
    byOrigin[origin] = ms;
  }
  return { byOrigin, fallbackMs };
}

function parseRunSummary(output: string | null): {
  ranAtMs?: number;
  errorCount?: number;
  resultCount?: number;
  nudgedCount?: number;
  config?: UngradedFilingsConfig;
} {
  if (!output) return {};
  try {
    const decoded = JSON.parse(output) as unknown;
    const envelope =
      decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        ? (decoded as { json?: unknown; __dbos_serializer?: unknown })
        : null;
    const payload =
      envelope?.__dbos_serializer === 'superjson' &&
      envelope.json &&
      typeof envelope.json === 'object' &&
      !Array.isArray(envelope.json)
        ? envelope.json
        : decoded;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    const parsed = payload as {
      ranAtMs?: unknown;
      errorCount?: unknown;
      resultCount?: unknown;
      nudgedCount?: unknown;
      results?: unknown;
      config?: unknown;
    };
    const persistedResults = Array.isArray(parsed.results) ? parsed.results : null;
    const resultCount = nonNegativeCount(parsed.resultCount) ?? (persistedResults ? persistedResults.length : undefined);
    const nudgedCount =
      nonNegativeCount(parsed.nudgedCount) ??
      (persistedResults
        ? persistedResults.filter(
            (result) =>
              result && typeof result === 'object' && !Array.isArray(result) && (result as { outcome?: unknown }).outcome === 'nudged',
          ).length
        : undefined);
    return {
      ranAtMs: Number.isFinite(Number(parsed.ranAtMs)) ? Number(parsed.ranAtMs) : undefined,
      errorCount: Number.isFinite(Number(parsed.errorCount)) ? Number(parsed.errorCount) : undefined,
      resultCount,
      nudgedCount,
      config: parsePersistedConfig(parsed.config),
    };
  } catch {
    return {};
  }
}

function nonNegativeCount(value: unknown): number | undefined {
  if (value == null || (typeof value !== 'number' && typeof value !== 'string')) return undefined;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : undefined;
}

export async function readScheduledWatchdogStatus(args: {
  id: ScheduledWatchdogId;
  workspaceId: string;
  harnessSlug: string;
  nowMs?: number;
  sql?: Sql;
}): Promise<ScheduledWatchdogStatus> {
  const sql = args.sql ?? getOrgPg().sql;
  const nowMs = args.nowMs ?? Date.now();
  const schedulerRows = await sql<SchedulerRow[]>`
    SELECT op.output,
           op.error AS operation_error,
           op.completed_at_epoch_ms,
           ws.status AS workflow_status,
           ws.error AS workflow_error
      FROM dbos.operation_outputs op
      LEFT JOIN dbos.workflow_status ws ON ws.workflow_uuid = op.workflow_uuid
     WHERE op.function_name = 'su-ideate-ungraded-sweep'
     ORDER BY op.completed_at_epoch_ms DESC NULLS LAST
     LIMIT 1`;
  const schedulerRow = schedulerRows[0];
  const runSummary = parseRunSummary(schedulerRow?.output ?? null);
  // The DBOS step runs in the dedicated bg-host, while this reader usually runs
  // in the API process. Their environment overrides may differ, so the step's
  // persisted readback is authoritative whenever present.
  const config = runSummary.config ?? ungradedFilingsConfig();
  const eligibleBeforeMs = nowMs - Math.max(0, config.effectiveThresholdSec) * 1_000;

  const [eligibility, fireRows] = await Promise.all([
    // P-001: read the SAME population the rail sweeps, through the same contract.
    // This query used to say `origin = 'su-ideate'` while the sweep beside it had
    // widened to every producer — a readout that disagrees with the thing it reads
    // out. It reported 22 pending against a 1,675-row actionable backlog.
    readUngradedEligibility(sql, {
      workspaceId: args.workspaceId,
      harnessSlug: args.harnessSlug,
      policy: config.policy ?? DEFAULT_UNGRADED_EPOCH_POLICY,
      eligibleBeforeMs,
    }),
    sql<FireRow[]>`
      SELECT count(*)::int AS fire_count,
             max(fired_at) AS last_fire_at,
             (array_agg(reason ORDER BY fired_at DESC))[1] AS last_reason
        FROM harness_shared.pot_watchdog_fires
       WHERE workspace_id = ${args.workspaceId}
         AND install_slug = ${args.harnessSlug}
         AND source = 'su-ideate-ungraded'`,
  ]);

  const completedMs = Number(schedulerRow?.completed_at_epoch_ms ?? Number.NaN);
  const executionMs = Number.isFinite(runSummary.ranAtMs)
    ? runSummary.ranAtMs!
    : Number.isFinite(completedMs)
      ? completedMs
      : null;
  const eligibleRows = Object.entries(eligibility.byOrigin);
  const oldestMs = Math.min(...eligibleRows.map(([, row]) => row.oldestRoutedAtMs ?? Infinity));
  const firstEligibleMs = Number.isFinite(oldestMs)
    ? oldestMs + Math.max(0, config.effectiveThresholdSec) * 1_000
    : null;
  const lastFire = fireRows[0]?.last_fire_at ?? null;
  const base = {
    id: args.id,
    scope: { workspaceId: args.workspaceId, harnessSlug: args.harnessSlug },
    config,
    scheduler: {
      kind: 'dbos-operation' as const,
      parentWorkflow: 'routinesTick' as const,
      operation: 'su-ideate-ungraded-sweep' as const,
      lastExecutionAt: executionMs == null ? null : new Date(executionMs).toISOString(),
      lastWorkflowStatus: schedulerRow?.workflow_status ?? null,
      lastError: schedulerRow?.operation_error ?? schedulerRow?.workflow_error ?? null,
      internalErrorCount: Math.max(0, Number(runSummary.errorCount ?? 0)),
      lastResultCount: runSummary.resultCount ?? null,
      lastNudgedCount: runSummary.nudgedCount ?? null,
    },
    eligibility: {
      byOrigin: Object.fromEntries(eligibleRows.map(([origin, row]) => [origin, {
        pendingCount: row.pendingCount,
        eligibleCount: config.enabled ? row.eligibleCount : 0,
        oldestRoutedAt: row.oldestRoutedAtMs == null ? null : new Date(row.oldestRoutedAtMs).toISOString(),
      }])),
      total: {
        pendingCount: eligibleRows.reduce((sum, [, row]) => sum + row.pendingCount, 0),
        eligibleCount: config.enabled ? eligibleRows.reduce((sum, [, row]) => sum + row.eligibleCount, 0) : 0,
        oldestRoutedAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
        firstEligibleAt: firstEligibleMs == null ? null : new Date(firstEligibleMs).toISOString(),
      },
    },
    fire: {
      source: 'su-ideate-ungraded' as const,
      count: Number(fireRows[0]?.fire_count ?? 0),
      lastFireAt: lastFire == null ? null : new Date(lastFire).toISOString(),
      lastReason: fireRows[0]?.last_reason ?? null,
    },
  };
  return { ...base, ...classifyScheduledWatchdogStatus(base) };
}
