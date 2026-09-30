/** HTTP admission and stream lifecycle for the shared authenticated MCP host. */
import { createMcpHandler } from 'mcp-handler';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { loopPressure } from '../../../event-loop-lag-monitor';
import { withMcpAdmission, ADMISSION_CONTROL_ENABLED } from './mcp-admission';
import { mcpAuthChallenge, type McpAuthChallengeDependencies } from './mcp-auth-challenge';
import { isLoopbackRequest } from '../../../superuser-token';
import { isAppKeyShaped } from '../../../connected-apps/key';

const mcpAuthChallengeDependencies: McpAuthChallengeDependencies = {
  isLocal: isLoopbackRequest,
  isAppKeyShaped,
  // Lazy: the store pulls in the org database client, which this light module must not load
  // until an app key is actually presented.
  verifyAppKey: async (token) => (await import('../../../connected-apps/store')).verifyAppKey(token),
};
type BuildMcpToolContextForTests = typeof import('./_mcp-host')['__buildMcpToolContext_forTests'];
type ResolveMcpTargetAfterPluginHostWarm = typeof import('./_mcp-host')['resolveMcpTargetAfterPluginHostWarm'];

// Keep the route's lightweight contract helpers available without pulling in the
// operator host. Host-only helpers are imported from `_mcp-host` by their tests
// and by the native transport; the HTTP adapter loads that host on first request.
export { MCP_SERVER_CAPABILITIES } from './mcp-contract';
export { withMcpDiagnosticWarnings } from './mcp-diagnostic-warnings';
export type { McpCallResult } from './mcp-diagnostic-warnings';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type McpRouteHandler = ReturnType<typeof createMcpHandler>;
let handlerLoad: Promise<McpRouteHandler> | null = null;

/**
 * Build the third-party HTTP adapter on first request, after the operator
 * catalog is loaded. createMcpHandler installs a process-wide cleanup
 * interval at construction time; doing that at module scope made importing a
 * pure exported helper keep direct tsx probes alive forever.
 */
async function getMcpRouteHandler(): Promise<McpRouteHandler> {
  if (!handlerLoad) {
    handlerLoad = (async () => {
      const host = await import('./_mcp-host');
      await host.ensureOperatorToolsLoaded();
      return createMcpHandler(host.registerMcpHost, host.mcpHostServerOptions(), {
        basePath: '/api',
        maxDuration: 60,
        verboseLogs: process.env.NODE_ENV !== 'production',
        // mcp-handler defaults to enabling its SSE transport, which requires
        // Redis (REDIS_URL or KV_URL env) for cross-process pub/sub. We don't
        // run a Redis here in dev, so leaving SSE on means every SSE-bound
        // client triggers `Error: redisUrl is required` — which surfaces as
        // an unhandledRejection and (under recent Node defaults) eventually
        // takes the whole operator process down with rc=0 silently.
        // Streamable-HTTP transport doesn't need Redis; turn SSE off.
        disableSse: true,
      });
    })().catch((error) => {
      handlerLoad = null;
      throw error;
    });
  }
  return await handlerLoad;
}

// Compatibility boundary for the handler-level tests and existing internal
// callers. Keep these helpers lazy: a runtime re-export from `_mcp-host` would
// recreate the eager operator-tool graph that makes one-shot tsx imports hang.
export async function __buildMcpToolContext_forTests(
  ...args: Parameters<BuildMcpToolContextForTests>
): ReturnType<BuildMcpToolContextForTests> {
  const host = await import('./_mcp-host');
  return host.__buildMcpToolContext_forTests(...args);
}

export async function resolveMcpTargetAfterPluginHostWarm(
  ...args: Parameters<ResolveMcpTargetAfterPluginHostWarm>
): ReturnType<ResolveMcpTargetAfterPluginHostWarm> {
  const host = await import('./_mcp-host');
  return host.resolveMcpTargetAfterPluginHostWarm(...args);
}

/**
 * SSE header-flush priming: a streamable-HTTP tools/call that BLOCKS inside
 * the tool (chat:ask_choice awaiting the user's pick) opens a text/event-stream
 * response and then writes NOTHING until the tool resolves. Direct clients see
 * the 200 headers immediately (node flushes them), but any intermediary built
 * on node http-proxy — the :3055 Vite dev proxy, most reverse proxies — holds
 * the response headers until the FIRST BODY BYTE arrives, so the client sees
 * a connection that never responds at all. Prepending one SSE comment line
 * (spec-legal; eventsource parsers ignore `:`-prefixed lines) pushes the
 * headers through every hop the moment the stream opens.
 * Pinned by ask-choice-e2e.integration.test.ts ("tool reachable" case).
 */
const SSE_PRIME = new TextEncoder().encode(':stream-open\n\n');

