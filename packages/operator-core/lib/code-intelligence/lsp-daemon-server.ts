/** Owns language-server processes and adapter state outside the operator process. */
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listenUnixSocketExclusive, SIDECAR_EXIT_SOCKET_IN_USE } from '../sidecar-socket/pid-keyed-socket.ts';
import { resolveLspDaemonSocketPath, reapOrphanedLspDaemonSockets } from './lsp-daemon-socket.ts';
import { resolveLspDaemonDispatchContext, type LspDaemonRequest, type LspDaemonApplyRequest } from './lsp-daemon-protocol.ts';
import { lspAdmissionController, runLspAdmission } from './lsp-admission.ts';
import { lspDaemonFacade, lspHealth } from './lsp-daemon-facade.ts';
import { languageForFile, resolveProjectRoot, lspRenameWorkspaceEdit, lspDiagnostics, lspResyncDocument } from './lsp-adapter.ts';
import { isTrustworthyEmpty } from './contracts.ts';
import { lspDaemonCostKey } from './lsp-daemon-cost-key.ts';
import { activeWorkspaceId } from '../workspace-registry.ts';
import type { CodeIntelAnswer } from './contracts.ts';
import { newLspQueryEvidence, withLspQueryEvidence, lspEvidenceNow } from './lsp-query-evidence.ts';
import type { LspDaemonAnswer } from './lsp-daemon-protocol.ts';

interface RpcRequest { jsonrpc: '2.0'; id: string; method: 'lsp:query' | 'lsp:cancel' | 'lsp:admission' | 'lsp:rename' | 'lsp:diagnostic-count' | 'lsp:resync'; params: LspDaemonRequest | LspDaemonApplyRequest | { requestId: string } | { workspaceId: string } }

export async function dispatchLspDaemonApply(
  method: 'lsp:rename' | 'lsp:diagnostic-count' | 'lsp:resync',
  request: LspDaemonApplyRequest,
  requestId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const { file, rootPath, workspaceId } = request;
  if (!workspaceId || !file || !rootPath) throw new Error('LSP apply request requires workspaceId, file and rootPath');
  if (method === 'lsp:resync') {
    if (typeof request.newText !== 'string') throw new Error('LSP resync requires newText');
    return lspResyncDocument(file, rootPath, request.newText);
  }
  const language = languageForFile(file);
  const project = language ? resolveProjectRoot(language, file, rootPath) : null;
  const task = async () => {
    if (method === 'lsp:rename') {
      if (!Number.isInteger(request.line1) || !Number.isInteger(request.character) || !request.newName)
        throw new Error('LSP rename requires line1, character and newName');
      return lspRenameWorkspaceEdit({ file, rootPath, line1: request.line1!, character: request.character!, newName: request.newName });
    }
    const answer = await lspDiagnostics({ file, rootPath });
    if (answer.error) return null;
    if (answer.sites.length === 0) return isTrustworthyEmpty(answer) ? 0 : null;
    return answer.sites.length;
  };
  if (!language || !project || project.error) return task();
  return lspAdmissionController(workspaceId).run({
    workspaceId, requestId, language, projectRoot: project.root, op: method,
    actor: request.actorId, deadlineAtMs: request.deadlineAtMs ?? Date.now() + 90_000,
    signal, query: file, queryKey: await lspDaemonCostKey(method, request),
  }, task);
}

export async function dispatchLspDaemonRequest(
  request: LspDaemonRequest,
  requestId: string,
  signal: AbortSignal,
): Promise<LspDaemonAnswer> {
  const context = resolveLspDaemonDispatchContext(request, signal);
  const evidence = request.archive === true ? newLspQueryEvidence(requestId) : undefined;
  const task = () => withLspQueryEvidence(evidence, () => lspDaemonFacade(request.op, request.args, evidence ? 'archive' : 'context'));
  // The local facade owns the original exact refusals and the flag check. An
  // incomplete request never reaches admission or an adapter child.
  const answer = !context ? await task() : await runLspAdmission({
    workspaceId: request.workspaceId ?? activeWorkspaceId(),
    requestId,
    language: context.language,
    projectRoot: context.projectRoot,
    op: request.op,
    actor: request.actorId,
    priority: request.priority,
    deadlineAtMs: request.deadlineAtMs ?? Date.now() + 90_000,
    signal,
    query: request.args.file ?? request.args.name ?? request.op,
    queryKey: await lspDaemonCostKey(request.op, request.args),
    observe: evidence ? event => evidence.events.push(event) : undefined,
  }, task);
  if (!evidence) return answer;
  evidence.respondedAtMs = lspEvidenceNow();
  return { ...answer, daemonEvidence: evidence,
    ...(request.op === 'health' ? { daemonRuntime: { ...await lspHealth(), pid: process.pid,
      node: process.version, entry: import.meta.url, sampledAtMs: lspEvidenceNow() } } : {}) };
}

