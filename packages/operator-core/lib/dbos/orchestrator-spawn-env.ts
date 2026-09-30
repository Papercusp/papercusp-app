/**
 * Extra env for invoke-once spawns from the durable pipeline
 * (`dbos-retire-legacy-orchestrator-2026-05-31` P-008 fix).
 *
 * The crux: `harnessSlug(projectDir)` in the orchestrator resolves the slug via
 * `HARNESS_SLUG` env → a registry curl to `:3055/api/harness/projects` →
 * `basename(projectDir)`. In the DBOS-spawned context the env was unset AND the
 * `:3055` registry curl fails (the operator moved to Vite; that route is on the
 * Hono host now), so it fell back to the directory basename — e.g. `sheets-clone`
 * instead of the registry slug `sheets` → `search_path=harness_sheets_clone`
 * (a schema that doesn't exist) → the director reads no feature state and exits
 * with EMPTY output (the "decide invoke failed exit=0 empty=true" ERROR).
 *
 * The runner/finalizer already know the authoritative registry slug (it's how
 * `resolveProject` found the path), so we pass it explicitly as `HARNESS_SLUG` —
 * `harnessSlug()` prefers the env over basename, fixing the schema resolution.
 *
 * SCOPE (unify-launch-mechanics-2026-06-09 D-001, P-004): this builder is
 * WHO/WHEN only — schema routing, chunk-lock backend, idempotency, workspace
 * pinning. It is NOT a parallel launch-MECHANICS path: the HOW (identity,
 * per-session CLAUDE_CONFIG_DIR + signed-MCP dir keying, native session id,
 * least-privilege env, signed MCP URL) is produced by the ONE converged
 * primitive — `invoke.ts` keys the per-session dirs through the shared
 * `@papercusp/orchestrator/session-launch-dirs` helper, the exact same helper
 * `buildRoleLaunchSpec` (the interactive primitive) and the wake-executor resume
 * leg use. So launch and resume can never drift (the EI-153 fix lands once), and
 * the orchestrator keeps only placement/scheduling here — by design, not legacy.
 */
export interface PipelineSpawnEnvInput {
  /** The authoritative registry slug (NOT the dir basename). */
  harnessSlug: string;
  /** Idempotency key for an agent run (omit for finalizer curator/documenter). */
  idempotencyKey?: string;
  /** Workspace to pin the spawn to (the pipeline's captured workspace). */
  workspaceId?: string;
  /**
   * WI-3082: per-turn trigger attribution — 'coord-wake' | 'cron' | 'autoloop' | 'user'
   * (the same enum `invoke.ts` reads as `PAPERCUSP_TURN_TRIGGER` for cup:spawn'd bee/queen
   * children). Every current caller of this builder is a DBOS-scheduled durable-pipeline
   * tick (the next queued role step for a feature/chunk, picked up by the orchestrator's
   * own recurring poll — never a human or a coordinating peer directly placing the run),
   * so 'cron' is the correct default and callers need not pass it. Override only if a
   * future caller invokes a pipeline role for a genuinely different reason (e.g. an
   * immediate event-reaction re-dispatch rather than the periodic tick).
   */
  turnTrigger?: string;
}

export function buildPipelineExtraEnv(input: PipelineSpawnEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    // Force the registry slug so invoke-once's pg-bootstrap uses harness_<slug>
    // (correct schema), never basename(projectDir).
    HARNESS_SLUG: input.harnessSlug,
    // P-040: this spawn is under the DBOS orchestrator (cross-feature concurrency),
    // so the worker chunk-loop routes its file claims through the PG-backed
    // SuLocksCoordinator (the same backend locks:* uses) instead of the in-process
    // FileLockQueue. Only set on pipeline spawns — the single-feature / manual /
    // test path stays in-process. invoke-once also requires DATABASE_URL (set by
    // buildInvokeOnce) before it actually uses the PG backend.
    PAPERCUSP_CHUNK_LOCK_PG: '1',
    // WI-3082: attribute this run's agent_usage_samples row so burn reports can split
    // scheduled-pipeline spend from coord-wake/autoloop/user spend — previously NULL for
    // every invoke-once pipeline role (worker/scoper/architect/reviewer/documenter/curator/
    // auditor), the single largest unattributed jsonl-source slice the token-usage audit
    // (P-002) found. `invoke.ts` reads this via `process.env.PAPERCUSP_TURN_TRIGGER` in the
    // SAME child process this env is spawned into, so setting it here (rather than mutating
    // the parent's shared process.env) is race-free across concurrent pipeline spawns.
    PAPERCUSP_TURN_TRIGGER: input.turnTrigger ?? 'cron',
  };
  if (input.idempotencyKey) env.IDEMPOTENCY_KEY = input.idempotencyKey;
  if (input.workspaceId) env.PAPERCUSP_WORKSPACE_ID = input.workspaceId;
  return env;
}
