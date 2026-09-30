/**
 * ⚠️ RETIRED (P-009, dbos-retire-legacy-orchestrator-2026-05-31).
 * This looping main loop is no longer in the live operator path — the operator
 * orchestrates via the DBOS durable per-feature pipeline (the default since P-009;
 * `apps/operator/lib/dbos/*`), and per-agent runs go through one-shot `invoke()`
 * (`bin/invoke-once.ts`). `runMainLoop`'s only caller is the standalone `bin/run.ts`
 * CLI, which the operator does not invoke. Kept for reference + instant revert
 * (set PAPERCUSP_DBOS_ORCHESTRATOR=0 to re-enable the legacy path). Do not extend.
 *
 * Main orchestrator loop. Mirrors bash run.sh's `while [ $iteration -lt
 * $MAX_ITERATIONS ]` block. Drives the harness one iteration at a time:
 *
 *   1. Invoke the primary advancing role (orchestrator / coordinator / etc.)
 *   2. Parse the decision verb
 *   3. Dispatch to the matching handler — this is where most of the bash
 *      lives (worker / validator / curator / documenter pipelines, branch
 *      isolation, competition mode, smoke-test gate on DONE, etc.)
 *   4. Snapshot state, prune logs, check cost cap
 *   5. Sleep briefly, repeat
 *
 * As of Stage 5a, every decision branch from run.sh is handled here —
 * including parallel-lane and competition workers. The TS loop is a full
 * replacement for the bash version when PAPERCUSP_USE_TS_ORCHESTRATOR=1.
 */
import { spawnSync } from 'node:child_process';
import { configGet, readConfig } from './config';
import { readEffectiveConfig } from './effective-config';
import { parseDecision, parseDecisions } from './decision-parse';
import { invoke } from './invoke';
import { featureAttempts, harnessSlug as harnessSlugFromDir, readFeatures, setFeatureStatus, stateCtx } from './state';
import { readStartedPlanSlugsPg } from './state-pg';
import {
  branchIsoPostValidator,
  branchIsoPostWorker,
  branchIsoPreValidator,
  branchIsoPreWorker,
  worktreeEnabled,
  worktreePath,
} from './branch-iso';
import { runHook } from './hooks';
import { processActionsBlock } from './actions-block';
import { evaluateCostCap } from './cost-cap';
import { pruneLogs } from './prune-logs';
import { snapshotState } from './snapshot-state';
import { postArchiveEvent, postCuratorOutputs, postTestSnapshot } from './bus-posts';
import { runPreLoop } from './pre-loop';

import { firePluginHook } from './plugin-hooks';
import {
  competitionManifestPath,
  createLanePool,
  hasWorkerCountTiers,
  workerCountTiers,
  maxFeaturesInFlight as maxFeaturesInFlightCfg,
  parallelMaxWorkers,
  parallelWorkersPerFeature,
  readCompetitionManifest,
  resolveWorkerCount,
  useChunkLoop,
  writeCompetitionManifest,
  type WorkerCountTiers,
} from './lanes';
import type { LanePool } from './lanes';
import { FileLockQueue } from './file-lock-queue';
import { FileLockQueueCoordinator } from './file-lock-queue-coordinator';
// The chunk-loop worker model lives in run-worker-chunk-loop.ts (the SHARED home
// for both the durable DBOS pipeline and this retired loop). handleChunkLoopWorker
// below delegates to it; when this file is deleted, that module is the sole home.
import { runWorkerChunkLoop } from './run-worker-chunk-loop';
import { formatChunkCommitMessage } from './chunk-plan';
import { branchExists, git } from './git';
import { branchIsoBase, worktreePath } from './branch-iso';
import type { InvokeContext } from './invoke';
import { fetchDistributedClaim } from './distributed-claim-fetch';
import type { Logger } from './log';
import {
  handleSynthesisOutcome,
  runSynthesizer,
  singleLaneManifest,
  synthesizeSingle,
} from './synthesizer';
import type { ParsedDecision } from './decision-parse';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Resolve the harness slug for telemetry calls.
 *
 * Resolution order:
 *   1. HARNESS_SLUG / PAPERCUSP_HARNESS_SLUG env (caller-set; fastest).
 *   2. Operator registry reverse lookup (canonical — handles cases where
 *      the slug differs from basename(projectDir), e.g. project at
 *      /home/foo/sheets-clone registered as slug "sheets").
 *   3. basename(projectDir) — matches the registry's default derivation
 *      when no explicit slug was set.
 *
 * Memoized per projectDir so we only hit the operator once per run.
 */
/**
 * Read the validator's last output path for a feature, if one was
 * recorded by a prior NEXT_VALIDATOR dispatch. Used to thread
 * PRIOR_VALIDATOR_LOG into worker invocations on retry — the worker
 * reads it to learn why its last attempt was rejected, rather than
 * restarting from scratch.
 *
 * Returns null when no pointer exists (first attempt at this feature)
 * or when the pointed-at .out file is gone (PG-canonical mode pruned
 * disk logs after a retention boundary).
 */
function priorValidatorLogPath(stateDir: string, fid: string): string | null {
  try {
    const ptr = join(stateDir, 'last-validator-out', `${fid}.path`);
    if (!existsSync(ptr)) return null;
    const path = readFileSync(ptr, 'utf8').trim();
    if (!path || !existsSync(path)) return null;
    return path;
  } catch {
    return null;
  }
}

/**
 * Build the env-extra fragment for a retry. Surfaces:
 *   - `PRIOR_VALIDATOR_LOG=<path>` — the validator's last `.out` file,
 *     so the worker reads the rejection reasons before SPEC/contract.
 *   - `PRIOR_SYNTHESIS_BRANCH=harness/<fid>-synthesis` — the branch
 *     the worker's worktree is checked out from; surfaces so the
 *     worker can `git log` it for context or explicitly diff its
 *     starting point.
 * Returns [] (no extras) on the first attempt at a feature.
 */
function priorAttemptExtras(stateDir: string, projectDir: string, fid: string): string[] {
  const path = priorValidatorLogPath(stateDir, fid);
  if (!path) return [];
  const extras = [`PRIOR_VALIDATOR_LOG=${path}`];
  const synthBr = `harness/${fid}-synthesis`;
  if (branchExists(synthBr, { cwd: projectDir })) {
    extras.push(`PRIOR_SYNTHESIS_BRANCH=${synthBr}`);
  }
  return extras;
}

const _slugCache = new Map<string, string>();
/**
 * Pre-dispatch distributed-claim attempt. Best-effort observability:
 * logs `[claim] <fid> won|lost (Nms) reason=<reason>` and returns. The
 * decision to drop on `won: false` is a future config flag; today it
 * only fills the audit table.
 *
 * Skipped (silently) when:
 *   - PAPERCUSP_OPERATOR_BASE points nowhere reachable: handled by the
 *     fetch module — won:true with reason=fetch-failed.
 *   - PAPERCUSP_GITHUB_USER_ID isn't set or is 0/non-positive: no
 *     identifiable claimer; the operator-side endpoint would reject.
 */
async function tryDistributedClaim(
  featureId: string,
  ctx: InvokeContext,
  logger: Logger,
): Promise<void> {
  const userIdRaw = process.env.PAPERCUSP_GITHUB_USER_ID ?? '';
  const userId = userIdRaw ? Number.parseInt(userIdRaw, 10) : 0;
  if (!Number.isInteger(userId) || userId <= 0) return;
  // Hono-host (substrate) runs on :3070 — distinct from the SPA :3055.
  const operatorBase =
    process.env.PAPERCUSP_SUBSTRATE_BASE ??
    process.env.PAPERCUSP_HONO_BASE ??
    'http://localhost:3070';
  const r = await fetchDistributedClaim({
    operatorBase,
    harnessSlug: harnessSlug(ctx),
    featureId,
    githubUserId: userId,
  });
  logger.log(
    `[claim] ${featureId} ${r.claimed ? 'claimed' : 'BLOCKED'} (${r.latencyMs}ms) ` +
      `reason=${r.reason}` +
      (r.my_pubkey ? ` me=${r.my_pubkey.slice(0, 12)}…` : '') +
      (r.error ? ` error=${r.error}` : ''),
  );
}

function harnessSlug(ctx: InvokeContext): string {
  const fromEnv = process.env.HARNESS_SLUG ?? process.env.PAPERCUSP_HARNESS_SLUG;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const cached = _slugCache.get(ctx.projectDir);
  if (cached) return cached;
  const fromRegistry = lookupSlugFromRegistry(ctx.projectDir);
  if (fromRegistry) {
    _slugCache.set(ctx.projectDir, fromRegistry);
    return fromRegistry;
  }
  const fromBasename = ctx.projectDir.split(/[\\/]/).filter(Boolean).pop() ?? 'unknown';
  _slugCache.set(ctx.projectDir, fromBasename);
  return fromBasename;
}

/**
 * Synchronous reverse lookup against the operator's harness registry.
 * Returns null on any failure (operator down, network hiccup, parse
 * error). Best-effort — caller falls back to basename.
 */
function lookupSlugFromRegistry(projectDir: string): string | null {
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  try {
    // Sync curl. Same pattern as role-prompt-from-slug.ts:lookupProjectDir.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('curl', [
      '-sf', '--max-time', '3', `${operatorBase}/api/harness/projects`,
    ], { encoding: 'utf8', timeout: 4000 });
    const data = JSON.parse(out) as { projects?: Array<{ slug?: string; path?: string }> };
    const norm = projectDir.replace(/\/+$/, '');
    const hit = data.projects?.find((p) => (p.path ?? '').replace(/\/+$/, '') === norm)?.slug;
    return hit && hit.length > 0 ? hit : null;
  } catch {
    return null;
  }
}

/** Test-only — drop the slug cache so a stale lookup doesn't leak across tests. */
export function _resetHarnessSlugCacheForTests(): void {
  _slugCache.clear();
}

/**
 * Map of feature id → telemetry row id for in-flight adaptive decisions.
 * Used by handleNextValidator to attach the outcome (pass/fail) to the
 * decision row recorded at NEXT_WORKER time. Cleared after outcome attaches.
 */
const _adaptiveTelemetryByFeature = new Map<string, { id: number; startedAt: number }>();

/**
 * Record one adaptive-mode allocation decision. Best-effort; logs and
 * continues on any error. Returns the row id (so tests can verify) or null.
 */
