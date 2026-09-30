/**
 * Synthesizer step.
 *
 * Sits between workers and the validator in the multi-agent pipeline.
 * The synthesizer LLM receives N candidate implementations (lane diffs)
 * for a feature, plus the feature spec and project conventions, and
 * produces the final shipped tree inside a dedicated `<fid>-synthesis`
 * worktree. The validator then runs against that worktree as if it were
 * a normal single-branch feature — no special protocol on its side.
 *
 * N may be 1: in that case the synthesizer's job is to take a single
 * worker's draft across the finish line (polish, fix obvious bugs,
 * ship). Gated by `parallelWorkers.synthesizeSingle` (default true).
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configGet } from './config';
import { git } from './git';
import { invoke, type InvokeContext } from './invoke';
import { branchIsoBase, worktreePath } from './branch-iso';
import { runHook } from './hooks';
import { competitionManifestPath, type CompetitionManifest } from './lanes';
import { readFeatures, setFeatureStatus, stateCtx } from './state';
import type { HarnessConfig } from './types';

export interface SynthesisResult {
  synthesized: boolean;
  branch?: string;
  worktree?: string;
  reason?: string;
  /**
   * True when the synthesizer ran successfully but chose to ship a
   * candidate verbatim (zero code changes, but wrote the notes file).
   * Distinguishable from `synthesized: false` with no `approvedAsIs`,
   * which means the synthesizer skipped its job entirely.
   */
  approvedAsIs?: boolean;
}

/**
 * Whether single-worker dispatches go through synthesis. Default true —
 * synthesis-as-code-review even when only one candidate exists. Users
 * can flip to false to skip the extra LLM call on N=1.
 */
export function synthesizeSingle(cfg: HarnessConfig): boolean {
  const v = configGet<unknown>(cfg, 'parallelWorkers.synthesizeSingle', true);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return true;
}

/** Path to a feature's synthesis worktree. */
export function synthesisWorktreePath(stateDir: string, featureId: string): string {
  return join(stateDir, 'worktrees', `${featureId}-synthesis`);
}

/** Branch name for a feature's synthesis worktree. */
export function synthesisBranch(featureId: string): string {
  return `harness/${featureId}-synthesis`;
}

/** Path the synthesizer can write a per-feature explanatory note to. */
export function synthesisNotePath(stateDir: string, featureId: string): string {
  return join(stateDir, 'synthesis-notes', `${featureId}.md`);
}

/**
 * Build a synthetic 1-lane manifest from the worker's feature branch.
 * Used when synthesis runs on N=1 dispatches that didn't write a real
 * manifest. The lane branch is the standard `harness/<fid>` produced by
 * handleParallelLaneWorker / single-worker path.
 */
export function singleLaneManifest(
  stateDir: string,
  featureId: string,
): CompetitionManifest {
  return {
    parentFeatureId: featureId,
    n: 1,
    lanes: [
      {
        lane: 1,
        worktree: join(stateDir, 'worktrees', featureId),
        branch: `harness/${featureId}`,
      },
    ],
  };
}

interface SynthesisInputs {
  fid: string;
  manifest: CompetitionManifest;
  ctx: InvokeContext;
  cfg: HarnessConfig;
  log: (msg: string) => void;
}

/**
 * Create (or reuse) the synthesis worktree branched from base.
 * Idempotent — safe to call across retries.
 */
function ensureSynthesisWorktree(inputs: SynthesisInputs): { worktree: string; branch: string } {
  const { fid, ctx, cfg, log } = inputs;
  const base = branchIsoBase({
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log,
  });
  const worktree = synthesisWorktreePath(ctx.stateDir, fid);
  const branch = synthesisBranch(fid);
  mkdirSync(join(ctx.stateDir, 'worktrees'), { recursive: true });
  // Always start synthesis from a clean worktree. A leftover dir from a
  // crashed previous run would otherwise have stale files the
  // synthesizer's prompt assumes aren't there (the prompt frames the
  // worktree as starting from base).
  if (existsSync(worktree)) {
    git(['worktree', 'remove', '--force', worktree], { cwd: ctx.projectDir });
  }
  const r = git(['worktree', 'add', '-B', branch, worktree, base], {
    cwd: ctx.projectDir,
  });
  if (r.outputHead(3)) log(`  ${r.outputHead(3)}`);
  return { worktree, branch };
}

