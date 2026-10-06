import { ownerPidFromPidKeyedPath, pidKeyedSocketPath, pinSocketForCluster, reapOrphanedPidKeyedSockets } from '../sidecar-socket/pid-keyed-socket.ts';

export const LSP_DAEMON_SOCKET_ENV = 'PAPERCUSP_LSP_DAEMON_SOCKET';
const PREFIX = 'lsp-daemon';

export function resolveLspDaemonSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[LSP_DAEMON_SOCKET_ENV]?.trim() || pidKeyedSocketPath(PREFIX, process.pid);
}

export function pinLspDaemonSocketForCluster(clusterWorkers: number, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return pinSocketForCluster({ prefix: PREFIX, envVar: LSP_DAEMON_SOCKET_ENV, clusterWorkers, env });
}

export function reapOrphanedLspDaemonSockets(): void {
  reapOrphanedPidKeyedSockets({ prefix: PREFIX });
}

export function lspDaemonSocketOwner(socketPath: string): number | null {
  return ownerPidFromPidKeyedPath(PREFIX, socketPath);
}