async function recordAdaptiveDecision(
  ctx: InvokeContext,
  logger: Logger,
  args: {
    featureId: string;
    requestedN: number;
    actualN: number;
    tierLabel: string | null;
    availableAtDecision: number;
    maxSlots: number;
  },
): Promise<number | null> {
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const slug = harnessSlug(ctx);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(
      `${operatorBase}/api/harness/${slug}/orchestrator/adaptive-telemetry`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: number };
    if (typeof data.id === 'number') {
      _adaptiveTelemetryByFeature.set(args.featureId, { id: data.id, startedAt: Date.now() });
      return data.id;
    }
  } catch (err) {
    logger.log(`  telemetry: insert failed (${(err as Error).message}); continuing`);
  } finally {
    // Always clear; if we don't, fetch-failure paths leave a 3s timer
    // armed and keep the Node event loop alive past handler return.
    clearTimeout(timer);
  }
  return null;
}

/**
 * Patch the matching pending telemetry row with the synthesizer
 * outcome (whether synth ran + an error string when it didn't).
 * Best-effort; never blocks dispatch.
 */
async function attachSynthesisOutcomeTelemetry(
  ctx: InvokeContext,
  logger: Logger,
  featureId: string,
  synthesized: boolean,
  synthesisError: string | null,
): Promise<void> {
  const pending = _adaptiveTelemetryByFeature.get(featureId);
  if (!pending) return;
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const slug = harnessSlug(ctx);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch(
      `${operatorBase}/api/harness/${slug}/orchestrator/adaptive-telemetry/${pending.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ synthesized, synthesisError }),
        signal: ctrl.signal,
      },
    );
  } catch (err) {
    logger.log(`  telemetry: synth-outcome patch failed (${(err as Error).message}); continuing`);
  } finally {
    clearTimeout(timer);
  }
}

/** Patch the matching pending telemetry row with an outcome. */
async function attachAdaptiveOutcome(
  ctx: InvokeContext,
  logger: Logger,
  featureId: string,
  outcome: 'pass' | 'fail' | 'cancelled',
): Promise<void> {
  const pending = _adaptiveTelemetryByFeature.get(featureId);
  if (!pending) return;
  _adaptiveTelemetryByFeature.delete(featureId);
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const slug = harnessSlug(ctx);
  const durationMs = Date.now() - pending.startedAt;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    await fetch(
      `${operatorBase}/api/harness/${slug}/orchestrator/adaptive-telemetry/${pending.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, durationMs }),
        signal: ctrl.signal,
      },
    );
  } catch (err) {
    logger.log(`  telemetry: outcome patch failed (${(err as Error).message}); continuing`);
  } finally {
    clearTimeout(timer);
  }
}

/** Test-only: clear the adaptive caches. */
export function _resetAdaptiveCachesForTests(): void {
  _adaptiveTelemetryByFeature.clear();
}

/** Fire a Papercusp plugin lifecycle hook with InvokeContext defaults. */
function fireLifecycleHook(ctx: InvokeContext, hookName: string, log: (m: string) => void): void {
  firePluginHook({
    hookName,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    pluginsLogPath: join(ctx.logDir, 'plugins.log'),
    log,
  });
}

export interface MainLoopExit {
  /** Process exit code matching bash semantics. */
  exitCode: number;
  /** Why the loop stopped (for tests + observability). */
  reason:
    | 'done'
    | 'escalate'
    | 'idle'
    | 'max-iterations'
    | 'unparsable-decision'
    | 'cost-cap'
    | 'plan-rejected'
    | 'scoper-failed';
  /** Number of iterations executed (1-based). */
  iterations: number;
}

export interface MainLoopOptions {
  ctx: InvokeContext;
  logger: Logger;
  maxIterations: number;
  /** Sleep between iterations (ms). 0 disables for tests. */
  iterationSleepMs: number;
  /** Override for `Date.now()` and `setTimeout` to make tests deterministic. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Skip pre-loop (scoper / plan-reviewer / ensure-docs / etc.) for tests
   *  that want to drive only the iteration loop. Defaults to false. */
  skipPreLoop?: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/** Run the orchestrator loop until exit. Returns when bash would exit. */
export async function runMainLoop(opts: MainLoopOptions): Promise<MainLoopExit> {
  const { ctx, logger, maxIterations } = opts;
  const sleep = opts.sleepFn ?? defaultSleep;
  const cfg = readEffectiveConfig(ctx.stateDir);
  const primaryRole = configGet<string>(cfg, 'primaryRole', 'orchestrator');

  // Plugin lifecycle: onLoad fires once at orchestrator startup; onUnload
  // fires once at orchestrator shutdown via try/finally below. Fired even
  // if the run aborts so plugins can clean up.
  fireLifecycleHook(ctx, 'onLoad', logger.log);
  try {
    return await runMainLoopBody(opts, ctx, logger, sleep, cfg, primaryRole, maxIterations);
  } finally {
    fireLifecycleHook(ctx, 'onUnload', logger.log);
  }
}

async function runMainLoopBody(
  opts: MainLoopOptions,
  ctx: InvokeContext,
  logger: Logger,
  sleep: (ms: number) => Promise<void>,
  cfg: ReturnType<typeof readConfig>,
  primaryRole: string,
  maxIterations: number,
): Promise<MainLoopExit> {
  // Pre-loop: scoper, plan-reviewer, ensure-docs, post-planner checkpoints,
  // worktree prune.
  if (opts.skipPreLoop !== true) {
    const pre = await runPreLoop(ctx, logger, cfg);
    if (pre.stop !== null) {
      return { exitCode: pre.exitCode, reason: pre.stop, iterations: 0 };
    }
  }

  // Lane pool — one per loop run. Used by NEXT_WORKER (parallel/competition)
  // and drained by NEXT_VALIDATOR before the validator runs. cfg.parallelWorkers.max
  // is the cap; default 1 (sequential).
  const lanePool = createLanePool(ctx.stateDir, parallelMaxWorkers(cfg));
  // Process-singleton lock queue used by the chunk-loop path. Shared
  // across all NEXT_WORKER dispatches so concurrent workers see each
  // other's holds. Empty / unused when useChunkLoop is false.
  const lockQueue = new FileLockQueue();

  // Tier configuration is per-harness, stored in the spec at
  // parallelWorkers.adaptive.{tiers,labels,rubric}. When tiers are
  // configured AND max>1 AND worktrees are on, the orchestrator gets
  // ADAPTIVE_* prompt extras and emits N=k per dispatch.
  const adaptiveTiers: WorkerCountTiers = workerCountTiers(cfg);
  const hasTiers = hasWorkerCountTiers(cfg);
  const adaptiveActive =
    hasTiers &&
    parallelMaxWorkers(cfg) > 1 &&
    configGet<boolean>(cfg, 'branchIsolation.enabled', false) === true &&
    configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true;
  if (adaptiveActive) {
    logger.log(
      `ADAPTIVE: tiers=[${adaptiveTiers.tiers.join(', ')}] labels=[${adaptiveTiers.labels.join(', ')}] max=${parallelMaxWorkers(cfg)}`,
    );
  }

  // Inline derivation of the cosmetic PARALLEL_MODE label injected into
  // the orchestrator prompt. The runtime no longer keys off mode — this
  // string just tells the LLM whether to emit `N=k` (adaptive only).
  const inferredMode = adaptiveActive
    ? 'adaptive'
    : parallelWorkersPerFeature(cfg) > 1
    ? 'competition'
    : 'lane';

  // Fire Papercusp plugin lifecycle: beforeMissionStart.
  fireLifecycleHook(ctx, 'beforeMissionStart', logger.log);

  // Reset mission-scoped state so per-mission sentinels (cost-warn-fired,
  // ready-for-prod) start fresh on each `run.sh` invocation. The PG row
  // is keyed (workspace_id, harness_slug); without an explicit reset
  // here, the file-based "fires once per mission" semantic the doc
  // strings claim (e.g. cost-cap.ts:148) silently became "fires once
  // per harness, ever." See clearMissionStatePg's docstring for full
  // rationale.
  if (ctx.pg && ctx.workspaceId) {
    try {
      const { clearMissionStatePg } = await import('./mission-state-pg');
      const { harnessSlug } = await import('./state');
      await clearMissionStatePg({
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: harnessSlug(ctx.projectDir),
      });
    } catch (e) {
      logger.log(`  mission-state reset failed (non-fatal): ${(e as Error).message ?? e}`);
    }
  }

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    logger.log(`── iteration ${iteration} ──`);

    // 1a. Pre-orchestrator slot gate. Block the next orchestrator call
    // until enough lane slots are free for a meaningful dispatch — saves
    // the LLM cost of asking for a decision we'd just have to clamp.
    //
    // Without tiers: wait for >= 1 free slot.
    // With tiers: wait for >= min(tiers) free slots, so a tiered
    //   orchestrator that picks the smallest tier never silently
    //   downgrades. (Picking the next tier up still gets clamped in
    //   resolveWorkerCount; that's expected and visible in telemetry.)
    const maxSlots = parallelMaxWorkers(cfg);
    const slotRequirement = adaptiveActive
      ? Math.min(...adaptiveTiers.tiers)
      : 1;
    if (maxSlots > 1 && maxSlots - lanePool.count() < slotRequirement) {
      logger.log(
        `  gate: pool ${lanePool.count()}/${maxSlots}, need ${slotRequirement} free — waiting before invoking orchestrator`,
      );
      while (maxSlots - lanePool.count() < slotRequirement) {
        await sleep(100);
      }
    }
    const availableSlots = Math.max(0, maxSlots - lanePool.count());
    // Optional cap on distinct features in flight. null = no separate
    // cap (only AVAILABLE_SLOTS limits). The orchestrator sees this in
    // its prompt extras and applies it to its greedy fit.
    const maxFeatures = maxFeaturesInFlightCfg(cfg);

    // 1b. Build adaptive-context extras for the primary role's prompt.
    // The orchestrator prompt itself documents how to use ADAPTIVE_*; we
    // just inject the live values here. Empty when adaptive mode isn't
    // active so existing prompts keep their current shape.
    const orchestratorExtras: string[] = [];
    if (adaptiveActive) {
      const tierDocs = adaptiveTiers.tiers
        .map((n, i) => `${n} (${adaptiveTiers.labels[i] ?? `tier-${i}`})`)
        .join(', ');
      orchestratorExtras.push(
        `PARALLEL_MODE=${inferredMode}`,
        `MAX_SLOTS=${maxSlots}`,
        `AVAILABLE_SLOTS=${availableSlots}`,
        `ADAPTIVE_TIERS=${tierDocs}`,
      );
      if (maxFeatures !== null) {
        orchestratorExtras.push(`MAX_FEATURES_IN_FLIGHT=${maxFeatures}`);
      }
      if (adaptiveTiers.rubric.trim().length > 0) {
        // Rubric goes through extras as a single line — newlines preserved
        // so the LLM sees the formatted version. Bash-equivalent extras
        // are typed as readonly string[] and joined with newlines later.
        orchestratorExtras.push(`ADAPTIVE_RUBRIC=${adaptiveTiers.rubric}`);
      }
    } else if (maxSlots > 1) {
      orchestratorExtras.push(
        `PARALLEL_MODE=${inferredMode}`,
        `MAX_SLOTS=${maxSlots}`,
        `AVAILABLE_SLOTS=${availableSlots}`,
      );
      if (maxFeatures !== null) {
        orchestratorExtras.push(`MAX_FEATURES_IN_FLIGHT=${maxFeatures}`);
      }
    }

    // Inject ACTIVE_PLANS so the orchestrator knows which plans are started.
    // The hard filter is in readFeaturesPg (state-pg.ts); this extra is
    // informational context for the LLM so it can reason about plan scope.
    if (ctx.pg && ctx.workspaceId) {
      try {
        const slugs = await readStartedPlanSlugsPg({
          pg: ctx.pg,
          workspaceId: ctx.workspaceId,
          harnessSlug: harnessSlugFromDir(ctx.projectDir),
        });
        if (slugs.length > 0) {
          orchestratorExtras.push(`ACTIVE_PLANS=${slugs.join(',')}`);
        }
      } catch {
        // Non-fatal — omit the hint if PG is unreachable.
      }
    }

    // 1. Invoke the primary advancing role.
    const decisionResult = await invoke(ctx, primaryRole, orchestratorExtras);
    fireLifecycleHook(ctx, 'onPostOrchestrator', logger.log);
    // Batch-aware decision parse — accepts a single decision OR a
    // `DECISIONS … END` envelope with multiple NEXT_WORKER lines.
    // SOLO_VERBS in a multi-decision batch reject the whole batch.
    const batch = parseDecisions(decisionResult.output);

    if (batch.length === 0) {
      logger.log(
        `ERROR: orchestrator returned unparsable decision: '${decisionResult.output.slice(0, 200)}'`,
      );
      logger.log('Aborting. Inspect logs and state, then rerun.');
      await lanePool.waitAll();
      return { exitCode: 4, reason: 'unparsable-decision', iterations: iteration };
    }

    if (batch.length === 1) {
      logger.log(`ORCH decision: ${batch[0].raw} (role=${primaryRole})`);
    } else {
      logger.log(
        `ORCH batch (${batch.length} decisions, role=${primaryRole}): ${batch.map((d) => d.raw).join(' | ')}`,
      );
    }

    // 2. Dispatch — batch-aware. Solo verbs are rejected at parse time
    // when mixed with others, so any batch of length > 1 is all
    // batchable verbs (currently only NEXT_WORKER). Greedy fit:
    // dispatch in order, stop early if a terminal decision lands.
    let dispatch: DispatchResult = { terminal: false, exitCode: 0, reason: 'idle' };
    let dispatched = 0;
    for (const decision of batch) {
      // Honor maxFeaturesInFlight cap — orchestrator should already
      // have respected it, but enforce belt-and-suspenders.
      if (
        maxFeatures !== null
        && decision.verb === 'NEXT_WORKER'
        && dispatched >= maxFeatures
      ) {
        logger.log(
          `  skipping ${decision.raw}: would exceed maxFeaturesInFlight=${maxFeatures}`,
        );
        continue;
      }
      dispatch = await dispatchDecision(
        decision,
        ctx,
        logger,
        cfg,
        iteration,
        sleep,
        lanePool,
        lockQueue,
      );
      dispatched++;
      if (dispatch.terminal) break;
    }
    if (dispatch.terminal) {
      // Drain in-flight parallel lanes so they don't outlive this exit
      // (e.g. a worker writing to a directory the caller is about to clean up).
      await lanePool.waitAll();
      return { exitCode: dispatch.exitCode, reason: dispatch.reason, iterations: iteration };
    }

    // 3. Snapshot state (for UI rollback).
    if (ctx.pg && ctx.workspaceId) {
      const { harnessSlug: getSlug } = await import('./state');
      await snapshotState(ctx.stateDir, iteration, cfg, {
        pg: ctx.pg,
        workspaceId: ctx.workspaceId,
        harnessSlug: getSlug(ctx.projectDir),
      });
    } else {
      await snapshotState(ctx.stateDir, iteration, cfg, stateCtx(ctx));
    }

    // 4. Prune oldest agent logs beyond logRetention.
    pruneLogs(ctx.logDir, cfg);

    // 5. Cost cap. Aborts the loop with exit code 6 when total >= cap.
    const cost = ctx.pg && ctx.workspaceId
      ? await evaluateCostCap(cfg, ctx.logDir, ctx.stateDir, {
          pg: ctx.pg,
          workspaceId: ctx.workspaceId,
          harnessSlug: (await import('./state')).harnessSlug(ctx.projectDir),
        })
      : evaluateCostCap(cfg, ctx.logDir, ctx.stateDir);
    if (cost.cap !== null) {
      logger.log(`  COST total=${cost.total.toFixed(4)} cap=${cost.cap}`);
    } else {
      logger.log(`  COST total=${cost.total.toFixed(4)} (no cap configured)`);
    }
    if (cost.overCap) {
      logger.log(
        `⛔ COST CAP EXCEEDED: ${cost.total.toFixed(4)} >= ${cost.cap}. Aborting.`,
      );
      logger.notifyEvent(
        'cost-cap',
        `Cost cap exceeded: ${cost.total.toFixed(4)} >= ${cost.cap}`,
      );
      return { exitCode: 6, reason: 'cost-cap', iterations: iteration };
    }
    if (cost.warned && cost.cap !== null) {
      const pct = Math.round((cost.total / cost.cap) * 100);
      logger.log(`⚠ COST WARN: ${cost.total.toFixed(4)} >= ${pct}% of ${cost.cap} cap`);
      logger.notifyEvent(
        'cost-warn',
        `Cost at ${pct}% of cap: ${cost.total.toFixed(4)} of ${cost.cap}`,
      );
    }
    if (cost.shouldPause) {
      logger.log("  auto-pause: SIGSTOP'ing harness process tree (config.maxCostUsdAutoPause=true)");
      try {
        process.kill(process.pid, 'SIGSTOP');
        // Resumes here on SIGCONT.
        logger.log('  auto-pause: resumed');
      } catch (err) {
        logger.log(`  auto-pause failed: ${(err as Error).message}`);
      }
    }

    // 6. Sleep.
    await sleep(opts.iterationSleepMs);
  }