/**
 * Compute the diff between base and each candidate lane's branch.
 * Returned as a list of `{lane, branch, worktree, diff}` records the
 * synthesizer prompt enumerates.
 */
function buildLaneDiffs(
  inputs: SynthesisInputs,
): { lane: number; branch: string; worktree: string; diff: string }[] {
  const { ctx, cfg, manifest, log } = inputs;
  const base = branchIsoBase({
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log,
  });
  const out: { lane: number; branch: string; worktree: string; diff: string }[] = [];
  for (const lane of manifest.lanes) {
    const r = git(['diff', `${base}...${lane.branch}`], { cwd: ctx.projectDir });
    out.push({
      lane: lane.lane,
      branch: lane.branch,
      worktree: lane.worktree,
      diff: r.output,
    });
  }
  return out;
}

/**
 * Run the synthesizer role on a feature.
 *
 *  1. Create/reuse `<fid>-synthesis` worktree from base.
 *  2. Build lane-diff context (the LLM also has filesystem access to
 *     each lane worktree directly).
 *  3. Persist the manifest to disk so the synthesizer role can read it
 *     with the same shape competition mode used.
 *  4. Invoke the synthesizer role inside the synthesis worktree.
 *  5. Commit whatever the synthesizer left.
 *
 * Returns `{synthesized: true, branch, worktree}` on success. A failure
 * is "no commit was produced" or the LLM exited nonzero — caller is
 * responsible for falling back / marking the feature failing.
 */
export async function runSynthesizer(inputs: SynthesisInputs): Promise<SynthesisResult> {
  const { fid, manifest, ctx, log } = inputs;
  try {
    const { worktree, branch } = ensureSynthesisWorktree(inputs);

    // Persist the manifest so the synthesizer role's shell tools can
    // read it. Skips the write if the file already exists (real
    // competition path already wrote it; the synthetic-1-lane path
    // needs the write).
    const manifestPath = competitionManifestPath(ctx.stateDir, fid);
    if (!existsSync(manifestPath)) {
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    }

    // Pre-create the synthesis-notes dir so the synthesizer LLM's Write
    // tool can drop <fid>.md without first calling mkdir. Best-effort —
    // skipped silently if the dir already exists or can't be created.
    try {
      mkdirSync(join(ctx.stateDir, 'synthesis-notes'), { recursive: true });
    } catch {
      // ignore
    }

    const laneDiffs = buildLaneDiffs(inputs);
    log(`SYNTHESIZER: ${fid} starting (${manifest.n} candidate${manifest.n === 1 ? '' : 's'})`);

    // Surface lane metadata via env extras. The role prompt instructs the
    // LLM to enumerate $SYNTHESIS_LANES (JSON) and read each worktree.
    // Diffs themselves are not embedded — too long for env; the role
    // reads them from disk via `git diff` or reads the files directly.
    const lanesPayload = JSON.stringify(
      laneDiffs.map(({ lane, worktree: lwt, branch: lbr }) => ({
        lane,
        worktree: lwt,
        branch: lbr,
      })),
    );
    const extras = [
      `FEATURE_ID=${fid}`,
      `SYNTHESIS_LANE_COUNT=${String(manifest.n)}`,
      `SYNTHESIS_LANES=${lanesPayload}`,
      `SYNTHESIS_WORKTREE=${worktree}`,
      `SYNTHESIS_BRANCH=${branch}`,
      `SYNTHESIS_NOTE_PATH=${synthesisNotePath(ctx.stateDir, fid)}`,
    ];

    const synthCtx: InvokeContext = { ...ctx, worktreePathFor: () => worktree };
    let exitCode = 0;
    try {
      const r = await invoke(synthCtx, 'synthesizer', extras);
      exitCode = r.exitCode;
    } catch (err) {
      log(`SYNTHESIZER error: ${(err as Error).message}`);
      return { synthesized: false, reason: `invoke threw: ${(err as Error).message}` };
    }
    if (exitCode !== 0) {
      log(`SYNTHESIZER: ${fid} exited rc=${exitCode}`);
      return { synthesized: false, reason: `nonzero exit (${exitCode})` };
    }

    // Commit whatever the synthesizer left in the worktree. The prompt
    // tells the synthesizer it MUST write SYNTHESIS_NOTE_PATH even when
    // shipping a candidate verbatim — so we can distinguish:
    //   - notes file written, worktree empty → "approved as-is" (ship
    //     the worker's branch via branchIsoPostValidator).
    //   - notes file missing, worktree empty → real failure (synth
    //     skipped its job). Caller marks the feature failing.
    git(['add', '-A'], { cwd: worktree });
    const status = git(['diff', '--cached', '--quiet'], { cwd: worktree });
    if (status.exitCode === 0) {
      const notesPath = synthesisNotePath(ctx.stateDir, fid);
      if (existsSync(notesPath)) {
        log(`SYNTHESIZER_APPROVED: ${fid} accepted candidate verbatim (notes: ${notesPath})`);
        return {
          synthesized: false,
          approvedAsIs: true,
          reason: 'synthesizer approved candidate verbatim (no code changes needed)',
        };
      }
      log(`SYNTHESIZER_SKIPPED: ${fid} exited without writing any files or notes — treating as failure`);
      return {
        synthesized: false,
        reason: 'synthesizer skipped its job (empty worktree, no notes file)',
      };
    }
    const commit = git(
      [
        'commit',
        '--quiet',
        '-m',
        `synthesizer: ${fid} (from ${manifest.n} candidate${manifest.n === 1 ? '' : 's'})`,
      ],
      { cwd: worktree },
    );
    if (commit.outputHead(3)) log(`  ${commit.outputHead(3)}`);

    log(`SYNTHESIZER: ${fid} branch ${branch} ready for validation`);
    return { synthesized: true, branch, worktree };
  } catch (err) {
    log(`SYNTHESIZER fatal: ${(err as Error).message}`);
    return { synthesized: false, reason: (err as Error).message };
  }
}

