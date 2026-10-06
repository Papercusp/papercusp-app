/** The daemon's resource lifetime, using the packaged host's existing deadline. */
import { runShutdownWithDeadline } from './shutdown-deadline';

interface LspDaemonShutdownDeps {
  closeClients?: () => Promise<unknown>;
  closeDatabase?: () => Promise<unknown>;
  exit?: (code: number) => void;
  deadlineMs?: number;
  onForceExit?: () => void;
}

/** One drain even if SIGTERM and SIGINT arrive together. */
export function createLspDaemonShutdown(deps: LspDaemonShutdownDeps = {}) {
  let stopping = false;
  return (closeRpc: () => Promise<void>): void => {
    if (stopping) return;
    stopping = true;
    let rpcClosed: Promise<void>;
    runShutdownWithDeadline({
      // Adapter protocol shutdown already allows five seconds for child exit.
      deadlineMs: deps.deadlineMs ?? 8_000,
      exit: deps.exit ?? (code => process.exit(code)),
      onForceExit: deps.onForceExit ?? (() => console.error('[lsp-daemon] shutdown deadline exceeded; force-exiting')),
      syncCleanup: () => { rpcClosed = closeRpc(); },
      gracefulStop: async () => {
        // Destroying RPC clients aborts outstanding requests before draining
        // adapter children. Keep the DB available until child teardown settles.
        const drained = await Promise.allSettled([
          rpcClosed!,
          Promise.resolve().then(deps.closeClients ?? (async () => {
            const { shutdownAllLspClients } = await import('@papercusp/operator-core/lib/code-intelligence/lsp-adapter');
            return shutdownAllLspClients();
          })),
        ]);
        for (const result of drained) {
          if (result.status === 'rejected') console.error('[lsp-daemon] resource shutdown failed:', result.reason);
        }
        try {
          await (deps.closeDatabase ?? (async () => {
            const { getOrgPg } = await import('@papercusp/db-org');
            await getOrgPg().sql.end({ timeout: 1 });
          }))();
        } catch (error) {
          console.error('[lsp-daemon] database shutdown failed:', error);
        }
      },
    });
  };
}
