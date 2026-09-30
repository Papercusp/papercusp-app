/** Agent MCP listener. This is NOT the trusted webview endpoint-IPC channel. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, chmod, lstat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { UdsMcpTransport } from '@papercusp/tooldef-mcp';
import type { BuiltSpawnContext, TrySpawnContextResult } from './_mcp-host';
import { AGENT_MCP_AUTH_META, agentMcpOperatorId, type AgentMcpEndpoint } from '../../../endpoint-ipc-discovery';
import { allowStalePlanRecoveryForMcpCall } from '../../../agent-tools/_harness-scope';
import { loopPressure } from '../../../event-loop-lag-monitor';
import { acquireMcpBodyAdmission, ADMISSION_CONTROL_ENABLED, type McpAdmissionLease } from './mcp-admission';

/**
 * Client transport supplies this initialize.params._meta field, never the model.
 * It carries existing HTTP credential/context syntax, NOT a new credential.
 * Removed before SDK dispatch; neither discovery nor errors contain its contents.
 */
export { AGENT_MCP_AUTH_META };
const HEADER_NAMES = new Set([
  'authorization', 'x-papercusp-client', 'x-papercusp-workspace',
  'x-papercusp-harness', 'x-papercusp-profile', 'x-papercusp-agent',
  'x-papercusp-model', 'x-papercusp-call-origin',
]);

export interface AgentMcpHost {
  register(server: McpServer): void;
  options: ConstructorParameters<typeof McpServer>[1];
  verify(extra: unknown, options?: { allowStalePlanRecovery?: boolean }): Promise<TrySpawnContextResult>;
  /** Carry exactly the just-verified authority to the shared host dispatch. */
  pin?(info: object, ctx: BuiltSpawnContext, connection?: 'uds'): object;
}

export interface AgentMcpListener {
  endpoint: AgentMcpEndpoint;
  close(): Promise<void>;
}

function rejected(code: string): Error {
  // Never interpolate credentials, verifier exceptions, or untrusted metadata.
  return new Error(code);
}

type RequestInfo = { readonly url: string; readonly headers: Readonly<Record<string, string>> };
function sdkInfo(info: RequestInfo): NonNullable<MessageExtraInfo['requestInfo']> {
  // URL's setters survive Object.freeze. Keep a string privately and expose
  // fresh URL/header copies so a handler cannot mutate the connection carrier.
  return { url: new URL(info.url), headers: { ...info.headers } };
}
function credentialInfo(message: JSONRPCMessage, endpoint: AgentMcpEndpoint, port: number): RequestInfo {
  if (!('method' in message) || message.method !== 'initialize' || !('id' in message))
    throw rejected('uds_initialize_required');
  const meta = message.params?._meta as Record<string, unknown> | undefined;
  const raw = meta?.[AGENT_MCP_AUTH_META] as Record<string, unknown> | undefined;
  if (!raw || raw.version !== 1 || raw.operatorId !== endpoint.operatorId || raw.generation !== endpoint.generation)
    throw rejected('uds_endpoint_mismatch');
  if (typeof raw.url !== 'string' || raw.url.length > 16_384)
    throw rejected('uds_invalid_context');
  const url = new URL(raw.url);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      Number(url.port || 80) !== port || url.username || url.password ||
      !['/api/mcp', '/api/agent-mcp'].includes(url.pathname))
    throw rejected('uds_operator_mismatch');
  const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
  if (!raw.headers || typeof raw.headers !== 'object' || Array.isArray(raw.headers))
    throw rejected('uds_invalid_credentials');
  for (const [key, value] of Object.entries(raw.headers)) {
    const name = key.toLowerCase();
    if (!HEADER_NAMES.has(name) || typeof value !== 'string' || value.length > 16_384 || /[\r\n]/.test(value))
      throw rejected('uds_invalid_credentials');
    headers[name] = value;
  }
  // No ambient workspace fallback on the new authenticated connection.
  if (!(headers['x-papercusp-workspace'] || url.searchParams.get('workspace')))
    throw rejected('uds_workspace_required');
  return Object.freeze({ url: url.href, headers: Object.freeze(headers) });
}

function identity(ctx: BuiltSpawnContext): unknown {
  const { runId, spawnId, requestOrigin: _origin, dataPlaneDegradedAtMs: _warning, ...rest } = ctx;
  // SU/PI call IDs are deliberately ephemeral in the HTTP host. They are NOT
  // session identity and must not falsely reject the next request on a socket.
  return structuredClone({ ...rest, ...(ctx.sigVerifiedSpawn ? { runId, spawnId } : {}) });
}

