/**
 * Shared DB-pool sizing for green-checkpoint runners.
 *
 * The periodic routine and the detached manual launcher both run the same
 * suite, but they have different process-environment boundaries. Keep the
 * resolver and the two forms of env injection here so the suite cannot inherit
 * the host operator's larger pool on one launch path and not the other.
 */

export const DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX = 2;

export function resolveGreenCheckpointDbPoolMax(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.PAPERCUSP_CHECKPOINT_DB_POOL_MAX);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_GREEN_CHECKPOINT_DB_POOL_MAX;
}

/** The standard db package env override for a checkpoint child process. */
export function greenCheckpointDbPoolEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { PAPERCUSP_DB_POOL_MAX: String(resolveGreenCheckpointDbPoolMax(env)) };
}

/** The equivalent `systemd-run` arguments for a detached checkpoint unit. */
export function greenCheckpointDbPoolSetenvArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(greenCheckpointDbPoolEnv(env)).map(([key, value]) => `--setenv=${key}=${value}`);
}
