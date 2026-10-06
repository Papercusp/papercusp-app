/**
 * Spawner sidecar JSON-RPC server (WI-344 ③, plan spawner-sidecar-offload-2026-06-30).
 *
 * Cloned from sync/hyperbee/substrate-sidecar-server.ts. The Unix-socket JSON-RPC
 * server that fronts the REAL agent-spawn chokepoint (`spawnInvokeOnce`, imported
 * from ../dbos/orchestrator-runner) — relocated OFF the bg-host main event loop so
 * the `child_process.spawn` of bee/queen children + the synchronous
 * `buildInvokeOnce` stop saturating routinesTick.
 *
 * It lives in operator-core (NOT the bin) so the SAME code can start two ways
 * without the esbuild trap an auto-running bin guard would spring (esbuild bundles
 * every module into serve.mjs, so a bin's `import.meta.url === argv[1]` guard would
 * resolve TRUE on every operator boot and start a stray sidecar in the main
 * process):
 *   - DEV     : apps/operator/bin/spawner-sidecar.ts (run via tsx) calls it.
 *   - PACKAGED: serve.ts diverts here under PAPERCUSP_SPAWNER_SIDECAR_MODE=1.
 *
 * No top-level side effects: importing this module never starts a server; only
 * runSpawnerSidecarServer() does. Reached ONLY when the OFF-by-default
 * `papercusp-spawner-sidecar` flag is ON.
 *
 * ── Protocol ──
 * Request  `spawn:invokeOnce` { projectDir, role, extras, extraEnv, timeoutMs?,
 *            resultPath?, forceSessionId?, taskSpawnId? } → runs the real spawnInvokeOnce; while
 *            in flight it PUSHES (server→client notifications, no id):
 *              `spawn:pid`            { requestId, pid }
 *              `spawn:outputActivity` { requestId }
 *            then replies with the SpawnInvokeOnceResult.
 * Request  `spawn:cancel`     { requestId } → aborts that request's AbortController.
 *                           Also returns the server/connection generation for a
 *                           process:exec `fence` (including with no requestId).
 * Request  `process:drain`    { serverGeneration, connectionId, requestId } on a
 *                           different connection → revokes the old connection,
 *                           waits for its exec to settle, confirms exit. A null
 *                           result means the result was lost, never retry it.
 *                           This is live-server proof only; a server-generation
 *                           mismatch cannot prove an old process has exited.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
// WI-6822: MUST be the first import in this file, textually before
// `orchestrator-runner` below — it installs the flag-override store as an
// import-time side effect. `orchestrator-runner` transitively imports
// `work-item-claim-lease-wiring.ts`, whose OWN top-level
// `void refreshClaimLease()` calls `getFlag()` during ITS import evaluation
// — which, being a sibling import of this file, would otherwise run BEFORE
// `installFlagOverrideStore()` (previously only called inside
// `runSpawnerSidecarServer()`'s body, which executes after every import
// already resolved — too late). See flag-override-store-boot-effect.ts's
// docblock for the full explanation.
import '../flag-override-store-boot-effect';
import { spawnInvokeOnce, type SpawnInvokeOnceResult } from '../dbos/orchestrator-runner';
import { installFlagOverrideStore } from '../flag-override-store';
import { ensureFlagChangeListener } from '../flag-change-listener';
import {
  resolveSpawnerSocketPath,
  reapOrphanedSpawnerSockets,
} from './spawner-socket-path';
import {
  execProcess,
  PROCESS_EXEC_CALLER_LABELS,
  type ExecParams,
  type ExecResult,
  type ProcessExecCallerLabel,
} from './sidecar-exec-process';
import { listenUnixSocketExclusive, SIDECAR_EXIT_SOCKET_IN_USE } from '../sidecar-socket/pid-keyed-socket';
import { captureSidecarContainment, SPAWNER_SCOPE_ENV } from './sidecar-exec-lifetime';
import { armSpawnerSidecarOrphanWatchdog } from './spawner-sidecar-orphan-watchdog';
import { getBuildInfo } from '../build-info';

const SAFE_PROCESS_EXEC_CALLER_LABELS = new Set<ProcessExecCallerLabel>(
  Object.values(PROCESS_EXEC_CALLER_LABELS),
);

// JSON-RPC 2.0 response builders
function rpcResult(result: unknown, id: number | string): object {
  return { jsonrpc: '2.0', result, id };
}
function rpcError(code: number, message: string, id: number | string | null, data?: unknown): object {
  if (id === null) return {}; // can't reply to a parse-failed request with no id
  return { jsonrpc: '2.0', error: { code, message, ...(data ? { data } : {}) }, id };
}
function rpcNotification(method: string, params: unknown): object {
  // A JSON-RPC NOTIFICATION carries NO id — the client routes it to per-request
  // push callbacks via params.requestId.
  return { jsonrpc: '2.0', method, params };
}

interface InvokeOnceParams {
  projectDir: string;
  role: string;
  extras: string[];
  extraEnv: Record<string, string>;
  timeoutMs?: number;
  resultPath?: string;
  forceSessionId?: string;
  taskSpawnId?: string;
}

/**
 * Start the spawner sidecar JSON-RPC server on the (ABSOLUTE) socket and own the
 * process lifecycle (SIGTERM/SIGINT → close). Prints PAPERCUSP_SPAWNER_READY once
 * listening so the parent spawnSpawnerSidecar() handshake completes.
 */
