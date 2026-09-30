/**
 * Branch-isolation subsystem. Replaces bash's branch_iso_* + worktree_*
 * functions in run.sh.
 *
 * Two modes:
 *   - branch isolation (no worktrees): each feature runs on its own
 *     `harness/<fid>` branch in the main project dir. The worker's edits
 *     get committed there, validator switches back to base after, etc.
 *   - branch isolation + worktrees: each feature runs in a sibling git
 *     worktree at `<stateDir>/worktrees/<fid>`. Allows parallel workers
 *     without git checkout conflicts. Composio-inspired.
 *
 * The pre-/post- functions do nothing when `branchIsolation.enabled` is
 * false — same as bash. Callers can invoke them unconditionally without
 * checking the config first.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { configGet } from './config';
import { branchExists, git, hasStagedChanges } from './git';
import { useChunkLoop } from './lanes';
import { readFeatures, setFeatureStatus, type StateContext } from './state';
import type { HarnessConfig } from './types';

export interface BranchIsoCtx {
  cfg: HarnessConfig;
  projectDir: string;
  stateDir: string;
  log: (message: string) => void;
}

export function branchIsoEnabled(cfg: HarnessConfig): boolean {
  // Chunk-loop manages locking + commits at a finer granularity (per
  // chunk, not per feature) and pushes straight to the integration
  // branch, so per-feature branches and worktrees are bypassed
  // entirely. Use the canonical useChunkLoop() helper (lanes.ts) so
  // the default value stays in one place.
  if (useChunkLoop(cfg)) return false;
  return configGet<boolean>(cfg, 'branchIsolation.enabled', false) === true;
}

export function worktreeEnabled(cfg: HarnessConfig): boolean {
  return (
    branchIsoEnabled(cfg) &&
    configGet<boolean>(cfg, 'branchIsolation.useWorktrees', false) === true
  );
}

/** Path to the per-feature worktree dir. */
export function worktreePath(stateDir: string, featureId: string): string {
  return join(stateDir, 'worktrees', featureId);
}

/**
 * Resolve the base branch. Honors `branchIsolation.baseBranch` config; if
 * absent, auto-detects `main` then `master`, defaulting to `main`.
 */
export function branchIsoBase(ctx: BranchIsoCtx): string {
  const fromCfg = configGet<string>(ctx.cfg, 'branchIsolation.baseBranch', '');
  if (fromCfg) return fromCfg;
  const opts = { cwd: ctx.projectDir };
  if (branchExists('main', opts)) return 'main';
  if (branchExists('master', opts)) return 'master';
  return 'main';
}

/** Pre-worker: create branch (or worktree) for the feature. */
export function branchIsoPreWorker(ctx: BranchIsoCtx, featureId: string): void {
  if (!branchIsoEnabled(ctx.cfg)) return;
  const opts = { cwd: ctx.projectDir };
  const base = branchIsoBase(ctx);

  if (worktreeEnabled(ctx.cfg)) {
    const wt = worktreePath(ctx.stateDir, featureId);
    const br = `harness/${featureId}`;
    mkdirSync(join(ctx.stateDir, 'worktrees'), { recursive: true });
    if (existsSync(wt)) {
      ctx.log(`  worktree: ${wt} already exists (worker retry)`);
      return;
    }
    // If a preserved synth branch exists from a prior round (validator
    // rejected the synthesized output, but we kept the branch), start
    // this worker FROM that branch instead of base. Worker iterates on
    // the prior rejected code with knowledge of why it was rejected
    // (PRIOR_VALIDATOR_LOG env extra at dispatch time).
    const synthBr = `harness/${featureId}-synthesis`;
    const workerBase = branchExists(synthBr, opts) ? synthBr : base;
    if (workerBase !== base) {
      ctx.log(`  worktree: retry off ${synthBr}`);
    }
    const r = git(['worktree', 'add', '-B', br, wt, workerBase], opts);
    if (r.outputHead(3)) ctx.log(`  ${r.outputHead(3)}`);
    // Mode 0700 on the worktree root — pairs with .mcp.json mode 0600
    // to harden against sibling-spawn URL theft. Same-UID access is
    // unaffected; this is a no-op until workers run under different
    // UIDs (bwrap/firejail). See apps/operator/docs/spawn-signing-threat-model.md.
    try { chmodSync(wt, 0o700); } catch { /* best-effort */ }
    ctx.log(`  worktree: lane ${wt} (branch ${br}, off ${base})`);
    return;
  }

  // No worktrees — checkout/create the feature branch in-place.
  const br = `harness/${featureId}`;
  let r = git(['checkout', '-B', br, base], opts);
  if (r.exitCode !== 0) {
    r = git(['checkout', '-B', br], opts);
  }
  ctx.log(`  branch-iso: worker on ${br} (off ${base})`);
}

/** Post-worker: commit any staged changes on the feature branch / worktree. */
export function branchIsoPostWorker(ctx: BranchIsoCtx, featureId: string): void {
  if (!branchIsoEnabled(ctx.cfg)) return;
  const cwd = worktreeEnabled(ctx.cfg)
    ? worktreePath(ctx.stateDir, featureId)
    : ctx.projectDir;
  if (!existsSync(cwd)) return;
  const opts = { cwd };
  git(['add', '-A'], opts);
  if (!hasStagedChanges(opts)) return;
  const r = git(['commit', '--quiet', '-m', `worker: ${featureId}`], opts);
  if (r.outputHead(3)) ctx.log(`  ${r.outputHead(3)}`);
}

