/**
 * The ONE start path for a plan clean-up run (plan-cleanup-system-repair-2026-10-01
 * P-004/P-005). Extracted from `POST /api/admin/plan-cleanup` so the owner's click
 * and the scheduled `system:plan-cleanup-sweep` routine cannot drift into two
 * lifecycles: create the run row → deterministic pass to a fixed point → launch an
 * LLM resolver ONLY when judgment residue remains.
 *
 * Also owns plan SELECTION when more plans are offered than one run may carry
 * (`MAX_RUN_PLANS`): least-recently-scanned first, so a capped run — and every
 * sweep fire — rotates through the whole population instead of re-scanning the
 * same first 200 slugs forever (the silent-truncation defect, WI-10004732).
 */
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import {
  BulkRunAlreadyActiveError,
  createRun,
  failRunIfExecuting,
  setRunPhase,
  type BulkRunPhase,
} from '../attention/bulk-run-store';
import { notifyPlanCleanupRunChanged } from '../attention/bulk-run-sync';
import { normalizeBulkAutomationPolicy, type BulkAutomationPolicy } from '../attention/bulk-dispositions';
import type { EffectiveBulkResolverLaunch } from '../agent-config-constants';
import {
  buildResolverLaunchCommand,
  resolverSpawnOutcome,
} from '../endpoint-route/routes/admin/attention-bulk-resolve';
import { buildCleanupResolverBrief } from './resolver-brief';
import {
  buildPlanCleanupSystemCall,
  runDeterministicPlanCleanup,
  type DeterministicCleanupResult,
} from './deterministic-runner';

/** The most plans one run may carry. Larger selections are ordered
 *  least-recently-scanned first and cut here — reported, never silent. */
export const MAX_RUN_PLANS = 200;

/** Requester stamped on runs the scheduled sweep starts (vs `'owner'`). */
export const PLAN_CLEANUP_SWEEP_REQUESTER = 'system:plan-cleanup-sweep';

/** Plan statuses the sweep never offers: their lifecycle is already closed. */
export const SWEEP_EXCLUDED_PLAN_STATUSES: readonly string[] = ['shipped', 'superseded'];

/** Unique, trimmed, order-preserving slugs. NO cap — capping is selection's job. */
export function normalizePlanSlugs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const slug = typeof value === 'string' ? value.trim() : '';
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export interface PlanSelection {
  /** The plans this run will carry, in scan-priority order. */
  planSlugs: string[];
  /** Unique plans offered (the pane's shown set, or the sweep population). */
  requested: number;
  /** = planSlugs.length. */
  accepted: number;
  /** requested - accepted: plans offered but left for a later run. */
  truncated: number;
}

/**
 * Pure ordering rule: never-scanned plans first (in offered order), then by the
 * oldest last scan. Ties keep the offered order, so the result is deterministic.
 */
