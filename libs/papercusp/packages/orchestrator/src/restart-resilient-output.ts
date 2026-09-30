/**
 * Keep a scope-isolated invoke-once driver alive when its launching operator
 * disappears during a deploy restart.
 *
 * The driver and its agent child live in a transient systemd scope, but their
 * stdout/stderr pipes are owned by the launcher. Closing the read end makes the
 * next write emit EPIPE. Without a listener Node treats that as an uncaught
 * stream error and kills invoke-once while the agent child keeps running. The
 * driver then never writes its restart-safe RESULT_PATH completion markers.
 *
 * Suppress only the OS broken-pipe condition. Any other stream error remains
 * fatal so this recovery seam cannot hide unrelated output failures.
 */

type ErrorStream = {
  on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown;
};

export function isLauncherPipeDisconnect(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'EPIPE';
}

export function installRestartResilientOutputHandlers(
  streams: readonly ErrorStream[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    stream.on('error', (error) => {
      if (isLauncherPipeDisconnect(error)) return;
      throw error;
    });
  }
}
