/**
 * Worker chunk loop — implements the simultaneous-editing model.
 *
 * Lifecycle for a single feature:
 *
 *   1. Plan all chunks up-front (one LLM call → ChunkPlan).
 *   2. For each chunk in order:
 *      a. acquire(chunk.files)  — atomic, FIFO-fair, deadlock-free
 *      b. Worker LLM implements the chunk in a scratch worktree.
 *      c. If the worker writes outside the declared file set:
 *         - tryExtend on the lock queue (free paths → success)
 *         - on contention: release everything, re-acquire the union,
 *           re-implement (one wasted LLM call, no deadlock).
 *      d. L1 typecheck gate runs in the scratch env. If it fails:
 *         - revert edits, release locks, re-plan THIS chunk only
 *           (LLM bundles more work to make a working state)
 *         - on N strikes: escalate to the debugger role.
 *      e. On pass: copy edits back to the main repo, commit with
 *         chunk[F-X-N]: <description>, release locks.
 *   3. When all chunks succeed, the feature is done.
 *
 * This module is dependency-injected — the LLM side (planning,
 * implementing, replanning) and the typecheck side are passed in. That
 * makes the loop unit-testable without an actual model. The real
 * integration with `invoke.ts` happens in main-loop.ts when this gets
 * wired into NEXT_WORKER dispatch.
 */

import type { FileClaimCoordinator } from '@papercusp/file-claim';
import {
  type Chunk,
  type ChunkPlan,
  formatChunkCommitMessage,
  parseChunkPlanBlock,
  type ParseError,
  type ParseResult,
} from './chunk-plan.js';
import { runCheck, setup as setupScratch, teardown as teardownScratch, type ScratchEnv } from './scratch-env.js';

/**
 * Generous ceiling on a single chunk's file-lock acquire. The lane
 * supervisor enforces the real budget; this is a last-resort guard so
 * a degenerate hang (a holder that never releases) surfaces as a typed
 * LockAcquireTimeoutError instead of an unbounded block.
 */
const CHUNK_LOCK_TIMEOUT_MS = 10 * 60_000;
/**
 * TTL on a chunk's file claim. Generous — longer than a chunk's
 * implement+typecheck+commit time — so the claim never expires mid-work; a crashed
 * worker's claim reaps via the PG backend's TTL (the in-process default has none).
 */
const CHUNK_LOCK_TTL_MS = 30 * 60_000;

// ─── Types ───────────────────────────────────────────────────────────

export interface ChunkLoopFeature {
  /** Stable feature id, e.g. F-AUTH-001. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Long-form description / acceptance criteria. */
  description: string;
  /** Optional context: prior agent notes, related-file hints, etc. */
  context?: string;
}

/**
 * P-020 monitoring metadata, additive across every outcome kind (all optional so no
 * existing outcome-literal construction needs updating). `runChunkLoop` stamps
 * `resumed`; `runChunkLoopCore` stamps the rest wherever the per-chunk loop actually
 * ran (absent for `planning_failed`, where zero chunks were attempted).
 */
export interface ChunkLoopOutcomeMeta {
  /** True iff this run resumed from a persisted PG plan after a crash/restart
   *  (deps.resumeFromPlan was set) — the P-020 crash-resume metric. */
  resumed?: boolean;
  /** Total replan-strike attempts spent across ALL chunks this run, not just the
   *  chunk in the final outcome — the P-020 replan-FREQUENCY metric (broader than
   *  `escalated.strikes`, which only covers the chunk that exhausted its budget). */
  totalReplans?: number;
  /** Chunks committed so far (mirrors `completed.chunksCommitted` but populated for
   *  every kind) + the plan's total chunk count — together the P-020
   *  per-chunk-DURABILITY metric (what fraction of a planned feature survives to a
   *  commit even when the run doesn't fully complete). */
  chunksCommittedSoFar?: number;
  totalChunksPlanned?: number;
}

