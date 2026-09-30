/**
 * OMP 18 owned in-process MCP extension. Built with the same client assembly
 * ptool uses; no stdio child, forked runtime, or HTTP intermediary on the UDS leg.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  connectAgentMcp, type NativeOmpConfig,
} from '../../operator-core/lib/agent-mcp-client';

export interface NativeExtensionApi {
  registerTool(tool: {
    name: string; label: string; description: string; parameters: unknown;
    mcpServerName: string; mcpToolName: string; approval: 'read' | 'write';
    strict: false;
    execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  }): void;
  on(name: 'session_shutdown', handler: () => Promise<void>): void;
}

export async function registerNativeMcp(pi: NativeExtensionApi, config: NativeOmpConfig): Promise<void> {
  const native = config.papercuspNativeMcp;
  if (!native || native.version !== 1) return;
  const connections: Array<Awaited<ReturnType<typeof connectAgentMcp>>> = [];
  pi.on('session_shutdown', async () => {
    await Promise.allSettled(connections.map(x => x.client.close()));
  });
  try {
    for (const [name, server] of Object.entries(native.servers)) {
      if (!server.url) throw new Error('native_mcp_url_missing');
      const headers = { ...server.headers };
      for (const value of Object.values(headers)) {
        // Never run shell-derived headers inside this adapter. The launcher
        // resolves its known credential fields before handing us the config.
        if (value.startsWith('!')) throw new Error('native_mcp_unresolved_header');
      }
      const connection = await connectAgentMcp({
        url: server.url, headers, mode: native.mode, home: native.home,
        name: 'papercusp-omp-native', timeoutMs: 15_000,
      });
      connections.push(connection);
      const { client } = connection;
      let catalog = new Set<string>();
      const refresh = async () => {
        const next = new Set<string>();
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          for (const tool of page.tools) {
            next.add(tool.name);
            pi.registerTool({
              name: `mcp__${name}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_'),
              label: `${name}/${tool.name}`, description: tool.description ?? '',
              parameters: tool.inputSchema, mcpServerName: name, mcpToolName: tool.name,
              approval: tool.annotations?.readOnlyHint === true ? 'read' : 'write', strict: false,
              async execute(_id, params, signal) {
                if (!catalog.has(tool.name)) throw new Error('native_mcp_tool_removed');
                const result = await client.callTool({ name: tool.name, arguments: params }, undefined, { signal });
                return {
                  content: result.content,
                  details: {
                    ...result,
                    // Client-observed connection, never a server-authored claim.
                    // Keep compact model-visible content untouched and expose no
                    // socket paths, credential headers or credential-bearing URLs.
                    nativeMcp: {
                      transportKind: connection.transportKind,
                      ...(connection.operatorId ? { operatorId: connection.operatorId } : {}),
                      ...(connection.generation ? { generation: connection.generation } : {}),
                    },
                  },
                  isError: result.isError,
                };
              },
            });
          }
          cursor = page.nextCursor;
          if (cursor && seenCursors.has(cursor)) throw new Error('native_mcp_catalog_cursor_cycle');
          if (cursor) seenCursors.add(cursor);
        } while (cursor);
        catalog = next;
      };
      // SDK notifications are PUSH. Removed entries cannot execute through old
      // OMP registrations; new/changed entries replace the named registration.
      client.setNotificationHandler(ToolListChangedNotificationSchema, refresh);
      await refresh();
    }
  } catch (error) {
    await Promise.allSettled(connections.map(x => x.client.close()));
    throw error;
  }
}

export default async function nativeExtension(pi: NativeExtensionApi): Promise<void> {
  const explicitAgent = process.env.PI_CODING_AGENT_DIR;
  const configRoot = process.env.PI_CONFIG_DIR;
  const agentDir = explicitAgent ?? (configRoot
    ? join(isAbsolute(configRoot) ? configRoot : join(homedir(), configRoot), 'agent')
    : join(homedir(), '.omp', 'agent'));
  const raw = await readFile(join(agentDir, 'mcp.json'), 'utf8');
  await registerNativeMcp(pi, JSON.parse(raw));
}
