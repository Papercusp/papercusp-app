/**
 * Pre-main-loop initialization. Mirrors bash run.sh's:
 *
 *   Step 1   — invoke scoper MODE=initial when no features exist yet
 *              (fresh-mission setup; plan-based harnesses gate on PG features)
 *   Step 1.5 — invoke reviewer MODE=plan to challenge scoper output;
 *              exit 7 on VERDICT: reject (the formerly-aliased name 'plan-gate'
 *              works via ROLE_ALIASES — see prompt-resolve.ts)
 *   Step 2   — ensure-docs.sh scaffold
 *   Step 3   — post-planner auto-checkpoints (per config.checkpoints.types)
 *   Step 4   — git worktree prune (when branchIsolation.useWorktrees)
 *
 * NOT yet ported (Stage 5b deferred):
 *   - SQL feature import (features.json → harness_<slug>.harness_features in
 *     Postgres). The bash run.sh still does this; TS path leaves it for
 *     bash to re-do on cutover. Most coding harnesses don't care because
 *     features.json on disk is the source of truth at runtime; SQL is an
 *     observability/cross-harness query layer.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { configGet } from './config';
import { featuresExist, harnessSlug, stateCtx } from './state';
import { invoke } from './invoke';
import { runHook } from './hooks';
import { git } from './git';
import type { InvokeContext } from './invoke';
import type { Logger } from './log';
import type { HarnessConfig } from './types';

export interface PreLoopResult {
  /** Reason the pre-loop signaled "stop here, exit". null if loop should run. */
  stop: 'plan-rejected' | 'auto-checkpoint' | 'scoper-failed' | null;
  /** Bash-equivalent exit code if stop is set. */
  exitCode: number;
}