export type ChunkLoopOutcome = (
  | { kind: 'completed'; chunksCommitted: number }
  | { kind: 'planning_failed'; error: string }
  | { kind: 'escalated'; chunk: Chunk; reason: string; strikes: number }
  | {
      kind: 'aborted';
      reason: string;
      /** Structured abort cause — `lock_contention` is the P-020 file-lock-contention
       *  metric (a chunk's file claim stayed busy through the full acquire wait). Set
       *  at each abort call site rather than sniffed from `reason` text later, so the
       *  metric survives a wording change. */
      abortReason?: 'lock_contention' | 'scratch_setup' | 'replan_failed' | 'other';
    }
) &
  ChunkLoopOutcomeMeta;

/** Result of a single chunk's worker LLM call — what files were touched
 *  and a summary of what was attempted (used in re-plan prompts). */
export interface ChunkImplementResult {
  /** Paths the LLM actually wrote to (relative to repoPath). May be a
   *  superset of chunk.files; the loop handles extension. */
  touchedFiles: readonly string[];
  /** One-paragraph plain-English description of what was attempted.
   *  Fed back to the re-plan prompt on typecheck failure. */
  attemptedChange: string;
}

export interface TypecheckResult {
  ok: boolean;
  /** stderr/stdout of the check, useful for diagnostics + re-plan input. */
  output: string;
}

export interface ChunkLoopDeps {
  /** Repo where worker edits land (and where commits happen). */
  repoPath: string;
  /**
   * File-claim coordinator. The in-process `FileLockQueueCoordinator` (default)
   * serializes this feature's own chunks; under DBOS cross-feature concurrency the
   * operator injects the PG-backed `SuLocksCoordinator` so concurrent feature
   * workers AND SU agents serialize cross-process on the same physical files
   * (P-040). Acquire/release/extend are async + result-typed.
   */
  lockCoordinator: FileClaimCoordinator;
  /** Plan all chunks for this feature. Returns the LLM's raw response;
   *  the loop parses it and re-asks ONCE if invalid — the retry call
   *  receives the parser's error as `parseFeedback` so the model can
   *  correct the format instead of guessing. */
  planChunks: (feature: ChunkLoopFeature, parseFeedback?: string) => Promise<string>;
  /** Implement one chunk inside the scratch dir. Worker writes its
   *  edits to env.dir/<file>. Returns what was touched + a summary. */
  implementChunk: (
    feature: ChunkLoopFeature,
    chunk: Chunk,
    env: ScratchEnv,
  ) => Promise<ChunkImplementResult>;
  /** Re-plan a failed chunk. Returns the LLM's raw response (one
   *  replacement chunk in chunk-plan format). */
  replanChunk: (
    feature: ChunkLoopFeature,
    failedChunk: Chunk,
    typecheckError: string,
    attemptedChange: string,
  ) => Promise<string>;
  /** L1 typecheck command (e.g. "pnpm typecheck"). Run inside scratch. */
  typecheckCommand: string;
  /** Optional escalation hook fired after `replanStrikes` fails. */
  onEscalate?: (
    feature: ChunkLoopFeature,
    chunk: Chunk,
    typecheckError: string,
    strikes: number,
  ) => Promise<void> | void;
  /** Commit + release-locks side effect. Default copies edits from
   *  scratch → repo, runs `git add -A && git commit`. Override for
   *  tests. */
  commitChunk?: (
    feature: ChunkLoopFeature,
    chunk: Chunk,
    env: ScratchEnv,
    deps: { repoPath: string },
  ) => Promise<void>;
  /** Optional progress callback — fired on every state transition for
   *  the harness UI (visible/persisted plan). */
  onProgress?: (event: ChunkProgressEvent) => Promise<void> | void;
  /** How many typecheck-rejection retries before escalating. Default 3. */
  replanStrikes?: number;
  /** Logger; defaults to console-noop. */
  log?: (msg: string) => void;
  /** Per-chunk typecheck timeout ms. Default 5 minutes. */
  typecheckTimeoutMs?: number;
  /**
   * Crash-recovery: when set, the loop skips the planChunks call and
   * uses this plan as-is, skipping any chunk whose id appears in
   * `committedChunkIds`. The driver populates this from pg
   * (`readPlan`) on orchestrator restart so a feature mid-implementation
   * doesn't get re-planned from scratch and lose its committed work.
   *
   * When set, the loop does NOT emit `plan_ready` (the plan is already
   * persisted; emitting would cause the driver to delete-and-reinsert
   * the existing rows).
   */
  resumeFromPlan?: {
    plan: ChunkPlan;
    committedChunkIds: readonly string[];
  };
}

