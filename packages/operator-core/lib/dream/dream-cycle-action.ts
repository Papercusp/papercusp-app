/** `system:dream-cycle` routine action (REM dreaming P-005 / D-001). */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { idleActivityAllowed } from '../owner-steering';
import { readHiveIdleRatio } from '../scout/cadence-signals';
import type { ScoutLlmCall } from '../scout/types';
import { resolveDreamCycleConfig, type DreamCycleConfig } from './dream-config';
import { runDreamCycle, type DreamCycleInput, type DreamCycleResult } from './dream-cycle';
import type { DreamRunMode } from './dream-run-store';
import { DreamPilotPinSchema, type DreamPilotPin } from './dream-evaluation';

export const DREAM_CYCLE_ACTION = 'dream-cycle';

export interface DreamCycleActionConfig extends Pick<DreamCycleInput, 'cycle' | 'sampler' | 'pass' | 'review' | 'problemMode'> {
  mode: DreamRunMode;
  pilot?: DreamPilotPin;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function parseDreamCycleActionConfig(payload: Record<string, unknown> | null): DreamCycleActionConfig {
  const root = object(payload) ?? {};
  const mode = root.mode ?? 'manual';
  if (mode !== 'manual' && mode !== 'auto') throw new RangeError(`unsupported dream-cycle mode ${String(mode)}`);
  if (root.problemMode !== undefined && !['observed-problems', 'open-exploration'].includes(String(root.problemMode)))
    throw new RangeError('Unsupported Dream problem mode');
  resolveDreamCycleConfig(object(root.cycle) ?? {});
  const sampler = object(root.sampler);
  if (
    sampler &&
    Object.keys(sampler).some(
      (key) => !['mode', 'arity', 'allowSubsystem', 'policy', 'relations', 'thirdRoles'].includes(key),
    )
  )
    throw new RangeError('Unsupported capability sampler setting');
  return {
    mode,
    ...(root.problemMode !== undefined ? { problemMode: root.problemMode as DreamCycleInput['problemMode'] } : {}),
    ...(root.pilot !== undefined ? { pilot: DreamPilotPinSchema.parse(root.pilot) } : {}),
    ...(object(root.cycle) ? { cycle: object(root.cycle) as Partial<DreamCycleConfig> } : {}),
    ...(object(root.sampler) ? { sampler: object(root.sampler)! } : {}),
    ...(object(root.pass) ? { pass: object(root.pass)! } : {}),
    ...(object(root.review) ? { review: object(root.review)! } : {}),
  };
}

export interface DreamCycleActionDeps {
  featureEnabled: () => Promise<boolean>;
  idleAllowed: (workspaceId: string, potSlug: string) => Promise<boolean>;
  readIdleRatio: (workspaceId: string) => Promise<number>;
  runCycle: (ctx: SystemActionCtx, config: DreamCycleActionConfig) => Promise<DreamCycleResult>;
  log: (message: string) => void;
}

const defaultActionDeps: DreamCycleActionDeps = {
  featureEnabled: () => getFlag(FLAGS.DREAM_CYCLE, 'dream-cycle'),
  idleAllowed: (workspaceId, potSlug) => idleActivityAllowed(workspaceId, 'dream', potSlug),
  readIdleRatio: (workspaceId) => readHiveIdleRatio({ workspaceId }),
  runCycle: productionDreamCycle,
  log: (message) => console.log(`[dream-cycle] ${message}`),
};

export function makeDreamCycleAction(overrides: Partial<DreamCycleActionDeps> = {}) {
  const deps = { ...defaultActionDeps, ...overrides };
  return async function dreamCycleAction(ctx: SystemActionCtx): Promise<void> {
    if (!(await deps.featureEnabled())) {
      deps.log(`${ctx.installSlug}: skipped — DREAM_CYCLE feature flag is OFF`);
      return;
    }
    const config = parseDreamCycleActionConfig(ctx.payloadTemplate);
    if (config.mode === 'auto') {
      if (!(await deps.idleAllowed(ctx.workspaceId, ctx.installSlug))) {
        deps.log(`${ctx.installSlug}: skipped — owner idle-activity toggle (dream) is OFF`);
        return;
      }
      const idleRatio = await deps.readIdleRatio(ctx.workspaceId);
      const floor = resolveDreamCycleConfig(config.cycle).autoIdleRatioFloor;
      if (idleRatio < floor) {
        deps.log(`${ctx.installSlug}: skipped — idle ratio ${idleRatio.toFixed(2)} < ${floor.toFixed(2)}`);
        return;
      }
    }
    const result = await deps.runCycle(ctx, config);
    deps.log(
      `${ctx.installSlug}: ${result.reason} cycle=${result.cycleId} attempts=${result.attempts} accepted=${result.accepted} cost=$${result.costUsd.toFixed(4)}`,
    );
  };
}

function stableCycleId(ctx: SystemActionCtx): string {
  return DBOS.workflowID?.trim() || `dream-cycle:${ctx.workspaceId}:${ctx.installSlug}:${randomUUID()}`;
}

/** Lazily assemble production adapters so boot-time registration stays IO-free. */
export async function productionDreamCycle(
  ctx: SystemActionCtx,
  config: DreamCycleActionConfig,
): Promise<DreamCycleResult> {
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const [{ getOrgPg }, llm, governor, store, registry, catalog, packets, reviewSources, sink, problemSources] = await Promise.all([
    import('@papercusp/db-org'),
    import('../llm-testing/llm-client'),
    import('./dream-governor'),
    import('./dream-run-store'),
    import('../harness-registry'),
    import('./capability-catalog'),
    import('./capability-packets'),
    import('./capability-review-sources'),
    import('./dream-sink'),
    import('./dream-sources'),
  ]);
  const { sql } = getOrgPg();
  const registered = await registry.loadHarnessRegistry(ctx.workspaceId);
  const rootPath = registry.resolveHarnessContentPath(registered, ctx.installSlug);
  if (!rootPath) throw new Error('Dream requires the registered repository for ' + ctx.installSlug);
  const pilotProtocol = config.pilot ? DreamPilotPinSchema.shape.protocol.safeParse(config.pilot.protocol).data : null;
  const manifest = config.pilot && !pilotProtocol?.comparison ? catalog.getPilotCapabilityManifest() : catalog.getCurrentCapabilityManifest();
  const scope = { workspaceId: ctx.workspaceId, potSlug: ctx.installSlug, repositoryId: ctx.installSlug };
  const cycleId = stableCycleId(ctx);
  const llmCall: ScoutLlmCall = (input) => llm.llmCall({ ...input, priority: 'scout', harnessSlug: ctx.installSlug });
  const sources = (values: import('./capability-contracts').CapabilityPacket[]) =>
    reviewSources.buildCapabilityReviewSources({ sql, scope, rootPath, manifest, packets: values });
  const { notifySyncInvalidate } = await import('../sync-sse');
  const changing = async <T>(write: () => Promise<T>): Promise<T> => {
    const value = await write();
    notifySyncInvalidate('learning.dream');
    return value;
  };
  const result = await runDreamCycle(
    {
      ...scope,
      rootPath,
      manifest,
      mode: config.mode,
      cycleId,
      cycle: config.cycle,
      sampler: config.sampler,
      pass: config.pass,
      review: config.review,
      problemMode: config.problemMode,
      pilot: config.pilot,
    },
    {
      llmCall,
      exclusiveReplay: Boolean(DBOS.workflowID?.trim()),
      preflight: () => governor.preflightDreamCycle(sql, { ...scope, config: config.cycle }),
      canContinue: async () => {
        if (!(await getFlag(FLAGS.DREAM_CYCLE, 'dream-cycle'))) return false;
        const rows = await sql<Array<{ active: boolean }>>`
          SELECT active FROM harness_shared.routines
           WHERE workspace_id = ${ctx.workspaceId} AND install_slug = ${ctx.installSlug}
             AND name = ${config.mode === 'auto' ? 'dream-cycle-auto' : 'dream-cycle-manual'}`;
        if (rows[0]?.active !== true) return false;
        return config.mode !== 'auto' || idleActivityAllowed(ctx.workspaceId, 'dream', ctx.installSlug);
      },
      loadPackets: async (signal) => {
        const result: import('./capability-contracts').CapabilityPacket[] = [];
        for (const unit of manifest.units) {
          signal.throwIfAborted();
          const built = await packets.buildCapabilityPacket({
            rootPath,
            scope,
            unit,
            manifestRevision: manifest.revision,
          });
          if (built.status === 'ready') result.push(built.packet);
        }
        return result;
      },
      loadHistory: () => store.listDreamRuns(sql, { ...scope, limit: 500 }),
      reviewSources: sources,
      loadProblems: () => problemSources.readDreamProblemContext(scope),
      beginRun: ({ runId, capability }) =>
        changing(() =>
          store.beginDreamRun(sql, {
            ...scope,
            runId,
            cycleId,
            mode: config.mode,
            capability,
          }),
        ),
      recordSelection: (input) =>
        changing(() => store.recordDreamRunSelection(sql, { ...input, workspaceId: ctx.workspaceId })),
      beginCall: (input) =>
        changing(() => governor.admitDreamRunCall(sql, { ...input, ...scope, config: config.cycle })),
      settleCall: (input) => changing(() => store.settleDreamRunCall(sql, { ...input, workspaceId: ctx.workspaceId })),
      recordReview: (input) =>
        changing(() => store.recordDreamRunReview(sql, { ...input, workspaceId: ctx.workspaceId })),
      finalizeRun: (input) => changing(() => store.finalizeDreamRun(sql, { ...input, workspaceId: ctx.workspaceId })),
      recordSpend: (run) =>
        changing(() =>
          governor.recordDreamRunSpend(sql, {
            workspaceId: ctx.workspaceId,
            runId: run.runId,
            potSlug: ctx.installSlug,
          }),
        ),
      sink: (runId, values) =>
        sink.sinkDreamInsight({
          kind: 'capability',
          sql,
          workspaceId: ctx.workspaceId,
          dreamRunId: runId,
          rootPath,
          manifest,
          sources: sources(values),
          createdBy: 'system:dream-cycle',
        }),
    },
  );
  // A refused/empty cycle may have no run row. Preserve its actual outcome in
  // the existing routine metadata so the control never calls that "no run yet".
  const summary = {
    cycleId: result.cycleId,
    mode: config.mode,
    attempts: result.attempts,
    accepted: result.accepted,
    running: 0,
    costUsd: result.costUsd,
    reason: result.reason,
    updatedAt: new Date().toISOString(),
  };
  await sql`
    UPDATE harness_shared.routines
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{dreamLastCycle}', ${JSON.stringify(summary)}::text::jsonb),
           updated_at = now()
     WHERE workspace_id = ${ctx.workspaceId} AND install_slug = ${ctx.installSlug}
       AND name = ${config.mode === 'auto' ? 'dream-cycle-auto' : 'dream-cycle-manual'}`;
  notifySyncInvalidate('learning.dream');
  return result;
}

registerSystemAction(DREAM_CYCLE_ACTION, makeDreamCycleAction());