  logger.log(`Hit MAX_ITERATIONS=${maxIterations} without converging. Exiting.`);
  logger.notifyEvent('max-iter', `Hit MAX_ITERATIONS=${maxIterations} without converging`);
  // Drain any in-flight parallel lanes so they don't outlive this exit.
  await lanePool.waitAll();
  return { exitCode: 5, reason: 'max-iterations', iterations: maxIterations };
}

interface DispatchResult {
  /** True if the loop should exit. */
  terminal: boolean;
  /** Bash-equivalent exit code when terminal=true. */
  exitCode: number;
  /** Reason label for the MainLoopExit. */
  reason: MainLoopExit['reason'];
}

/**
 * Dispatch a parsed decision. Returns terminal=true when the loop should
 * stop (DONE / ESCALATE / IDLE-with-config) and false otherwise.
 */
async function dispatchDecision(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  iteration: number,
  sleep: (ms: number) => Promise<void>,
  lanePool: LanePool,
  lockQueue: FileLockQueue,
): Promise<DispatchResult> {
  switch (parsed.verb) {
    case 'DONE':
      return handleDone(ctx, logger, cfg, iteration);

    case 'IDLE':
      // bash sleeps 30s on IDLE to back off polling-style primary roles.
      logger.log('IDLE — sleeping before next iteration');
      await sleep(30_000);
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'ESCALATE':
      return handleEscalate(parsed, ctx, logger);

    case 'CHECKPOINT':
      // CHECKPOINT verb is deprecated — milestone gates are now needs-human plan items.
      // Log and treat as ESCALATE so the loop halts without writing a checkpoint file.
      logger.log(`CHECKPOINT verb received (deprecated) — treating as ESCALATE. Use needs-human plan items for milestone gates.`);
      return handleEscalate(parsed, ctx, logger);

    case 'READY_FOR_PROD':
      return await handleReadyForProd(ctx, logger);

    case 'NEXT_HARNESS':
      return handleNextHarness(parsed, ctx, logger);

    case 'NEXT_WORKER':
      return handleNextWorker(parsed, ctx, logger, cfg, lanePool, lockQueue);

    case 'NEXT_WORKER_CEO_MODE':
      return handleNextWorkerCeoMode(parsed, ctx, logger, cfg);

    case 'NEXT_VALIDATOR':
      return handleNextValidator(parsed, ctx, logger, cfg, lanePool);

    case 'NEXT_TESTER':
      return handleSimpleInvoke(ctx, logger, 'tester', parsed.arg ? [`VAL_ID=${parsed.arg}`] : ['VAL_ID='], `TESTER starting${parsed.arg ? ` for ${parsed.arg}` : ''}`);

    case 'NEXT_SECURITY':
      return handleSimpleInvoke(ctx, logger, 'security-reviewer', [], 'SECURITY sweep starting');

    case 'GENERATE_TESTS':
      return handleSimpleInvoke(ctx, logger, 'test-writer', [], 'TEST_WRITER edge-case expansion starting');

    case 'NEXT_MONITOR':
      return handleSimpleInvoke(ctx, logger, 'monitor', [], 'MONITOR health sweep starting (production phase)');

    case 'NEXT_ARCHITECT':
      return handleNextArchitect(parsed, ctx, logger);

    case 'CONVERTED':
      logger.log('Orchestrator converted issues to fix features. Continuing.');
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'FEATURE_FREEZE':
      logger.log(`FEATURE_FREEZE: ${parsed.raw}`);
      return { terminal: false, exitCode: 0, reason: 'idle' };

    case 'RUN_TESTS':
      return handleRunTests(ctx, logger);

    case 'NEXT_SCOPER':
      return handleNextScoper(parsed, ctx, logger);

    default: {
      // Unreachable — parseDecision narrows to DECISION_VERBS which we
      // exhaustively handle above. The exhaustive check appeases TS.
      const _exhaustive: never = parsed.verb;
      logger.log(`unhandled decision verb (impossible): ${String(_exhaustive)}`);
      return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
    }
  }
}