export type ChunkProgressEvent =
  | { kind: 'plan_ready'; plan: ChunkPlan }
  | { kind: 'chunk_start'; chunk: Chunk; index: number; total: number }
  | { kind: 'chunk_committed'; chunk: Chunk; index: number; total: number }
  | { kind: 'chunk_replan'; chunk: Chunk; strikes: number; reason: string }
  | { kind: 'chunk_escalated'; chunk: Chunk; strikes: number };

/**
 * Exit codes meaning the working-state check COMMAND itself could not run in
 * this environment (shell conventions: 127 = command not found, 126 = found
 * but not executable) — as opposed to "the check ran and found problems".
 * An unrunnable gate is a CONFIG error: replanning the chunk can never fix
 * it, so the loop fails open (commits, loudly) instead of striking.
 */
export function isCheckUnrunnable(exitCode: number): boolean {
  return exitCode === 127 || exitCode === 126;
}

// ─── The loop ────────────────────────────────────────────────────────

export async function runChunkLoop(
  feature: ChunkLoopFeature,
  deps: ChunkLoopDeps,
): Promise<ChunkLoopOutcome> {
  const log = deps.log ?? (() => {});
  // P-020 crash-resume metric: true iff the driver found a persisted, not-all-done
  // plan and is resuming mid-feature after a crash/restart (vs a fresh attempt).
  const wasResumed = Boolean(deps.resumeFromPlan);

  // ─── 1. Plan ────────────────────────────────────────────────────
  let plan: ChunkPlan;
  const committedFromResume = new Set<string>();
  if (deps.resumeFromPlan) {
    plan = deps.resumeFromPlan.plan;
    for (const id of deps.resumeFromPlan.committedChunkIds) committedFromResume.add(id);
    log(
      `chunk-loop: resuming ${feature.id} from PG — ${plan.chunks.length} chunks, ${committedFromResume.size} already committed`,
    );
    // Don't emit plan_ready: the persisted plan is already correct.
  } else {
    let planParse: ReturnType<typeof parseChunkPlanBlock> | undefined;
    let parseFeedback: string | undefined;
    // One re-ask on a parse rejection, quoting the parser error — a format
    // slip (wrong verb, stray prose in the JSON) otherwise burns the whole
    // planning round as an opaque `planning_failed` (live on frame 138790170,
    // 2026-06-09: 3 of 4 rounds died on a rejected verb with no feedback).
    for (let attempt = 0; attempt < 2; attempt++) {
      let planRaw: string;
      try {
        planRaw = await deps.planChunks(feature, parseFeedback);
      } catch (err) {
        return { kind: 'planning_failed', error: `planChunks threw: ${(err as Error).message}`, resumed: wasResumed };
      }
      planParse = parseChunkPlanBlock(planRaw, feature.id);
      if (planParse.ok) break;
      parseFeedback = planParse.message;
      log(`chunk-loop: plan parse rejected (${planParse.message})${attempt === 0 ? ' — re-asking with the parser error' : ''}`);
    }
    if (!planParse?.ok) {
      return { kind: 'planning_failed', error: planParse?.message ?? 'plan parse failed', resumed: wasResumed };
    }
    plan = planParse.value;
    log(`chunk-loop: plan has ${plan.chunks.length} chunks for ${feature.id}`);
    if (plan.chunks.length >= 20) {
      log(
        `chunk-loop: WARNING — ${feature.id} planned ${plan.chunks.length} chunks (≥20). Likely scope creep or over-decomposition; consider re-scoping the feature.`,
      );
    }
    await emit(deps, { kind: 'plan_ready', plan });
  }

  // ─── 2. Iterate chunks ──────────────────────────────────────────
  // Extracted to runChunkLoopCore (deterministic-blueprints-migration-2026-06-13
  // D-015 stage-a): a verbatim move so the chunk-iteration is a reusable seam a
  // future `worker:chunk-loop` program-step op can call (the staged rollout). The
  // plan phase above stays in runChunkLoop; behavior is byte-identical.
  const outcome = await runChunkLoopCore(feature, plan, deps, committedFromResume);
  // P-020 crash-resume metric: stamp on every outcome kind runChunkLoopCore can
  // return, regardless of which branch produced it.
  return { ...outcome, resumed: wasResumed };
}