// P2-2 (operator-scalability-event-loop-2026-06-16): a spec-legal SSE comment used as
// an application-level keepalive. While a blocking / long tools/call holds the
// streamable-HTTP event-stream OPEN but silent, the cloudflared tunnel + the client's
// ~60s idle timers fire and drop the connection mid-call (the MCP-tooling drops seen
// under load). Emitting this comment on a cadence well under 60s resets both timers.
// Like SSE_PRIME it rides the PER-REQUEST stream (NOT the Redis-backed SSE transport,
// which stays disabled) and is ignored by the MCP client's SSE parser (`:`-prefixed =
// comment). Tunable/disable-able via PAPERCUSP_MCP_KEEPALIVE_MS (0 = off).
const SSE_KEEPALIVE = new TextEncoder().encode(': keepalive\n\n');
const DEFAULT_KEEPALIVE_MS = Number(process.env.PAPERCUSP_MCP_KEEPALIVE_MS) || 20_000;

export function primeSseResponse(res: Response, keepaliveMs: number = DEFAULT_KEEPALIVE_MS): Response {
  const ctype = res.headers.get('content-type') ?? '';
  if (!res.body || !ctype.includes('text/event-stream')) return res;
  const reader = res.body.getReader();
  let cancelled = false;
  let closed = false;
  let keepalive: ManagedHandle | undefined;
  const stopKeepalive = (): void => {
    if (keepalive) {
      keepalive.stop();
      keepalive = undefined;
    }
  };
  // Tracks the latest in-flight inner read so the disconnect-drain (cancel)
  // never issues a `reader.read()` concurrent with a pending pull read — that
  // throws "read while another read is in progress".
  let lastRead: Promise<unknown> = Promise.resolve();
  const primed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(SSE_PRIME);
      // P2-2: keep the open-but-idle stream alive past the 60s tunnel/client timers.
      // Fires independently of pull() (which blocks on the inner read while the tool
      // runs), so a pending consumer read is satisfied by the comment — resetting the
      // idle timers — without waiting on the tool to produce.
      if (keepaliveMs > 0) {
        keepalive = managedSetInterval(
          'mcp-sse-keepalive',
          keepaliveMs,
          () => {
            if (cancelled || closed) return;
            try {
              controller.enqueue(SSE_KEEPALIVE);
            } catch {
              stopKeepalive(); // controller closed/errored between checks — stop pinging
            }
          },
          { category: 'lifecycle', instanced: true },
        );
      }
    },
    pull(controller) {
      const p = (async () => {
        const { done, value } = await reader.read();
        if (done) {
          closed = true;
          stopKeepalive();
          controller.close();
          return;
        }
        // Outer consumer already gone (cancel ran): stop forwarding. The
        // background drain below consumes the rest of the inner stream.
        if (cancelled) return;
        try {
          controller.enqueue(value);
        } catch {
          /* outer controller already closed — client raced us; ignore */
        }
      })();
      lastRead = p.catch(() => {});
      return p;
    },
    // Client disconnect. Do NOT cancel the inner reader: cancelling it closes
    // mcp-handler's ServerResponse-adapter controller, and that library's
    // detached write pump (createServerResponseAdapter → res.write →
    // controller.enqueue, node_modules/mcp-handler) then throws
    // TypeError[ERR_INVALID_STATE] "Controller is already closed" on the next
    // frame it writes after the client left. That throw is voided (an
    // unhandledRejection) and, under MCP load, crash-loops the whole operator
    // host (EI-12). Instead DRAIN the inner stream to completion in the
    // background — mcp-handler's OWN res.end() then stays the only thing that
    // closes its controller, so no enqueue-after-close ever happens. The
    // disconnect still reaches the tool + transport via the request
    // AbortSignal (mcp-handler wires request.signal → "close" →
    // transport.onclose), which is what makes the inner stream end.
    cancel() {
      cancelled = true;
      closed = true;
      stopKeepalive();
      void (async () => {
        try {
          await lastRead; // let any in-flight pull read settle first
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch {
          /* inner stream torn down — nothing left to drain */
        }
      })();
    },
  });
  return new Response(primed, res);
}

// P-010 admission control (mcp-reliability-hardening-2026-07-11): shed a tools/call
// PRE-DISPATCH with 429+Retry-After when the loop is critically saturated; the P-005
// proxy absorbs the 429 so the agent just waits. Pure decision logic + the full
// rationale live in ./mcp-admission (kept out of this heavy side-effect module so it's
// unit-testable). Fail-open when no lag monitor is running (loopPressure() → 'ok').
const mcpHandler = async (req: Request): Promise<Response> => {
  // external-app-access P-006: an outside client with no (or a bad) credential gets the HTTP 401
  // that starts MCP OAuth discovery, before the transport — see ./mcp-auth-challenge.
  const refused = await mcpAuthChallenge(req, mcpAuthChallengeDependencies);
  if (refused) return refused;
  const handler = await getMcpRouteHandler();
  return withMcpAdmission(req, loopPressure(), ADMISSION_CONTROL_ENABLED, async () =>
    primeSseResponse(await handler(req)),
  );
};

export { mcpHandler };
