/**
 * `defaultRunWorkerChunkLoop` — the production loop-runner for the
 * `worker:chunk-loop` op (worker-chunk-loop-operator-hosted-2026-06-14 P-002,
 * D-005). Split out of the op module + dynamic-imported so importing/registering
 * the op (and the op's unit tests, which inject `runLoop`) never load this heavy
 * operator/orchestrator surface.
 *
 * It is the turnkey D-005 recipe: construct the SAME `InvokeContext` the
 * subprocess `invoke-once` worker path builds (invoke-once.ts:64-177) — but
 * operator-side (`resolveProject().path` not `process.env.PROJECT_DIR`,
 * `getOrgPg()` not a fresh pg-bootstrap) — then call the EXISTING
 * `runWorkerChunkLoop`. A near-PORT: reuse, don't rewrite.
 *
 * ⚠ DARK-LAUNCH-VALIDATED (D-005): this path is mock-only-testable. A wrong ctx
 * (esp. `extraSpawnEnv` + the `pg` bridge + the lock-coordinator admin URL)
 * compiles + passes mocks but is only PROVEN by the Phase-1 dark-launch parity
 * run (P-010). The op's unit tests inject a fake `runLoop` and never exercise this.
 */
import { realpathSync } from 'node:fs';
import {
  runWorkerChunkLoop,
  readEffectiveConfig,
  resolvePhase,
  resolveAgentCmd,
  resolveAgentBackend,
  createLogger,
  FileLockQueueCoordinator,
  type InvokeContext,
  type ChunkLoopOutcome,
} from '@papercusp/orchestrator';
import { harnessRoot } from '@papercusp/harness/paths';
import type { FileClaimCoordinator } from '@papercusp/file-claim';
import { getOrgPg } from '@papercusp/db-org';
import { governorForBackend } from '@papercusp/papercusp-shared/agent';
import type { CoordOpCtx } from '../../coord-ops/types.js';
import { resolveProject } from '../../harness-core.js';
import { buildPipelineExtraEnv } from '../../dbos/orchestrator-spawn-env.js';
import { resolveSpawnBackendModel } from '../../harness-invoke-once.js';
import { createOperatorOwnedLoopPort } from '../../agent-loop/headless-invoke.js';
// Side-effect: wire @papercusp/locks to the operator's embedded-pg admin URL so
// the PG-backed SuLocksCoordinator below resolves the right `papercusp_su` DB.
import '../../agent-tools/locks/configure.js';

/**
 * The chunk file-claim coordinator, operator-hosted. Cross-feature concurrency →
 * the PG-backed `SuLocksCoordinator` (the SAME coordination domain the operator's
 * `locks:*` tools use), keyed by the canonical repo root so concurrent feature
 * workers AND SU agents serialize cross-process on the same physical files (P-040).
 * Falls back to the in-process queue only if the locks package can't load.
 */
async function buildChunkLockCoordinator(repoPath: string): Promise<FileClaimCoordinator> {
  try {
    const { SuLocksCoordinator } = await import('@papercusp/locks');
    return new SuLocksCoordinator({ coordinationDomain: realpathSync(repoPath) });
  } catch {
    return new FileLockQueueCoordinator();
  }
}

/** Unattended cap on how long the op-run waits on a shared rate-limit pause before
 *  giving up (the director re-dispatches later). Mirrors `governorMaxWaitMs`. */
const governorMaxWaitMs = (): number =>
  Number(process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS ?? 1_800_000);

/**
 * EI-6503 — pure decision for a governor-pause abort, mirroring the WI-181 fix
 * already applied to the sibling bee-spawn path (orchestrator-runner.ts): when
 * the per-account spawn-admission bucket is paused past maxWait, only hard-abort
 * when there is NO inference-gateway egress (no failover safety net). With
 * gateway egress present, the gateway's own per-account failover + internal
 * retry reaches a healthy account anyway, so proceeding is correct.
 *
 * Extracted as a standalone pure function (rather than inlined) so this branch
 * is unit-testable without exercising `defaultRunWorkerChunkLoop`'s heavy,
 * mock-only dependency graph (resolveProject/getOrgPg/buildChunkLockCoordinator).
 * Deliberately NOT shared with orchestrator-runner.ts this cycle — DRY-ing the
 * two would touch the critical bee-spawn path for a minor-severity residual.
 */
export function resolveGovernorPauseOutcome(opts: {
  extraSpawnEnvBaseUrl?: string;
  processEnvBaseUrl?: string;
}): { abort: boolean; gatewayEgress: boolean } {
  const gatewayEgress = !!(opts.extraSpawnEnvBaseUrl ?? opts.processEnvBaseUrl);
  return { abort: !gatewayEgress, gatewayEgress };
}