/**
 * The chunk-iteration core — given an already-resolved plan, implement each chunk
 * (acquire → implement → lock-extend → L1 typecheck-gate → commit / replan /
 * escalate), skipping any id in `committedChunkIds` (crash-recovery resume). A pure
 * extraction from runChunkLoop (D-015 stage-a) — byte-identical behavior to the
 * in-line loop it replaced; the reusable seam a future deterministic
 * `worker:chunk-loop` blueprint step calls (the staged rollout in D-015). Exported
 * + independently testable; NOT yet wired to any blueprint (the cutover is the
 * owner-gated, monitoring-dependent later stage).
 */
export async function runChunkLoopCore(
  feature: ChunkLoopFeature,
  plan: ChunkPlan,
  deps: ChunkLoopDeps,
  committedChunkIds: ReadonlySet<string>,
): Promise<ChunkLoopOutcome> {
  const log = deps.log ?? (() => {});
  const replanStrikes = deps.replanStrikes ?? 3;
  const typecheckTimeoutMs = deps.typecheckTimeoutMs ?? 5 * 60_000;
  const commitChunk = deps.commitChunk ?? defaultCommitChunk;

  let committed = 0;
  // P-020 replan-frequency metric: every strike across the whole run (not reset
  // per-chunk like `strikes`), so "did this feature need replans at all" is visible
  // even when it ultimately completed.
  let totalReplans = 0;
  for (let i = 0; i < plan.chunks.length; i++) {
    let chunk = plan.chunks[i];

    // Skip chunks already committed in a previous orchestrator run
    // (crash-recovery path).
    if (committedChunkIds.has(chunk.id)) {
      log(`chunk-loop: ${chunk.id} already committed (resume), skipping`);
      committed++;
      continue;
    }
    await emit(deps, {
      kind: 'chunk_start',
      chunk,
      index: i,
      total: plan.chunks.length,
    });

    let strikes = 0;
    while (true) {
      // Acquire the chunk's file claim. Waits up to CHUNK_LOCK_TIMEOUT_MS for a
      // cross-process holder to release (the in-process default never contends —
      // chunks are processed sequentially within a subprocess). A busy result after
      // the full wait means another worker/agent genuinely holds one of the files:
      // abort this run; the dispatcher re-scans and the holder's TTL guarantees
      // forward progress (P-040).
      const acq = await deps.lockCoordinator.acquire(
        `worker:${feature.id}:${chunk.id}`,
        chunk.files,
        { waitMs: CHUNK_LOCK_TIMEOUT_MS, ttlMs: CHUNK_LOCK_TTL_MS, intent: `chunk ${chunk.id}` },
      );
      if (!acq.ok) {
        const who = acq.busy[0]?.owner ?? 'another worker';
        return {
          kind: 'aborted',
          reason: `lock busy for ${chunk.id} (held by ${who})`,
          abortReason: 'lock_contention',
          chunksCommittedSoFar: committed,
          totalChunksPlanned: plan.chunks.length,
          totalReplans,
        };
      }
      let claim = acq.claim;
      let env: ScratchEnv | null = null;
      try {
        env = await setupScratch({
          repoPath: deps.repoPath,
          owner: chunk.id,
          editedFiles: chunk.files,
        });
      } catch (err) {
        await deps.lockCoordinator.release(claim);
        return {
          kind: 'aborted',
          reason: `scratch setup: ${(err as Error).message}`,
          abortReason: 'scratch_setup',
          chunksCommittedSoFar: committed,
          totalChunksPlanned: plan.chunks.length,
          totalReplans,
        };
      }

      let outcome: 'committed' | 'replan' | 'escalate' | 'aborted' = 'replan';
      let typecheckOutput = '';
      let attemptedChange = '';
      // Distinguishes "real typecheck failure (call replan)" from
      // "lock-extension contention (skip replan, just re-acquire)".
      // Can't rely on typecheckOutput emptiness: some typecheck
      // commands produce empty stderr/stdout on failure (e.g. plain
      // `false`).
      let isTypecheckFailure = false;

      try {
        const impl = await deps.implementChunk(feature, chunk, env);
        attemptedChange = impl.attemptedChange;

        // Lock extension: did the worker touch files outside its
        // declared set? If so, try to extend; on contention, abort
        // this attempt and re-do after re-acquiring the union.
        const extra = impl.touchedFiles.filter((f) => !chunk.files.includes(f));
        if (extra.length > 0) {
          const ext = await deps.lockCoordinator.extend(claim, { addPaths: extra });
          if (!ext.ok) {
            log(`chunk-loop: lock-extension contended for ${chunk.id}; release+reacquire`);
            // Release everything (via the finally) + drop env. Outer while
            // continues with the chunk's `files` field updated to include the
            // extras so the next acquire takes them as a sorted union.
            chunk = { ...chunk, files: [...chunk.files, ...extra] };
            outcome = 'replan'; // not strictly a replan — same chunk, just re-acquire
            // Don't increment strikes — this isn't a typecheck failure.
            continue;
          }
          // Extension succeeded: adopt the new claim (extend returns a fresh
          // claim) and expand chunk.files so the commit step copies + stages
          // every touched path.
          claim = ext.claim;
          chunk = { ...chunk, files: [...chunk.files, ...extra] };
        }

        // L1 typecheck gate.
        const tc = await runCheck(env, deps.typecheckCommand, { timeoutMs: typecheckTimeoutMs });
        typecheckOutput = tc.output;
        if (tc.exitCode === 0) {
          await commitChunk(feature, chunk, env, { repoPath: deps.repoPath });
          outcome = 'committed';
        } else if (isCheckUnrunnable(tc.exitCode)) {
          // The gate COMMAND itself cannot run in this environment (127 =
          // command not found, 126 = not executable — e.g. the default
          // `pnpm typecheck` on a cloud frame that only installs node/npm).
          // Replanning can never fix a gate-config problem, and striking
          // mis-attributes it to the chunk ("typecheck failed") — burning the
          // full strike budget + a debugger escalation on a FALSE signal
          // (observed live on Hetzner frame 138790170, 2026-06-09: 3 strikes ×
          // 2 pipelines on `pnpm: command not found`). The gate is an opt-in
          // safety net ('' disables it), so an unrunnable command fails OPEN,
          // loudly; the validator downstream remains the real gate.
          log(
            `chunk-loop: ${chunk.id} working-state check UNRUNNABLE (exit ${tc.exitCode}: ${tc.output.trim().slice(0, 120) || 'no output'}) — ` +
              `'${deps.typecheckCommand}' is misconfigured for this environment; committing WITHOUT the L1 gate (set parallelWorkers.workingStateCheck)`,
          );
          await commitChunk(feature, chunk, env, { repoPath: deps.repoPath });
          outcome = 'committed';
        } else {
          strikes++;
          totalReplans++;
          isTypecheckFailure = true;
          log(`chunk-loop: ${chunk.id} typecheck failed (strike ${strikes}/${replanStrikes})`);
          if (strikes >= replanStrikes) {
            outcome = 'escalate';
          } else {
            outcome = 'replan';
          }
        }
      } catch (err) {
        log(`chunk-loop: ${chunk.id} threw during implement: ${(err as Error).message}`);
        // Treat as a soft failure (count toward strikes). This catches
        // LLM API errors, file-write errors, etc.
        strikes++;
        totalReplans++;
        isTypecheckFailure = true;
        typecheckOutput = `[implement error] ${(err as Error).message}`;
        attemptedChange = attemptedChange || `(no summary — implement threw)`;
        outcome = strikes >= replanStrikes ? 'escalate' : 'replan';
      } finally {
        if (env) await teardownScratch(env, deps.repoPath);
        await deps.lockCoordinator.release(claim);
      }

      if (outcome === 'committed') {
        await emit(deps, {
          kind: 'chunk_committed',
          chunk,
          index: i,
          total: plan.chunks.length,
        });
        committed++;
        break;
      }

      if (outcome === 'escalate') {
        await emit(deps, { kind: 'chunk_escalated', chunk, strikes });
        if (deps.onEscalate) {
          try {
            await deps.onEscalate(feature, chunk, typecheckOutput, strikes);
          } catch (err) {
            log(`chunk-loop: onEscalate threw: ${(err as Error).message}`);
          }
        }
        return {
          kind: 'escalated',
          chunk,
          reason: typecheckOutput,
          strikes,
          chunksCommittedSoFar: committed,
          totalChunksPlanned: plan.chunks.length,
          totalReplans,
        };
      }

      // outcome === 'replan'
      await emit(deps, {
        kind: 'chunk_replan',
        chunk,
        strikes,
        reason: typecheckOutput.slice(0, 500),
      });
      if (isTypecheckFailure) {
        // Real typecheck failure — ask the LLM to bundle more work in.
        let replanRaw: string;
        try {
          replanRaw = await deps.replanChunk(feature, chunk, typecheckOutput, attemptedChange);
        } catch (err) {
          return {
            kind: 'aborted',
            reason: `replanChunk threw: ${(err as Error).message}`,
            abortReason: 'replan_failed',
            chunksCommittedSoFar: committed,
            totalChunksPlanned: plan.chunks.length,
            totalReplans,
          };
        }
        const replanParse: ParseResult<ChunkPlan> | ParseError = parseChunkPlanBlock(replanRaw, feature.id);
        if (!replanParse.ok) {
          // Replan response unparseable — count as a strike.
          if (strikes >= replanStrikes) {
            await emit(deps, { kind: 'chunk_escalated', chunk, strikes });
            return {
              kind: 'escalated',
              chunk,
              reason: `replan unparseable: ${replanParse.message}`,
              strikes,
              chunksCommittedSoFar: committed,
              totalChunksPlanned: plan.chunks.length,
              totalReplans,
            };
          }
          continue;
        }
        const replanned = replanParse.value.chunks.find((c) => c.id === chunk.id);
        if (!replanned) {
          return {
            kind: 'aborted',
            reason: `replan returned no chunk with id ${chunk.id}`,
            abortReason: 'replan_failed',
            chunksCommittedSoFar: committed,
            totalChunksPlanned: plan.chunks.length,
            totalReplans,
          };
        }
        chunk = replanned;
      }
      // If outcome === 'replan' but typecheckOutput is empty, this was
      // the lock-extension contention path — chunk.files was already
      // updated above. Loop body continues.
    }
  }

  return {
    kind: 'completed',
    chunksCommitted: committed,
    chunksCommittedSoFar: committed,
    totalChunksPlanned: plan.chunks.length,
    totalReplans,
  };
}

