/** Isolated production Hono process for installed-PUI restart acceptance.
 * Launched only by the Vitest fixture, with its migrated throwaway database.
 * The observation channel never supplies model output or answers a card.
 */
import { createAdaptorServer } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { SuSessionHost } from '../su-session-host';

// These workspace TypeScript entrypoints are CommonJS under tsx. Resolve
// their exports with Node's CJS loader rather than relying on named-export
// inference across an ESM child-process entrypoint.
const require = createRequire(import.meta.url);
const { app } =
  require('../../../../apps/operator/bin/host-app') as typeof import('../../../../apps/operator/bin/host-app');
const { getRegisteredSuSessionHost } = require('../su-session-host') as typeof import('../su-session-host');
const { getAdvSession } = require('../adv-sessions') as typeof import('../adv-sessions');
const { SU_SESSION_SCHEMA, SU_SESSION_PROTOCOL_VERSION } =
  require('@papercusp/chat-protocol') as typeof import('@papercusp/chat-protocol');

if (
  !process.send ||
  !process.env.PUI_OPERATOR_FIXTURE_WORKSPACE ||
  process.env.PAPERCUSP_WORKSPACE_ID !== process.env.PUI_OPERATOR_FIXTURE_WORKSPACE ||
  !process.env.HARNESS_ADMIN_DATABASE_URL
) {
  throw new Error('The PUI operator fixture requires IPC and an explicitly isolated workspace/database');
}
const workspaceId = process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
const observed = new Set<SuSessionHost>();
const instanceId = randomUUID();
const send = (message: unknown) => {
  if (process.connected) process.send!(message);
};
const sendAndFlush = async (message: unknown): Promise<void> => {
  if (!process.connected) return;
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => error ? reject(error) : resolve());
  });
};
for (const level of ['warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    send({ type: 'diagnostic', level, args: args.map((arg) => (arg instanceof Error ? arg.message : arg)) });
    original(...args);
  };
}

function observe(agentChatId: string, harnessSlug: string): void {
  const host = getRegisteredSuSessionHost({ workspaceId, harnessSlug, agentChatId });
  if (!host || observed.has(host)) return;
  observed.add(host);
  send({ type: 'host', descriptor: host.descriptor(), events: host.recent.map(({ event }) => event) });
  void (async () => {
    for await (const { event } of host.subscribe()) {
      send({ type: 'event', descriptor: host.descriptor(), event });
    }
  })().catch((error) => {
    console.error('PUI fixture observation failed', error);
  });
}

function observeSuSessionPath(pathname: string): void {
  const match = pathname.match(/^\/api\/harness\/([^/]+)\/agent-chats\/([^/]+)\/su-session(?:\/|$)/);
  if (!match) return;
  observe(decodeURIComponent(match[2]), decodeURIComponent(match[1]));
}