function credentialVerified(result: TrySpawnContextResult): result is { kind: 'ok'; ctx: BuiltSpawnContext } {
  return result.kind === 'ok' && !!(
    result.ctx.isSuperuser || result.ctx.isPowerUser ||
    result.ctx.sigVerifiedSpawn || result.ctx.authenticatedPrincipal
  );
}

/**
 * Authentication adapter around the SAME SDK Transport. The short receive queue
 * serializes auth only, not tool execution, so full-duplex calls/cancel stay live.
 */
export function authenticatedAgentTransport(
  wire: Transport, host: AgentMcpHost, endpoint: AgentMcpEndpoint, port: number,
  authTimeoutMs = 5_000,
): Transport {
  let info: RequestInfo | undefined;
  let boundIdentity: unknown;
  let initialized = false;
  let initializeId: string | number | undefined;
  let initializeResponded = false;
  let closed = false;
  let queued = 0;
  let queuedBytes = 0;
  const leases = new Map<string | number, McpAdmissionLease>();
  const release = (id: string | number) => {
    leases.get(id)?.release();
    leases.delete(id);
  };
  let chain = Promise.resolve();
  const deadline = setTimeout(() => void close(), authTimeoutMs);
  deadline.unref();
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadline);
    for (const id of leases.keys()) release(id);
    await wire.close();
  };
  const adapter: Transport = {
    start: () => wire.start(),
    async send(message, options) {
      try {
        await wire.send(message, options);
        if ('result' in message && message.id === initializeId) initializeResponded = true;
      } catch (error) {
        // SDK logs a failed response send but cannot deliver that failure over
        // the refused frame. Close so the caller gets a bounded unknown outcome,
        // never silence until its unrelated multi-minute request timeout.
        await close();
        throw error;
      } finally {
        if ('id' in message && message.id !== undefined && !('method' in message)) release(message.id);
      }
    },
    close,
  };
  wire.onclose = () => {
    closed = true;
    clearTimeout(deadline);
    for (const id of leases.keys()) release(id);
    adapter.onclose?.();
  };
  wire.onerror = () => adapter.onerror?.(rejected('uds_transport_error'));
  const verify = async (requestInfo: RequestInfo, recovery: boolean) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        host.verify({ requestInfo: sdkInfo(requestInfo) }, { allowStalePlanRecovery: recovery }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(rejected('uds_auth_timeout')), authTimeoutMs);
          timer.unref();
        }),
      ]);
    } finally { clearTimeout(timer); }
  };
  wire.onmessage = (message) => {
    if (closed) return;
    const body = JSON.stringify(message);
    const bytes = Buffer.byteLength(body);
    queuedBytes += bytes;
    if (++queued > 64 || queuedBytes > 4_194_304) { void close(); return; }
    chain = chain.then(async () => {
      if (closed) return;
      try {
        const first = !info;
        let verifiedCtx: BuiltSpawnContext | undefined;
        if (first) {
          info = credentialInfo(message, endpoint, port);
          if ('id' in message) initializeId = message.id;
        } else if ('method' in message && (
          message.method === 'initialize' ||
          (message.params?._meta as Record<string, unknown> | undefined)?.[AGENT_MCP_AUTH_META] !== undefined
        )) {
          throw rejected('uds_identity_rebind_forbidden');
        }
        // SDK responses/cancellation remain full duplex; protected requests
        // (including catalogs) always recheck the original credential.
        if (first || ('method' in message && 'id' in message)) {
          const admission = acquireMcpBodyAdmission(body, info!.url, loopPressure(), ADMISSION_CONTROL_ENABLED);
          if (admission.response) {
            const error = await admission.response.json() as { error: { code: number; message: string } };
            if ('id' in message) await wire.send({ jsonrpc: '2.0', id: message.id, error: error.error });
            if (first) await close();
            return;
          }
          if (admission.lease && 'id' in message && message.id !== undefined) leases.set(message.id, admission.lease);
          const recovery = 'method' in message && message.method === 'tools/call' &&
            typeof message.params?.name === 'string' && allowStalePlanRecoveryForMcpCall(
              message.params.name,
              message.params.arguments && typeof message.params.arguments === 'object' &&
                !Array.isArray(message.params.arguments)
                ? message.params.arguments as Record<string, unknown> : {},
            );
          const result = await verify(info!, recovery);
          if (closed) return;
          if (!credentialVerified(result)) throw rejected('uds_auth_failed');
          verifiedCtx = result.ctx;
          const nextIdentity = identity(result.ctx);
          if (first) {
            boundIdentity = nextIdentity;
            // Pin inherited SU scope after verification; signed URLs are never
            // rewritten. All subsequent host verifications use this same input.
            if (result.ctx.isSuperuser) {
              info = Object.freeze({ ...info!, headers: Object.freeze({
                ...info!.headers,
                'x-papercusp-workspace': result.ctx.workspaceId,
                'x-papercusp-harness': result.ctx.harnessSlug,
                ...(result.ctx.uiClientId ? { 'x-papercusp-client': result.ctx.uiClientId } : {}),
              }) });
            }
            clearTimeout(deadline);
          } else if (!isDeepStrictEqual(boundIdentity, nextIdentity)) {
            throw rejected('uds_identity_changed');
          }
        }
        if ('method' in message && message.method === 'notifications/initialized') {
          if (!initializeResponded) throw rejected('uds_initialize_incomplete');
          initialized = true;
        }
        if (!first && !initialized) throw rejected('uds_initialized_required');
        if ('method' in message && message.method === 'notifications/cancelled') {
          const id = message.params?.requestId;
          if (typeof id === 'string' || typeof id === 'number') release(id);
        }
        let clean = message;
        if (first && 'method' in message) {
          const metadata = { ...(message.params?._meta as Record<string, unknown>) };
          delete metadata[AGENT_MCP_AUTH_META];
          clean = { ...message, params: { ...message.params, _meta: metadata } };
        }
        const freshInfo = sdkInfo(info!);
        const requestInfo = verifiedCtx && host.pin
          ? host.pin(freshInfo, verifiedCtx, 'uds') as NonNullable<MessageExtraInfo['requestInfo']>
          : freshInfo;
        adapter.onmessage?.(clean, { requestInfo });
      } catch (error) {
        if ('id' in message && 'method' in message) {
          const reason = error instanceof Error && /^uds_[a-z_]+$/.test(error.message)
            ? error.message : 'uds_auth_failed';
          await wire.send({ jsonrpc: '2.0', id: message.id, error: {
            code: -32001, message: 'uds_auth_failed: reconnect with current credentials and selected endpoint',
            data: { reason, retryable: false },
          } }).catch(() => {});
        }
        await close();
      }
    }).finally(() => { queued--; queuedBytes -= bytes; }).catch(() => { void close(); });
  };
  return adapter;
}

