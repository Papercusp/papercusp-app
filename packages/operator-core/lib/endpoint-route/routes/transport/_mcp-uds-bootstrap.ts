import { startAgentMcpServer, type AgentMcpListener } from './_mcp-uds';
import { writeEndpointIpcDiscovery } from '../../../endpoint-ipc-discovery';
export { agentMcpBootstrapFailureCode } from './_mcp-uds-error';

/** UI startup stays independent; native MCP is advertised only after binding. */
export async function startDesktopAgentMcp(
  uiSocketPath: string,
  port: number,
): Promise<AgentMcpListener | null> {
  // Windows/WSL host boundaries and remote clients keep HTTP (plan D-009).
  if (!['linux', 'darwin'].includes(process.platform) ||
      process.env.PAPERCUSP_IPC_TCP === '1' || process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return null;
  let stopping = false;
  let listener: AgentMcpListener | undefined;
  const shutdown = () => { stopping = true; void listener?.close().catch(() => {}); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  const detach = () => {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  };
  try {
    const host = await import('./_mcp-host');
    await host.ensureOperatorToolsLoaded();
    if (stopping) { detach(); return null; }
    listener = await startAgentMcpServer({
      port, host: {
        register: host.registerMcpHost, options: host.mcpHostServerOptions(),
        verify: host.tryBuildSpawnContext, pin: host.pinVerifiedMcpRequest,
      },
    });
    if (stopping) { await listener.close(); detach(); return null; }
    await writeEndpointIpcDiscovery(uiSocketPath, { port, agentMcp: listener.endpoint });
    if (stopping) { await listener.close(); detach(); return null; }
  } catch (error) {
    detach();
    await listener?.close();
    throw error;
  }
  const close = listener.close;
  listener.close = async () => {
    detach();
    await close();
  };
  // Descriptor remains as a stale generation; readers validate socket+PID.
  // Never read/modify/write a descriptor at shutdown: a replacement operator
  // may have published between the read and write, losing its advertisement.
  return listener;
}