/** Runs every step before the main while loop. Returns stop signal or null. */
export async function runPreLoop(
  ctx: InvokeContext,
  logger: Logger,
  cfg: HarnessConfig,
): Promise<PreLoopResult> {
  // Step 1: PLAN — invoke scoper if mission state is fresh.
  const planNeeded = !(await featuresExist(ctx.stateDir, stateCtx(ctx)));
  if (planNeeded) {
    logger.log('PLAN: no features found. Invoking scoper (initial mode).');
    try {
      const out = await invoke(ctx, 'scoper', ['MODE=initial']);
      // bash: echo "$plan_out" | tail -3 | tee -a run.log
      const tail = out.output.split(/\r?\n/).filter((l) => l).slice(-3);
      for (const line of tail) logger.log(line);
    } catch (err) {
      logger.log(`SCOPER error: ${(err as Error).message}`);
    }
    if (!(await featuresExist(ctx.stateDir, stateCtx(ctx)))) {
      logger.log(`ERROR: scoper did not produce features. See ${ctx.logDir}.`);
      return { stop: 'scoper-failed', exitCode: 2 };
    }
  } else {
    logger.log('PLAN: existing contract + features found. Skipping scoper.');
  }

  // Step 1.5: REVIEWER — challenge the scoper output (idempotent: skips
  // if plan-review.md already exists). One canonical name now: `reviewer`.
  const planReviewPath = join(ctx.stateDir, 'plan-review.md');
  const planGateEnabled = configGet<boolean>(cfg, 'planReviewer.enabled', true);
  if (planGateEnabled === true && !existsSync(planReviewPath)) {
    logger.log('REVIEWER: challenging scoper output (MODE=plan)');
    try {
      await invoke(ctx, 'reviewer', ['MODE=plan']);
    } catch (err) {
      logger.log(`REVIEWER error: ${(err as Error).message}`);
    }
    if (existsSync(planReviewPath)) {
      const body = readFileSync(planReviewPath, 'utf8');
      const verdictLine = body
        .split(/\r?\n/)
        .filter((l) => /^VERDICT:/i.test(l))
        .pop() ?? '';
      logger.log(`PLAN-GATE: ${verdictLine || 'no verdict line found'}`);
      if (/reject/i.test(verdictLine)) {
        logger.log('⛔ Plan-gate rejected — writing escalation and exiting 7.');
        const escalationBody =
          '# Plan-gate rejected the plan\n\n' +
          'See .papercusp/plan-review.md for details.\n';
        if (ctx.pg && ctx.workspaceId) {
          const { setEscalationPg } = await import('./mission-state-pg');
          await setEscalationPg(
            { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: harnessSlug(ctx.projectDir) },
            escalationBody,
            ctx.phase,
          );
        } else {
          logger.log('No PG context — escalation not persisted. Body: ' + escalationBody.trim());
        }
        logger.notifyEvent('escalate', 'Plan-gate rejected the scoper output');
        return { stop: 'plan-rejected', exitCode: 7 };
      }
    } else {
      logger.log('PLAN-GATE: no plan-review.md produced, continuing without gate');
    }
  }

  // Step 2: ensure-docs.sh scaffold.
  const ensureDocsScript = join(ctx.harnessDir, 'bin', 'ensure-docs.sh');
  if (existsSync(ensureDocsScript)) {
    const r = spawnSync('bash', [ensureDocsScript, ctx.projectDir], {
      cwd: ctx.projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if ((r.status ?? 1) !== 0) {
      logger.log('WARN: ensure-docs.sh failed (non-fatal)');
    }
  }

  // Step 3: post-planner auto-checkpoints.
  const cpStop = await firePostPlannerCheckpoints(ctx, logger, cfg);
  if (cpStop) return cpStop;

  // Step 4: prune stale worktrees from prior crashes.
  if (configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true) {
    const r = git(['worktree', 'prune'], { cwd: ctx.projectDir });
    if (r.outputHead(3)) logger.log(`  ${r.outputHead(3)}`);
  }

  return { stop: null, exitCode: 0 };
}

/** Inspect config.checkpoints.types[].triggerOn=='post-planner' and fire any
 *  that haven't fired yet. Returns a stop signal if one was fired. */
async function firePostPlannerCheckpoints(
  ctx: InvokeContext,
  logger: Logger,
  cfg: HarnessConfig,
): Promise<PreLoopResult | null> {
  if (configGet<boolean>(cfg, 'checkpoints.enabled', false) !== true) return null;
  const types = configGet<unknown>(cfg, 'checkpoints.types', []);
  if (!Array.isArray(types)) return null;
  const postPlannerNames = types
    .filter((t): t is { name?: string; triggerOn?: string } => typeof t === 'object' && t !== null)
    .filter((t) => t.triggerOn === 'post-planner')
    .map((t) => t.name)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);

  const usePg = ctx.pg && ctx.workspaceId;

  for (const name of postPlannerNames) {
    const cpFile = join(ctx.stateDir, `checkpoint-${name}.md`);
    const isoNow = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const body =
      `# Checkpoint: ${name} (auto, triggerOn=post-planner)\n\n` +
      `Requested at: ${isoNow}\n` +
      `Trigger: scoper + reviewer both passed for the first time.\n\n` +
      'Review the plan via the harness UI (Plans tab → Inbox).\n\n' +
      '## How to grant\n' +
      `- UI: /api/harness/<slug>/checkpoint/${name}/grant\n` +
      `- CLI: touch ${cpFile}.granted && re-run the harness\n`;

    let actuallyFired: boolean;
    if (usePg) {
      const { fireCheckpointPg } = await import('./checkpoints-pg');
      actuallyFired = await fireCheckpointPg(
        { pg: ctx.pg!, workspaceId: ctx.workspaceId!, harnessSlug: harnessSlug(ctx.projectDir) },
        name,
        body,
      );
    } else {
      const sentinel = join(ctx.stateDir, `.checkpoint-${name}.fired`);
      if (existsSync(sentinel) || existsSync(cpFile) || existsSync(`${cpFile}.granted`)) {
        continue;
      }
      mkdirSync(ctx.stateDir, { recursive: true });
      writeFileSync(cpFile, body);
      writeFileSync(sentinel, '');
      actuallyFired = true;
    }
    if (!actuallyFired) continue;

    logger.log(`⏸  Auto-fired checkpoint: ${name} (post-planner). Exiting 8.`);
    runHook('on-checkpoint-fired', {
      stateDir: ctx.stateDir,
      projectDir: ctx.projectDir,
      logDir: ctx.logDir,
      env: {
        CHECKPOINT_NAME: name,
        TRIGGER: 'post-planner',
        PROJECT_DIR: ctx.projectDir,
        STATE_DIR: ctx.stateDir,
      },
      log: logger.log,
    });
    logger.notifyEvent('checkpoint', `Auto checkpoint: ${name}`);
    return { stop: 'auto-checkpoint', exitCode: 8 };
  }
  return null;
}