// ─── Default commit implementation ──────────────────────────────────

// Process-local mutex for git operations on the main repo. Concurrent
// `git add` / `git commit` from sibling workers race on `.git/index`
// — even though file-level locks prevent them from editing the same
// path, the index itself is a shared resource. Serializing commits is
// the simplest correct answer; commits are fast (<100 ms each) so this
// adds little wall-clock cost compared to the LLM-bound work.
let gitIndexMutex: Promise<void> = Promise.resolve();
async function withGitIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = gitIndexMutex;
  gitIndexMutex = next;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function defaultCommitChunk(
  feature: ChunkLoopFeature,
  chunk: Chunk,
  env: ScratchEnv,
  deps: { repoPath: string },
): Promise<void> {
  // Copy each edited file from the scratch worktree back into the main
  // repo, then `git add -A && git commit -m chunk[...]: ...`.
  // This module deliberately doesn't shell out to git directly — leave
  // the choice of branching strategy to the caller via override. The
  // default assumes the integration branch model: workers commit
  // straight to the current branch in the main repo.
  void feature;
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');

  // Stage paths individually to handle adds, modifications, and
  // deletes correctly, and to avoid the `git add -A path` "did not
  // match any files" error when a chunk's declared file was deleted.
  // The whole copy + add + commit sequence runs under withGitIndexLock
  // so concurrent workers can't race on `.git/index`.
  await withGitIndexLock(async () => {
    for (const rel of chunk.files) {
      const srcAbs = path.join(env.dir, rel);
      const dstAbs = path.join(deps.repoPath, rel);
      const st = await fs.stat(srcAbs).catch(() => null);
      if (!st) {
        // Worker deleted the file. Remove from working tree + index.
        await fs.rm(dstAbs, { force: true });
        await runGit(['rm', '-f', '--ignore-unmatch', '--', rel], deps.repoPath);
        continue;
      }
      if (st.isDirectory()) {
        // A directory in files[] is never a real edit (planner slip, or a
        // sandbox artifact like `node_modules/` that leaked into the set via
        // lock-extension). copyFile() would EISDIR-abort the WHOLE chunk —
        // and a poisoned files[] persisted in the PG plan then re-aborts
        // every resume (live on frame 138805161, 2026-06-09). Skip it.
        continue;
      }
      // copyFile EISDIRs when the DESTINATION is a directory too — the same
      // poison class seen from the other side (scratch holds the cache
      // SYMLINK, the real repo holds the sandbox's node_modules DIRECTORY).
      const dstSt = await fs.stat(dstAbs).catch(() => null);
      if (dstSt?.isDirectory()) {
        continue;
      }
      await fs.mkdir(path.dirname(dstAbs), { recursive: true });
      await fs.copyFile(srcAbs, dstAbs);
      await runGit(['add', '--', rel], deps.repoPath);
    }
    // A re-dispatched chunk whose net effect is ALREADY in HEAD stages nothing,
    // and `git commit` then exits 1 ("nothing to commit") — which read as a
    // false implement-strike (live on frame 138838461, 2026-06-09: the director
    // re-sent an already-committed feature to the worker; the replay was a
    // no-op but the empty commit failed the chunk). An idempotent replay IS
    // success — skip the commit when nothing is staged.
    const staged = await new Promise<boolean>((resolve) => {
      const c = spawn('git', ['diff', '--cached', '--quiet'], {
        cwd: deps.repoPath,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      c.on('error', () => resolve(true)); // can't tell — attempt the commit
      c.on('close', (code) => resolve(code !== 0)); // non-zero = staged changes exist
    });
    if (staged) {
      await runGit(['commit', '-q', '-m', formatChunkCommitMessage(chunk)], deps.repoPath);
    }
  });

  function runGit(args: readonly string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (b) => (err += b.toString('utf8')));
      c.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`git ${args.join(' ')} exit=${code}: ${err.trim()}`)),
      );
      c.on('error', (e) => reject(e));
    });
  }
}

async function emit(deps: ChunkLoopDeps, event: ChunkProgressEvent): Promise<void> {
  if (!deps.onProgress) return;
  try {
    await deps.onProgress(event);
  } catch {
    /* swallow — progress is observability, not control flow */
  }
}