export async function defaultRunWorkerChunkLoop(
  featureId: string,
  ctx: CoordOpCtx,
): Promise<ChunkLoopOutcome> {
  const workspaceId = ctx.workspaceId;
  const slug = ctx.harnessSlug;
  if (!workspaceId || !slug) {
    return { kind: 'aborted', reason: 'worker:chunk-loop runner requires workspaceId + harnessSlug' };
  }

  // Resolve in the op's CAPTURED workspace (not the volatile active one), exactly
  // like the operator's realRunner — an unresolved harness is a loud abort.
  const project = await resolveProject(slug, workspaceId);
  if (!project) {
    return { kind: 'aborted', reason: `worker:chunk-loop — unknown harness slug=${slug} ws=${workspaceId}` };
  }

  // Mirror invoke-once.ts:64-177 (the subprocess worker path), operator-side.
  const projectDir = project.path;
  const stateDir = `${projectDir}/.papercusp`;
  const harnessDir = harnessRoot();
  const logDir = `${stateDir}/logs`;
  const cfg = readEffectiveConfig(stateDir);
  const { phase } = resolvePhase(cfg);
  const claudeCmd = resolveAgentCmd();
  const agentBackend = resolveAgentBackend(claudeCmd);
  const logger = createLogger(stateDir);

  // extraSpawnEnv = the operator pipeline ROUTING env (HARNESS_SLUG +
  // PAPERCUSP_CHUNK_LOCK_PG + PAPERCUSP_WORKSPACE_ID), exactly what realRunner's
  // buildPipelineExtraEnv sets. The decrypted search-provider keys are NOT
  // computed here: they already live in the operator process.env and `invoke()`
  // spreads them into the spawned agent (kept by scopeSpawnEnvForRole) — the same
  // env the subprocess worker inherited. (D-005: the dark-launch-validated piece.)
  const extraSpawnEnv = buildPipelineExtraEnv({ harnessSlug: slug, workspaceId });

  const invokeCtx: InvokeContext = {
    harnessDir,
    projectDir,
    stateDir,
    logDir,
    phase,
    claudeCmd,
    agentBackend,
    log: (m) => logger.log(m),
    // getOrgPg().sql is the postgres-js tagged-template instance, which IS the
    // OrchestratorPg call signature (+ .json/.begin the chunk-plan PG writes use).
    pg: getOrgPg().sql as unknown as NonNullable<InvokeContext['pg']>,
    workspaceId,
    extraSpawnEnv,
    // P-020 metrics: label this run as the operator-hosted op path so the outcome
    // record (recordWorkerChunkOutcome) distinguishes it from the subprocess path.
    executionPath: 'op',
    // P-010: make the owned loop AVAILABLE without changing the default.
    // invoke.ts selects it only for aiBackend.{default,roles.<role>}.engine=loop;
    // the subprocess AGENT_BACKENDS tuple remains untouched.
    ownedLoop: createOperatorOwnedLoopPort(),
  };

  const lockCoordinator = await buildChunkLockCoordinator(projectDir);

  // D-002: govern the op-RUN as a UNIT — one governor permit held across the whole
  // worker:chunk-loop op, mirroring spawnInvokeOnce around the subprocess. The
  // inner plan/implement/replan invoke() calls inherit the unit's permit (invoke()
  // does not individually acquire), so this does NOT open a second ungoverned
  // spawn path (the seam the parent migration closed). Pacing is opt-in
  // (PAPERCUSP_AGENT_GOVERNOR=1, default OFF), exactly like spawnInvokeOnce.
  const { backend, model } = resolveSpawnBackendModel('worker', undefined, undefined);
  const gov = governorForBackend(backend, model, undefined, process.env.PAPERCUSP_ACCOUNT_ID || undefined);
  let release: (() => void) | null = null;
  if (process.env.PAPERCUSP_AGENT_GOVERNOR === '1') {
    release = await gov.acquire({}, { maxWaitMs: governorMaxWaitMs() });
    if (!release) {
      const { abort } = resolveGovernorPauseOutcome({
        extraSpawnEnvBaseUrl: extraSpawnEnv.ANTHROPIC_BASE_URL,
        processEnvBaseUrl: process.env.ANTHROPIC_BASE_URL,
      });
      if (abort) {
        return { kind: 'aborted', reason: 'agent governor: rate-limit pause exceeded max wait' };
      }
      console.warn('[worker:chunk-loop] spawn-governor bucket paced past maxWait → proceeding via inference-gateway failover');
      // release stays null — the finally below is then a no-op, same as the
      // ungoverned (pacing-off) path.
    }
  }
  try {
    return await runWorkerChunkLoop(featureId, invokeCtx, logger, cfg, lockCoordinator);
  } finally {
    release?.();
  }
}