export function orderLeastRecentlyScanned(
  planSlugs: readonly string[],
  lastScannedMs: ReadonlyMap<string, number>,
): string[] {
  return planSlugs
    .map((slug, index) => ({ slug, index, last: lastScannedMs.get(slug) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (a.last === b.last ? a.index - b.index : a.last - b.last))
    .map((entry) => entry.slug);
}

/** Pure cap: order, cut at `max`, and report what was left out. */
export function selectPlansForRun(
  planSlugs: readonly string[],
  lastScannedMs: ReadonlyMap<string, number>,
  max = MAX_RUN_PLANS,
): PlanSelection {
  const requested = planSlugs.length;
  const selected =
    requested > max ? orderLeastRecentlyScanned(planSlugs, lastScannedMs).slice(0, max) : [...planSlugs];
  return { planSlugs: selected, requested, accepted: selected.length, truncated: requested - selected.length };
}

/**
 * When each offered plan last appeared in a plan-cleanup run's `seed_refs`.
 * Failed runs do not count as a scan: a run that died before scanning must not
 * push its plans to the back of the queue.
 */
export async function readLastScannedMs(input: {
  workspaceId: string;
  harnessSlug: string;
  planSlugs: readonly string[];
}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (input.planSlugs.length === 0) return out;
  const { sql } = getOrgPg();
  const rows = await sql<{ slug: string; last_ms: string | number }[]>`
    SELECT ref AS slug, (EXTRACT(EPOCH FROM max(r.created_at)) * 1000)::bigint AS last_ms
      FROM harness_shared.attention_bulk_runs r
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(r.seed_refs) = 'array' THEN r.seed_refs ELSE '[]'::jsonb END
      ) AS ref
     WHERE r.workspace_id = ${input.workspaceId}
       AND r.run_kind = 'plan-cleanup'
       AND r.harness_slug = ${input.harnessSlug}
       AND r.phase <> 'failed'
       AND ref = ANY(${[...input.planSlugs]}::text[])
     GROUP BY ref
  `;
  for (const row of rows) out.set(row.slug, Number(row.last_ms));
  return out;
}

/** Order + cap against the real scan history. Reads PG only when a cut is
 *  actually needed; the workspace defaults to the active one. */
export async function selectPlansLeastRecentlyScanned(
  input: {
    workspaceId?: string;
    harnessSlug: string;
    planSlugs: readonly string[];
    max?: number;
  },
  readLastScanned: typeof readLastScannedMs = readLastScannedMs,
): Promise<PlanSelection> {
  const max = input.max ?? MAX_RUN_PLANS;
  if (input.planSlugs.length <= max) return selectPlansForRun(input.planSlugs, new Map(), max);
  const workspaceId = input.workspaceId ?? (await import('../workspace-registry')).activeWorkspaceId();
  const lastScanned = await readLastScanned({
    workspaceId,
    harnessSlug: input.harnessSlug,
    planSlugs: input.planSlugs,
  });
  return selectPlansForRun(input.planSlugs, lastScanned, max);
}

/** The sweep population: every non-archived plan whose lifecycle is still open. */
export async function listSweepablePlanSlugs(input: {
  workspaceId: string;
  harnessSlug: string;
}): Promise<string[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ plan_slug: string }[]>`
    SELECT plan_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${input.workspaceId}
       AND harness_slug = ${input.harnessSlug}
       AND archived = false
       AND COALESCE(status, '') <> ALL(${[...SWEEP_EXCLUDED_PLAN_STATUSES]}::text[])
     ORDER BY plan_slug
  `;
  return rows.map((row) => row.plan_slug);
}

export async function invalidateCleanupRun(): Promise<void> {
  await notifyPlanCleanupRunChanged().catch(() => undefined);
}

/** Spawn the headless cleanup resolver for an existing run row. */
export async function launchCleanupResolver(
  runId: string,
  planSlugs: string[],
  harness: string,
  launch: EffectiveBulkResolverLaunch | null,
  resolverOwner: string,
  workspaceIdOverride?: string,
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const [{ buildConsoleEnvelope }, { spawnHeadless }, { activeWorkspaceId }, { resolveSpawnHostOperatorBaseUrl }] =
      await Promise.all([
        import('../console-launcher'),
        import('../console-spawn'),
        import('../workspace-registry'),
        import('../mcp-base-url'),
      ]);
    const workspaceId = workspaceIdOverride ?? activeWorkspaceId();
    const envelope = await buildConsoleEnvelope({
      workspaceId,
      slug: harness,
      operatorBaseUrl: await resolveSpawnHostOperatorBaseUrl(),
      headless: true,
      role: 'su',
    } as Parameters<typeof buildConsoleEnvelope>[0]);
    const result = await spawnHeadless({
      envelope: {
        ...envelope,
        greetingCmd: buildResolverLaunchCommand({
          workspaceId,
          harness,
          ownerId: resolverOwner,
          launch,
        }),
        env: {
          ...envelope.env,
          PAPERCUSP_KICKOFF_PROMPT: buildCleanupResolverBrief(
            runId,
            planSlugs,
            normalizeBulkAutomationPolicy({
              mode: launch?.automationMode,
              minConfidence: launch?.minConfidence,
            }),
          ),
        },
      },
      label: `plan-cleanup-${runId.slice(0, 12)}`,
      coordOwnerId: resolverOwner,
      launchedBy: 'plan-cleanup',
    });
    const outcome = resolverSpawnOutcome(result, resolverOwner);
    if (!outcome.ok) return outcome;

    let exitHandled = false;
    const failForExit = (detail: string): void => {
      if (exitHandled) return;
      exitHandled = true;
      void failRunIfExecuting({
        runId,
        workspaceId,
        resolverOwner,
        error: `cleanup resolver process ended before settling the run: ${detail}`,
      })
        .then(async (failed) => {
          if (failed) await invalidateCleanupRun();
        })
        .catch(() => undefined);
    };
    outcome.child.once('error', (error) => failForExit(error.message));
    outcome.child.once('exit', (code, signal) =>
      failForExit(signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`),
    );
    return { ok: true, sessionId: outcome.sessionId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface StartPlanCleanupRunInput {
  /** Already selected (≤ MAX_RUN_PLANS) — see selectPlansLeastRecentlyScanned. */
  planSlugs: string[];
  harness: string;
  workspaceId?: string;
  filter: Record<string, unknown>;
  /** Preflighted launch profile with the standing policy folded in. */
  launch: EffectiveBulkResolverLaunch;
  automationPolicy: BulkAutomationPolicy;
  requestedBy: string;
  signal?: AbortSignal;
}

export type StartPlanCleanupRunResult =
  | {
      kind: 'settled';
      runId: string;
      phase: BulkRunPhase;
      totalPlans: number;
      launched: boolean;
      resolverNeeded: boolean;
      deterministic: DeterministicCleanupResult;
      launchError?: string;
    }
  | {
      kind: 'authority-revoked';
      runId: string;
      phase: BulkRunPhase;
      refusal: string;
      deterministic: DeterministicCleanupResult;
    }
  | { kind: 'already-active'; error: BulkRunAlreadyActiveError };

export interface StartPlanCleanupRunDeps {
  createRun: typeof createRun;
  setRunPhase: typeof setRunPhase;
  runDeterministic: typeof runDeterministicPlanCleanup;
  buildCall: typeof buildPlanCleanupSystemCall;
  launchResolver: typeof launchCleanupResolver;
  invalidate: () => Promise<void>;
  newResolverOwner: () => string;
}

const PRODUCTION_DEPS: StartPlanCleanupRunDeps = {
  createRun,
  setRunPhase,
  runDeterministic: runDeterministicPlanCleanup,
  buildCall: buildPlanCleanupSystemCall,
  launchResolver: launchCleanupResolver,
  invalidate: invalidateCleanupRun,
  newResolverOwner: () => `su-${randomUUID()}`,
};

/**
 * Create → deterministic pass → resolver only on judgment residue. Throws only
 * for unexpected errors; single-flight contention is a typed result.
 */
export async function startPlanCleanupRun(
  input: StartPlanCleanupRunInput,
  overrides: Partial<StartPlanCleanupRunDeps> = {},
): Promise<StartPlanCleanupRunResult> {
  const deps = { ...PRODUCTION_DEPS, ...overrides };
  let run: Awaited<ReturnType<typeof createRun>>;
  try {
    run = await deps.createRun({
      items: [],
      runKind: 'plan-cleanup',
      seedRefs: input.planSlugs,
      filterSnapshot: input.filter,
      launchSnapshot: input.launch,
      automationPolicy: input.automationPolicy,
      requestedBy: input.requestedBy,
      harnessSlug: input.harness,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
  } catch (error) {
    if (error instanceof BulkRunAlreadyActiveError) return { kind: 'already-active', error };
    throw error;
  }
  const workspaceId = input.workspaceId ?? run.workspaceId;

  // Deterministic first. Scanner-authorized findings run through the SAME
  // run-row authority + canonical plan/claim dispatcher as plans:cleanup-act;
  // only the residue that needs judgment earns an LLM process.
  const deterministic = await deps.runDeterministic({
    run,
    call: deps.buildCall({
      workspaceId: run.workspaceId,
      harnessSlug: input.harness,
      runId: run.runId,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
  });
  if (deterministic.fatalError) {
    const failed = await deps.setRunPhase({
      runId: run.runId,
      phase: 'failed',
      error: deterministic.fatalError,
      workspaceId,
    });
    await deps.invalidate();
    return {
      kind: 'settled',
      runId: run.runId,
      phase: failed?.phase ?? 'failed',
      totalPlans: run.totalItems,
      launched: false,
      resolverNeeded: false,
      deterministic,
      launchError: deterministic.fatalError,
    };
  }
  if (deterministic.authorityRevoked) {
    await deps.invalidate();
    return {
      kind: 'authority-revoked',
      runId: run.runId,
      phase: deterministic.phase,
      refusal: deterministic.authorityRefusal?.reason ?? 'run_authority_revoked',
      deterministic,
    };
  }
  if (!deterministic.needsResolver) {
    await deps.invalidate();
    return {
      kind: 'settled',
      runId: run.runId,
      phase: deterministic.phase,
      totalPlans: run.totalItems,
      launched: false,
      resolverNeeded: false,
      deterministic,
    };
  }

  const resolverOwner = deps.newResolverOwner();
  await deps.setRunPhase({ runId: run.runId, phase: 'pending', resolverOwner, workspaceId });
  const launched = await deps.launchResolver(
    run.runId,
    input.planSlugs,
    input.harness,
    input.launch,
    resolverOwner,
    workspaceId,
  );
  if (launched.ok) {
    await deps.setRunPhase({ runId: run.runId, phase: 'running', resolverOwner, workspaceId });
  } else {
    await deps.setRunPhase({
      runId: run.runId,
      phase: 'failed',
      error: launched.error ?? 'launch failed',
      workspaceId,
    });
  }
  await deps.invalidate();
  return {
    kind: 'settled',
    runId: run.runId,
    phase: launched.ok ? 'running' : 'failed',
    totalPlans: run.totalItems,
    launched: launched.ok,
    resolverNeeded: true,
    deterministic,
    ...(launched.ok ? {} : { launchError: launched.error }),
  };
}
