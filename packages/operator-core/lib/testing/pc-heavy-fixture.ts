/**
 * Shared launch options for pc-heavy fixtures. The subject tests its own behavior,
 * so each invocation runs from the fixture's private temp directory and skips the
 * unrelated Git worktree fingerprint used by coalescing.
 */
export function pcHeavyFixtureOptions(cwd: string, env: NodeJS.ProcessEnv): { cwd: string; env: NodeJS.ProcessEnv } {
  return {
    cwd,
    env: {
      ...env,
      PC_HEAVY_COALESCE: '0',
    },
  };
}