/**
 * After-validator handling for the synthesizer path.
 *
 * Reads the (just-updated) feature status. On PASS, merges the synthesis
 * branch into base and drops every related worktree (synthesis + each
 * lane). On non-PASS, drops every worktree without merging — feature
 * stays `failing` and the orchestrator decides next move on the next
 * iteration. Either way, the post-state is "no leftover worktrees for
 * this feature."
 */
export async function handleSynthesisOutcome(
  fid: string,
  synthBranch: string,
  synthWorktree: string,
  laneCount: number,
  ctx: InvokeContext,
  log: (msg: string) => void,
  cfg: HarnessConfig,
  closeTelemetry?: (outcome: 'pass' | 'fail') => void,
): Promise<void> {
  let status = '';
  for (const f of await readFeatures(ctx.stateDir, stateCtx(ctx))) {
    if (f.id === fid) {
      status = f.status;
      break;
    }
  }

  const branchIsoCtx = {
    cfg,
    projectDir: ctx.projectDir,
    stateDir: ctx.stateDir,
    log,
  };
  const base = branchIsoBase(branchIsoCtx);

  // Tracks whether the synthesis branch was successfully merged into
  // base. On true, the synth worktree + branch are dropped in cleanup.
  // On false (validator failed, or merge-conflict-revert, or
  // checkout-failed), the synth branch + worktree are preserved so the
  // next NEXT_WORKER round can branch off it and iterate on the prior
  // attempt with knowledge of why it failed.
  let mergedSuccessfully = false;

  // Helper: handle a failed checkout/merge by reverting feature to
  // 'failing' so the orchestrator retries with a fresh round.
  // The synth branch is preserved (see cleanup below) so the retry
  // starts from the prior attempt's HEAD, not from base.
  const revertOnMergeFail = async (reason: string): Promise<void> => {
    log(`SYNTHESIZER: ${fid} ${reason} — reverting to 'failing' for retry`);
    await setFeatureStatus(ctx.stateDir, fid, 'failing', { ctx: stateCtx(ctx) });
    // Bug P: telemetry must reflect the actual outcome. The validator-side
    // transition loop suppresses the 'pass' close for synthesis-eligible
    // features, so we own closing the row.
    if (closeTelemetry) closeTelemetry('fail');
  };

  if (status === 'passed') {
    log(`SYNTHESIZER: ${fid} validator passed → merging ${synthBranch}`);
    const checkout = git(['checkout', base], { cwd: ctx.projectDir });
    if (checkout.exitCode !== 0) {
      if (checkout.outputHead(5)) log(`  ${checkout.outputHead(5)}`);
      await revertOnMergeFail(`checkout ${base} failed (rc=${checkout.exitCode})`);
      // Fall through to cleanup below (drop synth + lane worktrees).
    } else {
      const merge = git(
        ['merge', '--no-ff', synthBranch, '-m', `synthesizer winner: ${fid}`],
        { cwd: ctx.projectDir },
      );
      if (merge.exitCode !== 0) {
        if (merge.outputHead(10)) log(`  ${merge.outputHead(10)}`);
        git(['merge', '--abort'], { cwd: ctx.projectDir });
        await revertOnMergeFail(`merge of ${synthBranch} failed (rc=${merge.exitCode})`);
        // Fall through to cleanup.
      } else {
        if (merge.outputHead(5)) log(`  ${merge.outputHead(5)}`);
        runHook('on-synthesis-won', {
          stateDir: ctx.stateDir,
          projectDir: ctx.projectDir,
          logDir: ctx.logDir,
          env: {
            FEATURE_ID: fid,
            SYNTH_BRANCH: synthBranch,
            LANE_COUNT: String(laneCount),
            PROJECT_DIR: ctx.projectDir,
            STATE_DIR: ctx.stateDir,
          },
          log,
        });
        // Bug P: fire 'pass' telemetry only after merge actually lands.
        if (closeTelemetry) closeTelemetry('pass');
        mergedSuccessfully = true;
      }
    }
  } else {
    log(
      `SYNTHESIZER: ${fid} validator did not pass (status=${status || '?'}) → keeping synth branch for retry`,
    );
  }

  if (mergedSuccessfully) {
    // PASS path: synth content is merged into base. Drop the worktree
    // + branch — they have no further use. Also clear the
    // last-validator-out pointer so a future feature with the same id
    // (rare, but possible in re-imports) doesn't read a stale path.
    git(['worktree', 'remove', '--force', synthWorktree], { cwd: ctx.projectDir });
    git(['branch', '-D', synthBranch], { cwd: ctx.projectDir });
    try {
      unlinkSync(join(ctx.stateDir, 'last-validator-out', `${fid}.path`));
    } catch { /* best-effort */ }
  } else {
    // FAIL / revert / validator-rejected: preserve `harness/<fid>-synthesis`
    // + its worktree. The next NEXT_WORKER round will branch lanes off
    // this branch (see handleMultiWorker / branchIsoPreWorker) so the
    // retry starts from the prior attempt's HEAD, with knowledge of the
    // validator's rejection notes (PRIOR_VALIDATOR_LOG env extra).
    log(`  preserved ${synthBranch} at ${synthWorktree} for next round`);
  }

  // Drop each lane worktree + branch — the per-lane drafts have done
  // their job (synth read their diffs). For the synthetic 1-lane case
  // (single-worker synthesis), the lane "is" the feature's own branch.
  if (laneCount > 1) {
    for (let i = 1; i <= laneCount; i++) {
      const wt = join(ctx.stateDir, 'worktrees', `${fid}-lane-${i}`);
      const br = `harness/${fid}-lane-${i}`;
      if (existsSync(wt)) {
        git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
      }
      git(['branch', '-D', br], { cwd: ctx.projectDir });
    }
  } else {
    const wt = worktreePath(ctx.stateDir, fid);
    const br = `harness/${fid}`;
    if (existsSync(wt)) {
      git(['worktree', 'remove', '--force', wt], { cwd: ctx.projectDir });
    }
    git(['branch', '-D', br], { cwd: ctx.projectDir });
  }

  // Remove any stale manifest (should already be gone if synth ran).
  try {
    unlinkSync(competitionManifestPath(ctx.stateDir, fid));
  } catch {
    // ignore
  }
}