/**
 * Pre-validator: in worktree mode, just log which worktree the validator
 * will see. In branch-mode, switch to the feature branch.
 */
export function branchIsoPreValidator(
  ctx: BranchIsoCtx,
  featureId: string,
): void {
  if (!branchIsoEnabled(ctx.cfg)) return;
  if (worktreeEnabled(ctx.cfg)) {
    const wt = worktreePath(ctx.stateDir, featureId);
    if (existsSync(wt)) {
      ctx.log(`  worktree: validator on ${wt}`);
    } else {
      ctx.log(
        `  worktree: validator — no worktree for ${featureId} (falling through to main tree)`,
      );
    }
    return;
  }
  const br = `harness/${featureId}`;
  const r = git(['checkout', br], { cwd: ctx.projectDir });
  if (r.exitCode === 0) {
    ctx.log(`  branch-iso: validator on ${br}`);
  } else {
    ctx.log(`  branch-iso: branch ${br} not found (validator will use current)`);
  }
}

/**
 * Post-validator: on PASS, merge/PR/keep per `branchIsolation.onPass`.
 * On FAIL, leave the worktree/branch in place so the worker can retry.
 *
 * Reads the feature's status via the state context (PG canonical;
 * in-memory in tests). Caller is expected to have updated status via
 * setFeatureStatus before calling.
 */
export async function branchIsoPostValidator(
  ctx: BranchIsoCtx,
  featureId: string,
  stateContext: StateContext,
): Promise<void> {
  if (!branchIsoEnabled(ctx.cfg)) return;

  // Skip merge/PR work on FAIL. Read status from the canonical store.
  const features = await readFeatures(ctx.stateDir, stateContext);
  const f = features.find((x) => x.id === featureId);
  const status = f?.status ?? '';
  if (status !== 'passed') return;

  const base = branchIsoBase(ctx);
  const br = `harness/${featureId}`;
  const onPass = configGet<string>(ctx.cfg, 'branchIsolation.onPass', 'merge');

  if (worktreeEnabled(ctx.cfg)) {
    const wt = worktreePath(ctx.stateDir, featureId);
    if (!existsSync(wt)) return;
    if (onPass === 'merge') {
      git(['checkout', base], { cwd: ctx.projectDir });
      git(
        ['merge', '--no-ff', br, '-m', `merge harness/${featureId}`],
        { cwd: ctx.projectDir },
      );
      git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
      git(['branch', '-D', br], { cwd: ctx.projectDir });
      ctx.log(`  worktree: merged ${br} into ${base}; removed ${wt}`);
    } else if (onPass === 'keep') {
      ctx.log(`  worktree: onPass=keep; ${wt} retained on branch ${br}`);
    } else if (onPass === 'pr') {
      // Push + open PR via gh.
      git(['push', '-u', 'origin', br], { cwd: wt });
      const ghCheck = spawnGh(['--version'], ctx.projectDir);
      if (ghCheck === 0) {
        spawnGh(
          [
            'pr',
            'create',
            '--head',
            br,
            '--base',
            base,
            '--title',
            `harness: ${featureId}`,
            '--body',
            'Autogenerated by harness.',
          ],
          ctx.projectDir,
        );
        git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
      } else {
        ctx.log(`  worktree: onPass=pr but gh not found — leaving ${wt} in place`);
      }
    }
    return;
  }

  // Branch mode (no worktrees).
  if (onPass === 'merge') {
    git(['checkout', base], { cwd: ctx.projectDir });
    git(['merge', '--no-ff', br, '-m', `merge harness/${featureId}`], {
      cwd: ctx.projectDir,
    });
    git(['branch', '-D', br], { cwd: ctx.projectDir });
    ctx.log(`  branch-iso: merged ${br} into ${base}`);
  } else {
    ctx.log(`  branch-iso: onPass=${onPass}; leaving ${br} in place`);
  }
}

/** Discard a worktree (used when feature is reset to todo). */
export function worktreeReset(ctx: BranchIsoCtx, featureId: string): void {
  if (!worktreeEnabled(ctx.cfg)) return;
  const wt = worktreePath(ctx.stateDir, featureId);
  if (!existsSync(wt)) return;
  git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
  git(['branch', '-D', `harness/${featureId}`], { cwd: ctx.projectDir });
  ctx.log(`  worktree: reset removed ${wt}`);
}

// Tiny gh wrapper. Lives here rather than in git.ts because it's only used by
// the PR mode of branchIsoPostValidator — can be promoted to its own module
// when the auto-updater work needs gh too.
function spawnGh(args: readonly string[], cwd: string): number {
  const r = spawnSync('gh', args, { cwd, stdio: 'ignore' });
  return r.status ?? 127;
}

// Re-export the no-op state setter to keep imports tidy in main-loop.ts.
// (Avoids a top-level `export { setFeatureStatus }` that'd conflict with
// the index re-export.)
export { setFeatureStatus };