const server = createAdaptorServer({
  fetch: async (request, env) => {
    const pathname = new URL(request.url).pathname;
    const runTool =
      request.method === 'POST' && pathname === '/api/agent-mcp/run-tool'
        ? ((await request.clone().json().catch(() => null)) as { name?: string } | null)
        : null;
    const configStep = pathname === '/api/agent-config'
      ? 'agent-config'
      : pathname === '/api/agent-tools/operator/credentials_status'
        ? 'credentials-status'
        : runTool?.name === 'config:tiers-get'
          ? 'tiers-get'
          : null;
    const configStartedAt = Date.now();
    if (configStep) {
      send({
        type: 'diagnostic',
        level: 'info',
        args: ['PUI_OPERATOR_CONFIG_REQUEST_START', {
          step: configStep,
          method: request.method,
          pathname,
          at: new Date(configStartedAt).toISOString(),
        }],
      });
    }
    const tracksReadiness = pathname.includes('/su-session');
    // A streamed launch returns before async bootstrap registers its host, so
    // the launch-response hook below can legitimately see nothing. The PUI's
    // first canonical snapshot/event request is the request-driven rendezvous:
    // attach the observer there instead of polling the registry.
    if (tracksReadiness) observeSuSessionPath(pathname);
    const before = tracksReadiness ? [...observed].map((host) => host.snapshot()) : undefined;
    const requestedAt = new Date().toISOString();
    const launch =
      request.method === 'POST' && pathname === '/api/adv/sessions/launch-su'
        ? ((await request.clone().json()) as {
            agent_chat_id: string;
            harness_slug: string;
            model?: string;
            account?: string;
            mode?: string;
            carry?: string;
            plan_slug?: string;
          })
        : null;
    const mcpRequest = pathname === '/api/mcp' && request.method === 'POST'
      ? await request.clone().json().catch(() => null) as { method?: string; params?: { protocolVersion?: string } } | null
      : null;
    const response = await app.fetch(request, env);
    if (pathname === '/api/mcp') {
      send({ type: 'diagnostic', level: 'info', args: ['PUI_OPERATOR_MCP_NEGOTIATION', {
        method: request.method, rpcMethod: mcpRequest?.method,
        headerProtocol: request.headers.get('mcp-protocol-version'),
        offeredProtocol: mcpRequest?.method === 'initialize' ? mcpRequest.params?.protocolVersion : undefined,
        status: response.status, requestedAt, respondedAt: new Date().toISOString(),
      }] });
      if (mcpRequest?.method === 'initialize' && response.ok) {
        void response.clone().text().then((text) => {
          const data = text.split('\n').find((line) => line.startsWith('data:'))?.slice(5) ?? text;
          const result = JSON.parse(data).result;
          send({ type: 'diagnostic', level: 'info', args: ['PUI_OPERATOR_MCP_INITIALIZED', {
            protocolVersion: result?.protocolVersion,
          }] });
        }).catch(() => {});
      }
    }
    if (configStep) {
      send({
        type: 'diagnostic',
        level: 'info',
        args: ['PUI_OPERATOR_CONFIG_REQUEST_END', {
          step: configStep,
          method: request.method,
          pathname,
          status: response.status,
          durationMs: Date.now() - configStartedAt,
          at: new Date().toISOString(),
        }],
      });
    }
    if (runTool?.name === 'config:tiers-get') {
      send({
        type: 'diagnostic',
        level: 'info',
        args: ['PUI_CONFIG_TIERS_GET', {
          status: response.status,
          body: await response.clone().json().catch(() => undefined),
        }],
      });
    }
    if (launch) observe(launch.agent_chat_id, launch.harness_slug);
    if (tracksReadiness) {
      // Rehydration may itself occur while handling the snapshot request.
      observeSuSessionPath(pathname);
      const body = !pathname.endsWith('/events')
        ? await response
            .clone()
            .json()
            .catch(() => undefined)
        : undefined;
      send({
        type: 'readiness',
        path: pathname,
        method: request.method,
        requestedAt,
        respondedAt: new Date().toISOString(),
        status: response.status,
        before,
        after: [...observed].map((host) => host.snapshot()),
        body,
      });
    }
    if (pathname.endsWith('/su-session/commands')) {
      for (const host of observed) {
        const row = await getAdvSession(host.descriptor().identity.advSessionId);
        send({ type: 'host-state', descriptor: host.descriptor(), pid: row?.pid ?? null });
      }
    }
    // Claude reports every unhandled MCP POST status as CLIENT_HTTP_NOT_IMPLEMENTED
    // and drops the status and body, so the fixture keeps them.
    if (pathname === '/api/mcp' && !response.ok) {
      send({
        type: 'diagnostic',
        level: 'warn',
        args: ['PUI_OPERATOR_MCP_REFUSED', {
          method: request.method,
          status: response.status,
          body: (await response.clone().text().catch(() => '')).slice(0, 800),
        }],
      });
    }
    if (launch || pathname.endsWith('/card-response')) {
      send({
        type: 'response',
        path: pathname,
        status: response.status,
        ...(launch
          ? {
              model: launch.model,
              account: launch.account,
              mode: launch.mode,
              carry: launch.carry,
              planSlug: launch.plan_slug,
            }
          : {}),
      });
    }
    return response;
  },
});
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(Number(process.env.PUI_OPERATOR_FIXTURE_PORT ?? 0), '127.0.0.1', resolve);
});
const port = (server.address() as AddressInfo).port;
process.env.PAPERCUSP_HONO_PORT = String(port);
process.env.PAPERCUSP_OPERATOR_URL = `http://127.0.0.1:${port}`;
process.env.PAPERCUSP_MCP_PROXY_BASE = `http://127.0.0.1:${port}`;
send({ type: 'ready', pid: process.pid, instanceId, port });

let stopping = false;
async function stop({ endSessions = true }: { endSessions?: boolean } = {}): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    for (const host of endSessions ? observed : []) {
      if (!host.snapshot().terminal) {
        const command = {
          schema: SU_SESSION_SCHEMA,
          protocolVersion: SU_SESSION_PROTOCOL_VERSION,
          type: 'end',
          commandId: randomUUID(),
          issuedAt: new Date().toISOString(),
          target: host.descriptor().identity,
        };
        const dispatch = await host.acceptCommand(command);
        const terminal = await dispatch.terminal;
        if (terminal.status !== 'completed') throw new Error(`Native end refused: ${JSON.stringify(terminal)}`);
      }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { drainDetached } = require('../detached-imports') as typeof import('../detached-imports');
    await drainDetached();
    const { stopInvalidationListener } = require('../sync-sse') as typeof import('../sync-sse');
    await stopInvalidationListener();
    // Production's hard-exit contract deliberately does not terminate native
    // addon workers or reset process-local DB pools. Those operations run the
    // ONNX/node-addon teardown that this SIGKILL path exists to bypass and can
    // itself abort below JavaScript before the process exits. The child owns a
    // throwaway process; once HTTP and the process-owned LISTEN are drained,
    // the OS safely reclaims every remaining worker, pool, fd and socket.
    send({ type: 'shutdown-stage', stage: 'os-hard-exit-ready', pid: process.pid, instanceId });
    // Match the production host's post-drain exit contract. Calling
    // process.exit() runs native environment teardown, where ONNX (or another
    // loaded addon) can throw below JavaScript and strand the process in
    // do_exit. Flush the success marker first so the parent can distinguish
    // this intentional hard exit from a crash, then let the OS reclaim the
    // already-drained fixture process without running native destructors.
    await sendAndFlush({ type: 'stopped', pid: process.pid, instanceId });
    process.kill(process.pid, 'SIGKILL');
  } catch (error) {
    console.error('PUI operator fixture shutdown failed', error);
    await sendAndFlush({
      type: 'shutdown-failed',
      pid: process.pid,
      instanceId,
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    }).catch(() => {});
    process.kill(process.pid, 'SIGKILL');
  }
}
process.on('message', (message: { type?: string }) => {
  if (message.type === 'stop') void stop();
  if (message.type === 'restart') void stop({ endSessions: false });
});
process.on('SIGTERM', () => {
  void stop();
});
process.on('disconnect', () => {
  void stop();
});
