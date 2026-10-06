/** Operator transport for the managed, cgroup-isolated LSP daemon. */
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { managedSpawn } from '../task-manager/managed-spawn.ts';
import { newTaskId } from '../task-manager/types.ts';
import { resolveSidecarSpawnPlan } from '../process-supervision/sidecar-spawn-shared.ts';
import { probeUnixSocketAlive } from '../sidecar-socket/pid-keyed-socket.ts';
import { LSP_DAEMON_SOCKET_ENV, resolveLspDaemonSocketPath } from './lsp-daemon-socket.ts';
import type { LspDaemonRequest, LspDaemonApplyRequest, LspDaemonAnswer } from './lsp-daemon-protocol.ts';
import type { CodeIntelAnswer } from './contracts.ts';
import type { LspAdmissionSnapshot } from './lsp-admission.ts';
import type { lspRenameWorkspaceEdit } from './lsp-adapter.ts';

type LspRenameResult = Awaited<ReturnType<typeof lspRenameWorkspaceEdit>>;

let starting: Promise<void> | null = null;

async function ensureLspDaemon(): Promise<void> {
  const socketPath = resolveLspDaemonSocketPath();
  if (await probeUnixSocketAlive(socketPath)) return;
  if (starting) return starting;
  starting = (async () => {
    // Another cluster worker may be starting the same pinned sidecar. The
    // exclusive socket listener decides ownership; every worker then adopts it.
    if (await probeUnixSocketAlive(socketPath)) return;
    const selfPath = fileURLToPath(import.meta.url);
    const plan = resolveSidecarSpawnPlan({
      selfPath,
      devScriptPath: resolve(dirname(selfPath), '../../../../apps/operator/bin/lsp-daemon.ts'),
      bundledModeEnvVar: 'PAPERCUSP_LSP_DAEMON_MODE',
      execPath: process.execPath,
      spawnerPid: process.pid,
    });
    const taskId = newTaskId();
    const managed = await managedSpawn(plan.cmd, plan.args, {
      class: 'sidecar', title: 'LSP service daemon', argv: [plan.cmd, ...plan.args],
      launchedBy: 'code-intelligence:lsp-daemon',
      planSlug: 'lsp-fleet-scale-all-languages-2026-08-21',
      detail: { socketPath, subsystem: 'code-intelligence' },
    }, {
      taskId,
      spawnOptions: {
        env: { ...process.env, ...plan.env, [LSP_DAEMON_SOCKET_ENV]: socketPath,
          PAPERCUSP_HONO_PORT: '0', PORT: '0', PAPERCUSP_BACKGROUND_WORKERS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: false,
      },
    });
    if (!managed.confined) {
      managed.child.kill('SIGTERM');
      throw new Error(`LSP daemon ${taskId} could not enter a managed cgroup`);
    }
    // Drain pipes even when no caller is looking at startup diagnostics.
    let stderrTail = '';
    managed.child.stdout?.resume();
    managed.child.stderr?.setEncoding('utf8');
    managed.child.stderr?.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-4000);
    });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await probeUnixSocketAlive(socketPath)) return;
      if (managed.child.exitCode !== null) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error(`LSP daemon did not bind ${socketPath}: ${stderrTail || 'no stderr'}`);
  })().finally(() => { starting = null; });
  return starting;
}