/** Private generation directory: never unlink or adopt another listener's path. */
export async function startAgentMcpServer(options: {
  port: number;
  host: AgentMcpHost;
  runtimeDir?: string;
  authTimeoutMs?: number;
}): Promise<AgentMcpListener> {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)
    throw new RangeError('Invalid operator port');
  const directory = await mkdtemp(join(options.runtimeDir ?? tmpdir(), 'pmcp-'));
  await chmod(directory, 0o700);
  const socketPath = join(directory, 'agent.sock');
  const endpoint: AgentMcpEndpoint = Object.freeze({
    version: 1, transport: 'uds', socketPath,
    operatorId: agentMcpOperatorId(options.port), generation: randomUUID(),
  });
  const connections = new Set<McpServer>();
  const server = createServer((socket) => {
    const sdk = new McpServer({ name: 'papercusp', version: '1.0.0' }, options.host.options);
    const transport = authenticatedAgentTransport(
      new UdsMcpTransport({ socket }), options.host, endpoint, options.port, options.authTimeoutMs,
    );
    connections.add(sdk);
    sdk.server.onclose = () => connections.delete(sdk);
    sdk.server.onerror = () => {}; // Generic errors only; never log private metadata.
    try {
      options.host.register(sdk);
      void sdk.connect(transport).catch(() => { connections.delete(sdk); void transport.close(); });
    } catch { connections.delete(sdk); void transport.close(); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await rmdir(directory).catch(() => {});
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const stopped = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.allSettled([...connections].map(sdk => sdk.close()));
    await stopped;
    // net.Server owns unlinking its socket. Refuse recursive removal; any
    // unexpected file is left untouched instead of erasing a peer's data.
    await rmdir(directory).catch(() => {});
  })();
  // Establish actual socket ownership before advertising it.
  const stat = await lstat(socketPath);
  if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) {
    await close();
    throw rejected('uds_socket_not_private');
  }
  return { endpoint, close };
}
