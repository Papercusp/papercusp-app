/**
 * GET /api/plugins/host/events — SSE event stream for iframe plugin surfaces.
 * Ported from app/api/plugins/host/events/route.ts. `auth: 'public'`.
 */
import { sseResponse } from '@papercusp/sse';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/plugins/host/events',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req) {
    const url = new URL(req.url);
    const pluginName = url.searchParams.get('plugin');
    const installSlug = url.searchParams.get('install');
    const name = url.searchParams.get('name');
    if (!pluginName || !installSlug || !name) {
      return new Response('plugin, install, name query params required', { status: 400 });
    }

    // The HookBus this stream used to bridge (`state.bus.registerAction`) was
    // retired with the plugin-host rework — plugin events now feed the
    // event-reaction matcher via emitSystemEvent (plugin-system-hive-port
    // P-006/D-003) — and HostState carries no bus. No iframe-facing fan-out
    // exists on the new path yet, so this stream carries heartbeats only: the
    // EventSource contract PluginIframe.tsx expects stays intact (before this
    // change the setup crashed on the missing bus and the connection errored
    // anyway, so no events are lost that were previously delivered). Re-wiring
    // iframe event delivery onto the reaction engine is tracked as a work item.
    return sseResponse({
      signal: req.signal,
      heartbeatMs: 30_000,
      initialHeartbeat: true,
      setup: () => {},
    });
  },
});