/** One request per socket. A dropped connection cancels its daemon request. */
async function callLspDaemonFrame<T>(
  socketPath: string,
  method: 'lsp:query' | 'lsp:admission' | 'lsp:rename' | 'lsp:diagnostic-count' | 'lsp:resync',
  params: LspDaemonRequest | LspDaemonApplyRequest | { workspaceId: string },
  valid: (result: unknown) => result is T,
  timeoutMs: number,
  requestId?: string,
): Promise<T> {
  const id = requestId ?? randomUUID();
  return new Promise<T>((resolveAnswer, reject) => {
    const socket = connect(socketPath);
    let settled = false;
    let data = '';
    const finish = (error?: Error, answer?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolveAnswer(answer!);
    };
    const timer = setTimeout(() => finish(new Error('LSP daemon RPC deadline elapsed')), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`));
    socket.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 33_554_432) { finish(new Error('LSP daemon response exceeded 32 MiB')); return; }
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const reply = JSON.parse(data.slice(0, end)) as { id?: string; result?: unknown; error?: { message?: string } };
        if (reply.id !== id) throw new Error('LSP daemon response id mismatch');
        if (reply.error) throw new Error(reply.error.message || 'LSP daemon error');
        if (!valid(reply.result)) throw new Error(`Invalid LSP daemon ${method} response`);
        finish(undefined, reply.result);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.once('error', (error) => finish(error));
    socket.once('close', () => { if (!settled) finish(new Error('LSP daemon closed without an answer')); });
  });
}

export function callLspDaemonRpc(socketPath: string, request: LspDaemonRequest, timeoutMs = 90_000, requestId?: string): Promise<LspDaemonAnswer> {
  return callLspDaemonFrame(socketPath, 'lsp:query', request,
    (result): result is CodeIntelAnswer => !!result && typeof result === 'object' &&
      Array.isArray((result as CodeIntelAnswer).sites) && !!(result as CodeIntelAnswer).freshness,
    timeoutMs, requestId);
}

/** Full daemon-owned inventory via the existing health operation, not local adapter state. */
export async function readLspDaemonHealth(workspaceId: string): Promise<NonNullable<LspDaemonAnswer['daemonRuntime']>> {
  await ensureLspDaemon();
  const answer = await callLspDaemonRpc(resolveLspDaemonSocketPath(), { op: 'health', args: {}, workspaceId, archive: true }, 10_000);
  if (!answer.daemonRuntime || !Number.isFinite(answer.daemonRuntime.sampledAtMs))
    throw new Error('daemon health inventory unavailable; reload the owning runtime');
  return answer.daemonRuntime;
}

/** The operator observes the daemon's live controller, never its own singleton. */
export async function readLspDaemonAdmission(workspaceId: string): Promise<LspAdmissionSnapshot> {
  if (!workspaceId) throw new Error('LSP admission workspaceId is required');
  await ensureLspDaemon();
  return callLspDaemonFrame(resolveLspDaemonSocketPath(), 'lsp:admission', { workspaceId },
    (result): result is LspAdmissionSnapshot => !!result && typeof result === 'object' &&
      (result as LspAdmissionSnapshot).measured === true &&
      Number.isFinite((result as LspAdmissionSnapshot).sampledAtMs) &&
      Array.isArray((result as LspAdmissionSnapshot).classes),
    5_000);
}

export async function computeLspDaemonRename(request: LspDaemonApplyRequest): Promise<LspRenameResult> {
  await ensureLspDaemon();
  return callLspDaemonFrame(resolveLspDaemonSocketPath(), 'lsp:rename', request,
    (result): result is LspRenameResult => !!result && typeof result === 'object' &&
      typeof (result as LspRenameResult).ok === 'boolean',
    Math.max(1, (request.deadlineAtMs ?? Date.now() + 90_000) - Date.now()));
}

export async function countLspDaemonDiagnostics(request: LspDaemonApplyRequest): Promise<number | null> {
  await ensureLspDaemon();
  return callLspDaemonFrame(resolveLspDaemonSocketPath(), 'lsp:diagnostic-count', request,
    (result): result is number | null => result === null || (Number.isInteger(result) && (result as number) >= 0),
    Math.max(1, (request.deadlineAtMs ?? Date.now() + 90_000) - Date.now()));
}

export async function resyncLspDaemonDocument(request: LspDaemonApplyRequest): Promise<boolean> {
  await ensureLspDaemon();
  return callLspDaemonFrame(resolveLspDaemonSocketPath(), 'lsp:resync', request,
    (result): result is boolean => typeof result === 'boolean',
    Math.max(1, (request.deadlineAtMs ?? Date.now() + 30_000) - Date.now()));
}

export async function queryLspDaemon(request: LspDaemonRequest): Promise<CodeIntelAnswer> {
  const startedAt = Date.now();
  try {
    await ensureLspDaemon();
    return await callLspDaemonRpc(resolveLspDaemonSocketPath(), request, Math.max(1, (request.deadlineAtMs ?? startedAt + 90_000) - Date.now()));
  } catch (error) {
    return {
      backend: 'lsp-adapter', intent: 'diagnostics', query: request.args.file ?? request.args.name ?? request.op,
      sites: [], truncation: { truncated: false, totalAvailable: null, continuation: null },
      freshness: { health: 'unhealthy', indexedAt: null, staleVsDisk: null, indexedCommit: null },
      latencyMs: Date.now() - startedAt,
      error: `LSP daemon unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