/**
 * DONE handler. Mirrors bash:
 *   - service-smoke-test gate (configurable; failure reopens the loop)
 *   - curator + documenter consolidate-mode invocations
 *   - optional scoper proposal + reviewer auto-apply (product workflow)
 *   - optional archiveOnDone tar.gz of state dir
 *   - fire afterDone plugin hooks
 *   - notify_event done
 *   - exit 0
 */
async function handleDone(
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  iteration: number,
): Promise<DispatchResult> {
  logger.log('🎉 All features passed.');

  // Needs-human gate (P-010): cannot emit DONE while a started plan has open
  // needs-human items. Check the operator plans API and re-enter idle loop.
  const slug = harnessSlug(ctx);
  if (slug) {
    try {
      const substrateBase =
        process.env.PAPERCUSP_SUBSTRATE_BASE ??
        process.env.PAPERCUSP_HONO_BASE ??
        'http://localhost:3070';
      const url = `${substrateBase}/api/admin/plans/items?needsHuman=true&harness_slugs=${encodeURIComponent(slug)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const body = (await res.json()) as { items?: unknown[] };
        if (Array.isArray(body.items) && body.items.length > 0) {
          logger.log(
            `DONE blocked: ${body.items.length} open needs-human plan item(s) for harness "${slug}". ` +
            `Resolve them in the Plans tab → Inbox before work can complete.`,
          );
          return { terminal: false, exitCode: 0, reason: 'idle' };
        }
      }
    } catch (err) {
      logger.log(`needs-human gate check failed (non-fatal): ${(err as Error).message}`);
    }
  }

  // Smoke-test gate.
  if (
    configGet<boolean>(cfg, 'smokeTest.enabled', false) === true &&
    configGet<boolean>(cfg, 'smokeTest.onDone', true) === true
  ) {
    logger.log('Running service smoke-test (smokeTest.onDone=true)…');
    const smokeRc = runSmokeTest(ctx, logger);
    const hookOpts = {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: { TRIGGER: 'onDone', PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
      log: logger.log,
    };
    if (smokeRc === 0) {
      logger.log('Smoke test PASSED.');
      runHook('on-smoke-pass', hookOpts);
    } else {
      logger.log('Smoke test FAILED — feature reopened. Re-entering loop.');
      runHook('on-smoke-fail', hookOpts);
      return { terminal: false, exitCode: 0, reason: 'idle' };
    }
  }

  logger.log('Running curator to distill run memory.');
  try {
    const curatorOut = await invoke(ctx, 'curator', ['TRIGGER=done']);
    logger.log(`CURATOR: ${(curatorOut.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`CURATOR error: ${(err as Error).message}`);
  }
  // G5 — POST identity + skill snapshots after curator finishes.
  // Mirrors bash _post_curator_outputs. Best-effort.
  void postCuratorOutputs({ stateDir: ctx.stateDir, harnessDir: ctx.harnessDir }).catch(() => {});

  logger.log('Running documenter in consolidate mode.');
  try {
    const docOut = await invoke(ctx, 'documenter', ['TRIGGER=done', 'FEATURE_ID=-']);
    logger.log(`DOCUMENTER: ${(docOut.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`DOCUMENTER error: ${(err as Error).message}`);
  }

  // G4 — archiveOnDone. tar.gz state dir, fire archive event. Mirrors
  // bash run.sh:2326–2336. Default off (config.archiveOnDone=true to
  // enable). Best-effort: archive errors are logged and don't gate exit.
  if (configGet<boolean>(cfg, 'archiveOnDone', false) === true) {
    try {
      const archivesDir = join(ctx.stateDir, 'archives');
      mkdirSync(archivesDir, { recursive: true });
      const archivePath = join(archivesDir, `${Math.floor(Date.now() / 1000)}-done.tar.gz`);
      const tarRes = spawnSync(
        'tar',
        ['czf', archivePath, '-C', ctx.stateDir, '--exclude=archives', '--exclude=./archives', '.'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (tarRes.status === 0 && existsSync(archivePath)) {
        const sz = (() => { try { return statSync(archivePath).size; } catch { return 0; } })();
        logger.log(`  archiveOnDone: saved ${basename(archivePath)} (${sz} bytes)`);
        const phase = ctx.phase ?? 'staging';
        void postArchiveEvent({ stateDir: ctx.stateDir, archivePath, phase }).catch(() => {});
      } else {
        logger.log(`  archiveOnDone: tar failed (rc=${tarRes.status})`);
      }
    } catch (err) {
      logger.log(`  archiveOnDone error: ${(err as Error).message}`);
    }
  }

  // Fire registered plugin afterDone hooks (briefings pipeline, etc.).
  firePluginHook({
    hookName: 'afterDone',
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    pluginsLogPath: join(ctx.logDir, 'plugins.log'),
    log: logger.log,
  });

  logger.notifyEvent('done', `Mission complete: all features passed after ${iteration} iterations`);
  return { terminal: true, exitCode: 0, reason: 'done' };
}

/**
 * NEXT_WORKER handler. Routes via resolveWorkerCount(cfg, parsed.n,
 * availableSlots):
 *
 *   - N > 1 → handleMultiWorker spawns N workers on the same feature in
 *     sibling worktrees. Requires branchIsolation + useWorktrees.
 *   - N == 1 + max > 1 + branchIso → handleParallelLaneWorker (one worker
 *     per feature, multiple features in flight).
 *   - N == 1 + max == 1 → legacy sequential single-worker path (with
 *     optional debugger pre-check at attempts ≥ debugger.threshold).
 *   - useChunkLoop → handleChunkLoopWorker short-circuits everything
 *     above (per-chunk file locks + L1 typecheck gate + replan loop).
 *
 * After workers commit, handleNextValidator runs the synthesizer pass
 * and then the validator against the synthesized branch.
 */
/**
 * P-019: count open `needs-human` plan items at importance `urgent` for
 * this harness. An urgent human gate means "stop churning" — the worker
 * loop halts (idles) rather than dispatching more work. Best-effort: any
 * error returns 0 (fail-open — never stall the loop on an infra blip).
 * Mirrors handleDone's needs-human gate fetch.
 */
async function countOpenUrgentNeedsHuman(ctx: InvokeContext): Promise<number> {
  const slug = harnessSlug(ctx);
  if (!slug) return 0;
  try {
    const substrateBase =
      process.env.PAPERCUSP_SUBSTRATE_BASE ??
      process.env.PAPERCUSP_HONO_BASE ??
      'http://localhost:3070';
    const url = `${substrateBase}/api/admin/plans/items?needsHuman=true&harness_slugs=${encodeURIComponent(slug)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return 0;
    const body = (await res.json()) as { items?: Array<{ item?: { importance?: string } }> };
    if (!Array.isArray(body.items)) return 0;
    return body.items.filter((r) => r?.item?.importance === 'urgent').length;
  } catch {
    return 0;
  }
}

async function handleNextWorker(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
  lockQueue: FileLockQueue,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_WORKER without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }

  // P-019: an open `urgent` needs-human gate halts the worker loop — don't
  // keep churning a feature while a human must act now. Non-urgent
  // needs-human items still only gate DONE (see handleDone). Fail-open.
  const urgentGates = await countOpenUrgentNeedsHuman(ctx);
  if (urgentGates > 0) {
    logger.log(
      `WORKER halt: ${urgentGates} open urgent needs-human item(s) for this harness — ` +
        `resolve them in the Plans tab → Inbox to resume. (NEXT_WORKER ${fid} deferred.)`,
    );
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }

  // P-037: pre-dispatch distributed claim. Best-effort; logs the outcome
  // and continues regardless. The operator-side endpoint records every
  // attempt in harness_shared.claim_audit for diagnostics. When the
  // substrate is off / unbound the endpoint returns single-writer-
  // fallback + won:true so this is a no-op for the legacy path.
  await tryDistributedClaim(fid, ctx, logger);

  // Chunk-loop path takes priority over the legacy modes when enabled.
  // It runs ONE feature end-to-end through plan → chunk-loop → commit,
  // returning when the feature is done or escalated. Concurrent
  // dispatches share the lockQueue.
  if (useChunkLoop(cfg)) {
    return handleChunkLoopWorker(fid, ctx, logger, cfg, lockQueue);
  }

  // Resolve how many workers to dispatch on this feature.
  //   - max=1 → always 1 (single-worker fast path below).
  //   - workersPerFeature configured → that many (clamped to max + slots).
  //   - tier set configured → orchestrator-picked N from the tier vocab.
  // resolveWorkerCount handles all clamping and tier validation.
  const max = parallelMaxWorkers(cfg);
  const availableSlots = Math.max(0, max - lanePool.count());
  const N = resolveWorkerCount(cfg, parsed.n, availableSlots);

  // Adaptive telemetry: when tiers are configured, record the
  // requested-vs-actual N for this dispatch. Best-effort; never blocks.
  const hasTiers = hasWorkerCountTiers(cfg);
  if (hasTiers) {
    const tiers = workerCountTiers(cfg);
    const requestedN = parsed.n ?? tiers.tiers[0];
    const tierIdx = tiers.tiers.indexOf(N);
    const tierLabel = tierIdx >= 0 ? tiers.labels[tierIdx] : null;
    logger.log(
      `ADAPTIVE: ${fid} → N=${N} (${tierLabel ?? '?'})` +
        (requestedN !== N ? ` [requested ${requestedN}]` : ''),
    );
    await recordAdaptiveDecision(ctx, logger, {
      featureId: fid,
      requestedN,
      actualN: N,
      tierLabel,
      availableAtDecision: availableSlots,
      maxSlots: max,
    });
  }

  if (N > 1) {
    return handleMultiWorker(
      fid,
      N,
      ctx,
      logger,
      cfg,
      lanePool,
      hasTiers ? 'adaptive' : 'static',
    );
  }
  if (max > 1 && configGet<boolean>(cfg, 'branchIsolation.enabled', false) === true) {
    return handleParallelLaneWorker(fid, ctx, logger, cfg, lanePool);
  }

  // Optional debugger before the worker.
  if (configGet<boolean>(cfg, 'debugger.enabled', true) === true) {
    const threshold = Number(configGet<unknown>(cfg, 'debugger.threshold', 3));
    const attempts = await featureAttempts(ctx.stateDir, fid, stateCtx(ctx));
    const debugNote = join(ctx.stateDir, 'debug', `${fid}.md`);
    if (attempts >= threshold && !existsSync(debugNote)) {
      logger.log(
        `DEBUGGER ${fid} starting (attempts=${attempts} ≥ ${threshold})`,
      );
      try {
        const dout = await invoke(ctx, 'debugger', [`FEATURE_ID=${fid}`]);
        logger.log(
          `DEBUGGER: ${(dout.output || '').slice(0, 200) || '(no output)'}`,
        );
        // PG-canonical capture: read whatever the debugger wrote at
        // <stateDir>/debug/<fid>.md and UPSERT to PG. Replaces the
        // never-built `/api/internal/feature-debug-note-event` poster
        // referenced by bash run.sh. Best-effort.
        if (ctx.pg && ctx.workspaceId) {
          try {
            const { captureDebuggerOutput } = await import('./feature-debug-notes.js');
            const { harnessSlug: getSlug } = await import('./state.js');
            const r = await captureDebuggerOutput({
              pg: ctx.pg,
              workspaceId: ctx.workspaceId,
              harnessSlug: getSlug(ctx.projectDir),
              featureId: fid,
              stateDir: ctx.stateDir,
            });
            if (r.captured) {
              logger.log(`  debugger output captured to PG (${r.bytes} chars)`);
            }
          } catch { /* best-effort */ }
        }
      } catch (err) {
        logger.log(`DEBUGGER error: ${(err as Error).message}`);
      }
    }
  }

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };

  branchIsoPreWorker(branchIsoCtx, fid);
  // pre-worker hook (user customization point).
  runHook('pre-worker', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: { ROLE: 'worker', FEATURE_ID: fid, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
    log: logger.log,
  });
  logger.log(`WORKER ${fid} starting`);
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  // If worktrees enabled, route the worker subprocess to the worktree dir
  // by passing a worktreePathFor callback to invoke().
  const worktreedCtx: InvokeContext = worktreeEnabled(cfg)
    ? {
        ...ctx,
        worktreePathFor: (id) => worktreePath(ctx.stateDir, id),
      }
    : ctx;

  let workerRc = 0;
  try {
    const r = await invoke(worktreedCtx, 'worker', [
      `FEATURE_ID=${fid}`,
      ...priorAttemptExtras(ctx.stateDir, ctx.projectDir, fid),
    ]);
    workerRc = r.exitCode;
  } catch (err) {
    logger.log(`WORKER error: ${(err as Error).message}`);
    workerRc = 1;
  }

  // post-worker hook.
  runHook('post-worker', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: {
      ROLE: 'worker',
      FEATURE_ID: fid,
      RC: String(workerRc),
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
    },
    log: logger.log,
  });
  fireLifecycleHook(ctx, 'onPostWorker', logger.log);

  branchIsoPostWorker(branchIsoCtx, fid);
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_VALIDATOR handler.
 *   - drains parallel worker lanes first (avoid git conflicts with the
 *     validator running concurrently with workers)
 *   - branchIsoPreValidator (switches to feature branch / logs worktree)
 *   - log "VALIDATOR <fid> starting"
 *   - run the synthesizer pass (for N>1 manifests, or N=1 with
 *     synthesizeSingle on + a worker worktree present): synthesizer
 *     produces a unified <fid>-synthesis branch the validator will
 *     certify
 *   - invoke validator (cwd = synthesis worktree on synth success,
 *     otherwise the feature's worker worktree)
 *   - handleSynthesisOutcome on synth success: merge synth branch on
 *     PASS, drop all worktrees on FAIL; fires on-synthesis-won hook
 *   - on synth failure or no-synth: branchIsoPostValidator + lane
 *     worktree cleanup (skipped when synth failed with N>1 manifest
 *     since there's nothing to merge)
 */
/**
 * Exported for testability — see test-context-builder.ts and
 * handle-next-validator.test.ts. Not part of the public API; do not
 * call from other modules (everything goes through runMainLoop in
 * production).
 */
export async function _handleNextValidatorForTests(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  return handleNextValidator(parsed, ctx, logger, cfg, lanePool);
}

async function handleNextValidator(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_VALIDATOR without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }

  // Drain THIS feature's parallel worker lanes before running the
  // validator — running git operations concurrently with workers
  // committing in their lanes risks index conflicts. Other features'
  // competitions keep running (the hybrid case: 5 features × 2 workers
  // each — when feature A is ready to validate, only its 2 lanes need
  // to drain; B/C/D/E's 8 lanes keep working).
  const perFeatureCount = lanePool.countForFeature(fid);
  if (perFeatureCount > 0) {
    logger.log(
      `  parallel: waiting on ${perFeatureCount} worker lane(s) for ${fid}…` +
        (lanePool.count() > perFeatureCount
          ? ` (${lanePool.count() - perFeatureCount} other-feature lane(s) keep running)`
          : ''),
    );
    await lanePool.waitForFeature(fid);
  }

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };

  branchIsoPreValidator(branchIsoCtx, fid);
  // pre-validator hook.
  runHook('pre-validator', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: { ROLE: 'validator', FEATURE_ID: fid, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
    log: logger.log,
  });
  logger.log(`VALIDATOR ${fid} starting`);

  const worktreedCtx: InvokeContext = worktreeEnabled(cfg)
    ? {
        ...ctx,
        worktreePathFor: (id) => worktreePath(ctx.stateDir, id),
      }
    : ctx;

  // ─── Synthesizer step (always runs) ──────────────────────────────
  // Synthesizer reads all candidate lanes (real competition manifest for
  // N>1, synthetic 1-lane manifest for single-worker dispatches when
  // synthesizeSingle is on), produces a unified tree in the
  // `<fid>-synthesis` worktree, and the validator then runs against
  // that worktree as a normal single-branch validation.
  let synthesisWorktree: string | null = null;
  let synthesisBr: string | null = null;
  let synthesisRanWithManifest: { n: number } | null = null;
  let synthesisAttempted = false;
  let synthApprovedAsIs = false;
  let synthHardFailed = false;
  {
    let effectiveManifest = readCompetitionManifest(ctx.stateDir, fid);
    // N=1 fallback: only synthesize if worktrees are enabled AND the
    // feature's worktree actually exists. Without it the singleLaneManifest
    // points at a missing directory and the synthesizer gets empty
    // context. This handles:
    //   - branchIso/worktrees disabled (no worktree created at all)
    //   - useChunkLoop=true (writes to projectDir, not a worktree)
    //   - the worker just didn't create one for any reason
    // Skip silently; legacy single-branch path handles merge via
    // branchIsoPostValidator.
    if (
      !effectiveManifest &&
      synthesizeSingle(cfg) &&
      worktreeEnabled(cfg) &&
      existsSync(worktreePath(ctx.stateDir, fid))
    ) {
      effectiveManifest = singleLaneManifest(ctx.stateDir, fid);
    }
    if (effectiveManifest) {
      synthesisAttempted = true;
      const result = await runSynthesizer({
        fid,
        manifest: effectiveManifest,
        ctx,
        cfg,
        log: logger.log,
      });
      if (result.synthesized && result.worktree && result.branch) {
        synthesisWorktree = result.worktree;
        synthesisBr = result.branch;
        synthesisRanWithManifest = { n: effectiveManifest.n };
        // Remove the manifest so it doesn't linger in state. With
        // COMPETITION_WINNER deleted from validator.md, validator just
        // validates the synthesis worktree as a normal feature branch.
        try {
          unlinkSync(competitionManifestPath(ctx.stateDir, fid));
        } catch {
          // ignore
        }
        void attachSynthesisOutcomeTelemetry(ctx, logger, fid, true, null);
      } else if (result.approvedAsIs) {
        // Synthesizer ran successfully and explicitly approved a
        // candidate verbatim (notes file written, no code changes).
        // Fall through to branchIsoPostValidator — the worker's branch
        // ships, but tagged as reviewed.
        logger.log(
          `SYNTHESIZER: ${fid} approved candidate as-is; validating worker branch directly`,
        );
        synthApprovedAsIs = true;
        void attachSynthesisOutcomeTelemetry(ctx, logger, fid, false, result.reason ?? null);
      } else {
        logger.log(
          `SYNTHESIZER: ${fid} failed (${result.reason ?? 'unknown'})`,
        );
        synthHardFailed = true;
        void attachSynthesisOutcomeTelemetry(ctx, logger, fid, false, result.reason ?? null);
      }
    }
  }

  // If synth was attempted with a real multi-lane manifest and failed,
  // there's no usable branch to validate — the worker's parent branch
  // (harness/<fid>) has no commits because lanes wrote to -lane-N
  // branches. Running the validator would either fail noisily against
  // projectDir or, worse, accidentally pass against ambient state.
  // Mark the feature failed programmatically and skip validator.
  //
  // Same treatment for the N=1 "synth hard-failed without approval"
  // case (no notes file written → synth skipped its job): the worker's
  // branch must not ship unreviewed.
  const earlyManifestForSkip = readCompetitionManifest(ctx.stateDir, fid);
  const skipValidatorMultiLaneFail =
    synthesisAttempted &&
    !synthesisWorktree &&
    earlyManifestForSkip !== null &&
    earlyManifestForSkip.n > 1;
  const skipValidatorSynthHardFail = synthHardFailed && !synthApprovedAsIs;

  const validatorCtx: InvokeContext = synthesisWorktree
    ? { ...ctx, worktreePathFor: () => synthesisWorktree as string }
    : worktreedCtx;

  // Capture pre-validator status set so we can detect transitions to
  // 'passed' after the validator returns. Validator updates harness_features
  // directly; this is the cheapest way to surface the per-feature event.
  const beforeStatus = new Map<string, string>();
  for (const f of (await readFeatures(ctx.stateDir, stateCtx(ctx)))) beforeStatus.set(f.id, f.status);

  let validatorRc = 0;
  if (skipValidatorMultiLaneFail || skipValidatorSynthHardFail) {
    const why = skipValidatorMultiLaneFail
      ? `synth failed with ${earlyManifestForSkip!.n} lanes`
      : `synth skipped its job (empty worktree, no notes file)`;
    logger.log(
      `SYNTHESIZER: ${fid} ${why} — skipping validator, marking failing`,
    );
    // 'failing' (present-tense) is the retry-candidate state the
    // orchestrator looks for. 'failed' would orphan the feature.
    await setFeatureStatus(ctx.stateDir, fid, 'failing', { ctx: stateCtx(ctx) });
    // Close out the telemetry row's validator-side outcome explicitly.
    // Without this, the row would stay pending forever even though we
    // know the dispatch is terminated. Best-effort.
    void attachAdaptiveOutcome(ctx, logger, fid, 'fail');
    validatorRc = 1;
  } else {
    try {
      const r = await invoke(validatorCtx, 'validator', [`FEATURE_ID=${fid}`]);
      validatorRc = r.exitCode;
      // Capture the validator's output path so the next NEXT_WORKER
      // for this feature can hand it to the worker as
      // PRIOR_VALIDATOR_LOG. Cleared on PASS — there's nothing to
      // retry against.
      try {
        const ptrDir = join(ctx.stateDir, 'last-validator-out');
        mkdirSync(ptrDir, { recursive: true });
        const ptr = join(ptrDir, `${fid}.path`);
        writeFileSync(ptr, r.outPath ?? '');
      } catch { /* best-effort */ }
    } catch (err) {
      logger.log(`VALIDATOR error: ${(err as Error).message}`);
      validatorRc = 1;
    }
  }

  // post-validator hook.
  runHook('post-validator', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: {
      ROLE: 'validator',
      FEATURE_ID: fid,
      RC: String(validatorRc),
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
    },
    log: logger.log,
  });
  fireLifecycleHook(ctx, 'onPostValidator', logger.log);

  // Pattern 1 — onFeaturePassed fires per newly-passed feature. Diff before
  // vs after to find features that transitioned status → 'passed'. Each
  // fire passes --feature-id=... so plugin scripts can target the event.
  // Also attach an adaptive-telemetry outcome for the matching pending row,
  // if any (see _adaptiveTelemetryByFeature seeded by handleNextWorker).
  // Bug P: when this dispatch will run handleSynthesisOutcome below, the
  // 'pass' transition here is provisional — the merge may still fail and
  // revert the feature to 'failing'. Defer telemetry close to handleSynthesisOutcome
  // (it owns the closeTelemetry callback) so the row reflects the actual outcome.
  const deferTelemetryToSynthesisOutcome =
    synthesisWorktree !== null && synthesisRanWithManifest !== null;
  for (const f of (await readFeatures(ctx.stateDir, stateCtx(ctx)))) {
    const before = beforeStatus.get(f.id);
    if (f.status === 'passed' && before !== 'passed') {
      firePluginHook({
        hookName: 'onFeaturePassed',
        projectDir: ctx.projectDir,
        stateDir: ctx.stateDir,
        pluginsLogPath: join(ctx.logDir, 'plugins.log'),
        log: logger.log,
        extraFlags: [`--feature-id=${f.id}`],
      });
      if (!(deferTelemetryToSynthesisOutcome && f.id === fid)) {
        void attachAdaptiveOutcome(ctx, logger, f.id, 'pass');
      }
      // Chunk-loop retry-cleanup. When chunk-loop is the worker model
      // and the feature just passed validation, drop the
      // last-validator-out pointer (so a future feature with the same
      // id doesn't get a stale retry context) and drop the chunk-plan
      // rows (so a future re-dispatch sees a clean slate). The synth
      // path handles its own pointer cleanup in handleSynthesisOutcome.
      if (useChunkLoop(cfg) && f.id === fid) {
        try {
          unlinkSync(join(ctx.stateDir, 'last-validator-out', `${f.id}.path`));
        } catch { /* best-effort */ }
        if (ctx.pg && ctx.workspaceId) {
          try {
            const slug =
              (configGet<string>(cfg, 'slug', '') || harnessSlug(ctx)) || '';
            const { dropPlan } = await import('./chunk-plan-pg.js');
            await dropPlan(
              { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: slug },
              f.id,
            );
          } catch { /* best-effort */ }
        }
        // Orphan-synth-worktree cleanup. If this feature was previously
        // attempted under the synth pipeline (useChunkLoop=false) and
        // validator rejected → synth worktree was preserved at
        // <stateDir>/worktrees/<fid>-synthesis. Then the user flipped
        // useChunkLoop=true; this round's chunk-loop passed. The
        // preserved synth worktree is now an orphan — clean it up.
        // No-op on the common case (no flip happened, branch doesn't
        // exist). Cheap to attempt unconditionally.
        const synthWt = join(ctx.stateDir, 'worktrees', `${f.id}-synthesis`);
        const synthBr = `harness/${f.id}-synthesis`;
        if (existsSync(synthWt)) {
          try {
            const r = git(['worktree', 'remove', '--force', synthWt], { cwd: ctx.projectDir });
            if (r.outputHead(3)) logger.log(`  ${r.outputHead(3)}`);
            logger.log(`  chunk-loop cleanup: removed orphan synth worktree ${synthWt}`);
          } catch { /* best-effort */ }
        }
        try {
          git(['branch', '-D', synthBr], { cwd: ctx.projectDir });
        } catch { /* best-effort */ }
      }
    } else if (
      (f.status === 'failed' || f.status === 'blocked') &&
      before !== f.status &&
      before !== 'passed'
    ) {
      void attachAdaptiveOutcome(ctx, logger, f.id, 'fail');
    }
  }

  if (synthesisWorktree && synthesisBr && synthesisRanWithManifest) {
    // Synthesis path: validator ran against `<fid>-synthesis`. On PASS,
    // merge the synthesis branch and drop ALL worktrees (synthesis +
    // every lane). On FAIL, drop everything without merging.
    await handleSynthesisOutcome(
      fid,
      synthesisBr,
      synthesisWorktree,
      synthesisRanWithManifest.n,
      ctx,
      logger.log,
      cfg,
      (outcome) => {
        void attachAdaptiveOutcome(ctx, logger, fid, outcome);
      },
    );
  } else {
    // Synthesizer did not produce a candidate. Two distinct sub-cases:
    //
    //   a) Synthesis was never attempted (no manifest + synthesizeSingle
    //      off, or worktrees disabled). Treat as legacy single-branch:
    //      run branchIsoPostValidator to merge harness/<fid> on PASS.
    //
    //   b) Synthesis was attempted but failed (e.g. synthesizer LLM
    //      errored, or produced no edits). If a real competition
    //      manifest exists (N>1 dispatch), the feature has no merged
    //      worker branch to fall back to — branchIsoPostValidator would
    //      try to merge harness/<fid> which has no commits. Skip the
    //      legacy merge and just clean up lane worktrees + manifest.
    //
    //      For the synthesis-attempted-but-failed N=1 case (synthetic
    //      manifest), the worker DID write to harness/<fid> — fall
    //      through to the legacy merge path.
    const staleManifest = readCompetitionManifest(ctx.stateDir, fid);
    const synthFailedMultiLane =
      synthesisAttempted && staleManifest !== null && staleManifest.n > 1;

    if (!synthFailedMultiLane) {
      await branchIsoPostValidator(branchIsoCtx, fid, stateCtx(ctx));
    }

    if (staleManifest) {
      logger.log(
        `SYNTHESIZER: cleaning up ${staleManifest.n} lane worktree(s) for ${fid} after synth failure`,
      );
      for (let i = 1; i <= staleManifest.n; i++) {
        const wt = join(ctx.stateDir, 'worktrees', `${fid}-lane-${i}`);
        const br = `harness/${fid}-lane-${i}`;
        if (existsSync(wt)) {
          git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
        }
        git(['branch', '-D', br], { cwd: ctx.projectDir });
      }
      try {
        unlinkSync(competitionManifestPath(ctx.stateDir, fid));
      } catch {
        // ignore
      }
    }
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Multi-worker dispatch: spawn `count` workers on the SAME feature in
 * sibling git worktrees. Each worker grabs a slot from the shared
 * LanePool so multiple multi-worker dispatches can run concurrently
 * across different features (max=10 + count=2 → up to 5 simultaneous
 * 2-way competitions).
 *
 * Returns immediately after registering the lanes — the actual worker
 * Promise.all + manifest write happen in a void(async) IIFE so the
 * orchestrator can dispatch the next decision (another NEXT_WORKER for
 * a different feature, typically) while these workers run.
 *
 * The validator path drains lanes per-feature (waitForFeature(fid)) so
 * other features' multi-worker rounds stay live while feature A is
 * being validated.
 *
 * `source` controls the log prefix ('static' → "COMPETITION",
 * 'adaptive' → "COMPETITION (adaptive)") and whether a workersPerFeature
 * > max clamp warning fires (only meaningful for the static path; the
 * adaptive caller has already validated against max).
 */
async function handleMultiWorker(
  fid: string,
  count: number,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
  source: 'static' | 'adaptive' = 'static',
): Promise<DispatchResult> {
  const max = parallelMaxWorkers(cfg);
  // Clamp: can't run more workers per feature than max (would deadlock
  // the acquire loop). User-set count > max is a config error in the
  // static path; clamp + warn rather than hang.
  const effectivePer = Math.min(count, max);
  if (effectivePer !== count && source === 'static') {
    logger.log(
      `  competition: workersPerFeature=${count} > max=${max}; clamping to ${effectivePer}`,
    );
  }
  const tag = source === 'adaptive' ? 'COMPETITION (adaptive)' : 'COMPETITION';
  logger.log(
    `${tag}: spawning ${effectivePer} workers on ${fid}` +
      ` (pool ${lanePool.count()}/${max} before this)`,
  );
  // on-competition-start hook (informational).
  runHook('on-competition-start', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: {
      FEATURE_ID: fid,
      LANE_COUNT: String(effectivePer),
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
    },
    log: logger.log,
  });
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };
  const base = branchIsoBase(branchIsoCtx);
  const worktreesRoot = join(ctx.stateDir, 'worktrees');
  mkdirSync(worktreesRoot, { recursive: true });

  // Acquire `effectivePer` lane slots up front. Each acquire blocks
  // on the global cap (max), so this naturally serializes when the
  // pool is full. After all slots are reserved, spawn the workers
  // ASYNC and return.
  const laneIds: number[] = [];
  for (let i = 1; i <= effectivePer; i++) {
    laneIds.push(await lanePool.acquire(fid));
  }

  // Spawn workers + manifest write in the background. Orchestrator
  // resumes immediately so the next NEXT_WORKER decision can run.
  void (async () => {
    const lanePromises: Promise<void>[] = [];
    for (let i = 0; i < effectivePer; i++) {
      const laneNum = i + 1;
      const laneId = laneIds[i];
      const laneFid = `${fid}-lane-${laneNum}`;
      const wt = join(worktreesRoot, laneFid);
      const br = `harness/${laneFid}`;
      if (!existsSync(wt)) {
        // If a preserved synth branch exists from a prior round (validator
        // rejected the synthesized output, but we kept the branch), start
        // this lane FROM that branch instead of base. Worker iterates on
        // prior rejected code with knowledge of why it was rejected
        // (PRIOR_VALIDATOR_LOG env extra below).
        const synthBr = `harness/${fid}-synthesis`;
        const laneBase = branchExists(synthBr, { cwd: ctx.projectDir }) ? synthBr : base;
        if (laneBase !== base) {
          logger.log(`  competition lane ${laneNum} (${fid}): retry off ${synthBr}`);
        }
        const r = git(['worktree', 'add', '-B', br, wt, laneBase], { cwd: ctx.projectDir });
        if (r.outputHead(3)) logger.log(`  ${r.outputHead(3)}`);
      }
      logger.log(`  competition lane ${laneNum} (${fid}): ${wt}`);

      const lanePromise = (async () => {
        try {
          await invoke(
            { ...ctx, worktreePathFor: () => wt },
            'worker',
            [
              `FEATURE_ID=${laneFid}`,
              `COMPETITION_PARENT=${fid}`,
              `COMPETITION_LANE=${laneNum}`,
              ...priorAttemptExtras(ctx.stateDir, ctx.projectDir, fid),
            ],
          );
        } catch (err) {
          logger.log(`  competition lane ${laneNum} (${fid}) error: ${(err as Error).message}`);
        }
        // Commit any staged changes in this lane's worktree.
        git(['add', '-A'], { cwd: wt });
        const status = git(['diff', '--cached', '--quiet'], { cwd: wt });
        if (status.exitCode !== 0) {
          const r = git(
            ['commit', '--quiet', '-m', `worker: ${laneFid} (competition lane ${laneNum})`],
            { cwd: wt },
          );
          if (r.outputHead(3)) logger.log(`  ${r.outputHead(3)}`);
        }
        // Release this lane's slot so other features (or this same
        // feature's next attempt after a fail) can dispatch.
        lanePool.release(laneId);
      })();
      lanePromises.push(lanePromise);
    }

    // Wait for THIS feature's competitors only. Other features keep running.
    await Promise.all(lanePromises);

    // Write the competition manifest so the validator iteration can
    // compare worktrees. handleNextValidator's waitForFeature(fid)
    // ensures it waits until this point before reading the manifest.
    await setFeatureStatus(ctx.stateDir, fid, 'validating', { ctx: stateCtx(ctx) });
    writeCompetitionManifest(ctx.stateDir, fid, effectivePer);
    logger.log(
      `${tag}: manifest ${competitionManifestPath(ctx.stateDir, fid)} written` +
        ` (${effectivePer}-way for ${fid})`,
    );
  })();

  // Return immediately — orchestrator can dispatch another NEXT_WORKER
  // for a different feature while this competition runs in the background.
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Parallel-lane worker: acquire a slot from the lane pool (blocks if at
 * cap), kick off the worker async, and return so the orchestrator can
 * dispatch the next decision while this worker runs in parallel. The
 * NEXT_VALIDATOR branch later drains the pool before its validator runs.
 */
async function handleParallelLaneWorker(
  fid: string,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lanePool: LanePool,
): Promise<DispatchResult> {
  const max = parallelMaxWorkers(cfg);
  if (lanePool.count() >= max) {
    logger.log(
      `  parallel: cap reached (${lanePool.count()}/${max}), waiting for a lane to free`,
    );
  }
  const laneId = await lanePool.acquire(fid);
  logger.log(
    `WORKER ${fid} starting (parallel lane, ${lanePool.count() - 1}/${max} active before this)`,
  );
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log: logger.log,
  };
  const useWorktrees =
    configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true;

  // Run the worker pipeline async. Each step matches the sequential path's
  // ordering (pre-worker hook → invoke → post-worker hook → branch-iso post).
  void (async () => {
    branchIsoPreWorker(branchIsoCtx, fid);
    runHook('pre-worker', {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: { ROLE: 'worker', FEATURE_ID: fid, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
      log: logger.log,
    });
    let workerRc = 0;
    try {
      const r = await invoke(
        useWorktrees
          ? { ...ctx, worktreePathFor: (id) => worktreePath(ctx.stateDir, id) }
          : ctx,
        'worker',
        [`FEATURE_ID=${fid}`, ...priorAttemptExtras(ctx.stateDir, ctx.projectDir, fid)],
      );
      workerRc = r.exitCode;
    } catch (err) {
      logger.log(`WORKER (parallel) error: ${(err as Error).message}`);
      workerRc = 1;
    }
    runHook('post-worker', {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: {
        ROLE: 'worker',
        FEATURE_ID: fid,
        RC: String(workerRc),
        PROJECT_DIR: ctx.projectDir,
        STATE_DIR: ctx.stateDir,
      },
      log: logger.log,
    });
    branchIsoPostWorker(branchIsoCtx, fid);
    await setFeatureStatus(ctx.stateDir, fid, 'validating', { ctx: stateCtx(ctx) });
    lanePool.release(laneId);
  })();

  return { terminal: false, exitCode: 0, reason: 'idle' };
}



/**
 * ESCALATE handler. Mirrors bash:
 *   reason = decision after "ESCALATE "
 *   logs, fires on-escalate hook, runs curator with TRIGGER=escalate,
 *   notifies, exits 3.
 */
async function handleEscalate(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const reason = parsed.arg ?? '';
  logger.log(`⛔ ESCALATED: ${reason}`);
  logger.log(`Reason: ${reason || '(none)'}. Check Plans tab → Inbox for milestone gates.`);
  runHook('on-escalate', {
    stateDir: ctx.stateDir,
    projectDir: ctx.projectDir,
    logDir: ctx.logDir,
    env: { REASON: reason, PROJECT_DIR: ctx.projectDir, STATE_DIR: ctx.stateDir },
    log: logger.log,
  });
  logger.log('Running curator to distill run memory before exit.');
  try {
    const c = await invoke(ctx, 'curator', ['TRIGGER=escalate', `REASON=${reason}`]);
    logger.log(`CURATOR: ${(c.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`CURATOR error: ${(err as Error).message}`);
  }
  logger.notifyEvent('escalate', reason);
  return { terminal: true, exitCode: 3, reason: 'escalate' };
}

/**
 * READY_FOR_PROD handler. Mirrors bash:
 *   date > <stateDir>/ready-for-prod.flag
 *   log
 *   continue
 */
async function handleReadyForProd(ctx: InvokeContext, logger: Logger): Promise<DispatchResult> {
  if (ctx.pg && ctx.workspaceId) {
    const { setReadyForProdPg } = await import('./mission-state-pg');
    await setReadyForProdPg({
      pg: ctx.pg,
      workspaceId: ctx.workspaceId,
      harnessSlug: (await import('./state')).harnessSlug(ctx.projectDir),
    });
  } else {
    const flagPath = join(ctx.stateDir, 'ready-for-prod.flag');
    writeFileSync(flagPath, `${new Date().toISOString()}\n`);
  }
  logger.log('READY_FOR_PROD — flag recorded for promotion pipeline.');
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_WORKER_CEO_MODE handler. Used by org/department harnesses when
 * the business role handles a Directive from the user. Mirrors bash:
 *
 *   invoke worker FEATURE_ID=$fid MODE=ceo MESSAGE_ID=$fid
 *   process_actions_block $worker_out $callingDept
 *
 * The worker's prompt is resolved per the same phase+dept lookup chain
 * as a regular invoke (CEO-mode prompt files live under
 * prompts/department/departments/business/worker.md by convention).
 *
 * The worker's output is expected to contain a markdown-fenced
 * ```actions ... ``` JSON block; each action gets POSTed to
 * /api/org/admin/execute-action.
 */
async function handleNextWorkerCeoMode(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
): Promise<DispatchResult> {
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_WORKER_CEO_MODE without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  logger.log(`NEXT_WORKER_CEO_MODE ${fid} (CEO mode)`);

  let workerOut = '';
  try {
    const r = await invoke(ctx, 'worker', [
      `FEATURE_ID=${fid}`,
      'MODE=ceo',
      `MESSAGE_ID=${fid}`,
    ]);
    workerOut = r.output;
  } catch (err) {
    logger.log(`WORKER (ceo mode) error: ${(err as Error).message}`);
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  logger.log(`WORKER (ceo mode): ${workerOut.slice(0, 200) || '(no output)'}`);

  const callingDept = configGet<string>(cfg, 'dept', '');
  const harnessToken = configGet<string>(cfg, 'harness_token', '');
  await processActionsBlock({
    stdout: workerOut,
    callingDept: callingDept || undefined,
    bearerToken: harnessToken || undefined,
    log: logger.log,
  });

  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * NEXT_HARNESS handler. Cross-harness dispatch (harness-of-harnesses).
 * Mirrors bash:
 *
 *   NEXT_HARNESS <child-slug> [--role=<role>] [other args]
 *
 *   1. Try POST http://localhost:3001/api/harness/<slug>/invoke?role=<role>
 *      with 120s timeout. On 2xx, write response to log dir and return.
 *   2. On unreachable (any non-2xx, network error, or timeout): look up
 *      the child's path in ~/.restart-harness-projects.json and recurse:
 *        cd <child_path> && PROJECT_DIR=<child_path> MAX_ITERATIONS=1 \
 *          bash <harnessDir>/run.sh
 *      (One iteration per call so the parent stays in control of cadence.)
 */
async function handleNextHarness(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const childSlug = parsed.arg ?? '';
  if (!childSlug) {
    logger.log(`ERROR: NEXT_HARNESS without child slug: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  // Pull --role= from raw if present.
  const roleMatch = parsed.raw.match(/--role=(\S+)/);
  const childRole = roleMatch?.[1] ?? 'orchestrator';
  logger.log(`NEXT_HARNESS ${childSlug} --role=${childRole}`);

  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  const apiUrl = `${operatorBase}/api/harness/${childSlug}/invoke?role=${childRole}`;
  const apiOk = await postJson(apiUrl, '{}', 120_000);
  if (apiOk.ok) {
    if (ctx.pg && ctx.workspaceId) {
      const { recordDispatchPg } = await import('./dispatches-pg');
      const { harnessSlug: getSlug } = await import('./state');
      await recordDispatchPg(
        { pg: ctx.pg, workspaceId: ctx.workspaceId },
        getSlug(ctx.projectDir),
        childSlug,
        childRole,
        apiOk.body,
      );
    } else {
      const ts = Math.floor(Date.now() / 1000);
      const out = join(ctx.logDir, `nexth-${childSlug}-${ts}.json`);
      writeFileSync(out, apiOk.body);
    }
    logger.log(`  → dispatched via API (${apiUrl})`);
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }

  logger.log('  → API unreachable, falling back to direct shell exec');
  const childPath = lookupHarnessPath(childSlug);
  if (!childPath || !existsSync(childPath)) {
    logger.log(`  ERROR: child harness path not found for slug '${childSlug}'`);
    logger.log('  Check ~/.restart-harness-projects.json');
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  // Recurse into the child harness for one iteration.
  const result = spawnSync('bash', [`${ctx.harnessDir}/run.sh`], {
    cwd: childPath,
    env: {
      ...process.env,
      PROJECT_DIR: childPath,
      MAX_ITERATIONS: '1',
      HARNESS_DIR: ctx.harnessDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  // Tail to the parent's run.log (bash uses tee + head -100).
  for (const line of (stdout + stderr).split(/\r?\n/).slice(0, 100)) {
    if (line.length > 0) logger.log(line);
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

interface PostResult {
  ok: boolean;
  status: number;
  body: string;
}

/** Tiny fetch wrapper. Returns ok=false on any error / non-2xx / timeout. */
async function postJson(url: string, body: string, timeoutMs: number): Promise<PostResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  } catch {
    return { ok: false, status: 0, body: '' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up a child harness's project dir. Tries the operator HTTP API
 * (canonical — PG-backed harness_shared.harness_registry) first, then
 * falls back to the legacy ~/.restart-harness-projects.json.
 *
 * The HTTP call is synchronous via execFileSync(curl) since this fn is
 * called from sync contexts. 3s timeout; falls through silently on any
 * failure.
 */
function lookupHarnessPath(slug: string): string | null {
  const home = process.env.HOME ?? '';
  const operatorBase = process.env.PAPERCUSP_OPERATOR_BASE ?? 'http://localhost:3055';
  // 1. Operator HTTP API.
  try {
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const out = execFileSync('curl', [
      '-sf', '--max-time', '3', `${operatorBase}/api/harness/projects`,
    ], { encoding: 'utf8', timeout: 4000 });
    const data = JSON.parse(out);
    const projects = (data?.projects ?? []) as Array<{ slug?: string; path?: string }>;
    const match = projects.find((p) => p.slug === slug);
    if (match?.path) return match.path;
  } catch { /* fall through */ }
  // 2. Legacy file.
  const legacyPath = join(home, '.restart-harness-projects.json');
  if (existsSync(legacyPath)) {
    try {
      const data = JSON.parse(readFileSync(legacyPath, 'utf8'));
      const projects = (data?.projects ?? []) as Array<{ slug?: string; path?: string }>;
      const match = projects.find((p) => p.slug === slug);
      if (match?.path) return match.path;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * NEXT_ARCHITECT handler. Mirrors bash:
 *
 *   rest="${decision##NEXT_ARCHITECT }"
 *   fid="${rest%% *}"; reason="${rest#* }"
 *   invoke architect "FEATURE_ID=$fid" "REASON=$reason"
 *   verdict ← grep -E '^(PATCH|REVIEW) '
 *   case verdict:
 *     PATCH*  → set feature.status='todo' attempts=0 (worker retries)
 *     REVIEW* → set feature.status='blocked' + notify review-pending
 *     other   → log no actionable verdict
 */
async function handleNextArchitect(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  // Bash splits "NEXT_ARCHITECT F-001 some reason" into fid + reason. Our
  // parseDecision only captures the next token (F-001). Recover the reason
  // by looking at the raw line: anything after the first whitespace post-arg
  // is the reason.
  const fid = parsed.arg ?? '';
  if (!fid) {
    logger.log(`ERROR: NEXT_ARCHITECT without feature id: ${parsed.raw}`);
    return { terminal: true, exitCode: 4, reason: 'unparsable-decision' };
  }
  // Reason is everything after `<verb> <arg>` in the original raw text.
  // parseDecision only matched the verb + first arg token, but the agent
  // may have included more — try to pull it back from the source raw.
  const stripped = parsed.raw.replace(/^NEXT_ARCHITECT\s+\S+\s*/, '').trim();
  const reason = stripped || '(no reason given)';

  logger.log(`ARCHITECT ${fid} starting — reason: ${reason}`);
  // Ensure pending-reviews dir exists for the REVIEW path.
  const pendingDir = join(ctx.stateDir, 'pending-reviews');
  if (!existsSync(pendingDir)) {
    mkdirSync(pendingDir, { recursive: true });
  }

  let archOut = '';
  try {
    const r = await invoke(ctx, 'architect', [`FEATURE_ID=${fid}`, `REASON=${reason}`]);
    archOut = r.output;
  } catch (err) {
    logger.log(`ARCHITECT error: ${(err as Error).message}`);
  }

  // Find the verdict line (last "PATCH ..." or "REVIEW ..." in the output).
  const verdictMatch = archOut
    .split(/\r?\n/)
    .reverse()
    .find((line) => /^(PATCH|REVIEW)\s/.test(line.trim()));
  const verdict = verdictMatch?.trim() ?? '';
  logger.log(`ARCHITECT verdict: ${verdict || '(none)'}`);

  if (verdict.startsWith('PATCH')) {
    await setFeatureStatus(ctx.stateDir, fid, 'todo', { resetAttempts: true, ctx: stateCtx(ctx) });
    logger.log(`ARCHITECT patched spec for ${fid}; reset to todo.`);
  } else if (verdict.startsWith('REVIEW')) {
    await setFeatureStatus(ctx.stateDir, fid, 'blocked', { ctx: stateCtx(ctx) });
    logger.log(`ARCHITECT queued review for ${fid}; blocked until resolved.`);
    logger.notifyEvent('review-pending', `${fid} needs human input`);
  } else {
    logger.log(`ARCHITECT produced no actionable verdict; leaving ${fid} untouched.`);
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * Generic "invoke role + log" handler for the trivial decision branches.
 * Mirrors bash's pattern of `invoke <role> [args]; log "<ROLE>: ${out}"`.
 *
 * The role's output isn't post-processed here — the agent itself updates
 * any state files it needs to (e.g. validator writes a verdict to
 * features.json), and the next orchestrator turn observes those changes.
 */
async function handleSimpleInvoke(
  ctx: InvokeContext,
  logger: Logger,
  role: string,
  extras: readonly string[],
  startLog: string,
): Promise<DispatchResult> {
  logger.log(startLog);
  try {
    const r = await invoke(ctx, role, extras);
    logger.log(`${role.toUpperCase()}: ${(r.output || '').slice(0, 200) || '(no output)'}`);
  } catch (err) {
    logger.log(`${role} error: ${(err as Error).message}`);
  }
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/**
 * RUN_TESTS handler. Mirrors bash:
 *   if bin/run-tests.sh is executable: run it
 *   else: log skip
 */
function handleRunTests(ctx: InvokeContext, logger: Logger): DispatchResult {
  const script = `${ctx.harnessDir}/bin/run-tests.sh`;
  logger.log('RUN_TESTS invoked (testing phase)');
  if (!existsSync(script)) {
    logger.log('  (bin/run-tests.sh not implemented yet — skipping)');
    return { terminal: false, exitCode: 0, reason: 'idle' };
  }
  const result = spawnSync('bash', [script, ctx.projectDir], {
    cwd: ctx.projectDir,
    env: {
      ...process.env,
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
      HARNESS_DIR: ctx.harnessDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = result.stdout?.toString() ?? '';
  const stderr = result.stderr?.toString() ?? '';
  for (const line of [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]) {
    if (line.trim().length > 0) logger.log(line);
  }
  // G6 — POST <stateDir>/tests/*.json snapshot to operator. Mirrors
  // bash _post_test_snapshot. Best-effort.
  void postTestSnapshot({ stateDir: ctx.stateDir, phase: ctx.phase }).catch(() => {});
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

/** Run bin/service-smoke-test.sh synchronously. Returns the exit code. */
function runSmokeTest(ctx: InvokeContext, logger: Logger): number {
  const script = `${ctx.harnessDir}/bin/service-smoke-test.sh`;
  const result = spawnSync('bash', [script], {
    cwd: ctx.projectDir,
    env: {
      ...process.env,
      PROJECT_DIR: ctx.projectDir,
      STATE_DIR: ctx.stateDir,
      HARNESS_DIR: ctx.harnessDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) {
    for (const line of result.stdout.toString().split(/\r?\n/)) {
      if (line.trim().length > 0) logger.log(line);
    }
  }
  if (result.stderr) {
    for (const line of result.stderr.toString().split(/\r?\n/)) {
      if (line.trim().length > 0) logger.log(`  ${line}`);
    }
  }
  return result.status ?? 1;
}

// ─── Chunk-loop driver path (parallelWorkers.useChunkLoop=true) ─────

/**
 * Concrete LLM bridges that connect the worker-chunk-loop to the
 * existing `invoke()` machinery. The loop itself is dependency-injected
 * so this file is the only place that knows about both sides.
 *
 * High level: each chunk-loop callback (`plan`, `implement`, `replan`,
 * `escalate`) renders the appropriate prompt from chunk-plan.ts, feeds
 * it to `invoke(ctx, role, extras, { inlinePrompt, cwd })`, and
 * returns the agent's raw output. For `implement` we additionally
 * scan `git status --porcelain` in the scratch dir to discover which
 * files the LLM actually touched (reported back to the loop for
 * lock-extension decisions).
 */
async function handleChunkLoopWorker(
  fid: string,
  ctx: InvokeContext,
  logger: Logger,
  cfg: ReturnType<typeof readConfig>,
  lockQueue: FileLockQueue,
): Promise<DispatchResult> {
  // The chunk-loop worker model now lives in run-worker-chunk-loop.ts (shared
  // with the durable DBOS pipeline). This retired loop delegates to it. The
  // worker always reports idle/exit-0: the feature *status* set by the loop
  // (validating/failing) drives the next orchestrator turn, not an exit code.
  // P-040: runWorkerChunkLoop now takes a FileClaimCoordinator — wrap the retired
  // loop's in-process FileLockQueue (it has no cross-process PG backend).
  await runWorkerChunkLoop(fid, ctx, logger, cfg, new FileLockQueueCoordinator(lockQueue));
  return { terminal: false, exitCode: 0, reason: 'idle' };
}

// ─── Bash-parity handler for NEXT_SCOPER ──

/**
 * NEXT_SCOPER [phaseN] — re-invokes the scoper. With no arg, runs the
 * default phase1; with `phase2`, derives features from the prior phase's
 * outputs. Idempotent — re-running with no new finalizations is a no-op.
 *
 * Mirrors run.sh's NEXT_SCOPER handler (line 2734).
 */
async function handleNextScoper(
  parsed: ParsedDecision,
  ctx: InvokeContext,
  logger: Logger,
): Promise<DispatchResult> {
  const phase = parsed.arg ?? '';
  logger.log(`SCOPER starting${phase ? ` (phase=${phase})` : ''}`);
  try {
    const extras = phase ? [`SCOPER_PHASE=${phase}`] : [];
    await invoke(ctx, 'scoper', extras);
  } catch (err) {
    logger.log(`SCOPER error: ${(err as Error).message}`);
  }
  logger.log('SCOPER complete');
  return { terminal: false, exitCode: 0, reason: 'idle' };
}