export function runSpawnerSidecarServer(deps: { executeProcess?: typeof execProcess } = {}): net.Server {
  // Runtime flag overrides (EI-8867 / WI-3628, corrected WI-6822). `getFlag()` consults the
  // PG override store ONLY in a process that installed it. This is a STANDALONE process (dev:
  // `tsx bin/spawner-sidecar.ts`; packaged: serve.mjs re-exec'd with
  // PAPERCUSP_SPAWNER_SIDECAR_MODE), and it does not import flag-bus — so without an install
  // somewhere, every `flags:set` would report success and be silently INVISIBLE here.
  //
  // The REAL install now happens at IMPORT TIME, via this file's top-of-file
  // `import '../flag-override-store-boot-effect'` (textually before the `orchestrator-runner`
  // import) — NOT here. WI-6822: this call, sitting inside the function body, used to be the
  // ONLY install and was too late — `orchestrator-runner` transitively imports
  // `work-item-claim-lease-wiring.ts`, whose own top-level `void refreshClaimLease()` reads a
  // flag DURING that sibling import's evaluation, before this function is ever invoked. That
  // silently latched the one-shot "no override store" warning and served FLAG_DEFAULTS on every
  // boot. This call is kept as a harmless, idempotent defensive re-assert (never blocks boot on
  // a store fault) — see flag-override-store-boot-effect.ts for the actual fix + full timing
  // explanation.
  installFlagOverrideStore();
  // WI-6793: LISTEN for peer processes' flags:set writes (cross-process
  // invalidation — see flag-change-listener.ts). Fire-and-forget; bounded
  // retry + fail-soft inside.
  void ensureFlagChangeListener();
  const socketPath = resolveSpawnerSocketPath();
  const socketDir = path.dirname(socketPath);
  // Resolve inside this loaded server, once at boot. A diagnostic reader must
  // never import the checkout's current build-info to label an older process.
  const processExecIdentity = { pid: process.pid, buildInfo: getBuildInfo() };

  if (!fs.existsSync(socketDir)) fs.mkdirSync(socketDir, { recursive: true });
  // No unconditional unlink of our own path here: `listenUnixSocketExclusive` below
  // reclaims it only when nothing is listening on it (host-memory-reduction P-005).

  // Sweep OTHER hosts' orphaned socket files (dead owner pids) before claiming ours
  // — the EI-7832 fix the substrate sidecar got and this one did not.
  //
  // The bind below can only ever reclaim OUR OWN path. The scheme is
  // pid-keyed, so an unpinned restart computes a brand-new path every time and a
  // PRIOR process's leftover file lives at a different (dead) pid's path that nothing
  // here ever looks at. With no reaper these accumulate without bound: measured in
  // tmpdir on this box 2026-08-12 — 206 files, 185 with no live listener, oldest 4
  // days, against WI-7273's count of 52 on 2026-08-03 (~4x/week).
  //
  // Safe to run from a sidecar serving a PINNED (cluster-primary-keyed) socket: the
  // reaper only removes paths whose owner pid is derivable AND provably dead, and the
  // pinned path's owner is the live primary. Best-effort; never blocks boot.
  try {
    const { removed, errors } = reapOrphanedSpawnerSockets();
    if (removed.length > 0) {
      console.log(`[spawner-sidecar] reaped ${removed.length} orphaned socket(s) from dead pids`);
    }
    if (errors.length > 0) {
      console.error(`[spawner-sidecar] socket reap had ${errors.length} error(s): ${JSON.stringify(errors)}`);
    }
  } catch (e) {
    console.error('[spawner-sidecar] socket reap threw (non-fatal)', e);
  }

  const controllers = new Set<AbortController>();
  // Only live connections and their unfinished work are retained. No result
  // cache, TTL, durable receipt or new background timer is needed for draining.
  const serverGeneration = randomUUID();
  const connections = new Map<string, {
    socket: net.Socket;
    requests: Map<number | string, AbortController>;
    executions: Map<number | string, Promise<ExecResult>>;
    requestMethods: Map<number | string, string>;
    clientConnectionId: string | null;
  }>();
  let shuttingDown = false;
  let socketsClosed = false;
  let exitRequested = false;
  const exitWhenDrained = (): void => {
    if (!shuttingDown || !socketsClosed || controllers.size > 0 || exitRequested) return;
    exitRequested = true;
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInterrupt);
    process.exit(0);
  };
  // Keep the client sockets so shutdown can destroy a persistent IPC connection
  // before `server.close()`. Without this, net.Server waits forever for the
  // parent-side client to close and the sidecar/socket survive the host exit.
  const clients = new Set<net.Socket>();

  const unlinkSocket = (): void => {
    try {
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
    } catch {
      /* best effort — the process is exiting regardless */
    }
  };

  // `process.exit()` and fatal paths bypass the async signal handler below;
  // the synchronous exit hook is the last chance to remove this pid's stale
  // Unix socket (SIGKILL is the only path no handler can cover).
  process.on('exit', unlinkSocket);

  const server = net.createServer((socket: net.Socket) => {
    clients.add(socket);
    // JSON-RPC ids are local to a connection. Two clients can both send id=1;
    // neither may cancel the other's child or leave it orphaned on disconnect.
    const requests = new Map<number | string, AbortController>();
    const executions = new Map<number | string, Promise<ExecResult>>();
    const requestMethods = new Map<number | string, string>();
    const requestCallerLabels = new Map<number | string, ProcessExecCallerLabel>();
    const activeRequestSnapshot = (): Array<{
      requestId: number | string;
      method: string;
      callerLabel?: ProcessExecCallerLabel;
    }> => Array.from(requestMethods, ([requestId, method]) => {
      const callerLabel = requestCallerLabels.get(requestId);
      return { requestId, method, ...(callerLabel ? { callerLabel } : {}) };
    });
    const connectionId = randomUUID();
    const connection = { socket, requests, executions, requestMethods, clientConnectionId: null as string | null };
    connections.set(connectionId, connection);
    const forgetDrainedConnection = (): void => {
      if (socket.destroyed && requests.size === 0) connections.delete(connectionId);
    };
    socket.once('close', () => {
      clients.delete(socket);
      for (const controller of requests.values()) controller.abort();
      forgetDrainedConnection();
    });
    const write = (obj: object): void => {
      if (socket.destroyed) return;
      socket.write(JSON.stringify(obj) + '\n');
    };

    const handleLine = async (line: string): Promise<void> => {
      // A recovery connection can revoke this socket while already-buffered
      // frames remain. None may create work after the drain barrier.
      if (socket.destroyed) return;
      let req: { jsonrpc?: string; method?: string; params?: unknown; id?: number | string | null; clientConnectionId?: string };
      try {
        req = JSON.parse(line);
      } catch {
        write(rpcError(-32700, 'Parse error', null));
        return;
      }
      const id = req.id ?? null;
      if (!req.method) {
        write(rpcError(-32600, 'Invalid Request', id));
        return;
      }
      if (
        connection.clientConnectionId === null &&
        typeof req.clientConnectionId === 'string' &&
        /^[0-9a-f-]{36}$/i.test(req.clientConnectionId)
      ) {
        connection.clientConnectionId = req.clientConnectionId;
      }

      if (req.method === 'spawn:invokeOnce') {
        if (id === null) {
          write(rpcError(-32600, 'spawn:invokeOnce requires an id', null));
          return;
        }
        const p = (req.params ?? {}) as InvokeOnceParams;
        const controller = new AbortController();
        controllers.add(controller);
        requests.set(id, controller);
        requestMethods.set(id, req.method);
        try {
          const result: SpawnInvokeOnceResult = await spawnInvokeOnce(
            p.projectDir,
            p.role,
            p.extras,
            p.extraEnv,
            {
              signal: controller.signal,
              timeoutMs: p.timeoutMs,
              resultPath: p.resultPath,
              forceSessionId: p.forceSessionId,
              taskSpawnId: p.taskSpawnId,
              onChildPid: (pid) => write(rpcNotification('spawn:pid', { requestId: id, pid })),
              onOutputActivity: () => write(rpcNotification('spawn:outputActivity', { requestId: id })),
            },
          );
          write(rpcResult(result, id));
        } catch (e) {
          const err = e as { message?: string };
          write(rpcError(-32603, err.message ?? 'Internal error', id));
        } finally {
          controllers.delete(controller);
          requests.delete(id);
          requestMethods.delete(id);
          requestCallerLabels.delete(id);
          forgetDrainedConnection();
          exitWhenDrained();
        }
        return;
      }

      if (req.method === 'process:exec') {
        if (id === null) {
          write(rpcError(-32600, 'process:exec requires an id', null));
          return;
        }
        const params = (req.params ?? {}) as ExecParams;
        if (params.fence && (params.fence.serverGeneration !== serverGeneration || params.fence.connectionId !== connectionId)) {
          write(rpcResult({ code: -1, stdout: '', stderr: 'spawner sidecar execution fence mismatch before spawn' }, id));
          return;
        }
        // Reusing an in-flight id could hide the original process from both
        // cancellation and draining. Refuse it before any admission or spawn.
        if (requests.has(id)) {
          write(rpcError(-32600, 'request id already active', id));
          return;
        }
        const controller = new AbortController();
        controllers.add(controller);
        requests.set(id, controller);
        requestMethods.set(id, req.method);
        const callerLabel = params.callerLabel;
        if (callerLabel && SAFE_PROCESS_EXEC_CALLER_LABELS.has(callerLabel)) {
          requestCallerLabels.set(id, callerLabel);
        }
        try {
          const executionParams = { ...params };
          delete executionParams.callerLabel;
          const execution = (deps.executeProcess ?? execProcess)(executionParams, {
            signal: controller.signal,
            onPid: (pid) => write(rpcNotification('spawn:pid', { requestId: id, pid })),
            onOutputActivity: () => write(rpcNotification('spawn:outputActivity', { requestId: id })),
          });
          executions.set(id, execution);
          const result = await execution;
          write(rpcResult(result, id));
        } catch (e) {
          const err = e as { message?: string };
          write(rpcError(-32603, err.message ?? 'Internal error', id));
        } finally {
          controllers.delete(controller);
          requests.delete(id);
          requestMethods.delete(id);
          requestCallerLabels.delete(id);
          executions.delete(id);
          forgetDrainedConnection();
          exitWhenDrained();
        }
        return;
      }

      if (req.method === 'process:drain') {
        const p = (req.params ?? {}) as { serverGeneration?: string; connectionId?: string; requestId?: number | string };
        if (id === null) return;
        if (p.serverGeneration !== serverGeneration) {
          write(rpcError(-32600, 'server generation mismatch; exit is unverified', id));
          return;
        }
        if (typeof p.connectionId !== 'string' || p.requestId == null) {
          write(rpcError(-32600, 'connectionId and requestId are required', id));
          return;
        }
        if (p.connectionId === connectionId) {
          write(rpcError(-32600, 'process:drain requires a different connection', id));
          return;
        }
        const original = connections.get(p.connectionId);
        const execution = original?.executions.get(p.requestId);
        console.info('[spawner-process-drain]', {
          serverGeneration,
          recoveryConnectionId: connectionId,
          recoveryClientConnectionId: connection.clientConnectionId,
          targetServerGeneration: p.serverGeneration,
          targetConnectionId: p.connectionId,
          targetClientConnectionId: original?.clientConnectionId ?? null,
          targetRequestId: p.requestId,
          targetMethod: original?.requestMethods.get(p.requestId) ?? null,
          targetExecutionPresent: execution !== undefined,
        });
        // Close FIRST, before awaiting admission or exit: even an absent
        // request is now fenced against later delivery on the old connection.
        original?.socket.destroy();
        for (const controller of original?.requests.values() ?? []) controller.abort();
        try {
          const result = execution ? await execution : null;
          // A deleted connection/request has already drained. Lost results
          // remain unknown (null); they are never replayed to reconstruct one.
          write(rpcResult({ exitConfirmed: true, result }, id));
        } catch (error) {
          write(rpcError(-32603, `process exit proof unavailable: ${String(error)}`, id));
        }
        return;
      }

      if (req.method === 'spawn:cancel') {
        const p = (req.params ?? {}) as { requestId?: number | string };
        const controller = p.requestId != null ? requests.get(p.requestId) : undefined;
        if (controller) controller.abort();
        // cancelled acknowledges the signal, not child exit. The original
        // process:exec result is sent only after the child closes.
        if (id !== null) write(rpcResult({
          cancelled: !!controller, processExecCancellation: true,
          processExecFence: { serverGeneration, connectionId },
          processExecIdentity,
          processExecContainment: captureSidecarContainment(process.env[SPAWNER_SCOPE_ENV]),
        }, id));
        return;
      }

      write(rpcError(-32601, 'Method not found', id));
    };

    // Decode across socket-chunk boundaries. `chunk.toString()` on a chunk that
    // ends mid-UTF-8-sequence yields replacement chars, which here corrupts the
    // JSON REQUEST itself (parse error, or worse a silently wrong argv/cwd) —
    // not merely a payload. Any request carrying non-ASCII in args/env/cwd can
    // trip it, so the control channel gets the same StringDecoder treatment.
    const requestDecoder = new StringDecoder('utf8');
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += requestDecoder.write(chunk);
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) void handleLine(line);
      }
    });
    socket.on('error', (err) => {
      const errno = err as NodeJS.ErrnoException;
      console.error('[spawner-socket-error]', {
        serverGeneration,
        connectionId,
        clientConnectionId: connection.clientConnectionId,
        errorCode: errno.code ?? null,
        errorName: err.name,
        activeRequests: activeRequestSnapshot(),
      });
    });
    socket.on('end', () => {
      const activeRequests = activeRequestSnapshot();
      if (activeRequests.length === 0) return;
      console.warn('[spawner-socket-peer-eof]', {
        serverGeneration,
        connectionId,
        clientConnectionId: connection.clientConnectionId,
        activeRequests,
      });
    });
  });

  void listenUnixSocketExclusive(server, socketPath).then(
    (outcome) => {
      if (outcome === 'in-use') {
        // A sibling's sidecar is live on this path, so we were spawned in error. Exit
        // WITHOUT the exit hook: `unlinkSocket` would delete the path the live
        // sidecar serves. The host adopts that sidecar on this exit code.
        process.off('exit', unlinkSocket);
        console.error(`[spawner-sidecar] EADDRINUSE: a live sidecar already serves ${socketPath}; exiting so the host adopts it`);
        process.exit(SIDECAR_EXIT_SOCKET_IN_USE);
      }
      // Attached only after the bind: during it, an EADDRINUSE belongs to the helper.
      server.on('error', (err) => {
        console.error('[spawner-server-error]', err.message);
        process.exit(1);
      });
      console.log(`[spawner-sidecar] listening on ${socketPath}`);
      console.log(`PAPERCUSP_SPAWNER_READY socket=${socketPath}`);
      console.log(`PAPERCUSP_SPAWNER_IDENTITY ${JSON.stringify({ ...processExecIdentity, serverGeneration })}`);
    },
    (err: Error) => {
      console.error('[spawner-server-error]', err.message);
      process.exit(1);
    },
  );

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[spawner-sidecar] ${signal} received, shutting down gracefully`);
    for (const controller of controllers.values()) controller.abort();
    for (const client of clients) client.destroy();
    server.close(() => {
      // Socket closure is not command exit. Keep this process alive so its
      // cancellation escalation and admission settlement can finish first.
      socketsClosed = true;
      exitWhenDrained();
    });
  };
  const onTerm = (): void => shutdown('SIGTERM');
  const onInterrupt = (): void => shutdown('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInterrupt);
  server.once('close', () => {
    process.off('exit', unlinkSocket);
    // Repeated termination signals must not bypass a shutdown still draining
    // children. Ordinary server.close() (tests/embedding) still removes hooks.
    if (!shuttingDown) {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInterrupt);
    }
    unlinkSocket();
  });

  armSpawnerSidecarOrphanWatchdog(socketPath, shutdown);
  return server;
}
