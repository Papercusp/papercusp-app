/** Learning-tab controls over the existing Dream routines, settings and ledger. */
import type { Sql } from 'postgres';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { getOwnerSteering, idleActivityEnabled, setOwnerSteering } from '../owner-steering';
import { governorCheck } from '../learning-governor/store';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { POT_DREAM_MANUAL_ROUTINE_NAME, POT_DREAM_AUTO_ROUTINE_NAME, ensurePotDreamLearningLoop } from '../pot/provision-learning-loop';
import { resolveDreamCycleConfig, type DreamCycleConfig } from './dream-config';
import { dreamLoopId, DREAM_ROLLING_WINDOW_MS, sumDreamSpendSince } from './dream-governor';
import type { DreamRunMode } from './dream-run-store';

const ROUTINE_NAMES = { manual: POT_DREAM_MANUAL_ROUTINE_NAME, auto: POT_DREAM_AUTO_ROUTINE_NAME } as const;

export interface DreamCycleSummary {
  cycleId: string;
  mode: DreamRunMode;
  attempts: number;
  accepted: number;
  running: number;
  costUsd: number;
  reason: string;
  updatedAt: string;
}

export interface DreamControlSnapshot {
  potSlug: string;
  featureEnabled: boolean;
  manual: { available: boolean; active: boolean; nextFireAt: string | null };
  automatic: { available: boolean; enabled: boolean };
  blocker: string | null;
  rollingAccountedUsd: number;
  limits: { attempts: number; cycleUsd: number; rollingUsd: number };
  lastCycle: DreamCycleSummary | null;
}

export interface DreamRoutineControlRow {
  name: string;
  active: boolean;
  next_fire_at: Date | string | null;
  metadata: Record<string, unknown> | null;
  payload_template?: { cycle?: Partial<DreamCycleConfig> } | null;
}

type Scope = { workspaceId: string; potSlug: string };

export async function readDreamRoutineControls(sql: Sql, scope: Scope): Promise<DreamRoutineControlRow[]> {
  return sql<DreamRoutineControlRow[]>`
    SELECT name, active, next_fire_at, metadata, payload_template FROM harness_shared.routines
     WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.potSlug}
       AND name IN (${ROUTINE_NAMES.manual}, ${ROUTINE_NAMES.auto})
       AND target_role = 'system:dream-cycle'`;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Invalid persisted metadata is absence, never a fabricated successful cycle. */
export function dreamCycleSummary(value: unknown): DreamCycleSummary | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.cycleId !== 'string' || !row.cycleId || !['manual', 'auto'].includes(String(row.mode))) return null;
  if (typeof row.reason !== 'string' || typeof row.updatedAt !== 'string' || !iso(row.updatedAt)) return null;
  for (const key of ['attempts', 'accepted', 'running', 'costUsd']) {
    if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || (row[key] as number) < 0) return null;
  }
  return row as unknown as DreamCycleSummary;
}

/** SQL aggregates the entire latest cycle; a UI row limit never bounds its counts. */
export async function readLatestDreamCycle(sql: Sql, scope: Scope): Promise<DreamCycleSummary | null> {
  const rows = await sql<Array<Record<string, unknown>>>`
    WITH latest AS (
      SELECT cycle_id FROM harness_shared.dream_runs
       WHERE workspace_id = ${scope.workspaceId} AND pot_slug = ${scope.potSlug}
       ORDER BY started_at DESC, run_id DESC LIMIT 1
    )
    SELECT r.cycle_id, MIN(r.mode) AS mode, COUNT(*)::int AS attempts,
           COUNT(*) FILTER (WHERE r.status = 'accepted')::int AS accepted,
           COUNT(*) FILTER (WHERE r.status = 'running')::int AS running,
           SUM(r.cost_usd)::float8 AS cost_usd, MAX(r.updated_at) AS updated_at,
           (array_agg(COALESCE(r.error, r.outcome->>'reason', r.status)
              ORDER BY r.updated_at DESC, r.run_id DESC))[1] AS reason
      FROM harness_shared.dream_runs r JOIN latest l ON r.cycle_id = l.cycle_id
     WHERE r.workspace_id = ${scope.workspaceId} AND r.pot_slug = ${scope.potSlug}
     GROUP BY r.cycle_id`;
  const row = rows[0];
  if (!row) return null;
  return dreamCycleSummary({
    cycleId: row.cycle_id, mode: row.mode, attempts: Number(row.attempts),
    accepted: Number(row.accepted), running: Number(row.running), costUsd: Number(row.cost_usd),
    reason: row.reason, updatedAt: iso(row.updated_at as Date),
  });
}

export interface DreamControlReadDeps {
  flags: () => Promise<{ feature: boolean; governor: boolean }>;
  ensureSetup: () => Promise<void>;
  routines: () => Promise<DreamRoutineControlRow[]>;
  autoEnabled: () => Promise<boolean>;
  sourceAvailable: () => Promise<boolean>;
  budget: () => Promise<{ allow: boolean; reason?: string }>;
  rolling: () => Promise<number>;
  latestCycle: () => Promise<DreamCycleSummary | null>;
}

