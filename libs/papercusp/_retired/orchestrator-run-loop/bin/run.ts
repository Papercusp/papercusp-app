#!/usr/bin/env -S npx tsx
/**
 * Orchestrator CLI entry point. The TypeScript orchestrator is the
 * canonical and only main-loop driver as of 2026-05-08. The legacy
 * `PAPERCUSP_USE_TS_ORCHESTRATOR=0` bash-fallback was removed once
 * parity gaps G4/G5/G6 closed and operator spawn sites moved to TS.
 *
 * `bash run.sh` has since been deleted entirely (2026-05-30) — its
 * last function-library call sites were ported onto `invoke-once.ts`.
 * The `=0` check below is kept only to warn anyone who still sets the
 * old env var; there is no bash fallback left to honor.
 */
import { configGet } from '../src/config.js';
import { readEffectiveConfig } from '../src/effective-config.js';
import { resolvePaths, resolveAgentBackend, resolveAgentCmd } from '../src/env.js';
import { createLogger } from '../src/log.js';
import { runMainLoop } from '../src/main-loop.js';
import { bootstrapOrchestratorPg } from '../src/pg-bootstrap.js';
import { activeWorkspaceId } from '../src/workspace.js';
import { harnessSlug } from '../src/state.js';
import { buildSearchProviderSpawnEnv } from '../src/spawn-env-from-pg.js';

if (process.env.PAPERCUSP_USE_TS_ORCHESTRATOR === '0') {
  process.stderr.write(
    '[papercusp-orchestrate] WARN: PAPERCUSP_USE_TS_ORCHESTRATOR=0 is no longer honored.\n' +
    '  The bash run.sh fallback was retired 2026-05-08. Running TS regardless.\n',
  );
}

const { harnessDir, projectDir, stateDir, logDir } = resolvePaths();

async function runTs(): Promise<never> {
  const logger = createLogger(stateDir);
  logger.log('TS orchestrator active (default).');

  const cfg = readEffectiveConfig(stateDir);
  const phase = (cfg.phase as string) ?? 'staging';
  const claudeCmd = resolveAgentCmd();
  const agentBackend = resolveAgentBackend(claudeCmd);
  const maxIterations = parseInt(process.env.MAX_ITERATIONS ?? '200', 10);
  const iterationSleepMs = (parseFloat(process.env.ITERATION_SLEEP ?? '2') || 0) * 1000;

  // Bootstrap PG so the orchestrator + spawned roles share one
  // connection pool (mirrors bin/invoke-once.ts). pgBoot.pg is undefined
  // when PG isn't reachable — every consumer below guards on it.
  const slug = harnessSlug(projectDir);
  const pgBoot = await bootstrapOrchestratorPg(logger.log, { harnessSlug: slug });
  const workspaceId = pgBoot.pg ? activeWorkspaceId() : undefined;

  // Pull decrypted search-provider keys (Migration 047) once at boot.
  // Workers/validators/scoper/architect inherit them via ctx.extraSpawnEnv.
  // No-op when PG not bootstrapped or no keys configured.
  const extraSpawnEnv =
    pgBoot.pg && workspaceId
      ? await buildSearchProviderSpawnEnv(pgBoot.pg, workspaceId)
      : {};

  try {
    const exit = await runMainLoop({
      ctx: {
        harnessDir,
        projectDir,
        stateDir,
        logDir,
        phase,
        claudeCmd,
        agentBackend,
        dept: configGet<string>(cfg, 'dept', ''),
        log: logger.log,
        ...(pgBoot.pg ? { pg: pgBoot.pg, workspaceId } : {}),
        ...(Object.keys(extraSpawnEnv).length > 0 ? { extraSpawnEnv } : {}),
      },
      logger,
      maxIterations,
      iterationSleepMs,
    });
    if (pgBoot.cleanup) await pgBoot.cleanup();
    process.exit(exit.exitCode);
  } catch (err) {
    if (pgBoot.cleanup) await pgBoot.cleanup();
    throw err;
  }
}

runTs().catch((err) => {
  process.stderr.write(
    `[papercusp-orchestrate] uncaught error in TS loop: ${(err as Error).message}\n${(err as Error).stack ?? ''}\n`,
  );
  process.exit(1);
});
