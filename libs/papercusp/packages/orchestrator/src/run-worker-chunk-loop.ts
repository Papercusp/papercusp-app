/**
 * The chunk-loop worker — extracted as the SHARED canonical worker model so
 * BOTH the durable DBOS pipeline (via `bin/invoke-once`) and the (retired)
 * `main-loop.ts` run it through the same code. Previously this logic lived only
 * in `main-loop.ts:handleChunkLoopWorker`, so the DBOS pipeline's worker step
 * silently fell back to a bare single-shot `invoke('worker')` and lost the
 * canonical model entirely (up-front chunk planning, per-chunk file locks, the
 * L1 typecheck gate, replan-strikes, escalate-to-debugger). dbos-durable-jobs
 * 2026-05-31 #2 closes that gap.
 *
 * `main-loop.ts:handleChunkLoopWorker` now delegates here; when that retired
 * file is deleted this module is the sole home.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { InvokeContext } from './invoke.js';
import type { Logger } from './log.js';
import type { HarnessConfig } from './types';
import type { FileClaimCoordinator } from '@papercusp/file-claim';
import { invoke } from './invoke.js';
import { readFeatures, stateCtx, setFeatureStatus, harnessSlug } from './state.js';
import { configGet } from './config.js';
import { CACHE_SYMLINKS } from './scratch-env.js';
import { driveChunkLoop } from './chunk-loop-driver.js';
import { planChunksUpfrontPrompt, replanChunkPrompt } from './chunk-plan.js';
import type {
  ChunkLoopFeature,
  ChunkImplementResult,
  ChunkLoopOutcome,
} from './worker-chunk-loop.js';

/**
 * Deprecated compatibility shim. Normal invoke paths no longer route through
 * the internal chunk loop; this always selects ordinary single-shot worker
 * invocation even when a stale harness config still carries the old knob.
 */
export function shouldUseWorkerChunkLoop(_role: string, _cfg: HarnessConfig): boolean {
  return false;
}

/** Resolve the harness slug for chunk-plan PG persistence: explicit config.slug
 * wins, else the durable pipeline's `HARNESS_SLUG` env (always set by the DBOS
 * runner), else the registry/basename fallback. */
function resolveSlug(ctx: InvokeContext, cfg: HarnessConfig): string | undefined {
  return (
    (configGet<string>(cfg, 'slug', '') ||
      process.env.HARNESS_SLUG ||
      process.env.PAPERCUSP_HARNESS_SLUG ||
      harnessSlug(ctx.projectDir)) || undefined
  );
}

/** Pointer file `<stateDir>/last-validator-out/<fid>.path` → the validator's
 * last `.out` file (retry context). Null when absent/dangling. */
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
 * Zero-byte files the fleet sandbox leaves behind in a spawn's cwd (mount-point
 * artifacts of claude's protected-file masking — see healSandboxZeroByteManifest
 * in invoke.ts). When the implement spawn runs INSIDE the scratch worktree these
 * appear as untracked entries, get mistaken for worker-touched files, and poison
 * the chunk's `files[]` → the commit copyFile()s them into the real repo (or
 * EISDIR-aborts on the `node_modules/` dir — live on frame 138805161,
 * 2026-06-09). Only a ZERO-BYTE file with one of these names is skipped; a
 * worker-authored non-empty file keeps flowing through.
 */
const SANDBOX_MASK_ARTIFACTS = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bunfig.toml',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.gitmodules',
]);
function isSandboxMaskArtifact(dir: string, rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  if (!SANDBOX_MASK_ARTIFACTS.has(base) && !base.startsWith('.env')) return false;
  try {
    const st = statSync(join(dir, rel));
    return st.isFile() && st.size === 0;
  } catch {
    return false;
  }
}

/**
 * Walk `git status --porcelain` in the scratch dir to find every file the worker
 * wrote (modified, added, or deleted). Returns paths relative to the scratch dir
 * (= relative to the main repo). Untracked DIRECTORIES (porcelain `?? name/`,
 * e.g. the sandbox's `node_modules/` / `.claude/` artifacts) and the sandbox's
 * zero-byte mask files are excluded — they are not worker edits, and a directory
 * in `files[]` EISDIR-aborts the chunk commit.
 */