/** Start once per host; all cluster workers address the primary's pinned socket. */
export function runLspDaemonServer(
  execute: typeof dispatchLspDaemonRequest = dispatchLspDaemonRequest,
  executeApply: typeof dispatchLspDaemonApply = dispatchLspDaemonApply,
  shutdown?: (closeRpc: () => Promise<void>) => void,
): Server {
  const socketPath = resolveLspDaemonSocketPath();
  mkdirSync(dirname(socketPath), { recursive: true });
  reapOrphanedLspDaemonSockets();
  const clients = new Map<Socket, Map<string, AbortController>>();
  const server = createServer((socket) => {
    const controllers = new Map<string, AbortController>();
    clients.set(socket, controllers);
    let buffer = '';
    const send = (value: unknown) => { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); };
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 16_777_216) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let frame: RpcRequest;
        try { frame = JSON.parse(line) as RpcRequest; }
        catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); continue; }
        if (frame.jsonrpc !== '2.0' || typeof frame.id !== 'string') {
          send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }); continue;
        }
        if (frame.method === 'lsp:cancel') {
          const target = (frame.params as { requestId?: string })?.requestId;
          if (target) controllers.get(target)?.abort();
          send({ jsonrpc: '2.0', id: frame.id, result: { cancelled: Boolean(target && controllers.has(target)) } });
          continue;
        }
        if (frame.method === 'lsp:admission') {
          const workspaceId = (frame.params as { workspaceId?: unknown })?.workspaceId;
          if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
            send({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'workspaceId is required' } });
          } else {
            send({ jsonrpc: '2.0', id: frame.id, result: lspAdmissionController(workspaceId).snapshot() });
          }
          continue;
        }
        if (frame.method === 'lsp:rename' || frame.method === 'lsp:diagnostic-count' || frame.method === 'lsp:resync') {
          if (!frame.params || typeof frame.params !== 'object') {
            send({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'LSP apply parameters are required' } }); continue;
          }
          if (controllers.has(frame.id)) {
            send({ jsonrpc: '2.0', id: frame.id, error: { code: -32600, message: 'Duplicate request id' } }); continue;
          }
          const controller = new AbortController();
          controllers.set(frame.id, controller);
          void executeApply(frame.method, frame.params as LspDaemonApplyRequest, frame.id, controller.signal).then(
            (result) => send({ jsonrpc: '2.0', id: frame.id, result }),
            (error) => send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }),
          ).finally(() => controllers.delete(frame.id));
          continue;
        }
        if (frame.method !== 'lsp:query' || !frame.params || typeof (frame.params as LspDaemonRequest).op !== 'string') {
          send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported LSP method' } }); continue;
        }
        if (controllers.has(frame.id)) {
          send({ jsonrpc: '2.0', id: frame.id, error: { code: -32600, message: 'Duplicate request id' } }); continue;
        }
        const controller = new AbortController();
        controllers.set(frame.id, controller);
        void execute(frame.params as LspDaemonRequest, frame.id, controller.signal).then(
          (result) => send({ jsonrpc: '2.0', id: frame.id, result }),
          (error) => send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }),
        ).finally(() => controllers.delete(frame.id));
      }
    });
    socket.once('close', () => { clients.delete(socket); for (const controller of controllers.values()) controller.abort(); });
  });
  const closeRpc = () => new Promise<void>((resolve) => {
    // Abort before resolving the listener drain. Socket 'close' is delivered
    // later, so relying on it lets adapter/database teardown overtake work.
    for (const [client, controllers] of clients) {
      for (const controller of controllers.values()) controller.abort();
      client.destroy();
    }
    server.close(() => resolve());
  });
  // An embedded RPC server owns only its socket. The daemon entrypoint also
  // owns adapter children and database pools, and supplies its bounded drain.
  const cleanup = () => { if (shutdown) shutdown(closeRpc); else void closeRpc(); };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
  let ownsSocket = false;
  const unlinkOwnedSocket = () => { if (ownsSocket && existsSync(socketPath)) { try { unlinkSync(socketPath); } catch { /* stale socket reaped next start */ } } };
  process.once('exit', unlinkOwnedSocket);
  server.once('close', () => {
    process.off('SIGTERM', cleanup);
    process.off('SIGINT', cleanup);
    process.off('exit', unlinkOwnedSocket);
    unlinkOwnedSocket();
  });
  void listenUnixSocketExclusive(server, socketPath).then((state) => {
    if (state === 'in-use') process.exitCode = SIDECAR_EXIT_SOCKET_IN_USE;
    else { ownsSocket = true; process.stdout.write(`PAPERCUSP_LSP_DAEMON_READY ${randomUUID()}\n`); }
  }, (error) => { console.error('[lsp-daemon] socket bind failed', error); process.exitCode = 1; });
  return server;
}
