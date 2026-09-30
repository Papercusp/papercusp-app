/**
 * Owned desktop client assembly. Reuses the SDK, verified discovery and the
 * existing UDS transport; contains no second JSON-RPC implementation.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { UdsMcpTransport } from '@papercusp/tooldef-mcp/uds-transport';
import { AGENT_MCP_AUTH_META, readAgentMcpDiscoveryForPort } from './endpoint-ipc-discovery';

export type AgentMcpMode = 'http' | 'uds' | 'auto';

export function agentMcpMode(value: string | undefined): AgentMcpMode {
  // P009 alone changes rollout policy after the pre-registered P008 budgets.
  if (value === undefined || value === '') return 'http';
  if (value === 'http' || value === 'uds' || value === 'auto') return value;
  throw new Error('Invalid MCP transport; expected http, uds or auto');
}

export function localAgentMcpPort(
  value: string,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (!['linux', 'darwin'].includes(platform) || env.WSL_INTEROP ||
      env.WSL_DISTRO_NAME || env.PAPERCUSP_IPC_TCP === '1') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !['/api/mcp', '/api/agent-mcp'].includes(url.pathname)) return null;
    return Number(url.port || 80);
  } catch { return null; }
}

export interface AgentMcpClientOptions {
  url: string;
  headers?: Record<string, string>;
  mode?: AgentMcpMode;
  /** Real operator home, preserved when an owned launcher isolates child HOME. */
  home?: string;
  timeoutMs?: number;
  name?: string;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}

/** A lost response is not evidence that a mutation failed or rolled back. */
export class AgentMcpOutcomeUnknownError extends Error {
  readonly code = 'uds_outcome_unknown';
  readonly outcome = 'unknown';
  readonly automaticRetry = false;
  constructor() {
    super('uds_outcome_unknown: connection lost or request cancelled/timed out; mutation outcome UNKNOWN. ' +
      'No automatic retry, reconnect or HTTP fallback occurred. Read current state before retrying; ' +
      'recover a committed result with the original transport idempotency key, never a fresh key.');
    this.name = 'AgentMcpOutcomeUnknownError';
  }
}

class UdsAgentMcpClient extends Client {
  override async callTool(...args: Parameters<Client['callTool']>): ReturnType<Client['callTool']> {
    try {
      return await super.callTool(...args);
    } catch (error) {
      // The SDK replaces transport.onclose's descriptive error with a generic
      // ConnectionClosed for pending requests. Translate at the owned client
      // seam, not by forging a server response in the JSON-RPC transport.
      // Presend admission, schema and auth errors retain their precise errors.
      if (error instanceof McpError &&
          (error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout)) {
        throw new AgentMcpOutcomeUnknownError();
      }
      throw error;
    }
  }
}

export async function connectAgentMcp(options: AgentMcpClientOptions): Promise<{
  client: Client;
  transportKind: 'http' | 'uds';
  operatorId?: string;
  generation?: string;
}> {
  const mode = options.mode ?? 'http';
  const port = localAgentMcpPort(options.url, options.platform, options.env);
  const descriptor = mode !== 'http' && port !== null
    ? await readAgentMcpDiscoveryForPort(port, options.home) : null;
  if (mode === 'uds' && !descriptor?.agentMcp)
    throw new Error('uds_endpoint_unavailable');
  const endpoint = descriptor?.agentMcp;
  let transport: Transport;
  if (endpoint) {
    const wire = new UdsMcpTransport({
      path: endpoint.socketPath,
      ...(options.timeoutMs ? { connectTimeoutMs: options.timeoutMs } : {}),
    });
    const send = wire.send.bind(wire);
    const credentials = {
      version: 1, operatorId: endpoint.operatorId, generation: endpoint.generation,
      url: options.url, headers: { ...options.headers },
    };
    wire.send = message => send('method' in message && message.method === 'initialize'
      ? { ...message, params: { ...message.params, _meta: {
        ...message.params?._meta, [AGENT_MCP_AUTH_META]: credentials,
      } } } : message);
    transport = wire;
  } else {
    transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: options.headers },
    });
  }
  const ClientClass = endpoint ? UdsAgentMcpClient : Client;
  const client = new ClientClass({ name: options.name ?? 'papercusp-native', version: '1' });
  try {
    await client.connect(transport, options.timeoutMs ? { timeout: options.timeoutMs } : undefined);
    return {
      client, transportKind: endpoint ? 'uds' : 'http',
      ...(endpoint ? { operatorId: endpoint.operatorId, generation: endpoint.generation } : {}),
    };
  } catch {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    // NEVER fall back/replay after sending initialize, or expose credential URLs.
    throw new Error(endpoint ? 'uds_connection_failed' : 'http_connection_failed');
  }
}

type ServerConfig = { url?: string; headers?: Record<string, string>; type?: string };
export interface NativeOmpConfig {
  mcpServers?: Record<string, ServerConfig>;
  papercuspNativeMcp?: {
    version: 1;
    mode: AgentMcpMode;
    home?: string;
    servers: Record<string, ServerConfig>;
  };
  [key: string]: unknown;
}

/** Only owned OMP launches call this. Never emit invented unix:// MCP config. */
export function prepareNativeOmpConfig(
  text: string,
  options: { mode: AgentMcpMode; home?: string; platform?: string; env?: NodeJS.ProcessEnv },
): string {
  if (options.mode === 'http') return text;
  const config = JSON.parse(text) as NativeOmpConfig;
  const servers: Record<string, ServerConfig> = {};
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (!server.url || localAgentMcpPort(server.url, options.platform, options.env) === null ||
        (server.type && server.type !== 'http')) continue;
    const headers = { ...server.headers };
    const env = options.env ?? process.env;
    const known = {
      'x-papercusp-client': 'PAPERCUSP_SID',
      'x-papercusp-workspace': 'PAPERCUSP_WORKSPACE',
      'x-papercusp-profile': 'PAPERCUSP_PROFILE',
    };
    for (const [header, variable] of Object.entries(known)) {
      if (headers[header] === `!printf %s "\${${variable}:-}"`) {
        if (env[variable]) headers[header] = env[variable]!;
        else delete headers[header];
      }
    }
    // Unknown shell headers stay on the existing client which owns their
    // semantics. This library is deliberately not a shell-execution engine.
    if (Object.values(headers).some(value => value.startsWith('!'))) continue;
    servers[name] = { ...server, headers };
    delete config.mcpServers![name];
  }
  if (Object.keys(servers).length) {
    config.papercuspNativeMcp = {
      version: 1, mode: options.mode, home: options.home, servers,
    };
  }
  return JSON.stringify(config);
}