function listChangedFiles(dir: string): string[] {
  const r = spawnSync('git', ['status', '--porcelain', '-z'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) return [];
  const cacheNames = new Set<string>(CACHE_SYMLINKS);
  const out: string[] = [];
  for (const entry of (r.stdout as string).split('\x00')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const path = trimmed.length >= 3 ? trimmed.slice(3) : trimmed;
    if (!path) continue;
    if (path.endsWith('/')) continue; // untracked directory — never a worker file edit
    // setup()'s own cache SYMLINKS (node_modules, dist, …) show as untracked
    // FILE entries (no trailing slash) in a repo that doesn't gitignore them —
    // they are scratch infrastructure, never worker edits.
    if (cacheNames.has(path)) continue;
    if (isSandboxMaskArtifact(dir, path)) continue;
    out.push(path);
  }
  return out;
}

/**
 * Build the inline prompt for the worker's per-chunk implement call. The worker
 * sees: feature context, chunk metadata, the scratch dir it should edit in, and
 * clear instructions about the L1 invariant and declared-files contract.
 */
function chunkImplementInlinePrompt(
  feature: ChunkLoopFeature,
  chunk: { id: string; files: readonly string[]; description: string },
  scratchDir: string,
  retry?: { priorValidatorLog: string },
): string {
  const retryBanner = retry
    ? `

⚠️  Retry round — this feature was previously implemented and the
validator REJECTED that attempt. The planner has decomposed the fix
into chunks; your chunk targets part of the validator's complaints.
The relevant validator output is below for context — focus on your
declared files, but use this to understand WHY the change is needed
rather than treating the chunk description as the only signal.

Validator output (verbatim, first 4KB):
\`\`\`
${retry.priorValidatorLog.slice(0, 4096)}${retry.priorValidatorLog.length > 4096 ? '\n…(truncated)' : ''}
\`\`\`
`
    : '';

  return `You are the WORKER. Implement ONE chunk of feature ${feature.id}.

Feature: ${feature.title}
${feature.description}
${retryBanner}
Chunk ${chunk.id}: ${chunk.description}
Declared files: ${chunk.files.join(', ')}

Working directory: ${scratchDir}

This is a transient scratch worktree at integration HEAD. Edit files
here in place — do NOT cd out, do NOT touch the main repo. Heavy
gitignored caches (node_modules, .next, target, etc.) are symlinked
back to the main repo so typecheckers see warm caches.

Constraints:
  - Modify ONLY the declared files. If you discover you need to touch
    additional files, you may — the harness handles lock extension —
    but be intentional about scope.
  - The chunk you commit must leave the project in a working state:
    the typecheck command will run after you finish, and a non-zero
    exit triggers a re-plan that bundles more work into this chunk.
  - When done, exit. The harness will copy your edits to the main
    repo, run the typecheck, and commit.

Do not produce a chunk-plan block — that was already done in the
planning stage. Just implement.`;
}

/**
 * Run the worker chunk loop for one feature. Loads the feature record, marks it
 * `in_progress`, threads any prior-validator retry context, drives the chunk loop
 * (plan → per-chunk implement + L1 typecheck gate + replan-strikes → escalate),
 * and sets the terminal feature status (`completed`→`validating`, otherwise
 * `failing`). Returns the driver outcome; the caller maps it to an exit code
 * (always 0 — the feature *status* drives the next orchestrator turn, not the
 * worker's exit code, matching the legacy loop).
 */
export async function runWorkerChunkLoop(
  fid: string,
  ctx: InvokeContext,
  logger: Logger,
  cfg: HarnessConfig,
  lockCoordinator: FileClaimCoordinator,
): Promise<ChunkLoopOutcome> {
  const features = await readFeatures(ctx.stateDir, stateCtx(ctx)).catch(() => []);
  const fRow = features.find((f: { id: string }) => f.id === fid);
  const feature: ChunkLoopFeature = {
    id: fid,
    title: (fRow?.title as string) ?? fid,
    description: (fRow?.summary as string) ?? `Feature ${fid}`,
    context: typeof fRow?.notes === 'string' ? (fRow.notes as string) : undefined,
  };

  logger.log(`CHUNK_LOOP starting for ${fid}`);
  await setFeatureStatus(ctx.stateDir, fid, 'in_progress', { bumpAttempts: true, ctx: stateCtx(ctx) });

  // Retry context from a prior validator rejection: the validator log + the
  // files the prior all-committed plan touched (so the planner targets the
  // complaints rather than re-implementing from scratch).
  const slug = resolveSlug(ctx, cfg);
  const priorLogPath = priorValidatorLogPath(ctx.stateDir, fid);
  let retryContext: { priorValidatorLog: string; priorFiles: string[] } | undefined;
  if (priorLogPath) {
    try {
      const body = readFileSync(priorLogPath, 'utf8');
      let priorFiles: string[] = [];
      if (ctx.pg && ctx.workspaceId && slug) {
        try {
          const { readPlan } = await import('./chunk-plan-pg.js');
          const existing = await readPlan({ pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: slug }, fid);
          const fileSet = new Set<string>();
          for (const row of existing) for (const f of row.files) fileSet.add(f);
          priorFiles = [...fileSet].sort();
        } catch {
          /* best-effort */
        }
      }
      retryContext = { priorValidatorLog: body, priorFiles };
      logger.log(
        `CHUNK_LOOP: retry detected for ${fid} — prior validator output ${body.length} chars; ${priorFiles.length} files touched on prior attempt`,
      );
    } catch {
      /* pointer pointed at a missing file — first attempt path */
    }
  }

  const outcome = await driveChunkLoop({
    feature,
    cfg,
    lockCoordinator,
    repoPath: ctx.projectDir,
    pg: ctx.pg,
    workspaceId: ctx.workspaceId,
    harnessSlug: slug,
    retryContext,
    log: (msg) => logger.log(msg),
    llm: {
      plan: async (f, retry, parseFeedback) => {
        const promptText = planChunksUpfrontPrompt({
          featureId: f.id,
          featureTitle: f.title,
          featureDescription: f.description,
          context: f.context,
          priorValidatorLog: retry?.priorValidatorLog,
          priorFiles: retry?.priorFiles,
          parseFeedback,
        });
        const result = await invoke(ctx, 'worker', [`FEATURE_ID=${f.id}`, 'CHUNK_LOOP_STAGE=plan'], {
          inlinePrompt: promptText,
        });
        return result.output;
      },
      implement: async (f, chunk, env): Promise<ChunkImplementResult> => {
        const result = await invoke(
          ctx,
          'worker',
          [
            `FEATURE_ID=${f.id}`,
            `CHUNK_ID=${chunk.id}`,
            'CHUNK_LOOP_STAGE=implement',
            `CHUNK_FILES=${chunk.files.join(',')}`,
            `CHUNK_DESCRIPTION=${chunk.description}`,
          ],
          { cwd: env.dir, inlinePrompt: chunkImplementInlinePrompt(f, chunk, env.dir, retryContext) },
        );
        const touched = listChangedFiles(env.dir);
        return { touchedFiles: touched, attemptedChange: (result.output || '').slice(0, 1000) };
      },
      replan: async (f, failedId, failedFiles, failedDesc, typecheckError, attemptedChange) => {
        const promptText = replanChunkPrompt({
          featureId: f.id,
          failedChunk: { id: failedId, files: failedFiles, description: failedDesc },
          typecheckError,
          attemptedChange,
        });
        const result = await invoke(
          ctx,
          'worker',
          [`FEATURE_ID=${f.id}`, `CHUNK_ID=${failedId}`, 'CHUNK_LOOP_STAGE=replan'],
          { inlinePrompt: promptText },
        );
        return result.output;
      },
      escalate: async (f, chunkId, chunkFiles, typecheckError, role) => {
        try {
          await invoke(ctx, role, [
            `FEATURE_ID=${f.id}`,
            `CHUNK_ID=${chunkId}`,
            `CHUNK_FILES=${chunkFiles.join(',')}`,
            `TYPECHECK_ERROR_HEAD=${typecheckError.slice(0, 500)}`,
          ]);
        } catch (err) {
          logger.log(`CHUNK_LOOP escalate(${role}) failed: ${(err as Error).message}`);
          return false;
        }
        return false;
      },
    },
  });

  logger.log(`CHUNK_LOOP ${fid} → ${outcome.kind}`);

  if (outcome.kind === 'completed') {
    await setFeatureStatus(ctx.stateDir, fid, 'validating', { ctx: stateCtx(ctx) });
  } else if (outcome.kind === 'escalated' || outcome.kind === 'planning_failed' || outcome.kind === 'aborted') {
    await setFeatureStatus(ctx.stateDir, fid, 'failing', { ctx: stateCtx(ctx) });
  }

  // P-020 monitoring metrics: record the terminal outcome + execution PATH (subprocess vs
  // the operator-hosted op) so the dark-launch parity diff + ramp gate can compare
  // completion-rate / outcome-distribution by path. BEST-EFFORT — a persist hiccup must
  // never fail the loop (recordWorkerChunkOutcome swallows + logs). Skipped when pg/ws/slug
  // are absent (CLI / unit runs), exactly like the chunk-plan PG writes.
  if (ctx.pg && ctx.workspaceId && slug) {
    try {
      const { recordWorkerChunkOutcome } = await import('./worker-chunk-outcome-pg.js');
      await recordWorkerChunkOutcome(
        { pg: ctx.pg, workspaceId: ctx.workspaceId, harnessSlug: slug },
        {
          featureId: fid,
          executionPath: ctx.executionPath ?? 'subprocess',
          outcome,
          log: (m) => logger.log(m),
        },
      );
    } catch (err) {
      logger.log(
        `CHUNK_LOOP outcome-metrics persist skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return outcome;
}