/** Materialize only missing, inactive controls for registered sources. Never arm or retune a lane. */
export async function readDreamControlSnapshot(
  sql: Sql, scope: Scope & { mode?: DreamRunMode }, overrides: Partial<DreamControlReadDeps> = {},
): Promise<DreamControlSnapshot> {
  const deps: DreamControlReadDeps = {
    flags: async () => {
      const [feature, governor] = await Promise.all([
        getFlag(FLAGS.DREAM_CYCLE, 'dream-control'), getFlag(FLAGS.LEARNING_GOVERNOR, 'dream-control'),
      ]);
      return { feature, governor };
    },
    ensureSetup: () => ensurePotDreamLearningLoop({ sql, ...scope }),
    routines: () => readDreamRoutineControls(sql, scope),
    autoEnabled: async () => idleActivityEnabled(await getOwnerSteering(scope.workspaceId, scope.potSlug, sql), 'dream'),
    sourceAvailable: async () => Boolean(resolveHarnessContentPath(await loadHarnessRegistry(scope.workspaceId), scope.potSlug)),
    budget: () => governorCheck(sql, { workspaceId: scope.workspaceId, loopId: dreamLoopId(scope.potSlug) }),
    rolling: async () => (await sumDreamSpendSince(sql, { workspaceId: scope.workspaceId, sinceMs: Date.now() - DREAM_ROLLING_WINDOW_MS })).totalUsd,
    latestCycle: () => readLatestDreamCycle(sql, scope),
    ...overrides,
  };
  const [flags, source] = await Promise.all([deps.flags(), deps.sourceAvailable()]);
  if (flags.feature && source) await deps.ensureSetup();
  const [routines, automatic, budget, rollingAccountedUsd, latest] = await Promise.all([
    deps.routines(), deps.autoEnabled(), deps.budget(), deps.rolling(), deps.latestCycle(),
  ]);
  const manual = routines.find((row) => row.name === ROUTINE_NAMES.manual);
  const auto = routines.find((row) => row.name === ROUTINE_NAMES.auto);
  const selected = scope.mode === 'auto' ? auto : manual;
  const config = resolveDreamCycleConfig(selected?.payload_template?.cycle);
  const summaries = [latest, ...routines.map((row) => dreamCycleSummary(row.metadata?.dreamLastCycle))]
    .filter((row): row is DreamCycleSummary => row !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const blocker = !flags.feature ? 'Dream is disabled in feature settings.'
    : !manual || !auto ? 'Dream is not set up for this pot. Restore its learning routines.'
    : !source ? 'No registered source repository is available for this pot.'
    : !flags.governor ? 'The learning budget governor is disabled. Enable it before starting Dream.'
    : !budget.allow ? `The learning budget stopped Dream: ${budget.reason ?? 'unavailable'}. Check this pot’s learning switch and lane budget.`
    : config.maxCostUsd === 0 ? 'The configured Dream cycle budget is zero.'
    : rollingAccountedUsd >= config.rolling24hCostUsd
      ? 'The workspace Dream budget for the last 24 hours is exhausted. Wait for spend to leave that window.' : null;
  return {
    potSlug: scope.potSlug, featureEnabled: flags.feature,
    manual: { available: Boolean(manual), active: manual?.active === true, nextFireAt: iso(manual?.next_fire_at ?? null) },
    automatic: { available: Boolean(auto), enabled: auto?.active === true && automatic },
    blocker, rollingAccountedUsd,
    limits: { attempts: config.maxDreamsPerCycle, cycleUsd: config.maxCostUsd, rollingUsd: config.rolling24hCostUsd },
    lastCycle: summaries[0] ?? null,
  };
}

/** Atomic, pot-scoped state change. Neither a read nor manual Start opts into automatic spending. */
export async function setDreamControl(
  sql: Sql, input: Scope & { mode: DreamRunMode; enabled: boolean; actor: string },
  read: typeof readDreamControlSnapshot = readDreamControlSnapshot,
): Promise<void> {
  if (!input.workspaceId.trim() || !input.potSlug.trim()) throw new Error('Dream requires an explicit workspace and pot.');
  if (input.enabled) {
    const snapshot = await read(sql, input);
    if (snapshot.blocker) throw new Error(snapshot.blocker);
  }
  await sql.begin(async (transaction) => {
    const tx = transaction as unknown as Sql;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`dream-control:${input.workspaceId}:${input.potSlug}`}, 0))`;
    const rows = await tx<Array<{ metadata: Record<string, unknown> | null }>>`
      SELECT metadata FROM harness_shared.routines
       WHERE workspace_id = ${input.workspaceId} AND install_slug = ${input.potSlug}
         AND name = ${ROUTINE_NAMES[input.mode]} AND target_role = 'system:dream-cycle'
         AND payload_template->>'mode' = ${input.mode} FOR UPDATE`;
    if (!rows[0]) throw new Error('The Dream routine is missing or has an incompatible configuration. Restore this pot’s learning setup.');
    if (input.mode === 'auto') {
      const steering = await getOwnerSteering(input.workspaceId, input.potSlug, tx);
      await setOwnerSteering(input.workspaceId, input.potSlug, {
        idleActivities: { ...steering.idleActivities, dream: input.enabled },
      }, tx);
    }
    const at = Date.now();
    const metadata = { ...rows[0].metadata };
    metadata.dreamControl = { mode: input.mode, enabled: input.enabled, actor: input.actor, at };
    if (!input.enabled) metadata.pause = { reason: 'Dream paused from Learning controls', pausedBy: input.actor, pausedAtMs: at };
    else if (metadata.pause) {
      metadata.lastPause = { ...(metadata.pause as Record<string, unknown>), resumedAtMs: at };
      delete metadata.pause;
    }
    await tx`
      UPDATE harness_shared.routines SET active = ${input.enabled},
        next_fire_at = CASE WHEN ${input.enabled} THEN now() ELSE next_fire_at END,
        metadata = ${JSON.stringify(metadata)}::text::jsonb, updated_at = now()
       WHERE workspace_id = ${input.workspaceId} AND install_slug = ${input.potSlug}
         AND name = ${ROUTINE_NAMES[input.mode]}`;
  });
}
