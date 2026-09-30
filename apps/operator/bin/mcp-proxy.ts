#!/usr/bin/env npx tsx
/**
 * Entry for the resilient local MCP proxy (mcp-host-availability-resilience-2026-06-22
 * P-005). Always-up local process that fronts :3070/api/mcp so a deploy restart of
 * :3070 is invisible to MCP clients (retry-on-refused). OPT-IN: nothing connects here
 * until a client config (~/.claude.json / psu launcher) is repointed at this port (P-006),
 * so running it is harmless. Config via env:
 *   PAPERCUSP_MCP_PROXY_PORT          listen port (default 9071; :3071-3079 are taken on the dev box)
 *   PAPERCUSP_MCP_PROXY_DYNAMIC_TARGET=1
 *                                     re-resolve upstream from ~/.papercusp/operator.json
 *                                     on every attempt (packaged installs with dynamic ports)
 *   PAPERCUSP_MCP_PROXY_TARGET_HOST   upstream host (default 127.0.0.1)
 *   PAPERCUSP_MCP_PROXY_TARGET_PORT   upstream port (default PAPERCUSP_HONO_PORT or 3070)
 *   PAPERCUSP_MCP_PROXY_DEV_FALLBACK_PORT
 *                                     unpinned dev-box fallback after :3070
 *                                     (default 3170); explicit target/HONO pins
 *                                     remain single-candidate fail-closed
 *   PAPERCUSP_MCP_PROXY_RETRY_MS      retry-on-refused window (default 90000 —
 *                                     a :3070 deploy restart measured ~45s wall
 *                                     on 2026-07-01, with recoveries landing at
 *                                     45.6s = past the old 45s window; 90s gives
 *                                     2× headroom so a slow restart can't 503).
 *                                     Read via lib/mcp-proxy/budgets.mjs, which is
 *                                     also what psu reads — see WI-6738: this window
 *                                     is only useful if the CLIENT waits at least
 *                                     this long, and it used to give up at 45s.
 *   PAPERCUSP_MCP_PROXY_MAX_HANDSHAKES_IN_FLIGHT
 *                                     write-free initialize/ping/tools-list class cap
 *                                     (default: control-plane reserve minus one, currently 7;
 *                                     non-positive disables). Keeps one reserved socket for
 *                                     the mcp-proxy-watchdog during a reconnect herd.
 *   PAPERCUSP_MCP_PROXY_MAX_QUEUE_WAIT_MS     bounded dwell (ms, default 30000) for a handshake
 *                                             WAITING in the admission FIFO — expiry sheds 429
 *                                             `mcp_proxy_handshake_queue_dwell`; 0 = unbounded.
 *   PAPERCUSP_MCP_PROXY_QUEUE_WAIT_LOG_MS     per-waiter queue-telemetry cadence
 *                                             (default 5000; 0 disables) — EI-21504897841052086.
 */
import {
  readOperatorJsonTarget,
  resolveDefaultMcpProxyTargets,
  startMcpProxy,
} from '../lib/mcp-proxy/proxy';
import { MCP_PROXY_RETRY_WINDOW_MS } from '../lib/mcp-proxy/budgets.mjs';

const dynamicTarget = process.env.PAPERCUSP_MCP_PROXY_DYNAMIC_TARGET === '1';
const targetHost = process.env.PAPERCUSP_MCP_PROXY_TARGET_HOST ?? '127.0.0.1';
const targetPort = Number(process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT ?? process.env.PAPERCUSP_HONO_PORT ?? 3070);

startMcpProxy({
  listenPort: Number(process.env.PAPERCUSP_MCP_PROXY_PORT ?? 9071),
  ...(dynamicTarget
    ? { resolveTarget: () => readOperatorJsonTarget() ?? { host: targetHost, port: targetPort, source: 'fallback' } }
    : { resolveTargets: () => resolveDefaultMcpProxyTargets() }),
  retryWindowMs: MCP_PROXY_RETRY_WINDOW_MS,
});
